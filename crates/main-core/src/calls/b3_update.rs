//! The functions of group `b3-update` (tools/main-diff/groups/b3-update.ts).

use super::{Answer, CallError, Context, arg, str_arg};
use crate::shell::mac_update::{
    self, MAC_SWAP_SCRIPT, SpawnOptions, StartMacSwap, SwapChild, default_writable,
};
use crate::shell::update_notes;
use crate::shell::update_restart::{self, UpdateRestart};
use crate::shell::update_resume::{
    self, BodyRead, DownloadOptions, FetchResponse, Progress, RESPONSE_TIMEOUT_MS, ResponseBody,
    ResumeEnv, STALL_TIMEOUT_MS,
};
use jscompat::node_path::host::join;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::rc::Rc;

type Logs = Rc<RefCell<Vec<Vec<Value>>>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "update-restart.requestUpdateRestart" => restart(args, "request"),
        "update-restart.cancelUpdateRestart" => restart(args, "cancel"),
        "update-restart.updateRestartRequested" => restart(args, "query"),
        "update-restart.reopenedByInstaller" => reopened_by_installer(args),
        "update-notes.normalizeReleaseNotes" => {
            let null = Value::Null;
            let input = arg(args, 0).unwrap_or(&null);
            Ok(Some(match update_notes::normalize_release_notes(input) {
                Some(notes) => serde_json::to_value(&notes).expect("notes serialize"),
                None => Value::Null,
            }))
        }
        "update-resume.installResumeDownload" => install_resume_download(args, cx),
        "mac-update.macAppBundle" => str_arg(args, 0)
            .map(|p| Some(mac_update::mac_app_bundle(p).map_or(Value::Null, Value::from))),
        "mac-update.macStagingDir" => {
            str_arg(args, 0).map(|b| Some(Value::from(mac_update::mac_staging_dir(b))))
        }
        "mac-update.macPreviousDir" => {
            str_arg(args, 0).map(|b| Some(Value::from(mac_update::mac_previous_dir(b))))
        }
        "mac-update.macSelfUpdateBlock" => mac_self_update_block(args, cx),
        "mac-update.removeMacLeftovers" => str_arg(args, 0).map(|b| {
            mac_update::remove_mac_leftovers(b);
            None
        }),
        "mac-update.runProgram" => run_program(args),
        "mac-update.stageMacUpdate" => stage_mac_update(args, cx),
        "mac-update.installMacStaging" => install_mac_staging(args, cx),
        "mac-update.MAC_SWAP_SCRIPT" => Ok(Some(Value::from(MAC_SWAP_SCRIPT))),
        "mac-update.startMacSwap" => start_mac_swap(args, cx),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn flush(logs: &Logs, cx: &mut Context) {
    cx.logs.append(&mut logs.borrow_mut());
}

fn text_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

// ---------- update-restart.ts ----------

/// The ops reset the module state, apply the listed `request`/`cancel` calls,
/// then the function under test runs; `request` and `cancel` answer the state
/// before and after, `query` the state.
fn restart(args: &[Value], function: &str) -> Answer {
    let mut state = UpdateRestart::new();
    for op in text_list(arg(args, 0)) {
        match op.as_str() {
            "request" => state.request_update_restart(),
            "cancel" => state.cancel_update_restart(),
            _ => {}
        }
    }
    let before = state.update_restart_requested();
    match function {
        "request" => state.request_update_restart(),
        "cancel" => state.cancel_update_restart(),
        _ => return Ok(Some(Value::Bool(before))),
    }
    Ok(Some(json!([before, state.update_restart_requested()])))
}

fn reopened_by_installer(args: &[Value]) -> Answer {
    let argv = text_list(arg(args, 0));
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    Ok(Some(Value::Bool(update_restart::reopened_by_installer(
        &refs,
    ))))
}

// ---------- mac-update.ts ----------

/// `probe.replace(/\d+$/, '#')`
fn mask_pid(probe: &str) -> String {
    let stem = probe.trim_end_matches(|c: char| c.is_ascii_digit());
    if stem.len() == probe.len() {
        probe.to_string()
    } else {
        format!("{stem}#")
    }
}

fn mac_self_update_block(args: &[Value], cx: &mut Context) -> Answer {
    let exec_path = str_arg(args, 0)?;
    let pid = f64::from(std::process::id());
    let block = match arg(args, 1) {
        Some(Value::Bool(verdict)) => {
            let verdict = *verdict;
            let mut writable = |dir: &str, probe: &str| {
                cx.logs
                    .push(vec![json!("writable"), json!(dir), json!(mask_pid(probe))]);
                verdict
            };
            mac_update::mac_self_update_block(exec_path, pid, &mut writable)
        }
        _ => mac_update::mac_self_update_block(exec_path, pid, &mut |d, p| default_writable(d, p)),
    };
    Ok(Some(block.map_or(Value::Null, |b| Value::from(b.as_str()))))
}

fn run_program(args: &[Value]) -> Answer {
    let file = str_arg(args, 0)?;
    let argv = text_list(arg(args, 1));
    mac_update::run_program(file, &argv)
        .map(|out| Some(Value::from(out)))
        .map_err(CallError::plain)
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

/// The `run` the harness fakes on both sides.
fn stage_mac_update(args: &[Value], cx: &mut Context) -> Answer {
    let zip = str_arg(args, 0)?;
    let bundle = str_arg(args, 1)?;
    let version = str_arg(args, 2)?;
    let script = arg(args, 3).cloned().unwrap_or(Value::Null);
    let logs: Logs = Rc::default();
    let run_logs = logs.clone();
    let step_logs = logs.clone();
    let mut run = move |file: &str, argv: &[String]| -> Result<String, String> {
        run_logs
            .borrow_mut()
            .push(vec![json!("run"), json!(file), json!(argv)]);
        match file {
            "/usr/bin/ditto" => {
                if let Some(e) = script.get("dittoError").and_then(Value::as_str) {
                    return Err(e.to_string());
                }
                for name in text_list(script.get("ditto")) {
                    let _ = std::fs::create_dir_all(join(&[&argv[3], &name]));
                }
                Ok(String::new())
            }
            "/usr/libexec/PlistBuddy" => {
                let key = argv[1].strip_prefix("Print :").unwrap_or(&argv[1]);
                let side = if argv[2].contains(".update") {
                    "staged"
                } else {
                    "installed"
                };
                match script
                    .get("plist")
                    .and_then(|p| p.get(side))
                    .and_then(|s| s.get(key))
                {
                    Some(Value::String(v)) => Ok(v.clone()),
                    Some(other) => Err(other
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()),
                    None => Err("no key".to_string()),
                }
            }
            "/usr/bin/codesign" => match script.get("codesignError").and_then(Value::as_str) {
                Some(e) => Err(e.to_string()),
                None => Ok(String::new()),
            },
            _ => Err("unexpected program".to_string()),
        }
    };
    let mut step = move |s: &str| step_logs.borrow_mut().push(vec![json!("step"), json!(s)]);
    let result = mac_update::stage_mac_update(zip, bundle, version, &mut run, &mut step);
    flush(&logs, cx);
    result
        .map(|staged| Some(Value::from(staged)))
        .map_err(CallError::from)
}

fn install_mac_staging(args: &[Value], cx: &mut Context) -> Answer {
    let shape = arg(args, 0).cloned().unwrap_or(Value::Null);
    let event = arg(args, 1).cloned().unwrap_or(Value::Null);
    let stage_error = arg(args, 2).and_then(Value::as_str).map(str::to_owned);
    let is_fn = |key: &str| shape.get(key).and_then(Value::as_str) == Some("fn");
    let installed = mac_update::install_mac_staging(is_fn("updateDownloaded"), is_fn("dispatch"));
    if !installed {
        return Ok(Some(json!({ "installed": false, "replaced": false })));
    }
    let logs: Logs = Rc::default();
    let stage_logs = logs.clone();
    let dispatch_logs = logs.clone();
    let result = mac_update::staged_update_downloaded(
        &event,
        &mut |zip, version| {
            stage_logs
                .borrow_mut()
                .push(vec![json!("stage"), zip.clone(), version.clone()]);
            match &stage_error {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        },
        &mut |e| {
            dispatch_logs
                .borrow_mut()
                .push(vec![json!("dispatch"), e.clone()]);
        },
    );
    flush(&logs, cx);
    Ok(Some(match result {
        Ok(list) => json!({ "installed": true, "result": list }),
        Err(message) => json!({ "installed": true, "error": message }),
    }))
}

struct FakeChild {
    logs: Logs,
    pid: bool,
    on_throws: Option<String>,
    unref_throws: Option<String>,
}

impl SwapChild for FakeChild {
    fn on_error_ignore(&mut self) -> Result<(), String> {
        self.logs
            .borrow_mut()
            .push(vec![json!("on"), json!("error")]);
        self.on_throws.clone().map_or(Ok(()), Err)
    }
    fn unref(&mut self) -> Result<(), String> {
        self.logs.borrow_mut().push(vec![json!("unref")]);
        self.unref_throws.clone().map_or(Ok(()), Err)
    }
    fn has_pid(&self) -> bool {
        self.pid
    }
}

fn start_mac_swap(args: &[Value], cx: &mut Context) -> Answer {
    let options = arg(args, 0).cloned().unwrap_or(Value::Null);
    let script = arg(args, 1).cloned().unwrap_or(Value::Null);
    let text = |key: &str| {
        options
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| bad(key))
    };
    let pid = options
        .get("pid")
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("pid"))?;
    let opts = StartMacSwap {
        pid,
        bundle: text("bundle")?,
        staged: text("staged")?,
        log_file: text("logFile")?,
        opener: options.get("opener").and_then(Value::as_str),
    };
    let logs: Logs = Rc::default();
    let spawn_logs = logs.clone();
    let string_of = |key: &str| script.get(key).and_then(Value::as_str).map(str::to_owned);
    let started = mac_update::start_mac_swap(&opts, &mut |file, argv, options: &SpawnOptions| {
        spawn_logs.borrow_mut().push(vec![
            json!("spawn"),
            json!(file),
            json!(argv),
            json!({ "detached": options.detached, "stdio": options.stdio }),
        ]);
        if let Some(e) = string_of("throws") {
            return Err(e);
        }
        Ok(Box::new(FakeChild {
            logs: spawn_logs.clone(),
            pid: script.get("pid").is_some_and(|p| !p.is_null()),
            on_throws: string_of("onThrows"),
            unref_throws: string_of("unrefThrows"),
        }) as Box<dyn SwapChild>)
    });
    flush(&logs, cx);
    Ok(Some(Value::Bool(started)))
}

// ---------- update-resume.ts ----------

struct ScriptBody {
    chunks: Vec<Value>,
    next: usize,
    end_delay: f64,
}

impl ResponseBody for ScriptBody {
    fn read(&mut self) -> BodyRead {
        let Some(item) = self.chunks.get(self.next) else {
            return BodyRead::End {
                delay_ms: self.end_delay,
            };
        };
        self.next += 1;
        let delay_ms = item.get("delayMs").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(message) = item.get("error").and_then(Value::as_str) {
            return BodyRead::Error {
                message: message.to_string(),
                delay_ms,
            };
        }
        let bytes = match item.get("hex").and_then(Value::as_str) {
            Some(hex) => hex_decode(hex),
            None => item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .as_bytes()
                .to_vec(),
        };
        BodyRead::Chunk { bytes, delay_ms }
    }
}

struct ScriptEnv {
    logs: Logs,
    script: Value,
    fetches: usize,
    cancel_checks: usize,
    clock: f64,
    now_ms: f64,
}

impl ResumeEnv for ScriptEnv {
    fn fallback(&mut self, url: &str, destination: &str) -> Result<String, String> {
        self.logs
            .borrow_mut()
            .push(vec![json!("stock"), json!(url), json!(destination)]);
        match self.script.get("fallbackError").and_then(Value::as_str) {
            Some(e) => Err(e.to_string()),
            None => Ok(format!("stock:{destination}")),
        }
    }

    fn fetch(&mut self, url: &str, headers: &[(String, String)]) -> Result<FetchResponse, String> {
        let index = self.fetches;
        self.fetches += 1;
        let mut object = Map::new();
        for (k, v) in headers {
            object.insert(k.clone(), Value::from(v.as_str()));
        }
        self.logs
            .borrow_mut()
            .push(vec![json!("fetch"), json!(url), Value::Object(object)]);
        let scripted = self
            .script
            .get("fetches")
            .and_then(|f| f.get(index))
            .ok_or_else(|| "no more scripted responses".to_string())?;
        let delay_ms = scripted
            .get("delayMs")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some(fail) = scripted.get("fail").and_then(Value::as_str) {
            return Err(fail.to_string());
        }
        let header = |key: &str| scripted.get(key).and_then(Value::as_str).map(str::to_owned);
        let body = scripted
            .get("body")
            .and_then(Value::as_array)
            .map(|chunks| {
                Box::new(ScriptBody {
                    chunks: chunks.clone(),
                    next: 0,
                    end_delay: scripted
                        .get("endDelayMs")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                }) as Box<dyn ResponseBody>
            });
        Ok(FetchResponse {
            delay_ms,
            status: scripted
                .get("status")
                .and_then(Value::as_u64)
                .ok_or_else(|| "status".to_string())? as u16,
            etag: header("etag"),
            last_modified: header("lastModified"),
            content_length: header("contentLength"),
            body,
        })
    }

    fn cancelled(&mut self) -> bool {
        let Some(list) = self.script.get("cancelled").and_then(Value::as_array) else {
            return false;
        };
        let at = self.cancel_checks.min(list.len().saturating_sub(1));
        self.cancel_checks += 1;
        list.get(at).and_then(Value::as_bool).unwrap_or(false)
    }

    fn has_progress(&self) -> bool {
        self.script.get("progress").and_then(Value::as_bool) == Some(true)
    }

    fn progress(&mut self, info: &Progress) {
        let number = |x: f64| serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number);
        self.logs.borrow_mut().push(vec![
            json!("progress"),
            json!({
                "total": number(info.total),
                "delta": number(info.delta),
                "transferred": number(info.transferred),
                "percent": number(info.percent),
            }),
        ]);
    }

    fn now(&mut self) -> f64 {
        let step = self
            .script
            .get("clockStep")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        let now = self.now_ms + step * self.clock;
        self.clock += 1.0;
        now
    }
}

fn install_resume_download(args: &[Value], cx: &mut Context) -> Answer {
    let script = arg(args, 0).cloned().unwrap_or(Value::Null);
    let shape = script.get("shape").and_then(Value::as_str).unwrap_or("ok");
    if shape != "ok" {
        return Ok(Some(json!({
            "wrapped": update_resume::install_resume_download(false)
        })));
    }
    let wrapped = update_resume::install_resume_download(true);
    debug_assert!(wrapped);
    let stall = script
        .get("stallMs")
        .and_then(Value::as_f64)
        .unwrap_or(STALL_TIMEOUT_MS);
    let response = script
        .get("responseMs")
        .and_then(Value::as_f64)
        .unwrap_or(RESPONSE_TIMEOUT_MS);
    let url = script
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("url"))?
        .to_string();
    let destination = script
        .get("destination")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("destination"))?
        .to_string();
    let headers: Vec<(String, Option<String>)> = script
        .get("headers")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
                .collect()
        })
        .unwrap_or_default();
    let options = DownloadOptions {
        sha512: script.get("sha512").and_then(Value::as_str),
        headers: &headers,
    };
    let logs: Logs = Rc::default();
    let mut env = ScriptEnv {
        logs: logs.clone(),
        script: script.clone(),
        fetches: 0,
        cancel_checks: 0,
        clock: 0.0,
        now_ms: cx.now_ms,
    };
    let result =
        update_resume::resume_download(&url, &destination, &options, &mut env, stall, response);
    flush(&logs, cx);
    result
        .map(|path| Some(Value::from(path)))
        .map_err(CallError::from)
}
