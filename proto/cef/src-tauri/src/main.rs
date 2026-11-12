// Throwaway shell prototype (proto/README.md): Tauri 3 alpha on the CEF runtime.
// It serves the folder from proto/common/stage-dist.sh and answers the commands
// proto/common/host/host.js sends (see its tauriShell()).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  collections::HashMap,
  fs,
  io::Write,
  path::PathBuf,
  sync::{Arc, Mutex, mpsc},
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{
  Manager, State, WebviewUrl, WebviewWindowBuilder,
  ipc::{InvokeBody, Request, Response},
};
use tauri_runtime_cef::{Cef, DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};

const SHELL: &str = "cef";
const CDP_TIMEOUT: Duration = Duration::from_secs(90);

fn env(key: &str) -> Option<String> {
  std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_or(0, |d| d.as_millis() as u64)
}

/// The Electron app's userData folder (apps/shell/src/main/index.ts names the
/// app "seuoffice"). BENCH_USER_DATA overrides it so a run on a dev machine
/// never touches the real folder.
fn user_data_dir() -> PathBuf {
  env("BENCH_USER_DATA").map_or_else(
    || {
      dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("seuoffice")
    },
    PathBuf::from,
  )
}

fn report_line(line: &str) -> std::io::Result<()> {
  let Some(out) = env("BENCH_OUT") else {
    return Ok(());
  };
  let mut file = fs::OpenOptions::new().create(true).append(true).open(out)?;
  writeln!(file, "{line}")
}

/// Writes proto-shell-started.json and, when BENCH_OUT is set, the startup line.
fn startup_note() -> std::io::Result<()> {
  let dir = user_data_dir();
  fs::create_dir_all(&dir)?;
  let args: Vec<String> = std::env::args().collect();
  fs::write(
    dir.join("proto-shell-started.json"),
    json!({
      "shell": SHELL,
      "version": env!("CARGO_PKG_VERSION"),
      "args": args,
      "time": now_ms(),
    })
    .to_string(),
  )?;
  let mut entries: Vec<String> = fs::read_dir(&dir)?
    .filter_map(|e| e.ok())
    .map(|e| e.file_name().to_string_lossy().into_owned())
    .collect();
  entries.sort();
  report_line(
    &json!({
      "kind": "startup",
      "shell": SHELL,
      "pid": std::process::id(),
      "userDataDir": dir.to_string_lossy(),
      "userDataEntries": entries,
    })
    .to_string(),
  )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchConfig {
  doc: Option<String>,
  mode: String,
  t0: Option<f64>,
  shell_name: &'static str,
}

#[tauri::command]
fn bench_config() -> BenchConfig {
  // a .docx handed over on the command line (file association) opens interactively
  let arg_doc = std::env::args()
    .skip(1)
    .find(|a| a.to_ascii_lowercase().ends_with(".docx"));
  let doc = env("BENCH_DOC").or(arg_doc);
  let mode = if env("BENCH_DOC").is_some() {
    env("BENCH_MODE").unwrap_or_else(|| "interactive".into())
  } else {
    "interactive".into()
  };
  BenchConfig {
    doc,
    mode,
    t0: env("BENCH_T0").and_then(|v| v.parse().ok()),
    shell_name: SHELL,
  }
}

#[derive(Serialize)]
struct OpenedPath {
  path: String,
}

#[tauri::command]
async fn open_file(path: Option<String>) -> Result<OpenedPath, String> {
  let path = match path {
    Some(path) => path,
    None => {
      let picked = rfd::AsyncFileDialog::new()
        .add_filter("Word", &["docx"])
        .pick_file()
        .await
        .ok_or_else(|| "canceled".to_string())?;
      picked.path().to_string_lossy().into_owned()
    }
  };
  Ok(OpenedPath { path })
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
  fs::read(&path)
    .map(Response::new)
    .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn save_file(request: Request<'_>) -> Result<(), String> {
  let InvokeBody::Raw(bytes) = request.body() else {
    return Err("save_file wants a raw body".into());
  };
  let header = request
    .headers()
    .get("x-path")
    .and_then(|v| v.to_str().ok())
    .ok_or("save_file wants an x-path header")?;
  let path = percent_decode_str(header)
    .decode_utf8()
    .map_err(|e| e.to_string())?
    .into_owned();
  fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn echo(request: Request<'_>) -> Result<Response, String> {
  match request.body() {
    InvokeBody::Raw(bytes) => Ok(Response::new(bytes.clone())),
    InvokeBody::Json(_) => Err("echo wants a raw body".into()),
  }
}

#[tauri::command]
async fn report(line: String) -> Result<(), String> {
  report_line(&line).map_err(|e| e.to_string())
}

/// CDP results waiting for their caller, keyed by the request id.
#[derive(Default)]
struct Pending(Mutex<HashMap<i32, mpsc::SyncSender<(bool, Vec<u8>)>>>);

impl Pending {
  /// The one observer of a browser's protocol traffic: hands each result to
  /// whoever sent the request with that id.
  fn observe(self: &Arc<Self>) -> impl Fn(DevToolsProtocol) + Send + Sync + 'static {
    let pending = Arc::clone(self);
    move |protocol| {
      if let DevToolsProtocol::MethodResult {
        message_id,
        success,
        result,
      } = protocol
        && let Some(tx) = pending.0.lock().unwrap().remove(&message_id)
      {
        let _ = tx.send((success, result));
      }
    }
  }

  /// Sends one CDP request through `send` and blocks for its result.
  fn call(
    &self,
    send: impl FnOnce(&[u8]) -> Result<(), String>,
    method: &str,
    params: Value,
  ) -> Result<(bool, Vec<u8>), String> {
    let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::sync_channel(1);
    self.0.lock().unwrap().insert(id, tx);
    let message = json!({ "id": id, "method": method, "params": params }).to_string();
    if let Err(error) = send(message.as_bytes()) {
      self.0.lock().unwrap().remove(&id);
      return Err(error);
    }
    rx.recv_timeout(CDP_TIMEOUT).map_err(|_| {
      self.0.lock().unwrap().remove(&id);
      format!("{method}: no answer in {}s", CDP_TIMEOUT.as_secs())
    })
  }
}

#[derive(Serialize)]
struct PrintResult {
  ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  bytes: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<String>,
}

fn print_to_pdf(
  pending: &Pending,
  webview: &tauri::Webview,
  out: &str,
  width: f64,
  height: f64,
) -> Result<usize, String> {
  let (success, result) = pending.call(
    |message| {
      webview
        .send_dev_tools_message(message)
        .map_err(|e| e.to_string())
    },
    "Page.printToPDF",
    json!({
      "paperWidth": width,
      "paperHeight": height,
      "marginTop": 0,
      "marginBottom": 0,
      "marginLeft": 0,
      "marginRight": 0,
      "printBackground": true,
    }),
  )?;
  if !success {
    return Err(String::from_utf8_lossy(&result).into_owned());
  }
  let result: Value = serde_json::from_slice(&result).map_err(|e| e.to_string())?;
  let data = result["data"].as_str().ok_or("printToPDF returned no data")?;
  let pdf = STANDARD.decode(data).map_err(|e| e.to_string())?;
  fs::write(out, &pdf).map_err(|e| format!("{out}: {e}"))?;
  Ok(pdf.len())
}

#[tauri::command]
async fn print_pdf(
  webview: tauri::Webview,
  pending: State<'_, Arc<Pending>>,
  out: String,
  width: f64,
  height: f64,
) -> Result<PrintResult, String> {
  let pending = Arc::clone(&pending);
  let printed = tauri::async_runtime::spawn_blocking(move || {
    print_to_pdf(&pending, &webview, &out, width, height)
  })
  .await
  .map_err(|e| e.to_string())?;
  Ok(match printed {
    Ok(bytes) => PrintResult {
      ok: true,
      bytes: Some(bytes),
      error: None,
    },
    Err(error) => PrintResult {
      ok: false,
      bytes: None,
      error: Some(error),
    },
  })
}

/// Writes one persistent cookie through CDP, so Chromium's OSCrypt has to
/// create its key (macOS keychain item / Windows Local State) and the smoke
/// run can report which one it used. Only with CEF_PROBE_OSCRYPT=1.
fn probe_oscrypt(app: &tauri::AppHandle, pending: Arc<Pending>) {
  let Some(window) = app.get_webview_window("main") else {
    return;
  };
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_secs(8));
    let expires = now_ms() / 1000 + 86_400;
    let outcome = pending.call(
      |message| {
        window
          .send_dev_tools_message(message)
          .map_err(|e| e.to_string())
      },
      "Network.setCookie",
      json!({
        "name": "seuoffice_oscrypt_probe",
        "value": "1",
        "url": "http://tauri.localhost/",
        "expires": expires,
      }),
    );
    let line = match outcome {
      Ok((success, result)) => json!({
        "kind": "oscrypt-probe",
        "ok": success,
        "result": String::from_utf8_lossy(&result),
      }),
      Err(error) => json!({ "kind": "oscrypt-probe", "ok": false, "error": error }),
    };
    let _ = report_line(&line.to_string());
  });
}

#[tauri_runtime_cef::cef_entry_point]
fn main() {
  let mut cef = Cef::default();
  // Chromium's own profile stays out of the Electron userData folder. The
  // runtime's default ({user cache}/{identifier}/cef) is already outside it;
  // a dev run with BENCH_USER_DATA moves it beside the override.
  if let Some(dir) = env("BENCH_USER_DATA") {
    cef = cef.root_cache_path(format!("{dir}-cef"));
  }

  let pending = Arc::new(Pending::default());

  tauri::Builder::default()
    .runtime(cef)
    .manage(Arc::clone(&pending))
    .invoke_handler(tauri::generate_handler![
      bench_config,
      open_file,
      read_file,
      save_file,
      echo,
      report,
      print_pdf,
    ])
    .setup(move |app| {
      startup_note()?;
      if env("BENCH_MODE").as_deref() == Some("seed") {
        app.handle().exit(0);
        return Ok(());
      }
      let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("host.html".into()))
        .title("SeuOffice")
        .inner_size(1280., 900.)
        .build()?;
      window.on_dev_tools_protocol(pending.observe())?;
      if env("CEF_PROBE_OSCRYPT").is_some() {
        probe_oscrypt(app.handle(), Arc::clone(&pending));
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running the tauri application");
}
