//! The scripted world of group `b5-provider`: the host of an
//! `ai_provider::task::Runtime` that answers its commands from a case's
//! script and logs them as `tools/main-diff/groups/b5-provider/world.ts`
//! logs the TypeScript's calls of its fakes. The script and the log lines
//! are described there.
//!
//! The order of answers follows JavaScript's: the answers of the commands a
//! pass queued come at once (promise continuations), then the scripted
//! emits of the children, one at a time, each followed by the continuations
//! it caused (Node runs `setImmediate` callbacks so), then the earliest
//! timer, the clock jumping to it.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{CallError, Context};
use crate::node_fs::{NodeError, code_of, node_error, node_error2};
use crate::packages::ai_provider::task::{
    Answer, ChildEvent, Cmd, DirEntry, Event, Fetcher, FileKind, FileStat, FormValue, FsAnswer,
    FsOp, HostInfo, Id, JsError, RequestBody, ResponseHead, Rt, Runtime, Signal, Stdio,
};

/// The UUID the n-th `randomUUID()` answers, on both sides.
pub(crate) fn uuid_of(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn chunk_bytes(chunk: &Value) -> Vec<u8> {
    match chunk {
        Value::String(s) => s.as_bytes().to_vec(),
        Value::Object(o) => o
            .get("hex")
            .and_then(Value::as_str)
            .map(|h| {
                (0..h.len() / 2)
                    .filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok())
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn chunks(value: Option<&Value>) -> VecDeque<Vec<u8>> {
    value
        .and_then(Value::as_array)
        .map(|a| a.iter().map(chunk_bytes).collect())
        .unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A thrown value as the log writes it (`errorLine` of world.ts).
pub(crate) fn error_line(e: &JsError) -> Value {
    if e.is_error() {
        let mut out = serde_json::Map::new();
        out.insert("name".into(), Value::String(e.name.clone()));
        out.insert("message".into(), Value::String(e.message.clone()));
        if let Some(code) = e.props.get("code") {
            out.insert("code".into(), json_value_to_serde(code));
        }
        return Value::Object(out);
    }
    json!({ "value": e.props.get("value").map(json_value_to_serde).unwrap_or(Value::Null) })
}

/// The error a script's `reject` describes.
fn error_of_spec(r: &Value) -> JsError {
    let message = r.get("message").and_then(Value::as_str).unwrap_or("");
    let class = r.get("class").and_then(Value::as_str).unwrap_or("Error");
    let name = r.get("name").and_then(Value::as_str);
    let mut e = match class {
        "DOMException" => JsError::dom(name.unwrap_or("Error"), message),
        "TypeError" => JsError::type_error(message),
        _ => JsError::error(message),
    };
    if class != "DOMException"
        && let Some(name) = name
    {
        e = e.named(name);
    }
    if let Some(code) = r.get("code") {
        e = e.with("code", json_value_from_serde(code));
    }
    e
}

fn body_line(body: &Option<RequestBody>) -> Value {
    match body {
        None => Value::Null,
        Some(RequestBody::Text(t)) => Value::String(t.clone()),
        Some(RequestBody::Bytes(b)) => json!({ "hex": hex(b) }),
        Some(RequestBody::Form(parts)) => {
            let parts: Vec<Value> = parts
                .iter()
                .map(|p| match &p.value {
                    FormValue::Text(t) => json!([p.name, t]),
                    FormValue::Blob { mime, filename, .. } => json!([
                        p.name,
                        { "mime": mime, "name": filename.clone().unwrap_or_else(|| "blob".into()) }
                    ]),
                })
                .collect();
            json!({ "form": parts })
        }
    }
}

fn pairs(list: &[(String, String)]) -> Value {
    Value::Array(list.iter().map(|(k, v)| json!([k, v])).collect())
}

fn stdio_name(s: Stdio) -> &'static str {
    match s {
        Stdio::Pipe => "pipe",
        Stdio::Ignore => "ignore",
        Stdio::Inherit => "inherit",
    }
}

struct ChildRun {
    i: usize,
    spec: Value,
    closed: bool,
    writes: usize,
}

enum Later {
    Start(Id),
    Reply(Id, usize, bool),
    Close(Id, Option<String>),
}

struct Body {
    fetch: usize,
    chunks: VecDeque<Vec<u8>>,
}

/// The log the world and the call's own callbacks write to, in one order.
pub(crate) type Sink = Rc<RefCell<Vec<Vec<Value>>>>;

/// Writes one log line to `sink`.
pub(crate) fn note(sink: &Sink, line: Value) {
    if let Value::Array(items) = line {
        sink.borrow_mut().push(items);
    }
}

/// The world's state while one call runs.
struct WorldRun<'a> {
    spec: &'a Value,
    sink: Sink,
    now: Rc<Cell<f64>>,
    fetches: usize,
    /// fetch op, body and clone ids to the fetch they belong to
    fetch_of: BTreeMap<Id, usize>,
    bodies: BTreeMap<Id, Body>,
    cancelled: BTreeSet<usize>,
    timers: Vec<(u64, f64, Id)>,
    timer_count: u64,
    children: BTreeMap<Id, ChildRun>,
    child_count: usize,
    calls: usize,
    immediate: VecDeque<Event>,
    later: VecDeque<Later>,
}

impl WorldRun<'_> {
    fn log(&mut self, line: Value) {
        note(&self.sink, line);
    }

    fn cancel(&mut self, i: usize) {
        if self.cancelled.insert(i) {
            self.log(json!(["cancel", i]));
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Fetch {
                id,
                via,
                url,
                request,
            } => {
                let i = self.fetches;
                self.fetches += 1;
                let via = match via {
                    Fetcher::Node => "node",
                    Fetcher::Net => "net",
                    Fetcher::Embed => "embed",
                };
                self.log(json!([
                    "fetch",
                    i,
                    via,
                    url,
                    request.method,
                    pairs(&request.headers),
                    body_line(&request.body),
                    request.redirect
                ]));
                self.fetch_of.insert(id, i);
                let spec = self.spec.get("fetches").and_then(|f| f.get(i)).cloned();
                let Some(spec) = spec else {
                    self.immediate.push_back(Event::Failed {
                        id,
                        error: JsError::type_error("fetch failed"),
                    });
                    return;
                };
                if let Some(r) = spec.get("reject") {
                    self.immediate.push_back(Event::Failed {
                        id,
                        error: error_of_spec(r),
                    });
                    return;
                }
                if spec.get("hang").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                let has_body = !matches!(spec.get("body"), Some(Value::Null));
                if has_body {
                    self.bodies.insert(
                        id,
                        Body {
                            fetch: i,
                            chunks: chunks(spec.get("body")),
                        },
                    );
                }
                let headers = spec
                    .get("headers")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|p| {
                                Some((
                                    p.get(0)?.as_str()?.to_lowercase(),
                                    p.get(1)?.as_str()?.to_owned(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.immediate.push_back(Event::Done {
                    id,
                    answer: Answer::Response(ResponseHead {
                        status: spec.get("status").and_then(Value::as_f64).unwrap_or(200.0),
                        status_text: spec
                            .get("statusText")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        headers,
                        url: spec
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        redirected: spec.get("redirected").and_then(Value::as_bool) == Some(true),
                        kind: spec
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("basic")
                            .to_owned(),
                        has_body,
                    }),
                });
            }
            Cmd::Read { id, body } => {
                let answer = match self
                    .bodies
                    .get_mut(&body)
                    .and_then(|b| b.chunks.pop_front())
                {
                    Some(chunk) => Answer::Chunk(chunk),
                    None => Answer::End,
                };
                self.immediate.push_back(Event::Done { id, answer });
            }
            Cmd::CloneBody { from, to } => {
                if let Some(b) = self.bodies.get(&from) {
                    let copy = Body {
                        fetch: b.fetch,
                        chunks: b.chunks.clone(),
                    };
                    self.fetch_of.insert(to, b.fetch);
                    self.bodies.insert(to, copy);
                }
            }
            Cmd::Cancel { id } => {
                let fetch = self
                    .fetch_of
                    .get(&id)
                    .copied()
                    .or_else(|| self.bodies.get(&id).map(|b| b.fetch));
                if let Some(i) = fetch {
                    self.cancel(i);
                }
            }
            Cmd::SetTimer { id, ms } => {
                self.timer_count += 1;
                let n = self.timer_count;
                self.log(json!(["timer", n, number(ms)]));
                let wait = if ms.is_finite() && ms > 0.0 { ms } else { 0.0 };
                self.timers.push((n, self.now.get() + wait, id));
            }
            Cmd::ClearTimer { id } => {
                if let Some(at) = self.timers.iter().position(|t| t.2 == id) {
                    let (n, _, _) = self.timers.remove(at);
                    self.log(json!(["clear", n]));
                }
            }
            Cmd::Spawn { id, spawn } => {
                let i = self.child_count;
                self.child_count += 1;
                let env = spawn.env.as_ref().map(|e| pairs(e)).unwrap_or(Value::Null);
                self.log(json!([
                    "spawn",
                    i,
                    spawn.command,
                    spawn.args,
                    {
                        "cwd": spawn.cwd,
                        "env": env,
                        "stdio": spawn.stdio.iter().map(|s| stdio_name(*s)).collect::<Vec<_>>(),
                        "detached": spawn.detached,
                        "windowsHide": spawn.windows_hide,
                    }
                ]));
                let spec = self
                    .spec
                    .get("children")
                    .and_then(|c| c.get(i))
                    .cloned()
                    .unwrap_or_else(|| {
                        json!({
                            "pid": null,
                            "error": { "message": format!("spawn {} ENOENT", spawn.command), "code": "ENOENT" }
                        })
                    });
                let pid = if spec.get("error").is_some() {
                    None
                } else {
                    match spec.get("pid") {
                        Some(Value::Null) => None,
                        Some(v) => v.as_f64(),
                        None => Some(4242.0 + i as f64),
                    }
                };
                self.children.insert(
                    id,
                    ChildRun {
                        i,
                        spec,
                        closed: false,
                        writes: 0,
                    },
                );
                self.immediate.push_back(Event::Done {
                    id,
                    answer: Answer::Spawned { pid },
                });
                self.later.push_back(Later::Start(id));
            }
            Cmd::Stdin { child, data } => {
                let Some(c) = self.children.get_mut(&child) else {
                    return;
                };
                c.writes += 1;
                let (i, k) = (c.i, c.writes);
                let close_now = c.spec.get("closeOn").and_then(Value::as_u64) == Some(k as u64);
                self.log(json!(["stdin", i, String::from_utf8_lossy(&data)]));
                self.later.push_back(Later::Reply(child, k, close_now));
            }
            Cmd::EndStdin { child } => {
                let Some(c) = self.children.get(&child) else {
                    return;
                };
                let i = c.i;
                let on_end = match c.spec.get("closeOn") {
                    None => true,
                    Some(v) => v.as_str() == Some("end"),
                };
                self.log(json!(["end", i]));
                if on_end {
                    self.later.push_back(Later::Close(child, None));
                }
            }
            Cmd::KillChild { child, signal } => {
                let Some(c) = self.children.get(&child) else {
                    return;
                };
                let i = c.i;
                let on_kill = c.spec.get("closeOn").and_then(Value::as_str) == Some("kill");
                self.log(json!(["kill", i, signal]));
                if on_kill {
                    self.later.push_back(Later::Close(
                        child,
                        Some(signal.unwrap_or_else(|| "SIGTERM".into())),
                    ));
                }
            }
            Cmd::KillPid { pid, signal } => {
                self.log(json!(["killpid", number(pid), signal]));
            }
            Cmd::Fs { id, op } => {
                let event = match run_fs(&op) {
                    Ok(answer) => Event::Done {
                        id,
                        answer: Answer::Fs(answer),
                    },
                    Err(e) => Event::Failed {
                        id,
                        error: node_js_error(e),
                    },
                };
                self.immediate.push_back(event);
            }
            Cmd::Listen { id, host, port } => {
                self.log(json!(["listen", host, number(port)]));
                self.immediate.push_back(Event::Done {
                    id,
                    answer: Answer::Listening { port: 40001.0 },
                });
            }
            Cmd::Respond {
                request,
                status,
                headers,
                body,
            } => {
                self.log(json!([
                    "respond",
                    request,
                    number(status),
                    pairs(&headers),
                    String::from_utf8_lossy(&body)
                ]));
            }
            Cmd::CloseServer { .. } => self.log(json!(["close-server"])),
            Cmd::Call { id, name, args } => {
                self.log(json!(["call", name, json_value_to_serde(&args)]));
                let answer = self
                    .spec
                    .get("calls")
                    .and_then(|c| c.get(self.calls))
                    .cloned();
                self.calls += 1;
                let event = match answer
                    .as_ref()
                    .and_then(|a| a.get("reject"))
                    .and_then(Value::as_str)
                {
                    Some(message) => Event::Failed {
                        id,
                        error: JsError::error(message),
                    },
                    None => Event::Done {
                        id,
                        answer: match answer {
                            Some(v) => Answer::Value(json_value_from_serde(&v)),
                            None => Answer::Unit,
                        },
                    },
                };
                self.immediate.push_back(event);
            }
            Cmd::Log { level, args } => {
                let mut line = vec![Value::from("log"), Value::from(level)];
                line.extend(args.iter().map(json_value_to_serde));
                self.sink.borrow_mut().push(line);
            }
        }
    }

    /// The events of one scripted emit, as the child's state is now.
    fn emit(&mut self, later: Later) -> Vec<Event> {
        let out = |chunks: VecDeque<Vec<u8>>, err: bool, child: Id| -> Vec<Event> {
            chunks
                .into_iter()
                .map(|bytes| Event::Child {
                    child,
                    event: if err {
                        ChildEvent::Stderr(bytes)
                    } else {
                        ChildEvent::Stdout(bytes)
                    },
                })
                .collect()
        };
        let close = |c: &mut ChildRun, child: Id, signal: Option<String>| -> Vec<Event> {
            if c.closed {
                return Vec::new();
            }
            c.closed = true;
            let exit = c.spec.get("exit").cloned().unwrap_or(Value::Null);
            let code = if signal.is_some() {
                None
            } else {
                match exit.get("code") {
                    Some(Value::Null) => None,
                    Some(v) => v.as_f64(),
                    None => Some(0.0),
                }
            };
            let signal = signal.or_else(|| {
                exit.get("signal")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            vec![
                Event::Child {
                    child,
                    event: ChildEvent::Exit {
                        code,
                        signal: signal.clone(),
                    },
                },
                Event::Child {
                    child,
                    event: ChildEvent::Close { code, signal },
                },
            ]
        };
        match later {
            Later::Start(child) => {
                let Some(c) = self.children.get_mut(&child) else {
                    return Vec::new();
                };
                if let Some(error) = c.spec.get("error") {
                    c.closed = true;
                    let mut e =
                        JsError::error(error.get("message").and_then(Value::as_str).unwrap_or(""));
                    if let Some(code) = error.get("code") {
                        e = e.with("code", json_value_from_serde(code));
                    }
                    return vec![
                        Event::Child {
                            child,
                            event: ChildEvent::Error(e),
                        },
                        Event::Child {
                            child,
                            event: ChildEvent::Close {
                                code: Some(-2.0),
                                signal: None,
                            },
                        },
                    ];
                }
                let mut events = out(chunks(c.spec.get("stdout")), false, child);
                events.extend(out(chunks(c.spec.get("stderr")), true, child));
                if c.spec.get("closeOn").and_then(Value::as_str) == Some("start") {
                    events.extend(close(c, child, None));
                }
                events
            }
            Later::Reply(child, k, close_now) => {
                let Some(c) = self.children.get_mut(&child) else {
                    return Vec::new();
                };
                if c.closed {
                    return Vec::new();
                }
                let reply = c.spec.get("replies").and_then(|r| r.get(k - 1)).cloned();
                let mut events = Vec::new();
                if let Some(reply) = reply {
                    events.extend(out(chunks(reply.get("stdout")), false, child));
                    events.extend(out(chunks(reply.get("stderr")), true, child));
                }
                if close_now {
                    events.extend(close(c, child, None));
                }
                events
            }
            Later::Close(child, signal) => match self.children.get_mut(&child) {
                Some(c) => close(c, child, signal),
                None => Vec::new(),
            },
        }
    }
}

fn number(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn node_js_error(e: NodeError) -> JsError {
    let mut error = JsError::error(e.message);
    if let Some(code) = e.code {
        error = error.with("code", JsonValue::String(code.into()));
    }
    error
}

fn kind_of(meta: &fs::Metadata) -> FileKind {
    let t = meta.file_type();
    if t.is_symlink() {
        FileKind::Symlink
    } else if t.is_dir() {
        FileKind::Dir
    } else if t.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    }
}

fn stat_of(meta: &fs::Metadata) -> FileStat {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    #[cfg(unix)]
    let mode = f64::from(std::os::unix::fs::PermissionsExt::mode(&meta.permissions()));
    #[cfg(not(unix))]
    let mode = 0.0;
    FileStat {
        kind: kind_of(meta),
        size: meta.len() as f64,
        mtime_ms,
        mode,
    }
}

/// A file system call carried out for real, failing as Node fails.
fn run_fs(op: &FsOp) -> Result<FsAnswer, NodeError> {
    match op {
        FsOp::ReadFile { path } => fs::read(path)
            .map(FsAnswer::Bytes)
            .map_err(|e| node_error(&e, "open", path)),
        FsOp::WriteFile {
            path, data, flag, ..
        } => {
            let mut options = fs::OpenOptions::new();
            options.write(true);
            if flag.as_deref() == Some("wx") {
                options.create_new(true);
            } else {
                options.create(true).truncate(true);
            }
            let mut file = options
                .open(path)
                .map_err(|e| node_error(&e, "open", path))?;
            std::io::Write::write_all(&mut file, data)
                .map_err(|e| node_error(&e, "write", path))?;
            Ok(FsAnswer::Unit)
        }
        FsOp::Mkdir {
            path, recursive, ..
        } => {
            let done = if *recursive {
                fs::create_dir_all(path)
            } else {
                fs::create_dir(path)
            };
            done.map(|()| FsAnswer::Unit)
                .map_err(|e| node_error(&e, "mkdir", path))
        }
        FsOp::Mkdtemp { prefix } => {
            // the world names temp folders by a counter, as world.ts does
            for n in 1..1000 {
                let path = format!("{prefix}{n:06}");
                match fs::create_dir(&path) {
                    Ok(()) => return Ok(FsAnswer::Path(path)),
                    Err(e) if code_of(&e) == Some("EEXIST") => continue,
                    Err(e) => return Err(node_error(&e, "mkdir", &path)),
                }
            }
            Err(NodeError {
                code: Some("EEXIST"),
                message: "no free temp name".into(),
            })
        }
        FsOp::Rm {
            path,
            recursive,
            force,
        } => {
            let meta = match fs::symlink_metadata(path) {
                Ok(m) => m,
                Err(e) if *force && code_of(&e) == Some("ENOENT") => return Ok(FsAnswer::Unit),
                Err(e) => return Err(node_error(&e, "lstat", path)),
            };
            let done = if meta.is_dir() {
                if !recursive {
                    return Err(NodeError {
                        code: Some("ERR_FS_EISDIR"),
                        message: format!(
                            "Path is a directory: rm returned EISDIR (is a directory) {path}"
                        ),
                    });
                }
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            };
            done.map(|()| FsAnswer::Unit)
                .map_err(|e| node_error(&e, "rm", path))
        }
        FsOp::Readdir { path, with_types } => {
            let mut entries: Vec<DirEntry> = fs::read_dir(path)
                .map_err(|e| node_error(&e, "scandir", path))?
                .filter_map(Result::ok)
                .map(|entry| DirEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind: with_types
                        .then(|| entry.metadata().ok().map(|m| kind_of(&m)))
                        .flatten(),
                })
                .collect();
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(FsAnswer::Entries(entries))
        }
        FsOp::Stat { path } => fs::metadata(path)
            .map(|m| FsAnswer::Stat(stat_of(&m)))
            .map_err(|e| node_error(&e, "stat", path)),
        FsOp::Lstat { path } => fs::symlink_metadata(path)
            .map(|m| FsAnswer::Stat(stat_of(&m)))
            .map_err(|e| node_error(&e, "lstat", path)),
        FsOp::Realpath { path } => fs::canonicalize(path)
            .map(|p| FsAnswer::Path(p.to_string_lossy().into_owned()))
            .map_err(|e| node_error(&e, "realpath", path)),
        FsOp::Readlink { path } => fs::read_link(path)
            .map(|p| FsAnswer::Path(p.to_string_lossy().into_owned()))
            .map_err(|e| node_error(&e, "readlink", path)),
        FsOp::Rename { from, to } => fs::rename(from, to)
            .map(|()| FsAnswer::Unit)
            .map_err(|e| node_error2(&e, "rename", from, to)),
        FsOp::Chmod { path, mode } => {
            #[cfg(unix)]
            {
                let perms = std::os::unix::fs::PermissionsExt::from_mode(*mode as u32);
                fs::set_permissions(path, perms)
                    .map(|()| FsAnswer::Unit)
                    .map_err(|e| node_error(&e, "chmod", path))
            }
            #[cfg(not(unix))]
            {
                let _ = (path, mode);
                Ok(FsAnswer::Unit)
            }
        }
    }
}

/// `os.tmpdir()` of Node on a POSIX system, from the world's environment.
fn tmpdir_of(env: &[(String, String)]) -> String {
    let get = |k: &str| {
        env.iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty())
    };
    let mut path = get("TMPDIR")
        .or_else(|| get("TMP"))
        .or_else(|| get("TEMP"))
        .unwrap_or_else(|| "/tmp".into());
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

/// Runs the call `start` makes in the world `world`; what it returned, or
/// an error when it never ended. `start` gets the handle, the caller's
/// signal (the one `abortAt` aborts) and the log.
pub(crate) fn drive<T: 'static, F>(
    world: Option<&Value>,
    cx: &mut Context,
    start: impl FnOnce(Rt, Signal, Sink) -> F,
) -> Result<T, CallError>
where
    F: Future<Output = T> + 'static,
{
    let empty = Value::Null;
    let spec = world.unwrap_or(&empty);
    let env: Vec<(String, String)> = spec
        .get("env")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let now = Rc::new(Cell::new(cx.now_ms));
    let clock = now.clone();
    let uuids = Cell::new(0u64);
    let mut random = 0u64;
    let home = env
        .iter()
        .find(|(k, _)| k == "HOME")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let host = HostInfo {
        platform: spec
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("linux")
            .to_owned(),
        pid: spec.get("pid").and_then(Value::as_f64).unwrap_or(1000.0),
        tmpdir: tmpdir_of(&env),
        homedir: home,
        env,
        clock: Box::new(move || clock.get()),
        uuid: Box::new(move || {
            uuids.set(uuids.get() + 1);
            uuid_of(uuids.get())
        }),
        random: Box::new(move |n| {
            (0..n)
                .map(|_| {
                    let b = (random % 256) as u8;
                    random += 1;
                    b
                })
                .collect()
        }),
    };
    let mut runtime = Runtime::new(host);
    let rt = runtime.rt().clone();
    let signal = rt.controller();
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let call = runtime.start(start(rt.clone(), signal.clone(), sink.clone()));
    let mut run = WorldRun {
        spec,
        sink: sink.clone(),
        now: now.clone(),
        fetches: 0,
        fetch_of: BTreeMap::new(),
        bodies: BTreeMap::new(),
        cancelled: BTreeSet::new(),
        timers: Vec::new(),
        timer_count: 0,
        children: BTreeMap::new(),
        child_count: 0,
        calls: 0,
        immediate: VecDeque::new(),
        later: VecDeque::new(),
    };
    // the caller's abort: timer 0
    const ABORT: Id = Id::MAX;
    if let Some(at) = spec.get("abortAt").and_then(Value::as_f64) {
        run.timers.push((0, at, ABORT));
    }
    for _ in 0..100_000 {
        for cmd in runtime.poll() {
            run.handle(cmd);
        }
        if !run.immediate.is_empty() {
            while let Some(event) = run.immediate.pop_front() {
                runtime.feed(event);
            }
            continue;
        }
        if let Some(later) = run.later.pop_front() {
            for event in run.emit(later) {
                runtime.feed(event);
            }
            continue;
        }
        if call.is_done() {
            break;
        }
        let Some(next) = run
            .timers
            .iter()
            .enumerate()
            .min_by(|a, b| a.1.1.total_cmp(&b.1.1).then(a.0.cmp(&b.0)))
            .map(|(k, _)| k)
        else {
            break;
        };
        let (_, at, id) = run.timers.remove(next);
        if at > now.get() {
            now.set(at);
        }
        if id == ABORT {
            signal.abort(None);
        } else {
            runtime.feed(Event::Timer { id });
        }
    }
    cx.logs.extend(sink.borrow_mut().drain(..));
    call.take()
        .ok_or_else(|| CallError::plain("the call never ended"))
}

/// A thrown value as the comparison's error: its `code` and message.
pub(crate) fn call_error(e: &JsError) -> CallError {
    CallError {
        code: match e.prop("code") {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        },
        message: e.message_or_string(),
    }
}
