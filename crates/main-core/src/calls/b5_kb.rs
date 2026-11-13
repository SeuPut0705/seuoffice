//! Group `b5-kb` (tools/main-diff/groups/b5-kb.ts): `apps/shell/src/main/
//! knowledge-base.ts`. `KB_READ_MAX_BYTES` and `kbReadMaxBytes` are answered
//! by `b3_projects::files`.
//!
//! The stand-ins are those the TypeScript spec describes: the parser by the
//! extension of the path, the open-files source by the case (each question a
//! `["openFiles"]` log line), the index, the project and the create
//! dependencies scripted by the case. A scenario keeps its text cache, scopes
//! and holder in locals of the call, as the TypeScript loads a fresh copy of
//! the module for each case. A `null` where a number is read is `NaN` (the
//! TypeScript's `NaN` is `null` in JSON).

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::node_path::host::{extname, join};
use jscompat::{JsMap, JsonValue, json_value_from_serde, json_value_to_serde, trim};
use serde_json::{Map, Number, Value, json};

use super::{Answer, CallError, Context, arg};
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSource, OpenFilesSourceFailed,
};
use crate::packages::project_store::ProjectReadResult;
use crate::shell::generate::materials::{FileParser, ParsedFile};
use crate::shell::knowledge_base::{
    IndexedHit, KB_CREATE_MAX_CHARS, KB_DOWNLOAD_DECLINED, KB_GROUP_EMPTY, KB_NOT_IN_BASE,
    KB_READ_CHUNK_CHARS, KB_SCOPE_UNKNOWN, KB_SCOPES_MAX, KbCreateDeps, KbCreateFormat,
    KbCreateProject, KbCreateRequest, KbReadProject, KbRunScopes, KbStarredReach, KbTextCache,
    KbWithin, create_knowledge_document, list_knowledge_files, parse_kb_create_request,
    parse_kb_open_scope, read_knowledge_file_page, read_knowledge_file_text,
    read_knowledge_or_project_page, search_knowledge_base, search_saved_knowledge_base,
    search_saved_knowledge_with_project,
};
use crate::shell::projects::project_tools::ProjectToolsScopes;
use crate::shell::renderer_disposal::Failure;

type Logs = Rc<RefCell<Vec<Vec<Value>>>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "knowledge-base.KB_READ_CHUNK_CHARS" => Ok(Some(num(KB_READ_CHUNK_CHARS))),
        "knowledge-base.KB_NOT_IN_BASE" => Ok(Some(Value::from(KB_NOT_IN_BASE))),
        "knowledge-base.KB_SCOPE_UNKNOWN" => Ok(Some(Value::from(KB_SCOPE_UNKNOWN))),
        "knowledge-base.KB_GROUP_EMPTY" => Ok(Some(Value::from(KB_GROUP_EMPTY))),
        "knowledge-base.KB_DOWNLOAD_DECLINED" => Ok(Some(Value::from(KB_DOWNLOAD_DECLINED))),
        "knowledge-base.KB_CREATE_MAX_CHARS" => Ok(Some(num(KB_CREATE_MAX_CHARS))),
        "knowledge-base.listKnowledgeFiles" => {
            string_list(arg(args, 0)).and_then(|paths| print(&list_knowledge_files(&paths)))
        }
        "knowledge-base.searchKnowledgeBase" => search_call(Search::Plain, args, cx),
        "knowledge-base.searchSavedKnowledgeBase" => search_call(Search::Saved, args, cx),
        "knowledge-base.searchSavedKnowledgeWithProject" => {
            search_call(Search::WithProject, args, cx)
        }
        "knowledge-base.readKnowledgeFileText" => reads_call(Read::Text, args, cx),
        "knowledge-base.readKnowledgeFilePage" => reads_call(Read::Page, args, cx),
        "knowledge-base.readKnowledgeOrProjectPage" => reads_call(Read::OrProject, args, cx),
        "knowledge-base.KbRunScopes" => scopes_call(args, cx),
        "knowledge-base.parseKbOpenScope" => open_scope_call(args),
        "knowledge-base.parseKbCreateRequest" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            parse_kb_create_request(raw.as_ref())
                .map_err(thrown)
                .and_then(|request| print(&request))
        }
        "knowledge-base.createKnowledgeDocument" => create_call(args, cx),
        _ => return None,
    })
}

// ---- helpers ----

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

/// a number as the comparison prints it: a non-finite one is `null`
fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn print<T: serde::Serialize>(value: &T) -> Answer {
    Ok(Some(serde_json::to_value(value).expect("an answer prints")))
}

fn thrown(error: Thrown) -> CallError {
    CallError::plain(error.0)
}

fn log(logs: &Logs, line: Vec<Value>) {
    logs.borrow_mut().push(line);
}

/// a number of a case; `null` (the TypeScript's `NaN`) and anything else is `NaN`
fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `{ ok }` of a result, `{ error }` of a refusal
fn settle(result: Result<Value, Thrown>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error.0 }),
    }
}

/// `[[path, group], ...]` as the `Map` of a case
fn pairs(value: Option<&Value>) -> JsMap<String> {
    let mut out = JsMap::new();
    for pair in value.and_then(Value::as_array).into_iter().flatten() {
        if let (Some(key), Some(group)) = (
            pair.get(0).and_then(Value::as_str),
            pair.get(1).and_then(Value::as_str),
        ) {
            out.set(key, group.to_owned());
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_at(path: &str, data: &[u8]) -> Result<(), Thrown> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|error| Thrown(error.to_string()))?;
    }
    fs::write(path, data).map_err(|error| Thrown(error.to_string()))
}

// ---- the open files and the parser ----

/// `open`: none, `"throws"`, or the paths open with unsaved changes; each
/// question is one `["openFiles"]` log line
fn set_open(holder: &mut OpenFilesHolder, spec: Option<&Value>, logs: &Logs) {
    let source: Option<OpenFilesSource> = match spec {
        None | Some(Value::Null) => None,
        Some(Value::String(_)) => {
            let logs = Rc::clone(logs);
            Some(Box::new(move || {
                log(&logs, vec![Value::from("openFiles")]);
                Err(OpenFilesSourceFailed)
            }))
        }
        Some(Value::Array(paths)) => {
            let paths: Vec<String> = paths
                .iter()
                .filter_map(|path| path.as_str().map(str::to_owned))
                .collect();
            let logs = Rc::clone(logs);
            Some(Box::new(move || {
                log(&logs, vec![Value::from("openFiles")]);
                Ok(paths
                    .iter()
                    .map(|path| OpenFileState {
                        file_path: Some(path.clone()),
                        dirty: true,
                    })
                    .collect())
            }))
        }
        Some(_) => None,
    };
    holder.set_open_files_source(source);
}

/// `parseFileToText` by the extension of the path (see the spec)
struct FakeParser {
    logs: Logs,
}

impl FileParser for FakeParser {
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        log(&self.logs, vec![Value::from("parse"), Value::from(path)]);
        let parsed = |ok: bool, error: Option<&str>, kind: Option<&str>, text: Option<&str>| {
            Ok(ParsedFile {
                ok,
                error: error.map(str::to_owned),
                kind: kind.map(str::to_owned),
                text: text.map(str::to_owned),
            })
        };
        match extname(path).as_str() {
            ".txt" | ".md" => {
                let bytes = fs::read(path).map_err(|error| Failure(error.to_string()))?;
                parsed(
                    true,
                    None,
                    Some("text"),
                    Some(&String::from_utf8_lossy(&bytes)),
                )
            }
            ".png" => parsed(true, None, Some("image"), None),
            ".empty" => parsed(true, None, Some("text"), None),
            ".kindless" => parsed(true, None, None, Some("x")),
            ".bad" => parsed(false, Some("broken file"), None, None),
            ".mute" => parsed(false, None, None, None),
            ".badtext" => parsed(false, Some("bad but text"), Some("text"), Some("zzz")),
            ".boom" => Err(Failure("parser crashed".to_owned())),
            _ => parsed(false, Some("unsupported"), None, None),
        }
    }
}

// ---- the reads ----

#[derive(Clone, Copy)]
enum Read {
    Text,
    Page,
    OrProject,
}

/// `[ops]` over one text cache and one open-files holder
fn reads_call(kind: Read, args: &[Value], cx: &mut Context) -> Answer {
    let ops = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let logs: Logs = Rc::default();
    let mut holder = OpenFilesHolder::new();
    let mut cache = KbTextCache::new();
    let mut parser = FakeParser {
        logs: Rc::clone(&logs),
    };
    let mut out = Vec::new();
    for op in ops {
        if let Some(spec) = op.get("open") {
            set_open(&mut holder, Some(spec), &logs);
            out.push(Value::Null);
        } else if let Some(path) = text(op, "write") {
            write_at(path, text(op, "text").unwrap_or("").as_bytes()).map_err(thrown)?;
            if let Some(ms) = op.get("mtimeMs").and_then(Value::as_f64) {
                let file = fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .map_err(|error| CallError::plain(error.to_string()))?;
                file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64))
                    .map_err(|error| CallError::plain(error.to_string()))?;
            }
            out.push(Value::Null);
        } else if let Some(path) = text(op, "grow") {
            let file =
                fs::File::create(path).map_err(|error| CallError::plain(error.to_string()))?;
            let size = op.get("size").and_then(Value::as_u64).unwrap_or(0);
            file.set_len(size)
                .map_err(|error| CallError::plain(error.to_string()))?;
            out.push(Value::Null);
        } else if let Some(path) = text(op, "remove") {
            let _ = fs::remove_file(path);
            out.push(Value::Null);
        } else {
            let path = text(op, "read").ok_or_else(|| bad("a read"))?;
            let offset = match op.get("offset") {
                None => 0.0,
                Some(value) => number(Some(value)),
            };
            let result = match kind {
                Read::Text => read_knowledge_file_text(&holder, &mut cache, &mut parser, path)
                    .map(|text| Value::from(&*text)),
                Read::Page => {
                    read_knowledge_file_page(&holder, &mut cache, &mut parser, path, offset)
                        .map(|page| serde_json::to_value(page).expect("a page prints"))
                }
                Read::OrProject => {
                    let project = op.get("project").filter(|project| !project.is_null());
                    let project_logs = Rc::clone(&logs);
                    let mut read_project =
                        |given: &str, at: f64| -> Result<ProjectReadResult, Thrown> {
                            log(
                                &project_logs,
                                vec![Value::from("readProject"), Value::from(given), num(at)],
                            );
                            let project = project.ok_or_else(|| Thrown("no project".to_owned()))?;
                            if let Some(message) = text(project, "throws") {
                                return Err(Thrown(message.to_owned()));
                            }
                            let result = project.get("result").cloned().unwrap_or(Value::Null);
                            serde_json::from_value::<ProjectReadResult>(result)
                                .map_err(|error| Thrown(error.to_string()))
                        };
                    let starred = op.get("starred").and_then(Value::as_bool).unwrap_or(false);
                    let project_arg: KbReadProject<'_> = if project.is_some() {
                        Some(&mut read_project)
                    } else {
                        None
                    };
                    read_knowledge_or_project_page(
                        &holder,
                        &mut cache,
                        &mut parser,
                        path,
                        offset,
                        starred,
                        project_arg,
                    )
                    .map(|page| serde_json::to_value(page).expect("a page prints"))
                }
            };
            out.push(settle(result));
        }
    }
    cx.logs.extend(logs.take());
    Ok(Some(Value::Array(out)))
}

// ---- the scopes ----

fn owner_of(op: &[Value]) -> Result<i64, CallError> {
    op.first()
        .and_then(Value::as_i64)
        .ok_or_else(|| bad("an owner"))
}

fn json_at(op: &[Value], at: usize) -> JsonValue {
    op.get(at).map_or(JsonValue::Null, json_value_from_serde)
}

/// `[cfg, ops]`
fn scopes_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("a config"))?;
    let ops = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    let logs: Logs = Rc::default();
    let mut scopes = if cfg.get("defaultIds").and_then(Value::as_bool) == Some(true) {
        KbRunScopes::default()
    } else {
        let mut made = 0_u32;
        KbRunScopes::new(
            Box::new(move || {
                made += 1;
                format!("scope-{made}")
            }),
            cfg.get("max")
                .and_then(Value::as_f64)
                .unwrap_or(KB_SCOPES_MAX),
        )
    };
    let mut defaults: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for op in ops {
        let list = |key: &str| op.get(key).and_then(Value::as_array);
        let result: Result<Value, Thrown> = if let Some(given) = list("open") {
            let group = json_at(given, 1);
            scopes
                .open(owner_of(given)?, Some(&group), &pairs(given.get(2)))
                .map(Value::from)
        } else if let Some(given) = list("openProject") {
            let project = given.get(1).and_then(Value::as_str).unwrap_or("");
            let starred = match given.get(2) {
                Some(Value::String(word)) if word == "all" => KbStarredReach::All,
                Some(Value::Object(object)) => KbStarredReach::Group(
                    object
                        .get("group")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                ),
                _ => KbStarredReach::None,
            };
            scopes
                .open_project(owner_of(given)?, project, starred, &pairs(given.get(3)))
                .map(Value::from)
        } else if let Some(given) = list("toolsOpen") {
            let project = given.get(1).and_then(Value::as_str).unwrap_or("");
            Ok(Value::from(ProjectToolsScopes::open_project(
                &mut scopes,
                owner_of(given)?,
                project,
            )))
        } else if let Some(given) = list("close") {
            scopes.close(owner_of(given)?, Some(&json_at(given, 1)));
            Ok(Value::Null)
        } else if let Some(given) = list("narrow") {
            let raw = json_at(given, 1);
            let paths = string_list(given.get(2))?;
            let groups = pairs(given.get(3));
            let groups_logs = Rc::clone(&logs);
            scopes
                .narrow(owner_of(given)?, Some(&raw), &paths, || {
                    log(&groups_logs, vec![Value::from("groups")]);
                    groups
                })
                .map(|paths| json!(paths))
        } else if let Some(given) = list("projectOf") {
            scopes
                .project_of(owner_of(given)?, Some(&json_at(given, 1)))
                .map(|project| project.map_or(Value::Null, Value::from))
        } else if let Some(given) = list("openDefault") {
            let group = json_at(given, 1);
            scopes
                .open(owner_of(given)?, Some(&group), &pairs(given.get(2)))
                .map(|id| {
                    let shape = json!({
                        "length": id.chars().count(),
                        "hex": !id.is_empty()
                            && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                    });
                    defaults.push(id);
                    shape
                })
        } else if op.get("distinct").is_some() {
            let mut unique = defaults.clone();
            unique.sort();
            unique.dedup();
            Ok(Value::Bool(unique.len() == defaults.len()))
        } else {
            return Err(bad("an op"));
        };
        out.push(settle(result));
    }
    cx.logs.extend(logs.take());
    Ok(Some(Value::Array(out)))
}

fn open_scope_call(args: &[Value]) -> Answer {
    let raw = arg(args, 0).map(json_value_from_serde);
    let parsed = parse_kb_open_scope(raw.as_ref());
    let mut out = Map::new();
    if let Some(group) = &parsed.group {
        out.insert("group".to_owned(), json_value_to_serde(group));
    }
    out.insert(
        "projectId".to_owned(),
        parsed.project_id.map_or(Value::Null, Value::from),
    );
    Ok(Some(Value::Object(out)))
}

// ---- the search ----

#[derive(Clone, Copy)]
enum Search {
    Plain,
    Saved,
    WithProject,
}

fn rows_of(cfg: &Value) -> Vec<IndexedHit> {
    cfg.get("rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|row| IndexedHit {
            path: text(row, "path").unwrap_or("").to_owned(),
            name: text(row, "name").unwrap_or("").to_owned(),
            ext: text(row, "ext").unwrap_or("").to_owned(),
            snippet_text: text(row, "snippetText").map(str::to_owned),
        })
        .collect()
}

/// `[cfg, query, starred, limit]`
fn search_call(kind: Search, args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("a config"))?;
    let query = text_arg(args, 1)?;
    let starred = string_list(arg(args, 2))?;
    let limit = number(arg(args, 3));
    let rows = rows_of(cfg);
    let fail = text(cfg, "fail").map(str::to_owned);
    let logs: Logs = Rc::default();
    let mut holder = OpenFilesHolder::new();
    set_open(&mut holder, cfg.get("open"), &logs);

    let search_logs = Rc::clone(&logs);
    let mut search = |q: &str, n: f64, within: KbWithin<'_>| -> Result<Vec<IndexedHit>, Thrown> {
        log(
            &search_logs,
            vec![
                Value::from("search"),
                Value::from(q),
                num(n),
                Value::from(if within.is_none() { "plain" } else { "within" }),
            ],
        );
        if let Some(message) = &fail {
            return Err(Thrown(message.clone()));
        }
        let mut within = within;
        let mut kept = Vec::new();
        for hit in &rows {
            if let Some(within) = within.as_deref_mut()
                && !within(&hit.path)?
            {
                continue;
            }
            kept.push(hit.clone());
        }
        kept.truncate(n as usize);
        Ok(kept)
    };

    let result = match kind {
        Search::Plain => search_knowledge_base(
            &mut |q: &str, n: f64| search(q, n, None),
            query,
            &starred,
            limit,
        ),
        Search::Saved => search_saved_knowledge_base(
            &holder,
            &mut |q: &str, n: f64| search(q, n, None),
            query,
            &starred,
            limit,
        ),
        Search::WithProject => {
            let within_cfg = cfg.get("within").filter(|within| !within.is_null());
            let visible: Vec<String> = within_cfg
                .and_then(|within| within.get("visible"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|path| path.as_str().map(str::to_owned))
                .collect();
            let fail_on = within_cfg
                .and_then(|within| text(within, "failOn"))
                .map(str::to_owned);
            let within_logs = Rc::clone(&logs);
            let mut within = |path: &str| -> Result<bool, Thrown> {
                log(&within_logs, vec![Value::from("within"), Value::from(path)]);
                if fail_on.as_deref() == Some(path) {
                    return Err(Thrown("within failed".to_owned()));
                }
                Ok(visible.iter().any(|seen| seen == path))
            };
            let indexed: Vec<String> = string_list(cfg.get("indexed")).unwrap_or_default();
            let indexed_logs = Rc::clone(&logs);
            let mut indexed_as_on_disk = |paths: &[String]| -> Vec<String> {
                log(&indexed_logs, vec![Value::from("indexed"), json!(paths)]);
                paths
                    .iter()
                    .filter(|path| indexed.contains(path))
                    .cloned()
                    .collect()
            };
            search_saved_knowledge_with_project(
                &holder,
                &mut search,
                query,
                &starred,
                limit,
                within_cfg.map(|_| &mut within as &mut dyn FnMut(&str) -> Result<bool, Thrown>),
                &mut indexed_as_on_disk,
            )
        }
    };
    cx.logs.extend(logs.take());
    result.map_err(thrown).and_then(|hits| print(&hits))
}

fn text_arg(args: &[Value], at: usize) -> Result<&str, CallError> {
    args.get(at)
        .and_then(Value::as_str)
        .ok_or_else(|| bad("a string"))
}

// ---- create_document ----

/// the file name the free-name dependencies give a taken name: `-2` before
/// the extension
fn taken_name(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) => format!("{}-2{}", &name[..dot], &name[dot..]),
        None => name.to_owned(),
    }
}

fn failure(cfg: &Value, key: &str) -> Result<(), Thrown> {
    match text(cfg, key) {
        Some(message) => Err(Thrown(message.to_owned())),
        None => Ok(()),
    }
}

struct FakeProject {
    cfg: Value,
    root: String,
    logs: Logs,
}

impl KbCreateProject for FakeProject {
    fn write(&mut self, file_name: &str, bytes: &[u8]) -> Result<String, Thrown> {
        log(
            &self.logs,
            vec![
                Value::from("project.write"),
                Value::from(file_name),
                Value::from(hex(bytes)),
            ],
        );
        failure(&self.cfg, "writeFail")?;
        let taken = string_list(self.cfg.get("taken")).unwrap_or_default();
        let name = if taken.iter().any(|name| name == file_name) {
            taken_name(file_name)
        } else {
            file_name.to_owned()
        };
        let path = join(&[&self.root, "project", &name]);
        write_at(&path, bytes)?;
        Ok(path)
    }

    fn docx_bytes(&mut self, markdown: &str) -> Result<Vec<u8>, Thrown> {
        log(
            &self.logs,
            vec![Value::from("project.docxBytes"), Value::from(markdown)],
        );
        failure(&self.cfg, "docxFail")?;
        Ok(format!("DOCX:{markdown}").into_bytes())
    }
}

struct FakeDeps {
    cfg: Value,
    root: String,
    logs: Logs,
    project: Option<FakeProject>,
}

impl KbCreateDeps for FakeDeps {
    fn dir(&mut self) -> Result<String, Thrown> {
        log(&self.logs, vec![Value::from("dir")]);
        failure(&self.cfg, "dirFail")?;
        Ok(text(&self.cfg, "dir").map_or_else(|| join(&[&self.root, "docs"]), str::to_owned))
    }

    fn unique_path(&mut self, dir: &str, file_name: &str) -> Result<String, Thrown> {
        log(
            &self.logs,
            vec![
                Value::from("uniquePath"),
                Value::from(dir),
                Value::from(file_name),
            ],
        );
        let taken = string_list(self.cfg.get("taken")).unwrap_or_default();
        let name = if taken.iter().any(|name| name == file_name) {
            taken_name(file_name)
        } else {
            file_name.to_owned()
        };
        Ok(join(&[dir, &name]))
    }

    fn sanitize_base(&mut self, title: &str) -> Result<String, Thrown> {
        log(
            &self.logs,
            vec![Value::from("sanitizeBase"), Value::from(title)],
        );
        failure(&self.cfg, "sanitizeFail")?;
        // `replace(/[^A-Za-z0-9 ]/g, '_')` replaces each UTF-16 code unit
        let replaced: String = title
            .encode_utf16()
            .map(|unit| match u8::try_from(unit) {
                Ok(byte) if byte.is_ascii_alphanumeric() || byte == b' ' => char::from(byte),
                _ => '_',
            })
            .collect();
        let cleaned = trim(&replaced);
        Ok(if cleaned.is_empty() {
            "Untitled".to_owned()
        } else {
            cleaned.to_owned()
        })
    }

    fn write_text(&mut self, path: &str, text_: &str) -> Result<(), Thrown> {
        log(
            &self.logs,
            vec![
                Value::from("writeText"),
                Value::from(path),
                Value::from(text_),
            ],
        );
        failure(&self.cfg, "writeFail")?;
        write_at(path, text_.as_bytes())
    }

    fn markdown_to_docx(&mut self, markdown: &str, out: &str) -> Result<(), Thrown> {
        log(
            &self.logs,
            vec![
                Value::from("markdownToDocx"),
                Value::from(markdown),
                Value::from(out),
            ],
        );
        failure(&self.cfg, "docxFail")?;
        write_at(out, format!("DOCX:{markdown}").as_bytes())
    }

    fn record_recent(&mut self, path: &str) -> Result<(), Thrown> {
        log(
            &self.logs,
            vec![Value::from("recordRecent"), Value::from(path)],
        );
        match &self.project {
            Some(project) => failure(&project.cfg, "recordFail"),
            None => failure(&self.cfg, "recordFail"),
        }
    }

    fn project(&mut self) -> Option<&mut dyn KbCreateProject> {
        self.project
            .as_mut()
            .map(|project| project as &mut dyn KbCreateProject)
    }
}

/// `[cfg, req]`: `cfg.root` is the case's folder; its `docs` is where the
/// default folder is, its `project` the project folder
fn create_call(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).ok_or_else(|| bad("a config"))?;
    let request = arg(args, 1).ok_or_else(|| bad("a request"))?;
    let root = text(cfg, "root").ok_or_else(|| bad("a root"))?.to_owned();
    let logs: Logs = Rc::default();
    let project = cfg
        .get("project")
        .filter(|project| project.is_object())
        .map(|project| FakeProject {
            cfg: project.clone(),
            root: root.clone(),
            logs: Rc::clone(&logs),
        });
    let mut deps = FakeDeps {
        cfg: cfg.clone(),
        root,
        logs: Rc::clone(&logs),
        project,
    };
    let request = KbCreateRequest {
        title: text(request, "title").unwrap_or("").to_owned(),
        format: if text(request, "format") == Some("docx") {
            KbCreateFormat::Docx
        } else {
            KbCreateFormat::Md
        },
        content: text(request, "content").unwrap_or("").to_owned(),
    };
    let result = create_knowledge_document(&mut deps, &request);
    cx.logs.extend(logs.take());
    result.map_err(thrown).and_then(|created| print(&created))
}
