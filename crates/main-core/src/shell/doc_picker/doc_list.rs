//! `apps/shell/src/main/doc-picker/doc-list.ts`: the document list the shell
//! hands out, built for the editor that asked. The same list feeds the
//! "Attach a document" window (missing files stay, greyed) and the AI
//! panel's `@` list ([`to_mention_items`], missing files hidden).

use std::collections::HashSet;

use jscompat::node_path::host::{basename, dirname, extname, resolve};
use serde_json::{Map, Value};

use super::asker::DocAsker;
use super::attachable::{
    ATTACHABLE_IMAGE_MAX_BYTES, attachable_max_bytes, diagram_picture_ext_of_name,
    is_attachable_ext_exact, is_image_ext,
};
use super::{DocItemGroup, DocItemState, DocListItem};

/// `OpenDocumentEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct OpenDocumentEntry {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    pub dirty: bool,
}

/// `RecentDocumentEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct RecentDocumentEntry {
    pub path: String,
    pub title: String,
    pub missing: bool,
}

/// One file of the asker's project, newest first
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectFile {
    pub path: String,
    pub title: String,
}

/// `DocListDeps` (the attachable formats are [`super::attachable`])
pub trait DocListDeps {
    fn open_documents(&self) -> Vec<OpenDocumentEntry>;
    fn recent(&self) -> Vec<RecentDocumentEntry>;
    /// The AI-visible files of the asker's project, newest first; empty
    /// without one, and where `projectFiles` threw: the list goes on without
    fn project_files(&self, asker: &DocAsker) -> Vec<ProjectFile>;
    /// the size of the file, or `None` when it is not there
    fn stat(&self, path: &str) -> Option<f64>;
}

/// `DocListOptions`
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DocListOptions {
    /// add the "files of this project" group (the `@` list only)
    pub project_files: bool,
}

/// how the shell compares open paths (`isOpen` in index.ts)
fn path_key(path: &str) -> String {
    resolve(&[path]).to_lowercase()
}

fn ext_of(path: &str) -> String {
    if let Some(picture) = diagram_picture_ext_of_name(&basename(path, None)) {
        return picture.to_owned();
    }
    extname(path).strip_prefix('.').unwrap_or("").to_lowercase()
}

fn cap_for(ext: &str) -> f64 {
    if is_image_ext(ext) {
        ATTACHABLE_IMAGE_MAX_BYTES
    } else {
        attachable_max_bytes(ext)
    }
}

struct Builder<'a> {
    deps: &'a dyn DocListDeps,
    items: Vec<DocListItem>,
    seen: HashSet<String>,
    dirty_keys: HashSet<String>,
    asker_key: Option<String>,
}

impl Builder<'_> {
    /// `include(path, title, group, knownMissing)`
    fn include(&mut self, path: &str, title: &str, group: DocItemGroup, known_missing: bool) {
        let key = path_key(path);
        if self.asker_key.as_deref() == Some(key.as_str()) || self.seen.contains(&key) {
            return;
        }
        let ext = ext_of(path);
        if !is_attachable_ext_exact(&ext) {
            return;
        }
        let size = if known_missing {
            None
        } else {
            self.deps.stat(path)
        };
        if size.is_some_and(|size| size > cap_for(&ext)) {
            return;
        }
        let state = match size {
            None => DocItemState::Missing,
            Some(_) if self.dirty_keys.contains(&key) => DocItemState::Modified,
            Some(_) => DocItemState::Ok,
        };
        self.seen.insert(key);
        let dir = dirname(path);
        self.items.push(DocListItem {
            id: path.to_owned(),
            title: title.to_owned(),
            dir: if dir == "." { String::new() } else { dir },
            state,
            group,
        });
    }

    /// `includeOpen(doc, group)`: a never-saved document is listed as it is,
    /// without a path
    fn include_open(&mut self, doc: &OpenDocumentEntry, group: DocItemGroup) {
        match doc.path.as_deref().filter(|p| !p.is_empty()) {
            None => self.items.push(DocListItem {
                id: format!("unsaved:{}", doc.id),
                title: doc.title.clone(),
                dir: String::new(),
                state: DocItemState::Unsaved,
                group,
            }),
            Some(path) => self.include(path, &doc.title, group, false),
        }
    }
}

/// `createDocList(deps)(asker, options)`: the items of `{ ok: true, items }`
pub fn doc_list(
    deps: &dyn DocListDeps,
    asker: &DocAsker,
    options: DocListOptions,
) -> Vec<DocListItem> {
    let open = deps.open_documents();
    // a path with unsaved changes in any open copy is not the saved file
    let dirty_keys = open
        .iter()
        .filter(|doc| doc.dirty)
        .filter_map(|doc| doc.path.as_deref().filter(|p| !p.is_empty()))
        .map(path_key)
        .collect();
    let mut list = Builder {
        deps,
        items: Vec::new(),
        seen: HashSet::new(),
        dirty_keys,
        asker_key: asker
            .path
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(path_key),
    };

    let others: Vec<&OpenDocumentEntry> = open
        .iter()
        .filter(|doc| Some(&doc.id) != asker.tab_id.as_ref())
        .collect();
    let pane = asker
        .pane_tab_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| others.iter().position(|doc| doc.id == id));
    if let Some(index) = pane {
        list.include_open(others[index], DocItemGroup::Pane);
    }
    for (index, doc) in others.iter().enumerate() {
        if Some(index) != pane {
            list.include_open(doc, DocItemGroup::Open);
        }
    }

    if options.project_files {
        let files = deps.project_files(asker);
        for file in &files {
            list.include(&file.path, &file.title, DocItemGroup::Project, false);
        }
    }

    for doc in deps.recent() {
        list.include(&doc.path, &doc.title, DocItemGroup::Recent, doc.missing);
    }
    list.items
}

/// `DocMentionItem` of `@seuoffice/electron-utils/doc-attach-bridge`
#[derive(Debug, Clone, PartialEq)]
pub struct MentionItem {
    /// `None` for a document never saved
    pub path: Option<String>,
    pub name: String,
    pub dir: String,
    pub group: DocItemGroup,
    pub state: DocItemState,
}

impl MentionItem {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert(
            "path".into(),
            self.path.clone().map_or(Value::Null, Value::from),
        );
        o.insert("name".into(), self.name.clone().into());
        o.insert("dir".into(), self.dir.clone().into());
        o.insert("group".into(), self.group.as_str().into());
        o.insert("state".into(), self.state.as_str().into());
        Value::Object(o)
    }
}

/// `toMentionItems(items)`: a saved document is named by its file name, a
/// never-saved one by its tab title (no path); missing files are left out
pub fn to_mention_items(items: &[DocListItem]) -> Vec<MentionItem> {
    items
        .iter()
        .filter(|item| item.state != DocItemState::Missing)
        .map(|item| {
            let unsaved = item.state == DocItemState::Unsaved;
            MentionItem {
                path: (!unsaved).then(|| item.id.clone()),
                name: if unsaved {
                    item.title.clone()
                } else {
                    basename(&item.id, None)
                },
                dir: item.dir.clone(),
                group: item.group,
                state: item.state,
            }
        })
        .collect()
}
