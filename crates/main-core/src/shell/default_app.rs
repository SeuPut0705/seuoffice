//! `apps/shell/src/main/default-app.ts`.
//!
//! macOS writes the LaunchServices user choice via osascript, Linux via
//! xdg-mime; Windows apps cannot set defaults, only open the page. The
//! commands run through [`DefaultAppHost::run`] (the `RunCommand` of the
//! TypeScript), whose rejection is its `Err`.
//!
//! The TypeScript starts the queries of a platform together (`Promise.all`);
//! the commands are issued here in the same order, and on Windows in the same
//! rounds: every type's `UserChoice` query, then the class-default query of
//! each type that needs one.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsonValue, encode_uri_component, js_regex, json_parse, replace_first, trim};
use serde::Serialize;

use crate::node_fs::code_of;

/// `OfficeType`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfficeType {
    pub ext: &'static str,
    pub uti: &'static str,
    pub mime: &'static str,
    /// Windows ProgId written by the NSIS installer = win.fileAssociations[].name in electron-builder.cjs
    pub prog_id: &'static str,
}

/// `OFFICE_TYPES`
pub const OFFICE_TYPES: [OfficeType; 7] = [
    OfficeType {
        ext: "docx",
        uti: "org.openxmlformats.wordprocessingml.document",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        prog_id: "seuoffice.WordDocument",
    },
    OfficeType {
        ext: "xlsx",
        uti: "org.openxmlformats.spreadsheetml.sheet",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        prog_id: "seuoffice.ExcelWorkbook",
    },
    OfficeType {
        ext: "xlsm",
        uti: "org.openxmlformats.spreadsheetml.sheet.macroenabled",
        mime: "application/vnd.ms-excel.sheet.macroEnabled.12",
        prog_id: "seuoffice.ExcelMacroEnabledWorkbook",
    },
    OfficeType {
        ext: "xls",
        uti: "com.microsoft.excel.xls",
        mime: "application/vnd.ms-excel",
        prog_id: "seuoffice.Excel972003Workbook",
    },
    OfficeType {
        ext: "pptx",
        uti: "org.openxmlformats.presentationml.presentation",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        prog_id: "seuoffice.PowerPointPresentation",
    },
    OfficeType {
        ext: "drawio",
        uti: "com.jgraph.drawio",
        mime: "application/vnd.jgraph.mxfile",
        prog_id: "seuoffice.Diagram",
    },
    OfficeType {
        ext: "dio",
        uti: "com.jgraph.drawio",
        mime: "application/vnd.jgraph.mxfile",
        prog_id: "seuoffice.Diagram",
    },
];

const LINUX_DESKTOP_ID: &str = "seuoffice.desktop";
const WINDOWS_DEFAULT_APPS_URL: &str = "ms-settings:defaultapps";

/// `DefaultAppStatus['state']`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultAppState {
    Unsupported,
    Unknown,
    Default,
    Other,
}

/// `DefaultAppStatus`. `others` holds strings; a macOS reply of an odd shape
/// (see [`parse_mac_status`]) can put another JSON value there, and
/// `undefined` is written `null` as `JSON.stringify` writes it in an array.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DefaultAppStatus {
    pub state: DefaultAppState,
    pub others: Vec<JsonValue>,
    #[serde(rename = "manualOnly")]
    pub manual_only: bool,
}

/// the `UNSUPPORTED` status
fn unsupported() -> DefaultAppStatus {
    DefaultAppStatus {
        state: DefaultAppState::Unsupported,
        others: Vec::new(),
        manual_only: false,
    }
}

/// `DefaultAppDeps` without its functions: they are [`DefaultAppHost`].
#[derive(Debug, Clone, PartialEq)]
pub struct DefaultAppDeps {
    /// `NodeJS.Platform`: `darwin`, `linux`, `win32`, ...
    pub platform: String,
    /// packaged app only: dev builds run inside Electron.app and must never claim the types
    pub packaged: bool,
    pub exe_path: String,
    /// the value name build/installer.nsh writes under Software\RegisteredApplications
    pub registered_app_name: String,
    /// `homedir()`
    pub home_dir: String,
}

/// `run`, `openExternal` and `readFile` of `DefaultAppDeps`
pub trait DefaultAppHost {
    /// `RunCommand`: the standard output, or the message of the rejection
    fn run(&mut self, cmd: &str, args: &[String]) -> Result<String, String>;
    fn open_external(&mut self, url: &str) -> Result<(), String>;
    /// `readFile`, by default `readFileSync(p, 'utf8')`
    fn read_file(&mut self, path: &str) -> Result<String, String> {
        read_file_utf8(path)
    }
}

/// `readFileSync(path, 'utf8')`: ill-formed bytes become U+FFFD, a byte order mark stays
pub fn read_file_utf8(path: &str) -> Result<String, String> {
    std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| e.to_string())
}

/// What `execFile` rejects with: the `code` a string error carries
/// (`ENOENT`) and its message.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecError {
    pub code: Option<String>,
    pub message: String,
}

const EXEC_TIMEOUT: Duration = Duration::from_millis(15_000);
/// `execFile`'s default `maxBuffer`
const EXEC_MAX_BUFFER: usize = 1024 * 1024;

/// `execFileRunner(cmd, args)`: `execFile` with a 15 s timeout, without a shell.
pub fn exec_file_runner(cmd: &str, args: &[String]) -> Result<String, ExecError> {
    let mut command = Command::new(cmd);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // windowsHide
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| ExecError {
        code: code_of(&e).map(str::to_string),
        message: format!("spawn {cmd} {}", code_of(&e).unwrap_or("UNKNOWN")),
    })?;
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = out.read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = err.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= EXEC_TIMEOUT => {
                #[cfg(unix)]
                // killSignal 'SIGTERM'
                unsafe {
                    libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
                }
                #[cfg(not(unix))]
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break None,
        }
    };
    drop(child.stdin.take());
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    for (name, bytes) in [("stdout", &stdout), ("stderr", &stderr)] {
        if bytes.len() > EXEC_MAX_BUFFER {
            return Err(ExecError {
                code: Some("ERR_CHILD_PROCESS_STDIO_MAXBUFFER".to_string()),
                message: format!("{name} maxBuffer length exceeded"),
            });
        }
    }
    if status.is_some_and(|status| status.success()) {
        return Ok(String::from_utf8_lossy(&stdout).into_owned());
    }
    let mut command_line = cmd.to_string();
    if !args.is_empty() {
        command_line.push(' ');
        command_line.push_str(&args.join(" "));
    }
    Err(ExecError {
        code: None,
        message: format!(
            "Command failed: {command_line}\n{}",
            String::from_utf8_lossy(&stderr)
        ),
    })
}

/// `macAppBundlePath(exePath)`: `/Applications/SeuOffice.app/Contents/MacOS/SeuOffice`
/// gives `/Applications/SeuOffice.app`
pub fn mac_app_bundle_path(exe_path: &str) -> Option<String> {
    let mut dir = exe_path.to_string();
    for _ in 0..6 {
        dir = dirname(&dir);
        if dir.ends_with(".app") {
            return Some(dir);
        }
        if dir == dirname(&dir) {
            break;
        }
    }
    None
}

// JXA: argv[0] = our .app path, argv[1..] = UTIs -> JSON [{uti, id, name}] of the
// current handler per type (id === own bundle id when we are the default).
const MAC_STATUS_SCRIPT: &str = r#"function run(argv) {
  ObjC.import('CoreServices'); ObjC.import('AppKit')
  var ws = $.NSWorkspace.sharedWorkspace
  var me = $.NSBundle.bundleWithPath(argv[0]).bundleIdentifier.js
  var out = { me: me, types: [] }
  for (var i = 1; i < argv.length; i++) {
    var ref = $.LSCopyDefaultRoleHandlerForContentType($(argv[i]), 0xFFFFFFFF)
    var obj = ObjC.castRefToObject(ref)
    var id = obj.isNil() ? null : obj.js
    var name = null
    if (id) {
      var url = ws.URLForApplicationWithBundleIdentifier(id)
      if (!url.isNil()) {
        var b = $.NSBundle.bundleWithURL(url)
        name = ObjC.unwrap(b.objectForInfoDictionaryKey('CFBundleDisplayName')) ||
          ObjC.unwrap(b.objectForInfoDictionaryKey('CFBundleName')) || null
      }
    }
    out.types.push({ uti: argv[i], id: id, name: name })
  }
  return JSON.stringify(out)
}"#;

const MAC_SET_SCRIPT: &str = r#"function run(argv) {
  ObjC.import('CoreServices')
  var me = $.NSBundle.bundleWithPath(argv[0]).bundleIdentifier.js
  var failed = []
  for (var i = 1; i < argv.length; i++) {
    if ($.LSSetDefaultRoleHandlerForContentType($(argv[i]), 0xFFFFFFFF, $(me)) !== 0) failed.push(argv[i])
  }
  return JSON.stringify({ me: me, failed: failed })
}"#;

/// a JavaScript value, `None` being `undefined`
type JsValue = Option<JsonValue>;

/// `a === b`: objects and arrays are never the same one here
fn strict_equals(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(JsonValue::Array(_) | JsonValue::Object(_)), Some(_)) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `summarize(owners, ours)`
fn summarize(owners: &[JsValue], ours: &dyn Fn(&JsValue) -> bool) -> DefaultAppStatus {
    let mut others: Vec<JsValue> = Vec::new();
    let mut all_ours = true;
    let mut known = false;
    for owner in owners {
        if matches!(owner, Some(JsonValue::Null)) {
            all_ours = false;
            continue;
        }
        known = true;
        if ours(owner) {
            continue;
        }
        all_ours = false;
        if !others.iter().any(|held| strict_equals(held, owner)) {
            others.push(owner.clone());
        }
    }
    if !known {
        return DefaultAppStatus {
            state: DefaultAppState::Unknown,
            others: Vec::new(),
            manual_only: false,
        };
    }
    DefaultAppStatus {
        state: if all_ours {
            DefaultAppState::Default
        } else {
            DefaultAppState::Other
        },
        others: others
            .into_iter()
            .map(|owner| owner.unwrap_or(JsonValue::Null))
            .collect(),
        manual_only: false,
    }
}

/// What a TypeScript expression throws, as `err.message` shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsThrow(pub String);

fn read_of(value: &JsonValue, key: &str) -> Result<JsValue, JsThrow> {
    if matches!(value, JsonValue::Null) {
        return Err(JsThrow(format!(
            "Cannot read properties of null (reading '{key}')"
        )));
    }
    Ok(value.get(key).map(std::borrow::Cow::into_owned))
}

/// `parseMacStatus(json)`. `Err` is what the TypeScript throws: the shapes
/// that make a property read or `data.types.map` fail carry V8's message. The
/// message of a text that is no JSON is not V8's (`JSON.parse` messages quote
/// the text), so it is not reproduced.
pub fn parse_mac_status(json: &str) -> Result<DefaultAppStatus, JsThrow> {
    let data = json_parse(json).map_err(|e| JsThrow(e.to_string()))?;
    let types = read_of(&data, "types")?;
    let types = match types {
        None => {
            return Err(JsThrow(
                "Cannot read properties of undefined (reading 'map')".to_string(),
            ));
        }
        Some(JsonValue::Null) => {
            return Err(JsThrow(
                "Cannot read properties of null (reading 'map')".to_string(),
            ));
        }
        Some(JsonValue::Array(items)) => items,
        Some(_) => return Err(JsThrow("data.types.map is not a function".to_string())),
    };
    let me = read_of(&data, "me")?;
    let mut owners: Vec<JsValue> = Vec::new();
    for t in &types {
        let id = read_of(t, "id")?;
        let owner = if matches!(id, Some(JsonValue::Null)) {
            Some(JsonValue::Null)
        } else if strict_equals(&id, &me) {
            me.clone()
        } else {
            // `t.name ?? t.id`
            match read_of(t, "name")? {
                Some(JsonValue::Null) | None => id,
                name => name,
            }
        };
        owners.push(owner);
    }
    Ok(summarize(&owners, &|id| strict_equals(id, &me)))
}

fn string_owner(text: &str) -> JsValue {
    Some(JsonValue::String(text.to_string()))
}

/// `parseLinuxStatus(outputs)`
pub fn parse_linux_status(outputs: &[String]) -> DefaultAppStatus {
    let owners: Vec<JsValue> = outputs
        .iter()
        .map(|o| {
            let trimmed = trim(o);
            if trimmed.is_empty() {
                Some(JsonValue::Null)
            } else {
                string_owner(trimmed)
            }
        })
        .collect();
    summarize(
        &owners,
        &|id| matches!(id, Some(JsonValue::String(text)) if text == LINUX_DESKTOP_ID),
    )
}

/// `parseRegValue(output)`: value of a `reg query` line:
/// `    ProgId    REG_SZ    Word.Document.12`
pub fn parse_reg_value(output: &str) -> Option<String> {
    for line in js_regex!(r"\r?\n").split(output) {
        if let Some(m) = js_regex!(r"^\s*\S.*?\s+REG_\w+\s+(.+?)\s*$").exec(line) {
            return m.get(1).map(str::to_string);
        }
    }
    None
}

/// `linuxDesktopName(id, readFile)`
fn linux_desktop_name(
    id: &str,
    read_file: &mut dyn FnMut(&str) -> Result<String, String>,
    home_dir: &str,
) -> String {
    let dirs = [
        join(&[home_dir, ".local/share/applications"]),
        "/usr/local/share/applications".to_string(),
        "/usr/share/applications".to_string(),
    ];
    for dir in &dirs {
        // not installed there: the read throws
        let Ok(text) = read_file(&join(&[dir.as_str(), id])) else {
            continue;
        };
        if let Some(m) = js_regex!(r"^Name=(.+)$", "m").exec(&text) {
            return trim(m.get(1).unwrap_or("")).to_string();
        }
    }
    replace_first(js_regex!(r"\.desktop$"), 0, id, "")
}

/// the object `createDefaultAppService(deps)` returns
pub struct DefaultAppService<H: DefaultAppHost> {
    deps: DefaultAppDeps,
    host: H,
    mac_bundle: Option<String>,
}

/// `createDefaultAppService(deps)`
pub fn create_default_app_service<H: DefaultAppHost>(
    deps: DefaultAppDeps,
    host: H,
) -> DefaultAppService<H> {
    let mac_bundle = if deps.platform == "darwin" {
        mac_app_bundle_path(&deps.exe_path)
    } else {
        None
    };
    DefaultAppService {
        deps,
        host,
        mac_bundle,
    }
}

fn utis() -> Vec<String> {
    OFFICE_TYPES.iter().map(|t| t.uti.to_string()).collect()
}

fn mimes() -> Vec<String> {
    OFFICE_TYPES.iter().map(|t| t.mime.to_string()).collect()
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_string()).collect()
}

impl<H: DefaultAppHost> DefaultAppService<H> {
    /// the host the service runs its commands through
    pub fn host(&self) -> &H {
        &self.host
    }

    /// `status()`
    pub fn status(&mut self) -> DefaultAppStatus {
        if !self.deps.packaged {
            return unsupported();
        }
        match self.status_of_platform() {
            Ok(Some(status)) => status,
            Ok(None) => unsupported(),
            Err(()) => DefaultAppStatus {
                state: DefaultAppState::Unknown,
                others: Vec::new(),
                manual_only: self.deps.platform == "win32",
            },
        }
    }

    /// the `try` block of `status()`: `Err` is what its `catch` takes
    fn status_of_platform(&mut self) -> Result<Option<DefaultAppStatus>, ()> {
        match self.deps.platform.as_str() {
            "darwin" => {
                let Some(bundle) = self.mac_bundle.clone() else {
                    return Ok(Some(unsupported()));
                };
                let mut args = strings(&["-l", "JavaScript", "-e", MAC_STATUS_SCRIPT]);
                args.push(bundle);
                args.extend(utis());
                let out = self.host.run("osascript", &args).map_err(|_| ())?;
                parse_mac_status(&out).map(Some).map_err(|_| ())
            }
            "linux" => {
                // every query is started before the first answer is awaited
                let results: Vec<Result<String, String>> = mimes()
                    .iter()
                    .map(|m| {
                        self.host
                            .run("xdg-mime", &strings(&["query", "default", m]))
                    })
                    .collect();
                let outs = results
                    .into_iter()
                    .collect::<Result<Vec<String>, String>>()
                    .map_err(|_| ())?;
                let mut st = parse_linux_status(&outs);
                let home = self.deps.home_dir.clone();
                let host = &mut self.host;
                st.others = st
                    .others
                    .iter()
                    .map(|id| {
                        let id = match id {
                            JsonValue::String(id) => id.as_str(),
                            _ => "",
                        };
                        JsonValue::String(linux_desktop_name(
                            id,
                            &mut |p: &str| host.read_file(p),
                            &home,
                        ))
                    })
                    .collect();
                Ok(Some(st))
            }
            "win32" => {
                let owners = self.windows_owners();
                let owners: Vec<JsValue> = owners
                    .into_iter()
                    .map(|owner| Some(owner.map_or(JsonValue::Null, JsonValue::String)))
                    .collect();
                let st = summarize(&owners, &|id| {
                    matches!(id, Some(JsonValue::String(id))
                        if OFFICE_TYPES.iter().any(|t| t.prog_id == id))
                });
                let ids: Vec<String> = st
                    .others
                    .iter()
                    .map(|id| match id {
                        JsonValue::String(id) => id.clone(),
                        _ => String::new(),
                    })
                    .collect();
                let mut names: Vec<JsonValue> = Vec::new();
                for id in &ids {
                    let name = JsonValue::String(self.windows_prog_id_name(id));
                    // `[...new Set(names)]`
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
                Ok(Some(DefaultAppStatus {
                    state: st.state,
                    others: names,
                    manual_only: true,
                }))
            }
            _ => Ok(None),
        }
    }

    /// `windowsOwner(t)` of every type: the queries of all types run in
    /// rounds, as the promises interleave
    fn windows_owners(&mut self) -> Vec<Option<String>> {
        let mut owners: Vec<Option<String>> = vec![None; OFFICE_TYPES.len()];
        let mut second: Vec<usize> = Vec::new();
        for (i, t) in OFFICE_TYPES.iter().enumerate() {
            let user_choice = format!(
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\UserChoice",
                t.ext
            );
            let answer = self
                .host
                .run("reg", &strings(&["query", &user_choice, "/v", "ProgId"]));
            // no explicit user choice: fall through to the class default
            match answer.ok().and_then(|out| parse_reg_value(&out)) {
                Some(v) if !v.is_empty() => owners[i] = Some(v),
                _ => second.push(i),
            }
        }
        for i in second {
            let key = format!("HKCR\\.{}", OFFICE_TYPES[i].ext);
            owners[i] = self
                .host
                .run("reg", &strings(&["query", &key, "/ve"]))
                .ok()
                .and_then(|out| parse_reg_value(&out));
        }
        owners
    }

    /// `windowsProgIdName(progId)`
    fn windows_prog_id_name(&mut self, prog_id: &str) -> String {
        let key = format!("HKCR\\{prog_id}");
        match self.host.run("reg", &strings(&["query", &key, "/ve"])) {
            Ok(out) => parse_reg_value(&out).unwrap_or_else(|| prog_id.to_string()),
            Err(_) => prog_id.to_string(),
        }
    }

    /// `windowsDefaultAppsUrl()`: Windows 11 (21H2/22H2 with the 2023-04
    /// update, 23H2 and later) opens the app's own page when told where the
    /// installer registered it: HKCU for a per-user install, HKLM for an
    /// all-users one. Older builds show the list.
    fn windows_default_apps_url(&mut self) -> String {
        for (hive, param) in [
            ("HKCU", "registeredAppUser"),
            ("HKLM", "registeredAppMachine"),
        ] {
            let key = format!("{hive}\\Software\\RegisteredApplications");
            let name = self.deps.registered_app_name.clone();
            // not registered in this hive: the query rejects
            if let Ok(out) = self
                .host
                .run("reg", &strings(&["query", &key, "/v", &name]))
                && parse_reg_value(&out).is_some()
            {
                return format!(
                    "{WINDOWS_DEFAULT_APPS_URL}?{param}={}",
                    encode_uri_component(&name)
                );
            }
        }
        WINDOWS_DEFAULT_APPS_URL.to_string()
    }

    /// `set()`: apply (mac/linux) or open the system page (win); the status afterwards
    pub fn set(&mut self) -> DefaultAppStatus {
        if !self.deps.packaged {
            return unsupported();
        }
        // status() below reports whatever actually stuck
        let _ = self.apply();
        self.status()
    }

    fn apply(&mut self) -> Result<(), String> {
        if self.deps.platform == "darwin" && self.mac_bundle.is_some() {
            let mut args = strings(&["-l", "JavaScript", "-e", MAC_SET_SCRIPT]);
            args.push(self.mac_bundle.clone().expect("checked above"));
            args.extend(utis());
            self.host.run("osascript", &args)?;
        } else if self.deps.platform == "linux" {
            let mut args = strings(&["default", LINUX_DESKTOP_ID]);
            args.extend(mimes());
            self.host.run("xdg-mime", &args)?;
        } else if self.deps.platform == "win32" {
            let url = self.windows_default_apps_url();
            self.host.open_external(&url)?;
        }
        Ok(())
    }
}
