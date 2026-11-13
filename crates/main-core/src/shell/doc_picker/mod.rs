//! `apps/shell/src/main/doc-picker/` (`doc-asker.ts`, `doc-list.ts`, and the
//! state logic of `doc-picker-window.ts`) with the shapes of
//! `apps/shell/src/shared/doc-picker-api.ts`. The window itself (Electron's
//! `BrowserWindow`) is the shell's; what decides which documents the picker
//! lists and which ids it hands back is here.

pub mod asker;
pub mod attachable;
pub mod doc_list;
pub mod picker;

use serde_json::{Map, Value};

/// `DocItemGroup`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocItemGroup {
    /// the document in the other split pane
    Pane,
    /// an open tab
    Open,
    /// the asker's project
    Project,
    /// the recent list
    Recent,
}

impl DocItemGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            DocItemGroup::Pane => "pane",
            DocItemGroup::Open => "open",
            DocItemGroup::Project => "project",
            DocItemGroup::Recent => "recent",
        }
    }
}

/// `DocItemState`: only `Ok` can be picked
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocItemState {
    Ok,
    Missing,
    Unsaved,
    Modified,
}

impl DocItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            DocItemState::Ok => "ok",
            DocItemState::Missing => "missing",
            DocItemState::Unsaved => "unsaved",
            DocItemState::Modified => "modified",
        }
    }
}

/// `DocListItem`
#[derive(Debug, Clone, PartialEq)]
pub struct DocListItem {
    /// the saved path, or `unsaved:<tab id>`
    pub id: String,
    pub title: String,
    /// the folder, for display; `""` when none
    pub dir: String,
    pub state: DocItemState,
    pub group: DocItemGroup,
}

impl DocListItem {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("id".into(), self.id.clone().into());
        o.insert("title".into(), self.title.clone().into());
        o.insert("dir".into(), self.dir.clone().into());
        o.insert("state".into(), self.state.as_str().into());
        o.insert("group".into(), self.group.as_str().into());
        Value::Object(o)
    }
}
