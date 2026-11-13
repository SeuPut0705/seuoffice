//! The functions of group `w-shell` (tools/main-diff/groups/w-shell.ts): the
//! quick-look extractor and the document picker's list, ported by batch W of
//! stage 3. What they read through a trait is a fake the spec describes: the
//! text a file parses to, the sizes of the paths, the open documents.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::shell::doc_picker::asker::{
    DocAsker, DocAskerSources, HostedDocument, resolve_doc_asker,
};
use crate::shell::doc_picker::doc_list::{
    DocListDeps, DocListOptions, MentionItem, OpenDocumentEntry, ProjectFile, RecentDocumentEntry,
    doc_list, to_mention_items,
};
use crate::shell::doc_picker::{DocItemGroup, DocItemState, DocListItem};
use crate::shell::quick_look::{
    DocBlock, MindmapSheet, ParsedFile, QuickLookEngines, Sheet, Slide, ZipArchive,
    extract_embedded_thumbnail, extract_quick_look, parse_doc_blocks_from_text,
    parse_mindmap_from_text, parse_sheets_from_text, parse_slides_from_text,
};

pub(super) fn call(name: &str, args: &[Value], _cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "extract.parseSheetsFromText" => (|| {
            let text = str_arg(args, 0)?;
            let ext = str_arg(args, 1)?;
            let fallback = str_arg(args, 2)?;
            let (sheets, truncated) = parse_sheets_from_text(text, ext, fallback);
            let mut o = Map::new();
            o.insert(
                "sheets".into(),
                Value::Array(sheets.iter().map(Sheet::to_json).collect()),
            );
            o.insert("truncated".into(), truncated.into());
            Ok(Some(Value::Object(o)))
        })(),
        "extract.parseSlidesFromText" => (|| {
            let (slides, truncated) = parse_slides_from_text(str_arg(args, 0)?);
            let mut o = Map::new();
            o.insert(
                "slides".into(),
                Value::Array(slides.iter().map(Slide::to_json).collect()),
            );
            o.insert("truncated".into(), truncated.into());
            Ok(Some(Value::Object(o)))
        })(),
        "extract.parseMindmapFromText" => (|| {
            let (mindmap, truncated) = parse_mindmap_from_text(str_arg(args, 0)?);
            let mut o = Map::new();
            o.insert(
                "mindmap".into(),
                Value::Array(mindmap.iter().map(MindmapSheet::to_json).collect()),
            );
            o.insert("truncated".into(), truncated.into());
            Ok(Some(Value::Object(o)))
        })(),
        "extract.parseDocBlocksFromText" => (|| {
            let (blocks, truncated) = parse_doc_blocks_from_text(str_arg(args, 0)?);
            let mut o = Map::new();
            o.insert(
                "docBlocks".into(),
                Value::Array(blocks.iter().map(DocBlock::to_json).collect()),
            );
            o.insert("truncated".into(), truncated.into());
            Ok(Some(Value::Object(o)))
        })(),
        "extract.extractEmbeddedThumbnail" => (|| {
            let ext = str_arg(args, 0)?;
            let bytes = unhex(str_arg(args, 1)?)?;
            let engines = SpecEngines { parse: None };
            Ok(Some(
                extract_embedded_thumbnail(&engines, ext, &bytes).map_or(Value::Null, Value::from),
            ))
        })(),
        "extract.extractQuickLook" => (|| {
            let path = str_arg(args, 0)?;
            let engines = SpecEngines {
                parse: arg(args, 1).cloned(),
            };
            Ok(Some(extract_quick_look(&engines, path, None).to_json()))
        })(),
        "doc-list.createDocList" => (|| {
            let spec = arg(args, 0)
                .and_then(Value::as_object)
                .ok_or_else(|| CallError::plain("argument 0 is not an object"))?;
            let deps = SpecDeps::of(spec);
            let asker = spec.get("asker").map(asker_of).unwrap_or_default();
            let options = DocListOptions {
                project_files: spec
                    .get("options")
                    .and_then(|o| o.get("projectFiles"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            let items = doc_list(&deps, &asker, options);
            let mut o = Map::new();
            o.insert("ok".into(), true.into());
            o.insert(
                "items".into(),
                Value::Array(items.iter().map(DocListItem::to_json).collect()),
            );
            Ok(Some(Value::Object(o)))
        })(),
        "doc-list.toMentionItems" => (|| {
            let list = arg(args, 0)
                .and_then(Value::as_array)
                .ok_or_else(|| CallError::plain("argument 0 is not an array"))?;
            let items: Vec<DocListItem> = list.iter().map(item_of).collect();
            Ok(Some(Value::Array(
                to_mention_items(&items)
                    .iter()
                    .map(MentionItem::to_json)
                    .collect(),
            )))
        })(),
        "doc-asker.resolveDocAsker" => (|| {
            let id = arg(args, 0)
                .and_then(Value::as_u64)
                .ok_or_else(|| CallError::plain("argument 0 is not a number"))?
                as u32;
            let spec = arg(args, 1).cloned().unwrap_or(Value::Null);
            Ok(Some(resolve_doc_asker(id, &SpecSources(spec)).to_json()))
        })(),
        _ => return None,
    })
}

fn unhex(text: &str) -> Result<Vec<u8>, CallError> {
    (0..text.len())
        .step_by(2)
        .map(|i| {
            text.get(i..i + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| CallError::plain("bad hex"))
        })
        .collect()
}

/// The engines of the preview: `parse` is the spec of `parseOf` in the group
/// (`{ ok, text, error }`, `{ throws }`, none when it must not run); the zip
/// engine opens nothing
struct SpecEngines {
    parse: Option<Value>,
}

impl QuickLookEngines for SpecEngines {
    fn parse_file_to_text(&self, _path: &str) -> Result<ParsedFile, String> {
        let spec = self
            .parse
            .as_ref()
            .ok_or_else(|| "parse was not expected to run".to_owned())?;
        if let Some(message) = spec.get("throws").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        Ok(ParsedFile {
            ok: spec.get("ok").and_then(Value::as_bool).unwrap_or(true),
            text: spec.get("text").and_then(Value::as_str).map(str::to_owned),
            error: spec.get("error").and_then(Value::as_str).map(str::to_owned),
        })
    }

    fn open_zip(&self, _bytes: &[u8]) -> Option<Box<dyn ZipArchive>> {
        None
    }
}

fn text_of(spec: &Value, key: &str) -> Option<String> {
    spec.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn asker_of(spec: &Value) -> DocAsker {
    DocAsker {
        web_contents_id: spec
            .get("webContentsId")
            .and_then(Value::as_u64)
            .map(|id| id as u32),
        tab_id: text_of(spec, "tabId"),
        path: text_of(spec, "path"),
        pane_tab_id: text_of(spec, "paneTabId"),
    }
}

fn item_of(spec: &Value) -> DocListItem {
    let state = match spec.get("state").and_then(Value::as_str) {
        Some("missing") => DocItemState::Missing,
        Some("unsaved") => DocItemState::Unsaved,
        Some("modified") => DocItemState::Modified,
        _ => DocItemState::Ok,
    };
    let group = match spec.get("group").and_then(Value::as_str) {
        Some("pane") => DocItemGroup::Pane,
        Some("project") => DocItemGroup::Project,
        Some("recent") => DocItemGroup::Recent,
        _ => DocItemGroup::Open,
    };
    DocListItem {
        id: text_of(spec, "id").unwrap_or_default(),
        title: text_of(spec, "title").unwrap_or_default(),
        dir: text_of(spec, "dir").unwrap_or_default(),
        state,
        group,
    }
}

/// `listOf` of the group: the lists and sizes of the spec
struct SpecDeps {
    open: Vec<OpenDocumentEntry>,
    recent: Vec<RecentDocumentEntry>,
    /// the project files; none where the dependency is absent or threw
    project: Vec<ProjectFile>,
    sizes: HashMap<String, f64>,
}

impl SpecDeps {
    fn of(spec: &Map<String, Value>) -> SpecDeps {
        let list = |key: &str| {
            spec.get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let open = list("open")
            .iter()
            .map(|doc| OpenDocumentEntry {
                id: text_of(doc, "id").unwrap_or_default(),
                path: text_of(doc, "path"),
                title: text_of(doc, "title").unwrap_or_default(),
                dirty: doc.get("dirty").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect();
        let recent = list("recent")
            .iter()
            .map(|doc| RecentDocumentEntry {
                path: text_of(doc, "path").unwrap_or_default(),
                title: text_of(doc, "title").unwrap_or_default(),
                missing: doc.get("missing").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect();
        // an object (`{ throws }`) stands for a dependency that threw: no files
        let project = spec
            .get("project")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .map(|file| ProjectFile {
                        path: text_of(file, "path").unwrap_or_default(),
                        title: text_of(file, "title").unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let sizes = spec
            .get("sizes")
            .and_then(Value::as_object)
            .map(|sizes| {
                sizes
                    .iter()
                    .filter_map(|(path, size)| Some((path.clone(), size.as_f64()?)))
                    .collect()
            })
            .unwrap_or_default();
        SpecDeps {
            open,
            recent,
            project,
            sizes,
        }
    }
}

impl DocListDeps for SpecDeps {
    fn open_documents(&self) -> Vec<OpenDocumentEntry> {
        self.open.clone()
    }

    fn recent(&self) -> Vec<RecentDocumentEntry> {
        self.recent.clone()
    }

    fn project_files(&self, _asker: &DocAsker) -> Vec<ProjectFile> {
        self.project.clone()
    }

    fn stat(&self, path: &str) -> Option<f64> {
        self.sizes.get(path).copied()
    }
}

/// `askerOf` of the group: tabs and detached windows by webContents id
struct SpecSources(Value);

impl SpecSources {
    fn hosted(&self, key: &str, id: u32) -> Option<HostedDocument> {
        let doc = self.0.get(key)?.get(id.to_string())?;
        Some(HostedDocument {
            id: text_of(doc, "id")?,
            file_path: text_of(doc, "filePath"),
        })
    }
}

impl DocAskerSources for SpecSources {
    fn tab_for(&self, web_contents_id: u32) -> Option<HostedDocument> {
        self.hosted("tabs", web_contents_id)
    }

    fn split(&self) -> Option<(String, String)> {
        let split = self.0.get("split").filter(|s| !s.is_null())?;
        Some((text_of(split, "aTabId")?, text_of(split, "bTabId")?))
    }

    fn detached_for(&self, web_contents_id: u32) -> Option<HostedDocument> {
        self.hosted("detached", web_contents_id)
    }
}
