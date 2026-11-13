//! The probe fakes of the `knowledge_base` port's batch hosts: what the shell
//! entry reaches for the `kb:*` channels beyond main-core (the file index, the
//! text parser, the project folder, the new-document placer, the bundled CLI,
//! the recent list), answering from the case's `hosts.a.kb`. Each call is one
//! line of the host log, named after the TypeScript call it stands for;
//! `groups/a/knowledge-base.ts` makes the TypeScript side answer and log the
//! same.
//!
//! `hosts.a.kb`:
//!
//! | key              | shape                                                                                              |
//! | ---------------- | -------------------------------------------------------------------------------------------------- |
//! | `index`          | `{hits: [{path, name, ext, snippet?: [text]}], stale: [path]}`; absent: no file index                |
//! | `unsaved`        | paths open with unsaved changes                                                                    |
//! | `maxBytes`       | `{"<ext>": bytes or null}` (`null`: no cap); other formats 20 MB                                    |
//! | `parsed`         | `[{path, ok, kind, text, error}]` the parser's answer; a path left out is `{ok: false}`             |
//! | `projects`       | `{"<id>": {available, visible: [path prefix] or absent (null), read: [{path, ...ProjectReadResult}]}}` |
//! | `placement`      | `{projectId, root, dir}`, `{error}` for a throw, or absent (no project)                             |
//! | `writeError`     | the project folder's write guard refuses with this message                                        |
//! | `defaultSaveDir` | the folder, or `{error}`; absent throws                                                            |
//! | `docxError`      | the CLI fails with this message                                                                    |

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use jscompat::node_path::host::{dirname, join};
use serde_json::{Value, json};
use shell_contract::ViewId;

use super::{Log, push};
use crate::knowledge_base::{
    IndexHit, KbScopeIds, KbServices, KbServicesHost, Placement, ProjectRead, ProjectReadRefusal,
    VisibleTest,
};

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    hosts.insert(crate::knowledge_base::factory());
    let host: KbServicesHost = Arc::new(FakeKb {
        case: case["kb"].clone(),
        log,
    });
    hosts.insert(host);
    // the TypeScript side of the group names scopes the same way
    let minted = AtomicUsize::new(0);
    let ids: KbScopeIds =
        Arc::new(move || format!("scope-{}", minted.fetch_add(1, Ordering::SeqCst) + 1));
    hosts.insert(ids);
}

struct FakeKb {
    case: Value,
    log: Option<Log>,
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// A JavaScript number as the log writes it: whole numbers without a fraction
fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `ext` as `attachableMaxBytes` reads it: without the dot, lower case
fn clean_ext(ext: &str) -> String {
    ext.strip_prefix('.').unwrap_or(ext).to_lowercase()
}

/// The conversion's temporary folder is named at random
fn out_name(out: &str) -> String {
    const MARK: &str = "/seuoffice-kb-docx-";
    match out.find(MARK) {
        Some(at) => {
            let from = at + MARK.len();
            let end = out[from..].find('/').map_or(out.len(), |n| from + n);
            format!("{}{MARK}X{}", &out[..at], &out[end..])
        }
        None => out.to_owned(),
    }
}

impl FakeKb {
    fn log(&self, line: Value) {
        push(&self.log, line);
    }

    fn index(&self) -> &Value {
        &self.case["index"]
    }

    fn project(&self, id: &str) -> &Value {
        &self.case["projects"][id]
    }

    /// The entry of a list of `{path, ...}` objects (the case's tables by path)
    fn entry<'a>(&self, list: &'a Value, path: &str) -> Option<&'a Value> {
        list.as_array()?
            .iter()
            .find(|entry| entry["path"].as_str() == Some(path))
    }
}

impl KbServices for FakeKb {
    fn has_file_index(&self) -> bool {
        !self.index().is_null()
    }

    fn refresh_file_index_if_stale(&self, max_age_ms: u64) {
        self.log(json!(["fileIndexer.refreshIfStale", max_age_ms]));
    }

    fn paths_indexed_as_on_disk(&self, paths: &[String]) -> Vec<String> {
        self.log(json!(["fileIndexStore.pathsIndexedAsOnDisk", paths]));
        let stale = strings(&self.index()["stale"]);
        paths
            .iter()
            .filter(|path| !stale.contains(path))
            .cloned()
            .collect()
    }

    fn index_search(
        &self,
        q: &str,
        limit: usize,
        within: Option<&dyn Fn(&str) -> bool>,
    ) -> Vec<IndexHit> {
        self.log(json!(["fileIndexStore.search", q, limit, within.is_some()]));
        self.index()["hits"]
            .as_array()
            .map(|hits| {
                hits.iter()
                    .filter_map(|hit| {
                        let path = hit["path"].as_str()?;
                        within.is_none_or(|test| test(path)).then(|| IndexHit {
                            path: path.to_owned(),
                            name: hit["name"].as_str().unwrap_or_default().to_owned(),
                            ext: hit["ext"].as_str().unwrap_or_default().to_owned(),
                            snippet_text: strings(&hit["snippet"]).concat(),
                        })
                    })
                    .take(limit)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn without_unsaved_files(&self, paths: &[String]) -> Vec<String> {
        self.log(json!(["withoutUnsavedFiles", paths]));
        let unsaved = strings(&self.case["unsaved"]);
        paths
            .iter()
            .filter(|path| !unsaved.contains(path))
            .cloned()
            .collect()
    }

    fn attachable_max_bytes(&self, ext: &str) -> f64 {
        self.log(json!(["attachableMaxBytes", ext]));
        match self.case["maxBytes"].get(clean_ext(ext).as_str()) {
            Some(Value::Null) => f64::INFINITY,
            Some(bytes) => bytes.as_f64().unwrap_or(f64::NAN),
            None => 20.0 * 1024.0 * 1024.0,
        }
    }

    fn parse_file_to_text(&self, path: &str) -> Result<String, Option<String>> {
        self.log(json!(["parseFileToText", path]));
        let none = Value::Null;
        let parsed = self.entry(&self.case["parsed"], path).unwrap_or(&none);
        let text = parsed["text"].as_str();
        if parsed["ok"].as_bool() == Some(true) && parsed["kind"].as_str() == Some("text") {
            if let Some(text) = text {
                return Ok(text.to_owned());
            }
        }
        Err(parsed["error"].as_str().map(str::to_owned))
    }

    fn project_available(&self, project_id: &str) -> bool {
        self.log(json!(["projectFolderTools.isAvailable", project_id]));
        self.project(project_id)["available"].as_bool() == Some(true)
    }

    fn project_visible_test(&self, project_id: &str) -> Option<VisibleTest> {
        self.log(json!(["projectFolderTools.visibleTest", project_id]));
        let prefixes = strings(&self.project(project_id)["visible"]);
        self.project(project_id)["visible"].is_array().then(|| {
            let test: VisibleTest =
                Arc::new(move |path| prefixes.iter().any(|prefix| path.starts_with(prefix)));
            test
        })
    }

    fn project_read(
        &self,
        owner: ViewId,
        project_id: &str,
        path: &str,
        offset: f64,
    ) -> ProjectRead {
        self.log(json!([
            "projectFolderTools.readPath",
            owner.0,
            project_id,
            path,
            number(offset)
        ]));
        let none = Value::Null;
        let read = self
            .entry(&self.project(project_id)["read"], path)
            .unwrap_or(&none);
        match read["status"].as_str() {
            Some("ok") => ProjectRead::Ok {
                text: read["text"].as_str().unwrap_or_default().to_owned(),
                total_chars: read["totalChars"].as_f64().unwrap_or(f64::NAN),
                offset: read["offset"].as_f64().unwrap_or(f64::NAN),
            },
            Some("declined") => ProjectRead::Declined,
            Some("refused") => ProjectRead::Refused(match read["reason"].as_str() {
                Some("hidden") => ProjectReadRefusal::Hidden,
                Some("ignored") => ProjectReadRefusal::Ignored,
                Some("not-found") => ProjectReadRefusal::NotFound,
                Some("unsaved") => ProjectReadRefusal::Unsaved,
                Some("too-large") => ProjectReadRefusal::TooLarge,
                Some("unreadable") => ProjectReadRefusal::Unreadable,
                _ => ProjectReadRefusal::Outside,
            }),
            _ => ProjectRead::Refused(ProjectReadRefusal::Outside),
        }
    }

    fn new_document_placement(&self, owner: ViewId) -> Result<Option<Placement>, String> {
        self.log(json!(["newDocuments.placementFor", owner.0]));
        let placement = &self.case["placement"];
        if let Some(message) = placement["error"].as_str() {
            return Err(message.to_owned());
        }
        if !placement.is_object() {
            return Ok(None);
        }
        let text = |key: &str| placement[key].as_str().unwrap_or_default().to_owned();
        Ok(Some(Placement {
            project_id: text("projectId"),
            root: text("root"),
            dir: text("dir"),
        }))
    }

    fn write_project_document(
        &self,
        placement: &Placement,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        self.log(json!([
            "newDocuments.write",
            placement.project_id,
            placement.root,
            placement.dir,
            file_name,
            String::from_utf8_lossy(&bytes)
        ]));
        if let Some(message) = self.case["writeError"].as_str() {
            return Err(message.to_owned());
        }
        let path = join(&[placement.dir.as_str(), file_name]);
        fs::create_dir_all(&placement.dir).map_err(|e| e.to_string())?;
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path)
    }

    fn default_save_dir(&self) -> Result<String, String> {
        self.log(json!(["defaultSaveDir"]));
        let dir = &self.case["defaultSaveDir"];
        match (dir.as_str(), dir["error"].as_str()) {
            (Some(dir), _) => Ok(dir.to_owned()),
            (None, Some(message)) => Err(message.to_owned()),
            (None, None) => Err("no default save folder".to_owned()),
        }
    }

    fn markdown_to_docx(&self, markdown: &str, out: &str) -> Result<(), String> {
        self.log(json!([
            "createFileViaCli",
            "docx",
            "content.md",
            markdown,
            out_name(out)
        ]));
        if let Some(message) = self.case["docxError"].as_str() {
            return Err(message.to_owned());
        }
        fs::create_dir_all(Path::new(&dirname(out))).map_err(|e| e.to_string())?;
        fs::write(out, format!("DOCX:{markdown}")).map_err(|e| e.to_string())
    }

    fn record_recent_file(&self, path: &str) {
        self.log(json!(["recordRecentFile", path]));
    }
}
