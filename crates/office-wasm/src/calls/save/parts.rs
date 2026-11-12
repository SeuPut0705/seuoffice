//! The functions of this slice of `docx_engine::save`: the part writers of
//! patch.ts (header/footer parts, comments, settings, the personal-information
//! scrub), style-upsert.ts, remove-parts.ts, resource-cleanup.ts and
//! zip-splice.ts. A function over XML takes its text; a function that writes
//! into a zip answers the parts of the zip after the call; bytes cross as
//! arrays of numbers.

use std::collections::{HashMap, HashSet};

use docx_engine::model::{CommentInfo, DocProtection, HeaderFooter, WriteProtection};
use docx_engine::save::parts::hf_parts;
use docx_engine::save::parts::remove_parts::{self, RemovePartsOptions, RemovedPartBinding};
use docx_engine::save::parts::resource_cleanup;
use docx_engine::save::parts::style_upsert::{self, DefaultFonts, StyleHeadingInfo, StyleUpsert};
use docx_engine::save::parts::zip_splice::{
    self, ByteSource, OutEntry, ZipArchive, ZipEntry, ZipFile,
};
use docx_engine::save::parts::{comments, markup, scrub, settings};
use jscompat::JsObject;
use ooxml_pkg::{Package, write::generate};
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::{Returned, arg, package, required, value};

/// None: not a function of this module.
pub fn dispatch(function: &str, text: &str, args: &Value) -> Option<Returned> {
    let call: fn(&str, &Value) -> Returned = match function {
        // settings.xml
        "settingsChildRank" => |text, _| value(settings::settings_child_rank(text)),
        "insertSettingsChild" => |text, args| {
            value(settings::insert_settings_child(
                text,
                &required::<String>(args, "localName")?,
                &required::<String>(args, "childXml")?,
            )?)
        },
        "applySettingsFlag" => |text, args| {
            value(settings::apply_settings_flag(
                text,
                &required::<String>(args, "tag")?,
                required(args, "on")?,
            )?)
        },
        "applyEvenAndOddHeaders" => |text, args| {
            value(settings::apply_even_and_odd_headers(
                text,
                required(args, "on")?,
            )?)
        },
        "applyPageColor" => |text, args| {
            let color: Option<String> = arg(args, "color")?;
            value(settings::apply_page_color(text, color.as_deref())?)
        },
        "applyProtection" => |text, args| {
            let protection: Option<DocProtection> = arg(args, "protection")?;
            value(settings::apply_protection(text, protection.as_ref())?)
        },
        "applyWriteProtection" => |text, args| {
            let protection: Option<WriteProtection> = arg(args, "writeProtection")?;
            value(settings::apply_write_protection(text, protection.as_ref())?)
        },
        "applyRemovePersonalInfo" => |text, args| {
            value(settings::apply_remove_personal_info(
                text,
                required(args, "on")?,
            )?)
        },
        // the scrub
        "opaqueMarkupEnd" => |text, args| {
            let start = byte_of(text, required::<f64>(args, "start")?);
            value(markup::opaque_markup_end(text, start).map(|end| units_of(text, end)))
        },
        "xmlTagEnd" => |text, args| {
            let start = byte_of(text, required::<f64>(args, "start")?);
            value(units_of(text, markup::xml_tag_end(text, start)))
        },
        "namespacePrefixes" => |text, args| {
            let namespaces = required::<Vec<String>>(args, "namespaces")?;
            let namespaces: Vec<&str> = namespaces.iter().map(String::as_str).collect();
            value(markup::namespace_prefixes(text, &namespaces))
        },
        "mapXmlStartTags" => |text, args| {
            let how = required::<String>(args, "rewrite")?;
            value(
                scrub::map_xml_start_tags(text, |tag| {
                    Ok(match how.as_str() {
                        "upper" => tag.to_uppercase(),
                        "underscore" => tag.replace(' ', "_"),
                        _ => tag.to_owned(),
                    })
                })
                .map_err(|limit| limit.to_string())?,
            )
        },
        "replaceQualifiedAttributes" => |text, args| {
            let prefixes = required::<Vec<String>>(args, "prefixes")?;
            let replacements = required::<JsObject<String>>(args, "replacements")?;
            let pairs: Vec<(&str, &str)> = replacements
                .entries()
                .into_iter()
                .map(|(key, value)| (key, value.as_str()))
                .collect();
            value(
                scrub::replace_qualified_attributes(text, &prefixes, &pairs)
                    .map_err(|e| e.to_string())?,
            )
        },
        "replaceUnqualifiedAttributes" => |text, args| {
            let replacements = required::<JsObject<String>>(args, "replacements")?;
            let pairs: Vec<(&str, &str)> = replacements
                .entries()
                .into_iter()
                .map(|(key, value)| (key, value.as_str()))
                .collect();
            value(scrub::replace_unqualified_attributes(text, &pairs).map_err(|e| e.to_string())?)
        },
        "clearQualifiedElements" => |text, args| {
            let namespaces = required::<Vec<String>>(args, "namespaces")?;
            let local_names = required::<Vec<String>>(args, "localNames")?;
            let namespaces: Vec<&str> = namespaces.iter().map(String::as_str).collect();
            let local_names: Vec<&str> = local_names.iter().map(String::as_str).collect();
            value(
                scrub::clear_qualified_elements(text, &namespaces, &local_names)
                    .map_err(|e| e.to_string())?,
            )
        },
        "scrubWordprocessingMetadata" => {
            |text, _| value(scrub::scrub_wordprocessing_metadata(text).map_err(|e| e.to_string())?)
        }
        "scrubPeopleMetadata" => {
            |text, _| value(scrub::scrub_people_metadata(text).map_err(|e| e.to_string())?)
        }
        "scrubPersonalMetadata" => |_, args| {
            let mut package = package(args)?;
            scrub::scrub_personal_metadata(&mut package)?;
            value(parts_of(&package)?)
        },
        "regexEscape" => |text, _| value(jscompat::regex_escape(text)),
        // header and footer parts
        "headerFooterPartXml" => |text, args| {
            let watermark: Option<String> = arg(args, "watermarkXml")?;
            let original: Option<String> = arg(args, "originalXml")?;
            let page_count: Option<f64> = arg(args, "pageCount")?;
            value(hf_parts::header_footer_part_xml(
                text,
                &required::<HeaderFooter>(args, "hf")?,
                watermark.as_deref(),
                original.as_deref(),
                page_count.unwrap_or(1.0),
            )?)
        },
        "withWatermarkNs" => |text, _| value(hf_parts::with_watermark_ns(text)),
        "hfOriginalXml" => |_, args| {
            let original: Option<String> = arg(args, "originalXml")?;
            value(hf_parts::hf_original_xml(
                &required::<HeaderFooter>(args, "hf")?,
                original.as_deref(),
            )?)
        },
        "patchWatermarkInPart" => |text, args| {
            value(hf_parts::patch_watermark_in_part(
                text,
                &required::<String>(args, "watermarkXml")?,
            )?)
        },
        "removeHfReference" => |text, args| {
            value(hf_parts::remove_hf_reference(
                text,
                &required::<String>(args, "kind")?,
                &required::<String>(args, "variant")?,
            )?)
        },
        // comments
        "buildCommentsXml" => |_, args| {
            let original: Option<String> = arg(args, "originalXml")?;
            let image_runs = pairs_map(arg(args, "imageRuns")?);
            let kept_runs = pairs_map(arg(args, "keptImageRuns")?);
            value(comments::build_comments_xml(
                &required::<Vec<CommentInfo>>(args, "comments")?,
                original.as_deref(),
                image_runs.as_ref(),
                kept_runs.as_ref(),
            )?)
        },
        "buildCommentsExtendedXml" => |_, args| {
            value(comments::build_comments_extended_xml(&required::<
                Vec<CommentInfo>,
            >(
                args, "comments"
            )?))
        },
        "commentPlainText" => |text, _| value(comments::comment_plain_text(text)),
        "removeDeletedCommentMarkers" => |text, args| {
            let live: HashSet<String> = required::<Vec<String>>(args, "liveIds")?
                .into_iter()
                .collect();
            value(comments::remove_deleted_comment_markers(text, &live)?)
        },
        // style-upsert.ts
        "mergeStyleXml" => |_, args| {
            let existing: Option<String> = arg(args, "existing")?;
            value(style_upsert::merge_style_xml(
                existing.as_deref(),
                &required::<StyleUpsert>(args, "up")?,
            )?)
        },
        "upsertStyleXml" => |text, args| {
            value(style_upsert::upsert_style_xml(
                text,
                &required::<StyleUpsert>(args, "up")?,
            )?)
        },
        "mergeDefaultFontsXml" => |text, args| {
            value(style_upsert::merge_default_fonts_xml(
                text,
                &required::<DefaultFonts>(args, "fonts")?,
            )?)
        },
        "builtInHeadingStyleUpsert" => |_, args| {
            let default_style: Option<String> = arg(args, "defaultParagraphStyleId")?;
            value(style_upsert::built_in_heading_style_upsert(
                required(args, "level")?,
                default_style.as_deref(),
            ))
        },
        "pendingHeadingLevel" => |text, args| {
            let pending = required::<JsObject<StyleUpsert>>(args, "pending")?;
            let existing = required::<JsObject<StyleHeadingInfo>>(args, "existing")?;
            value(style_upsert::pending_heading_level(
                text,
                &|id| pending.get(id).cloned(),
                &|id| existing.get(id).cloned(),
                &mut HashSet::new(),
            ))
        },
        // remove-parts.ts
        "planRemoveParts" => |_, args| {
            let package = package(args)?;
            let bytes = generate(&package, 0.0).map_err(|error| error.to_string())?;
            value(remove_parts::plan_remove_parts(
                &bytes,
                &required::<RemovePartsOptions>(args, "options")?,
            )?)
        },
        "applyRemoveParts" => |_, args| {
            let mut package = package(args)?;
            let plan = remove_parts::apply_remove_parts(
                &mut package,
                &required::<RemovePartsOptions>(args, "options")?,
            )?;
            value(json!({ "plan": plan, "parts": parts_of(&package)? }))
        },
        "removePartsRefusalMessage" => |_, args| {
            value(remove_parts::remove_parts_refusal_message(&required::<
                Vec<RemovedPartBinding>,
            >(
                args, "bindings",
            )?))
        },
        "removePartsRefusalMessageFor" => |_, args| {
            value(remove_parts::remove_parts_refusal_message_for(&required::<
                Vec<String>,
            >(
                args,
                "refusedPaths",
            )?))
        },
        // resource-cleanup.ts
        "referencedRelationshipIds" => |text, _| {
            let mut ids: Vec<String> = resource_cleanup::referenced_relationship_ids(text)?
                .into_iter()
                .collect();
            ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            value(ids)
        },
        "cleanupDocxOwnedResources" => |_, args| {
            let mut package = package(args)?;
            let source_ids: Option<Vec<String>> = arg(args, "sourceReferencedIds")?;
            let source_ids: Option<HashSet<String>> =
                source_ids.map(|ids| ids.into_iter().collect());
            resource_cleanup::cleanup_docx_owned_resources(
                &mut package,
                &required::<String>(args, "documentPath")?,
                source_ids.as_ref(),
            )?;
            value(parts_of(&package)?)
        },
        // zip-splice.ts
        "readZipEntries" => |_, args| {
            let bytes = required::<Vec<u8>>(args, "bytes")?;
            let entries = zip_splice::read_zip_entries(
                &zip_splice::BufferSource(&bytes),
                &ooxml_pkg::DEFAULT_ZIP_LIMITS,
            )?;
            value(entries.iter().map(entry_json).collect::<Vec<_>>())
        },
        "writeZip" => |_, args| {
            let entries = required::<Vec<OutEntryArg>>(args, "entries")?;
            let entries: Vec<OutEntry> = entries.into_iter().map(OutEntryArg::into_out).collect();
            value(zip_splice::write_zip(&entries)?)
        },
        "slimDocx" => |_, args| {
            let zip = ZipFile::open(Owned(required::<Vec<u8>>(args, "bytes")?))?;
            let slim = zip_splice::slim_docx(
                &zip,
                &required::<String>(args, "hash")?,
                required(args, "minBytes")?,
            )?;
            value(slim.map(|slim| json!({ "bytes": slim.bytes, "lazyParts": slim.lazy_parts })))
        },
        "lazyMediaHashesIn" => |_, args| {
            let mut hashes =
                zip_splice::lazy_media_hashes_in(&required::<Vec<u8>>(args, "bytes")?)?;
            hashes.sort();
            value(hashes)
        },
        "materializeDocx" => |_, args| {
            let sources = required::<Vec<(String, Option<Vec<u8>>)>>(args, "sources")?;
            let mut source_for = |hash: &str| -> Result<Option<Box<dyn ZipArchive>>, String> {
                let Some((_, bytes)) = sources.iter().find(|(name, _)| name == hash) else {
                    return Ok(None);
                };
                let Some(bytes) = bytes else {
                    return Ok(None);
                };
                Ok(Some(Box::new(ZipFile::open(Owned(bytes.clone()))?)))
            };
            value(zip_splice::materialize_docx(
                &required::<Vec<u8>>(args, "bytes")?,
                &mut source_for,
            )?)
        },
        _ => return None,
    };
    Some(call(text, args))
}

/// A byte source that owns its bytes.
struct Owned(Vec<u8>);

impl ByteSource for Owned {
    fn size(&self) -> u64 {
        self.0.len() as u64
    }

    fn read(&self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        zip_splice::BufferSource(&self.0).read(offset, length)
    }
}

/// An `OutEntry` of the arguments: the metadata of an entry and its data.
#[derive(Deserialize)]
struct OutEntryArg {
    meta: EntryArg,
    data: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryArg {
    name: String,
    name_bytes: Vec<u8>,
    flags: u16,
    method: u16,
    time: u16,
    date: u16,
    crc: u32,
    csize: u32,
    usize: u32,
    ver_made: u16,
    ver_need: u16,
    int_attr: u16,
    ext_attr: u32,
}

impl OutEntryArg {
    fn into_out(self) -> OutEntry {
        OutEntry {
            meta: ZipEntry {
                name: self.meta.name,
                name_bytes: self.meta.name_bytes,
                flags: self.meta.flags,
                method: self.meta.method,
                time: self.meta.time,
                date: self.meta.date,
                crc: self.meta.crc,
                csize: self.meta.csize,
                usize: self.meta.usize,
                ver_made: self.meta.ver_made,
                ver_need: self.meta.ver_need,
                int_attr: self.meta.int_attr,
                ext_attr: self.meta.ext_attr,
                data_offset: 0,
            },
            data: self.data,
        }
    }
}

fn entry_json(entry: &ZipEntry) -> Value {
    json!({
        "name": entry.name,
        "nameBytes": entry.name_bytes,
        "flags": entry.flags,
        "method": entry.method,
        "time": entry.time,
        "date": entry.date,
        "crc": entry.crc,
        "csize": entry.csize,
        "usize": entry.usize,
        "verMade": entry.ver_made,
        "verNeed": entry.ver_need,
        "intAttr": entry.int_attr,
        "extAttr": entry.ext_attr,
        "dataOffset": entry.data_offset,
    })
}

/// A `Map<string, string>` of the arguments, which crosses as its entries.
fn pairs_map(pairs: Option<Vec<(String, String)>>) -> Option<HashMap<String, String>> {
    pairs.map(|pairs| pairs.into_iter().collect())
}

/// The entries of a package, in order: `[name, text]`, `null` for a folder.
fn parts_of(package: &Package) -> Result<Vec<(String, Option<String>)>, String> {
    package
        .parts()
        .iter()
        .map(|part| {
            let text = if part.is_dir {
                None
            } else {
                Some(part.text().map_err(|error| error.to_string())?.to_owned())
            };
            Ok((part.name.clone(), text))
        })
        .collect()
}

/// The UTF-16 index `units` of `text` as a byte offset.
fn byte_of(text: &str, units: f64) -> usize {
    let target = if units.is_nan() {
        0.0
    } else {
        units.trunc().max(0.0)
    };
    let mut seen = 0.0;
    for (byte, c) in text.char_indices() {
        if seen >= target {
            return byte;
        }
        seen += c.len_utf16() as f64;
    }
    text.len()
}

/// The byte offset `byte` of `text` as a UTF-16 index.
fn units_of(text: &str, byte: usize) -> usize {
    text[..byte.min(text.len())].encode_utf16().count()
}
