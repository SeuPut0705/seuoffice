//! `odtPage.*`: the plain-data exports of `packages/odt-engine/src/page`.
//!
//! Conventions beyond the contract's:
//! - `prefixes` (a `PrefixMap`) crosses as the root attributes it is built
//!   from: `[{ name, raw }]` (`name` as written, `raw` the undecoded value);
//! - offsets in arguments and results are UTF-16 (`U16`); the functions run
//!   over bytes and convert at this boundary;
//! - `stripPPrSectPr` reads `pPr` from the text, or `undefined` where
//!   `args.missing` is set;
//! - `writePageExt` answers the `ext` of the map after the write (the
//!   TypeScript mutates the map and returns nothing);
//! - `layout` (an `OdtStyle`) crosses as `{ properties }` only: the property
//!   bags are all the geometry reads;
//! - `settings`, `before` and `after` (`SectionSettings`) cross whole; only
//!   the measures the geometry reads are looked at.
//!
//! Not covered, because they take the style table or a master page record:
//! `masterOf`, `pageNumberOf`, `regionsOf`, `titlePgOf`, `evenOddOf`,
//! `regionInnerXml`, `readEditedParts`, `baselineParagraphs`.

use docx_engine::model::HfParagraph;
use jscompat::JsObject;
use odt_engine::core::styles::OdtPropertyBag;
use odt_engine::core::xml::{PrefixMap, XmlAttribute};
use odt_engine::offset::{IndexedText, U16};
use odt_engine::page::geometry::{
    FOOTER_PROPS, HEADER_PROPS, LAYOUT_COLUMNS, LAYOUT_PROPS, LayoutOverrides, Measures,
    columns_of, is_empty_overrides, layout_geometry_of, layout_overrides_of, odf_lengths_of,
    twips_to_length,
};
use odt_engine::page::hf::{hf_format, pair_paragraphs};
use odt_engine::page::model::{
    HF_REGIONS, HfRegion, PAGE_EXT_KEY, PAGE_OWNER, PageExt, read_page_ext_in, write_page_ext_in,
};
use odt_engine::page::odf::{
    LayoutEdit, MasterEdit, RegionChild, RegionChildU16, child_elements, edit_layout_xml,
    edit_master_xml, start_tag_at,
};
use odt_engine::page::register::FORCE_MARK;
use odt_engine::page::sectpr::{
    SectPrSpec, build_sect_pr, inject_paragraph_sect_pr, paragraph_sect_pr, strip_p_pr_sect_pr,
    strip_paragraph_sect_pr,
};
use odt_engine::text::props::AttrOverrides;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{Returned, arg, byte_past_end, optional, required, u16_past_end, value};

#[derive(Deserialize)]
struct RootAttribute {
    name: String,
    raw: String,
}

fn prefixes(args: &Value) -> Result<PrefixMap, String> {
    let attrs: Vec<RootAttribute> = arg(args, "prefixes")?.unwrap_or_default();
    let attrs: Vec<XmlAttribute> = attrs
        .into_iter()
        .map(|a| XmlAttribute {
            name: a.name,
            raw: a.raw,
            name_start: 0,
            value_start: 0,
            value_end: 0,
        })
        .collect();
    Ok(PrefixMap::from_attributes(&attrs))
}

#[derive(Deserialize)]
struct LayoutArg {
    #[serde(default)]
    properties: Option<OdtPropertyBag>,
}

fn layout(args: &Value) -> Result<Option<OdtPropertyBag>, String> {
    Ok(arg::<LayoutArg>(args, "layout")?.and_then(|l| l.properties))
}

#[derive(Deserialize, Default)]
struct LayoutEditArg {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    page: Option<AttrOverrides>,
    #[serde(default)]
    header: Option<AttrOverrides>,
    #[serde(default)]
    footer: Option<AttrOverrides>,
}

fn u16_arg(args: &Value, key: &str) -> Result<U16, String> {
    required::<U16>(args, key)
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constant" => match required::<String>(args, "name")?.as_str() {
            "PAGE_EXT_KEY" => value(PAGE_EXT_KEY),
            "PAGE_OWNER" => value(PAGE_OWNER),
            "HF_REGIONS" => value(HF_REGIONS.map(HfRegion::as_str)),
            "LAYOUT_PROPS" => value(LAYOUT_PROPS),
            "LAYOUT_COLUMNS" => value(LAYOUT_COLUMNS),
            "HEADER_PROPS" => value(HEADER_PROPS),
            "FOOTER_PROPS" => value(FOOTER_PROPS),
            "FORCE_MARK" => value(FORCE_MARK),
            other => Err(format!("no constant {other}")),
        },
        "twipsToLength" => value(twips_to_length(required(args, "value")?)),
        "layoutGeometry" => value(layout_geometry_of(layout(args)?.as_ref())),
        "columnsOf" => {
            let cols: Option<JsObject<String>> = arg(args, "cols")?;
            value(columns_of(cols.as_ref()))
        }
        "isEmptyOverrides" => {
            let o: LayoutOverrides = required(args, "o")?;
            value(is_empty_overrides(&o))
        }
        "layoutOverrides" => {
            let before: Measures = required(args, "before")?;
            let after: Measures = required(args, "after")?;
            value(layout_overrides_of(layout(args)?.as_ref(), &before, &after))
        }
        "odfLengths" => {
            let settings: Measures = required(args, "settings")?;
            value(odf_lengths_of(layout(args)?.as_ref(), &settings))
        }
        "buildSectPr" => {
            let spec: SectPrSpec = required(args, "spec")?;
            value(build_sect_pr(&spec))
        }
        "injectParagraphSectPr" => value(inject_paragraph_sect_pr(
            text,
            &required::<String>(args, "sectPr")?,
        )),
        "paragraphSectPr" => value(paragraph_sect_pr(text)),
        "stripParagraphSectPr" => value(strip_paragraph_sect_pr(text)),
        "stripPPrSectPr" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            optional(strip_p_pr_sect_pr((!missing).then_some(text)))
        }
        "startTagAt" => {
            let indexed = IndexedText::new(text.to_owned());
            let start = indexed.to_byte(u16_arg(args, "start")?);
            let Some(tag) = start_tag_at(text, start, &prefixes(args)?) else {
                return value(Value::Null);
            };
            let mut out = Map::new();
            out.insert("name".into(), Value::String(tag.name));
            out.insert(
                "attrs".into(),
                serde_json::to_value(&tag.attrs).map_err(|e| e.to_string())?,
            );
            out.insert(
                "end".into(),
                serde_json::to_value(indexed.to_u16(tag.end)).map_err(|e| e.to_string())?,
            );
            value(Value::Object(out))
        }
        "childElements" => {
            let indexed = IndexedText::new(text.to_owned());
            let from = byte_past_end(&indexed, f64::from(u16_arg(args, "from")?.0));
            // `to` is `xml.lastIndexOf('</')` in the spec: -1 for a tag with no closing tag.
            // A limit at or below `from` ends the scan before its first token, which a
            // limit of 0 does for every `from` >= 0.
            let to = match required::<i64>(args, "to")? {
                to if to < 0 => 0,
                to => byte_past_end(&indexed, to as f64),
            };
            let children: Vec<RegionChild> = child_elements(text, &prefixes(args)?, from, to);
            value(
                children
                    .into_iter()
                    .map(|c| RegionChildU16 {
                        name: c.name,
                        start: U16(u16_past_end(&indexed, c.start)),
                        open_end: U16(u16_past_end(&indexed, c.open_end)),
                        close_start: U16(u16_past_end(&indexed, c.close_start)),
                        end: U16(u16_past_end(&indexed, c.end)),
                        self_closing: c.self_closing,
                    })
                    .collect::<Vec<_>>(),
            )
        }
        "editLayoutXml" => {
            let edit: LayoutEditArg = arg(args, "edit")?.unwrap_or_default();
            let edit = LayoutEdit {
                name: edit.name,
                page: edit.page,
                header: edit.header,
                footer: edit.footer,
            };
            value(edit_layout_xml(text, &prefixes(args)?, &edit).map_err(|e| e.to_string())?)
        }
        "editMasterXml" => {
            let style_tag: String = required(args, "styleTag")?;
            let edit: Option<Value> = arg(args, "edit")?;
            let edit = edit.unwrap_or(Value::Null);
            let string_of = |key: &str| edit.get(key).and_then(Value::as_str).map(str::to_owned);
            let regions = edit.get("regions").and_then(Value::as_object).map(|map| {
                map.iter()
                    .filter_map(|(k, v)| {
                        let region = HfRegion::from_name(k)?;
                        Some((region, v.as_str().map(str::to_owned)))
                    })
                    .collect::<Vec<_>>()
            });
            let edit = MasterEdit {
                name: string_of("name"),
                layout: string_of("layout"),
                regions,
            };
            value(
                edit_master_xml(text, &prefixes(args)?, &style_tag, &edit)
                    .map_err(|e| e.to_string())?,
            )
        }
        "hfFormat" => {
            let p: HfParagraph = required(args, "p")?;
            value(Value::Object(hf_format(&p)))
        }
        "pairParagraphs" => {
            let original: Vec<String> = required(args, "original")?;
            let edited: Vec<String> = required(args, "edited")?;
            value(pair_paragraphs(&original, &edited))
        }
        "readPageExt" => {
            let map: Value = required(args, "map")?;
            let ext = map
                .get("ext")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            value(read_page_ext_in(&ext))
        }
        "writePageExt" => {
            let map: Value = required(args, "map")?;
            let ext: PageExt = required(args, "ext")?;
            let mut map_ext = map
                .get("ext")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            write_page_ext_in(&mut map_ext, &ext);
            value(Value::Object(map_ext))
        }
        _ => Err(format!("no function {function}")),
    }
}
