//! `{diagram,epub,mindmap}/ai-attachments` of the `b5-agent-apps` part (see
//! the spec `tools/main-diff/groups/b5-agent-apps-attachments.ts`). The three
//! modules are separate ports with a host trait each; one fake implements
//! all three, and a small trait of this file (`App`) puts the three behind
//! one scenario. The tables of a case (`diagram`, `saved`, `parse`,
//! `hasFile`) are keyed by file name; each call of a stub is one log line.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::{Answer, Context, arg, out, out_list};
use crate::calls::fakes::FakeWindow;
use crate::node_fs::node_error;
use crate::packages::ai_provider::jsval::number;
use crate::packages::electron_utils::dialog_memory::{Dialog, DialogMemory};
use crate::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesHolder};
use crate::packages::i18n::Lang;

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

/// the stubs and the folder of a case
struct AttachFake {
    lang: Lang,
    temp: String,
    diagram: HashMap<String, String>,
    saved: HashMap<String, String>,
    parse: HashMap<String, Value>,
    now: f64,
    log: Log,
}

/// a file name of a path, of either separator
fn base_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn table(spec: &Value, key: &str) -> HashMap<String, Value> {
    spec.get(key)
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

impl AttachFake {
    fn of(ctx: &Value, now: f64, log: &Log) -> AttachFake {
        let strings = |key: &str| -> HashMap<String, String> {
            table(ctx, key)
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned())))
                .collect()
        };
        AttachFake {
            lang: if ctx.get("lang").and_then(Value::as_str) == Some("ko") {
                Lang::Ko
            } else {
                Lang::En
            },
            temp: ctx
                .get("temp")
                .and_then(Value::as_str)
                .unwrap_or("/tmp/none")
                .to_owned(),
            diagram: strings("diagram"),
            saved: strings("saved"),
            parse: table(ctx, "parse"),
            now,
            log: Rc::clone(log),
        }
    }

    fn record(&self, line: Vec<Value>) {
        self.log.borrow_mut().push(line);
    }

    fn stat_raw(&self, path: &str) -> Result<(f64, f64, bool), String> {
        let meta = fs::metadata(path).map_err(|e| node_error(&e, "stat", path).message)?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |d| {
                d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6
            });
        Ok((meta.len() as f64, mtime, meta.is_file()))
    }

    fn diagram_ext(&self, path: &str) -> Option<&'static str> {
        self.record(vec![Value::from("diagramPictureExtOf"), Value::from(path)]);
        match self.diagram.get(base_of(path)).map(String::as_str) {
            Some("drawio.svg") => Some("drawio.svg"),
            Some("drawio.png") => Some("drawio.png"),
            _ => None,
        }
    }

    fn temp_dir(&self) -> String {
        self.record(vec![Value::from("getPath"), Value::from("temp")]);
        self.temp.clone()
    }

    /// The open documents of the shell as the case scripts them: the file
    /// being read is open with unsaved changes when its name is in `saved`.
    /// Each ask of the source is one `assertFileSaved` line of the log.
    fn open_files(&self, file_path: Option<&JsonValue>) -> OpenFilesHolder {
        let path = match file_path {
            Some(JsonValue::String(path)) => path.clone(),
            _ => String::new(),
        };
        let dirty = self.saved.contains_key(base_of(&path));
        let log = Rc::clone(&self.log);
        let mut holder = OpenFilesHolder::new();
        holder.set_open_files_source(Some(Box::new(move || {
            log.borrow_mut().push(vec![
                Value::from("assertFileSaved"),
                Value::from(path.as_str()),
            ]);
            Ok(if dirty {
                vec![OpenFileState {
                    file_path: Some(path.clone()),
                    dirty: true,
                }]
            } else {
                Vec::new()
            })
        })));
        holder
    }

    /// `parseFileToText(path)`: `(ok, kind, text, damaged, error)`
    #[allow(clippy::type_complexity)]
    fn parsed(
        &self,
        path: &str,
    ) -> Result<(bool, Option<String>, Option<String>, bool, Option<String>), String> {
        self.record(vec![Value::from("parseFileToText"), Value::from(path)]);
        let Some(result) = self.parse.get(base_of(path)) else {
            return Ok((false, None, None, false, None));
        };
        if let Some(message) = result.get("throw").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        let text = |key: &str| result.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| result.get(key).and_then(Value::as_bool).unwrap_or(false);
        Ok((
            flag("ok"),
            text("kind"),
            text("text"),
            flag("damaged"),
            text("error"),
        ))
    }
}

/// the `AttachmentsHost` of one module over the fake
macro_rules! impl_host {
    ($app:ident) => {
        impl crate::$app::ai_attachments::AttachmentsHost for AttachFake {
            fn lang(&mut self) -> Lang {
                self.lang
            }

            fn stat(
                &mut self,
                path: &str,
            ) -> Result<crate::$app::ai_attachments::FileStat, String> {
                let (size, mtime_ms, is_file) = self.stat_raw(path)?;
                Ok(crate::$app::ai_attachments::FileStat {
                    size,
                    mtime_ms,
                    is_file,
                })
            }

            fn diagram_picture_ext_of(&mut self, path: &str) -> Option<&'static str> {
                self.diagram_ext(path)
            }

            fn temp_dir(&mut self) -> String {
                AttachFake::temp_dir(self)
            }

            fn now_ms(&mut self) -> f64 {
                self.now
            }

            fn make_dir(&mut self, dir: &str) -> Result<(), String> {
                fs::create_dir_all(dir).map_err(|e| node_error(&e, "mkdir", dir).message)
            }

            fn read_dir(&mut self, dir: &str) -> Result<Vec<String>, String> {
                let entries =
                    fs::read_dir(dir).map_err(|e| node_error(&e, "scandir", dir).message)?;
                Ok(entries
                    .filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect())
            }

            fn unlink(&mut self, path: &str) -> Result<(), String> {
                fs::remove_file(path).map_err(|e| node_error(&e, "unlink", path).message)
            }

            fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
                fs::write(path, bytes).map_err(|e| node_error(&e, "open", path).message)
            }

            fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String> {
                fs::read(path).map_err(|e| node_error(&e, "open", path).message)
            }

            fn parse_file_to_text(
                &mut self,
                path: &str,
            ) -> Result<crate::$app::ai_attachments::ParsedText, String> {
                let (ok, kind, text, damaged, error) = self.parsed(path)?;
                Ok(crate::$app::ai_attachments::ParsedText {
                    ok,
                    kind,
                    text,
                    damaged,
                    error,
                })
            }
        }
    };
}

impl_host!(diagram);
impl_host!(epub);
impl_host!(mindmap);

/// the dialog of a case: it logs `["showOpenDialog", "<window>"?, options]`
/// and answers `response`
struct AttachDialog {
    log: Log,
    response: Value,
}

impl Dialog for AttachDialog {
    type Window = FakeWindow;

    fn show_open_dialog(
        &mut self,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let mut line = vec![Value::from("showOpenDialog")];
        if parent.is_some() {
            line.push(Value::from("<window>"));
        }
        line.push(json_value_to_serde(&JsonValue::Object(options.clone())));
        self.log.borrow_mut().push(line);
        json_value_from_serde(&self.response)
    }

    fn show_save_dialog(
        &mut self,
        _parent: Option<&FakeWindow>,
        _options: &JsObject<JsonValue>,
    ) -> JsonValue {
        JsonValue::Null
    }
}

/// one of the three modules
trait App {
    type State;
    const REGISTER: &'static str;
    const SET_HOOK: Option<&'static str>;
    fn state() -> Self::State;
    fn exts() -> Vec<&'static str>;
    fn collect(host: &mut AttachFake, paths: &[JsonValue]) -> JsonValue;
    fn page(
        state: &mut Self::State,
        host: &mut AttachFake,
        file_path: Option<&JsonValue>,
        offset: Option<&JsonValue>,
        max_chars: Option<&JsonValue>,
    ) -> JsonValue;
    fn image(host: &mut AttachFake, file_path: Option<&JsonValue>) -> JsonValue;
    fn pick(
        host: &mut AttachFake,
        memory: &mut DialogMemory,
        dialog: &mut AttachDialog,
        parent: Option<&FakeWindow>,
    ) -> Result<Option<JsonValue>, String>;
    fn add_pasted(
        state: &mut Self::State,
        host: &mut AttachFake,
        data: Option<&[u8]>,
        ext: Option<&JsonValue>,
    ) -> Result<JsonValue, String>;
    /// `registerXAiIpc(options)`: whether the channels are registered now
    fn register(state: &mut Self::State) -> bool;
    fn set_hook(state: &mut Self::State, set: bool);
    /// the title the hook is given, if any
    fn title(
        state: &Self::State,
        has_file: &mut dyn FnMut() -> bool,
        title: Option<&JsonValue>,
    ) -> Option<String>;
}

macro_rules! common_methods {
    ($app:ident) => {
        type State = crate::$app::ai_attachments::AiAttachments;

        fn state() -> Self::State {
            crate::$app::ai_attachments::AiAttachments::new()
        }

        fn exts() -> Vec<&'static str> {
            crate::$app::ai_attachments::attachment_exts()
        }

        fn collect(host: &mut AttachFake, paths: &[JsonValue]) -> JsonValue {
            crate::$app::ai_attachments::collect_attachments(host, paths)
        }

        fn page(
            state: &mut Self::State,
            host: &mut AttachFake,
            file_path: Option<&JsonValue>,
            offset: Option<&JsonValue>,
            max_chars: Option<&JsonValue>,
        ) -> JsonValue {
            let open_files = host.open_files(file_path);
            state.read_attachment_page(host, &open_files, file_path, offset, max_chars)
        }

        fn image(host: &mut AttachFake, file_path: Option<&JsonValue>) -> JsonValue {
            crate::$app::ai_attachments::read_attachment_image(host, file_path)
        }

        fn pick(
            host: &mut AttachFake,
            memory: &mut DialogMemory,
            dialog: &mut AttachDialog,
            parent: Option<&FakeWindow>,
        ) -> Result<Option<JsonValue>, String> {
            crate::$app::ai_attachments::pick_attachments(host, memory, dialog, parent)
        }

        fn add_pasted(
            state: &mut Self::State,
            host: &mut AttachFake,
            data: Option<&[u8]>,
            ext: Option<&JsonValue>,
        ) -> Result<JsonValue, String> {
            state.add_pasted_image(host, data, ext)
        }
    };
}

struct Diagram;
struct Epub;
struct Mindmap;

impl App for Diagram {
    const REGISTER: &'static str = "registerDiagramAiIpc";
    const SET_HOOK: Option<&'static str> = Some("setDiagramProvisionalTitleHook");
    common_methods!(diagram);

    fn register(state: &mut Self::State) -> bool {
        state.register_ai_ipc()
    }

    fn set_hook(state: &mut Self::State, set: bool) {
        state.set_provisional_title_hook(set);
    }

    fn title(
        state: &Self::State,
        has_file: &mut dyn FnMut() -> bool,
        title: Option<&JsonValue>,
    ) -> Option<String> {
        crate::diagram::ai_attachments::provisional_title(state, has_file, title)
    }
}

impl App for Mindmap {
    const REGISTER: &'static str = "registerMindmapAiIpc";
    const SET_HOOK: Option<&'static str> = Some("setMindmapProvisionalTitleHook");
    common_methods!(mindmap);

    fn register(_state: &mut Self::State) -> bool {
        true
    }

    fn set_hook(state: &mut Self::State, set: bool) {
        state.set_provisional_title_hook(set);
    }

    fn title(
        state: &Self::State,
        has_file: &mut dyn FnMut() -> bool,
        title: Option<&JsonValue>,
    ) -> Option<String> {
        crate::mindmap::ai_attachments::provisional_title(state, has_file, title)
    }
}

impl App for Epub {
    const REGISTER: &'static str = "registerEpubAiIpc";
    const SET_HOOK: Option<&'static str> = None;
    common_methods!(epub);

    fn register(_state: &mut Self::State) -> bool {
        true
    }

    fn set_hook(_state: &mut Self::State, _set: bool) {}

    fn title(
        _state: &Self::State,
        _has_file: &mut dyn FnMut() -> bool,
        _title: Option<&JsonValue>,
    ) -> Option<String> {
        None
    }
}

fn paths_of(value: Option<&Value>) -> Vec<JsonValue> {
    match value.and_then(Value::as_array) {
        Some(items) => items.iter().map(json_value_from_serde).collect(),
        None => Vec::new(),
    }
}

/// a spec value that may be absent (`undefined`); `null` is kept
fn opt(value: Option<&Value>) -> Option<JsonValue> {
    value.map(json_value_from_serde)
}

fn run<A: App>(rest: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let ctx = arg(args, 1).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let mut host = AttachFake::of(&ctx, cx.now_ms, &log);
    let answer = match rest {
        "ATTACHMENT_MAX_BYTES" => Ok(Some(Value::from(50u64 * 1024 * 1024))),
        "ATTACHMENT_IMAGE_MAX_BYTES" => Ok(Some(Value::from(5u64 * 1024 * 1024))),
        "ATTACHMENT_READ_MAX_CHARS" => Ok(Some(Value::from(48000u64))),
        "ATTACHMENT_EXTS" => out_list(&A::exts()),
        "collectAttachments" => {
            let paths = paths_of(arg(args, 0));
            out(A::collect(&mut host, &paths))
        }
        "readAttachmentPage" => {
            let steps = arg(args, 0)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut state = A::state();
            let mut answers = Vec::new();
            for step in &steps {
                if let Some(write) = step.get("write") {
                    let path = write.get("path").and_then(Value::as_str).unwrap_or("");
                    let _ = fs::write(
                        path,
                        write.get("text").and_then(Value::as_str).unwrap_or(""),
                    );
                    if let Some(ms) = write.get("mtimeMs").and_then(Value::as_f64)
                        && let Ok(file) = fs::File::options().write(true).open(path)
                    {
                        let _ = file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64));
                    }
                } else if let Some(read) = step.get("read").and_then(Value::as_array) {
                    let at = |i: usize| opt(read.get(i));
                    let answer = A::page(
                        &mut state,
                        &mut host,
                        at(0).as_ref(),
                        at(1).as_ref(),
                        at(2).as_ref(),
                    );
                    answers.push(json_value_to_serde(&answer));
                }
            }
            Ok(Some(Value::Array(answers)))
        }
        "readAttachmentImage" => out(A::image(&mut host, opt(arg(args, 0)).as_ref())),
        _ if rest == A::REGISTER || Some(rest) == A::SET_HOOK => {
            return Some(scenario::<A>(args, cx, host, log));
        }
        _ => return None,
    };
    cx.logs.extend(log.borrow().iter().cloned());
    Some(answer)
}

/// the handlers of `ipcMain` of one module, step by step
fn scenario<A: App>(args: &[Value], cx: &mut Context, mut host: AttachFake, log: Log) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ctx = arg(args, 1).cloned().unwrap_or(Value::Null);
    let channels: Vec<String> = ctx
        .get("channels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| c.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let has_file_table = table(&ctx, "hasFile");
    let mut state = A::state();
    let mut memory = DialogMemory::new();
    let mut dialog = AttachDialog {
        log: Rc::clone(&log),
        response: Value::Null,
    };
    let mut registered: Vec<Value> = Vec::new();
    let mut answers: Vec<Value> = Vec::new();
    for step in &steps {
        if step.get("register").and_then(Value::as_bool) == Some(true) {
            let now: Vec<Value> = if A::register(&mut state) {
                channels.iter().map(|c| Value::from(c.as_str())).collect()
            } else {
                Vec::new()
            };
            registered.extend(now.iter().cloned());
            answers.push(Value::Array(now));
        } else if let Some(set) = step.get("hook").and_then(Value::as_bool) {
            A::set_hook(&mut state, set);
            answers.push(Value::Null);
        } else if let Some(pick) = step.get("pick") {
            dialog.response = pick.get("response").cloned().unwrap_or(Value::Null);
            let parent = match pick.get("win").and_then(Value::as_str) {
                Some("sender") | Some("focused") => Some(FakeWindow { destroyed: false }),
                _ => None,
            };
            let picked = A::pick(&mut host, &mut memory, &mut dialog, parent.as_ref());
            answers.push(match picked {
                Ok(Some(value)) => json_value_to_serde(&value),
                Ok(None) => Value::Null,
                Err(message) => error_value(&message),
            });
        } else if let Some(add) = step.get("add") {
            answers.push(json_value_to_serde(&A::collect(
                &mut host,
                &paths_of(Some(add)),
            )));
        } else if let Some(paste) = step.get("paste") {
            let hex = paste.get("hex").and_then(Value::as_str).unwrap_or("");
            let bytes = super::hex_bytes(hex);
            let data = match paste.get("kind").and_then(Value::as_str) {
                Some("buffer") | Some("view") => Some(bytes.as_slice()),
                _ => None,
            };
            let ext = opt(paste.get("ext"));
            answers.push(
                match A::add_pasted(&mut state, &mut host, data, ext.as_ref()) {
                    Ok(value) => json_value_to_serde(&value),
                    Err(message) => error_value(&message),
                },
            );
        } else if let Some(read) = step.get("read").and_then(Value::as_array) {
            let at = |i: usize| opt(read.get(i));
            let page = A::page(
                &mut state,
                &mut host,
                at(0).as_ref(),
                at(1).as_ref(),
                at(2).as_ref(),
            );
            answers.push(json_value_to_serde(&page));
        } else if let Some(image) = step.get("readImage") {
            let image = json_value_from_serde(image);
            answers.push(json_value_to_serde(&A::image(&mut host, Some(&image))));
        } else if let Some(title) = step.get("title") {
            let sender = title.get("sender").and_then(Value::as_f64).unwrap_or(5.0);
            let value = opt(title.get("value"));
            let table = &has_file_table;
            let log_ref = Rc::clone(&log);
            let mut has_file = || {
                log_ref.borrow_mut().push(vec![
                    Value::from("hasFile"),
                    json_value_to_serde(&number(sender)),
                ]);
                table
                    .get(&jscompat::number_to_string(sender))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            if let Some(clean) = A::title(&state, &mut has_file, value.as_ref()) {
                log.borrow_mut().push(vec![
                    Value::from("hook"),
                    json_value_to_serde(&number(sender)),
                    Value::from(clean),
                ]);
            }
            answers.push(Value::Null);
        }
    }
    cx.logs.extend(log.borrow().iter().cloned());
    let mut answer = Map::new();
    answer.insert("answers".into(), Value::Array(answers));
    answer.insert("registered".into(), Value::Array(registered));
    Ok(Some(Value::Object(answer)))
}

/// `{ error }` of a handler that rejected
fn error_value(message: &str) -> Value {
    let mut map = Map::new();
    map.insert("error".into(), Value::from(message));
    Value::Object(map)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let (app, rest) = name.split_once("/ai-attachments.")?;
    match app {
        "diagram" => run::<Diagram>(rest, args, cx),
        "epub" => run::<Epub>(rest, args, cx),
        "mindmap" => run::<Mindmap>(rest, args, cx),
        _ => None,
    }
}
