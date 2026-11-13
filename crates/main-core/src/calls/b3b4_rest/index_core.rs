//! The index core part of group `b3b4-rest` (tools/main-diff/groups/b3b4-rest/
//! index-core.ts): `text-marks`, the file index's `snippet`, `tokenize`,
//! `scan`, `extract` and `extract-worker`, and `folder-tree`.
//!
//! A case may end its arguments with `{ "$links": [[link, target], ...] }`:
//! the symbolic links to make before the call (the case's files cannot be
//! links). `@seuoffice/file-parse` is a fake the spec describes (the `world`
//! argument); each call of it is one `logs` line.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs;
use std::rc::Rc;

use serde::Serialize;
use serde_json::Value;

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::markdown::fs_util::{rename, rm_recursive_force};
use crate::node_fs::NodeError;
use crate::shell::file_index::extract::{
    FileParser, MAX_BODY_CHARS, MAX_EXTRACT_BYTES, ParsedFile, ParsedFileKind, extract_text,
};
use crate::shell::file_index::extract_worker::{WorkerRequest, handle_message};
use crate::shell::file_index::scan::{
    SCAN_MAX_DEPTH, SCAN_MAX_FILES, ScanLimits, scan_files, stat_or_null,
};
use crate::shell::file_index::snippet::{build_snippet, contains_any, excerpt};
use crate::shell::file_index::tokenize::{
    MatchJoin, QueryTerm, is_cjk, parse_query, term_chars, term_expr, to_index_text,
    to_match_expression, token_exprs, tokenize,
};
use crate::shell::folder_tree::{
    FolderErrors, FolderWatcher, MoveConflictPolicy, MoveOptions, ReplacedItem,
    TREE_FILE_EXTENSIONS, Thrown, create_folder, describe_root, is_hidden_entry, is_inside_root,
    is_self_or_descendant, is_supported_tree_file, list_folder, move_on_disk, move_on_disk_via,
    move_paths_into, paths_under, rebase_path, rename_folder, unique_name_in,
};
use crate::shell::text_marks::{find_ranges, find_text_ranges, fold_text, mark_text};
use jscompat::json_value_to_serde;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- text-marks ----
        "text-marks.foldText" => str_arg(args, 0).map(|text| Some(Value::from(fold_text(text)))),
        "text-marks.findRanges" => (|| {
            let hay = str_arg(args, 0)?;
            let needles = strings(arg(args, 1));
            let allowed: Option<Vec<usize>> = arg(args, 2).and_then(Value::as_array).map(|list| {
                list.iter()
                    .filter_map(Value::as_u64)
                    .map(|n| n as usize)
                    .collect()
            });
            let ranges = match &allowed {
                Some(list) => {
                    let allow = |at: usize| list.contains(&at);
                    find_ranges(hay, &needles, Some(&allow as &dyn Fn(usize) -> bool))
                }
                None => find_ranges(hay, &needles, None),
            };
            Ok(Some(ranges_value(&ranges)))
        })(),
        "text-marks.findTextRanges" => (|| {
            let text = str_arg(args, 0)?;
            let ranges = find_text_ranges(text, &strings(arg(args, 1)));
            Ok(Some(ranges_value(&ranges)))
        })(),
        "text-marks.markText" => (|| {
            let text = str_arg(args, 0)?;
            Ok(Some(to_value(&mark_text(text, &strings(arg(args, 1))))))
        })(),

        // ---- snippet ----
        "snippet.buildSnippet" => (|| {
            let text = str_arg(args, 0)?;
            Ok(Some(
                build_snippet(text, &strings(arg(args, 1))).map_or(Value::Null, |p| to_value(&p)),
            ))
        })(),
        "snippet.excerpt" => (|| {
            let text = str_arg(args, 0)?;
            let chars = arg(args, 2).and_then(Value::as_f64).unwrap_or(0.0);
            Ok(Some(Value::from(excerpt(
                text,
                &strings(arg(args, 1)),
                chars,
            ))))
        })(),
        "snippet.containsAny" => (|| {
            let text = str_arg(args, 0)?;
            Ok(Some(Value::Bool(contains_any(
                text,
                &strings(arg(args, 1)),
            ))))
        })(),

        // ---- tokenize ----
        "tokenize.isCjk" => Ok(Some(Value::Bool(is_cjk(
            arg(args, 0).and_then(Value::as_u64).unwrap_or(0) as u32,
        )))),
        "tokenize.tokenize" => str_arg(args, 0).map(|text| Some(to_value(&tokenize(text)))),
        "tokenize.toIndexText" => Ok(Some(Value::from(to_index_text(&strings(arg(args, 0)))))),
        "tokenize.parseQuery" => str_arg(args, 0).map(|text| Some(to_value(&parse_query(text)))),
        "tokenize.termExpr" => pick_term(args).map(|term| Some(Value::from(term_expr(&term)))),
        "tokenize.toMatchExpression" => str_arg(args, 0).map(|query| {
            let join = match arg(args, 1).and_then(Value::as_str) {
                Some("OR") => MatchJoin::Or,
                _ => MatchJoin::And,
            };
            Some(to_match_expression(&parse_query(query), join).map_or(Value::Null, Value::from))
        }),
        "tokenize.tokenExprs" => pick_term(args).map(|term| Some(to_value(&token_exprs(&term)))),
        "tokenize.termChars" => pick_term(args).map(|term| Some(Value::from(term_chars(&term)))),
        "tokenize.foldText" => str_arg(args, 0).map(|text| Some(Value::from(fold_text(text)))),

        // ---- scan ----
        "scan.SCAN_MAX_DEPTH" => Ok(Some(Value::from(SCAN_MAX_DEPTH))),
        "scan.SCAN_MAX_FILES" => Ok(Some(Value::from(SCAN_MAX_FILES))),
        "scan.scanFiles" => (|| {
            let args = take_links(args);
            let root = str_arg(args, 0)?;
            let limits = arg(args, 1)
                .filter(|v| v.is_object())
                .map(|v| ScanLimits {
                    max_depth: v.get("maxDepth").and_then(Value::as_f64),
                    max_files: v.get("maxFiles").and_then(Value::as_f64),
                })
                .unwrap_or_default();
            Ok(Some(to_value(&scan_files(root, &limits))))
        })(),
        "scan.statOrNull" => (|| {
            let args = take_links(args);
            let path = str_arg(args, 0)?;
            Ok(Some(
                stat_or_null(path).map_or(Value::Null, |f| to_value(&f)),
            ))
        })(),

        // ---- folder-tree ----
        "folder-tree.TREE_FILE_EXTENSIONS" => Ok(Some(Value::Array(
            TREE_FILE_EXTENSIONS
                .iter()
                .map(|e| Value::from(*e))
                .collect(),
        ))),
        "folder-tree.isSupportedTreeFile" => {
            str_arg(args, 0).map(|name| Some(Value::Bool(is_supported_tree_file(name))))
        }
        "folder-tree.isHiddenEntry" => (|| {
            let dir = str_arg(args, 0)?;
            let entry = str_arg(args, 1)?;
            let is_dir = arg(args, 2).and_then(Value::as_bool).unwrap_or(false);
            Ok(Some(Value::Bool(is_hidden_entry(dir, entry, is_dir))))
        })(),
        "folder-tree.isInsideRoot" => (|| {
            let args = take_links(args);
            let root = str_arg(args, 0)?;
            let path = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_inside_root(root, path))))
        })(),
        "folder-tree.describeRoot" => {
            str_arg(args, 0).map(|root| Some(json_value_to_serde(&describe_root(root).to_json())))
        }
        "folder-tree.listFolder" => (|| {
            let args = take_links(args);
            let dir = str_arg(args, 0)?;
            let starred: HashSet<String> = strings(arg(args, 1)).into_iter().collect();
            Ok(Some(to_value(&list_folder(dir, &starred))))
        })(),
        "folder-tree.pathsUnder" => (|| {
            let dir = str_arg(args, 0)?;
            Ok(Some(Value::Array(
                paths_under(dir, &strings(arg(args, 1)))
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            )))
        })(),
        "folder-tree.createFolder" => (|| {
            let parent = str_arg(args, 0)?;
            let folder = str_arg(args, 1)?;
            let errors = folder_errors(arg(args, 2));
            Ok(Some(to_value(&create_folder(parent, folder, &errors))))
        })(),
        "folder-tree.uniqueNameIn" => (|| {
            let dir = str_arg(args, 0)?;
            let entry = str_arg(args, 1)?;
            let is_dir = arg(args, 2).and_then(Value::as_bool).unwrap_or(false);
            Ok(Some(Value::from(unique_name_in(dir, entry, is_dir))))
        })(),
        "folder-tree.moveOnDisk" => (|| {
            let from = str_arg(args, 0)?;
            let to = str_arg(args, 1)?;
            let outcome = match arg(args, 2).and_then(Value::as_str) {
                Some("xdev") => {
                    move_on_disk_via(&|a, b| Err(rename_error("EXDEV", a, b)), from, to)
                }
                Some("xdev-eacces") => {
                    move_on_disk_via(&|a, b| Err(rename_error("EACCES", a, b)), from, to)
                }
                _ => move_on_disk(from, to),
            };
            outcome.map(|()| None).map_err(CallError::from)
        })(),
        "folder-tree.isSelfOrDescendant" => (|| {
            let path = str_arg(args, 0)?;
            let dir = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_self_or_descendant(path, dir))))
        })(),
        "folder-tree.movePathsInto" => moves_call(args, cx),
        "folder-tree.renameFolder" => (|| {
            let dir = str_arg(args, 0)?;
            let new_name = str_arg(args, 1)?;
            let errors = folder_errors(arg(args, 2));
            Ok(Some(to_value(&rename_folder(dir, new_name, &errors))))
        })(),
        "folder-tree.rebasePath" => (|| {
            let path = str_arg(args, 0)?;
            let old_dir = str_arg(args, 1)?;
            let new_dir = str_arg(args, 2)?;
            Ok(Some(Value::from(rebase_path(path, old_dir, new_dir))))
        })(),
        "folder-tree.FolderWatcher" => Ok(Some(watcher_call(arg(args, 0), cx))),

        // ---- extract ----
        "extract.MAX_EXTRACT_BYTES" => Ok(Some(Value::from(MAX_EXTRACT_BYTES))),
        "extract.MAX_BODY_CHARS" => Ok(Some(Value::from(MAX_BODY_CHARS))),
        "extract.extractText" => (|| {
            let path = str_arg(args, 0)?;
            let world = arg(args, 1).cloned().unwrap_or(Value::Null);
            let sparse = arg(args, 2).and_then(Value::as_u64);
            if let Some(bytes) = sparse {
                fs::File::create(path)
                    .and_then(|file| file.set_len(bytes))
                    .map_err(|e| CallError::plain(e.to_string()))?;
            }
            let mut parser = FakeParser {
                world: &world,
                logs: &mut cx.logs,
            };
            let result = extract_text(path, &mut parser);
            if sparse.is_some() {
                let _ = fs::remove_file(path);
            }
            Ok(Some(result.to_value()))
        })(),

        // ---- extract-worker ----
        "extract-worker.message" => (|| {
            let request = arg(args, 0).cloned().unwrap_or(Value::Null);
            let world = arg(args, 1).cloned().unwrap_or(Value::Null);
            let id = request.get("id").and_then(Value::as_f64).unwrap_or(0.0);
            let request = if request.get("type").and_then(Value::as_str) == Some("extract") {
                WorkerRequest::Extract {
                    id,
                    path: request
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                }
            } else {
                WorkerRequest::Scan {
                    id,
                    root: request
                        .get("root")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                }
            };
            let mut parser = FakeParser {
                world: &world,
                logs: &mut cx.logs,
            };
            Ok(Some(handle_message(&request, &mut parser).to_value()))
        })(),

        _ => return None,
    })
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a result serializes")
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn ranges_value(ranges: &[(usize, usize)]) -> Value {
    Value::Array(
        ranges
            .iter()
            .map(|&(s, e)| Value::Array(vec![Value::from(s), Value::from(e)]))
            .collect(),
    )
}

/// the term `[query, index]` names: the include terms, then the exclude terms
fn pick_term(args: &[Value]) -> Result<QueryTerm, CallError> {
    let parsed = parse_query(str_arg(args, 0)?);
    let index = arg(args, 1).and_then(Value::as_u64).unwrap_or(0) as usize;
    parsed
        .include
        .into_iter()
        .chain(parsed.exclude)
        .nth(index)
        .ok_or_else(|| CallError::plain("no such term"))
}

fn folder_errors(value: Option<&Value>) -> FolderErrors {
    let field = |key: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    FolderErrors {
        bad_args: field("badArgs"),
        bad_name: field("badName"),
        missing: field("missing"),
        exists: field("exists"),
        failed: field("failed"),
    }
}

fn rename_error(code: &'static str, from: &str, to: &str) -> NodeError {
    let text = match code {
        "EXDEV" => "cross-device link not permitted",
        _ => "permission denied",
    };
    NodeError {
        code: Some(code),
        message: format!("{code}: {text}, rename '{from}' -> '{to}'"),
    }
}

/// The links a case asks for in its last argument, made; the arguments before it.
fn take_links(args: &[Value]) -> &[Value] {
    let Some((last, rest)) = args.split_last() else {
        return args;
    };
    let Some(pairs) = last.get("$links").and_then(Value::as_array) else {
        return args;
    };
    for pair in pairs {
        let link = pair.get(0).and_then(Value::as_str);
        let target = pair.get(1).and_then(Value::as_str);
        if let (Some(link), Some(target)) = (link, target) {
            make_link(target, link);
        }
    }
    rest
}

#[cfg(unix)]
fn make_link(target: &str, link: &str) {
    let _ = std::os::unix::fs::symlink(target, link);
}

#[cfg(windows)]
fn make_link(target: &str, link: &str) {
    let _ = if fs::metadata(target).is_ok_and(|m| m.is_dir()) {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
}

/// `@seuoffice/file-parse` as the spec's world describes it:
/// `redact`: "mark" (every `SECRET` becomes `{{private}}`), `{ "throw": message }`
/// or anything else (the source as it is); `parse`: `{ kind, ok, text?, error? }`
/// or `{ "throw": message }`.
struct FakeParser<'a> {
    world: &'a Value,
    logs: &'a mut Vec<Vec<Value>>,
}

impl FileParser for FakeParser<'_> {
    fn redact_html_source(&mut self, source: &str) -> Result<String, String> {
        self.logs.push(vec![
            Value::from("redactHtmlSource"),
            Value::from(source.encode_utf16().count()),
        ]);
        match self.world.get("redact") {
            Some(Value::String(mode)) if mode == "mark" => {
                Ok(source.replace("SECRET", "{{private}}"))
            }
            Some(thrown @ Value::Object(_)) => Err(thrown_message(thrown)),
            _ => Ok(source.to_owned()),
        }
    }

    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, String> {
        self.logs
            .push(vec![Value::from("parseFileToText"), Value::from(path)]);
        let Some(parse) = self.world.get("parse") else {
            return Ok(ParsedFile {
                ok: true,
                text: Some(String::new()),
                kind: ParsedFileKind::Text,
                error: None,
            });
        };
        if parse.get("throw").is_some() || parse.get("throwValue").is_some() {
            return Err(thrown_message(parse));
        }
        let kind = match parse.get("kind").and_then(Value::as_str) {
            Some("image") => ParsedFileKind::Image,
            Some("unsupported") => ParsedFileKind::Unsupported,
            _ => ParsedFileKind::Text,
        };
        Ok(ParsedFile {
            ok: parse.get("ok").and_then(Value::as_bool).unwrap_or(false),
            text: parse.get("text").and_then(Value::as_str).map(str::to_owned),
            kind,
            error: parse
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

/// what the catch of `extractText` writes for `{ throw: message }` (an `Error`)
/// or `{ throwValue: text }` (a string thrown as it is)
fn thrown_message(thrown: &Value) -> String {
    thrown
        .get("throw")
        .or_else(|| thrown.get("throwValue"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

type Logs = Rc<RefCell<Vec<Vec<Value>>>>;

/// `replaceExisting` of the spec: parks the target beside itself as `<path>.parked`;
/// `mode` makes it fail ("throw", "throwValue") or the item fail ("commitThrows",
/// "rollbackThrows").
struct ParkOptions {
    mode: String,
    logs: Logs,
}

struct Parked {
    path: String,
    parked: String,
    mode: String,
    logs: Logs,
}

fn log_line(logs: &Logs, line: Vec<Value>) {
    logs.borrow_mut().push(line);
}

impl MoveOptions for ParkOptions {
    fn replace_existing(&mut self, path: &str) -> Result<Box<dyn ReplacedItem>, Thrown> {
        log_line(
            &self.logs,
            vec![Value::from("replaceExisting"), Value::from(path)],
        );
        match self.mode.as_str() {
            "throw" => return Err(Some("park failed".to_owned())),
            "throwValue" => return Err(None),
            _ => {}
        }
        let parked = format!("{path}.parked");
        rename(path, &parked).map_err(|e| Some(e.message))?;
        Ok(Box::new(Parked {
            path: path.to_owned(),
            parked,
            mode: self.mode.clone(),
            logs: Rc::clone(&self.logs),
        }))
    }
}

impl ReplacedItem for Parked {
    fn commit(&mut self) -> Result<(), Thrown> {
        log_line(&self.logs, vec![Value::from("commit")]);
        if self.mode == "commitThrows" || self.mode == "rollbackThrows" {
            return Err(Some("commit failed".to_owned()));
        }
        rm_recursive_force(&self.parked).map_err(|e| Some(e.message))
    }

    fn rollback(&mut self) -> Result<(), Thrown> {
        log_line(&self.logs, vec![Value::from("rollback")]);
        if self.mode == "rollbackThrows" {
            return Err(Some("rollback failed".to_owned()));
        }
        rename(&self.parked, &self.path).map_err(|e| Some(e.message))
    }
}

/// `movePathsInto(paths, targetDir, policy, errors, options)`: `[paths, targetDir, policy, errors, mode]`
fn moves_call(args: &[Value], cx: &mut Context) -> Answer {
    let paths = strings(arg(args, 0));
    let target = str_arg(args, 1)?;
    let policy = MoveConflictPolicy::from_wire(str_arg(args, 2)?);
    let errors = folder_errors(arg(args, 3));
    let logs: Logs = Rc::new(RefCell::new(Vec::new()));
    let mut options = ParkOptions {
        mode: arg(args, 4)
            .and_then(Value::as_str)
            .unwrap_or("park")
            .to_owned(),
        logs: Rc::clone(&logs),
    };
    let outcome = move_paths_into(&paths, target, policy, &errors, &mut options);
    drop(options);
    cx.logs.extend(logs.borrow().iter().cloned());
    match outcome {
        Ok(result) => Ok(Some(to_value(&result))),
        Err(thrown) => Err(CallError::plain(thrown.unwrap_or_default())),
    }
}

/// A scenario of one `FolderWatcher`: `{ watchOk, root, ops }` with the
/// operations `event` (`filename`, a string or null), `fire` (the debounce
/// timer runs), `error` (the handle's `'error'` event), `close` and `active`.
/// The Rust plays the caller: it owns the timer and the handle, and logs each
/// call it makes as the spec's fakes do (`watch`, `setTimeout`, `clearTimeout`,
/// `close`) and the `onChange` it gives.
fn watcher_call(world: Option<&Value>, cx: &mut Context) -> Value {
    let null = Value::Null;
    let world = world.unwrap_or(&null);
    let root = world
        .get("root")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let watch_ok = world
        .get("watchOk")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut log = |line: Vec<Value>| cx.logs.push(line);
    log(vec![Value::from("watch"), Value::from(root)]);
    let mut watcher = FolderWatcher::new(root, watch_ok);
    let mut timer = false;
    let mut results: Vec<Value> = Vec::new();
    let ops = world.get("ops").and_then(Value::as_array);
    for op in ops.into_iter().flatten() {
        let mut result = Value::Null;
        match op.get("op").and_then(Value::as_str) {
            Some("event") => {
                if timer {
                    log(vec![Value::from("clearTimeout")]);
                }
                let ms = watcher.note(op.get("filename").and_then(Value::as_str));
                timer = true;
                log(vec![Value::from("setTimeout"), Value::from(ms)]);
            }
            Some("fire") => {
                if timer {
                    timer = false;
                    if let Some(dirs) = watcher.on_timer() {
                        log(vec![
                            Value::from("onChange"),
                            Value::Array(dirs.into_iter().map(Value::from).collect()),
                        ]);
                    }
                }
            }
            Some("error") => {
                if watch_ok {
                    close_watcher(&mut watcher, &mut timer, &mut log);
                }
            }
            Some("close") => close_watcher(&mut watcher, &mut timer, &mut log),
            Some("active") => result = Value::Bool(watcher.active()),
            _ => {}
        }
        results.push(result);
    }
    Value::Array(results)
}

fn close_watcher(watcher: &mut FolderWatcher, timer: &mut bool, log: &mut dyn FnMut(Vec<Value>)) {
    if *timer {
        log(vec![Value::from("clearTimeout")]);
        *timer = false;
    }
    if watcher.active() {
        log(vec![Value::from("watcher.close")]);
    }
    watcher.close();
}
