//! `apps/shell/src/main/doc-picker/doc-asker.ts`: which editor is asking for
//! the document list, read from the webContents that sent the request.

use serde_json::{Map, Value};

/// `DocAsker`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocAsker {
    /// the asking webContents (the shell adds it; the panel's project is read from it)
    pub web_contents_id: Option<u32>,
    /// the asking tab's id (`detached:<wcId>` for a detached window)
    pub tab_id: Option<String>,
    /// the asking document's saved path
    pub path: Option<String>,
    /// the tab shown in the other split pane
    pub pane_tab_id: Option<String>,
}

impl DocAsker {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        if let Some(id) = &self.tab_id {
            o.insert("tabId".into(), id.clone().into());
        }
        if let Some(path) = &self.path {
            o.insert("path".into(), path.clone().into());
        }
        if let Some(id) = &self.pane_tab_id {
            o.insert("paneTabId".into(), id.clone().into());
        }
        if let Some(id) = self.web_contents_id {
            o.insert("webContentsId".into(), id.into());
        }
        Value::Object(o)
    }
}

/// A tab or detached window hosting a webContents: its id and saved path
#[derive(Debug, Clone, PartialEq)]
pub struct HostedDocument {
    pub id: String,
    pub file_path: Option<String>,
}

/// `DocAskerSources`
pub trait DocAskerSources {
    /// the in-window tab hosting this webContents
    fn tab_for(&self, web_contents_id: u32) -> Option<HostedDocument>;
    /// the live split's two tab ids, or none when the view is not split
    fn split(&self) -> Option<(String, String)>;
    /// the detached window hosting this webContents
    fn detached_for(&self, web_contents_id: u32) -> Option<HostedDocument>;
}

/// `resolveDocAsker(webContentsId, sources)`
pub fn resolve_doc_asker(web_contents_id: u32, sources: &dyn DocAskerSources) -> DocAsker {
    let path_of = |doc: &HostedDocument| doc.file_path.clone().filter(|p| !p.is_empty());
    if let Some(tab) = sources.tab_for(web_contents_id) {
        let pane_tab_id = sources.split().and_then(|(a, b)| {
            if a == tab.id {
                Some(b)
            } else if b == tab.id {
                Some(a)
            } else {
                None
            }
        });
        return DocAsker {
            web_contents_id: None,
            path: path_of(&tab),
            pane_tab_id: pane_tab_id.filter(|id| !id.is_empty()),
            tab_id: Some(tab.id),
        };
    }
    if let Some(detached) = sources.detached_for(web_contents_id) {
        return DocAsker {
            web_contents_id: None,
            path: path_of(&detached),
            pane_tab_id: None,
            tab_id: Some(detached.id),
        };
    }
    DocAsker::default()
}
