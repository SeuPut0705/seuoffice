// Throwaway Tauri 2 shell for the measurement in proto/README.md. The page is
// proto/common/host/host.html; this file is the command side of its tauriShell() adapter.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod print_mac;
#[cfg(windows)]
mod print_win;

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const SHELL: &str = "tauri2";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The .docx a file association (or the command line) asked this launch to open.
struct Launch {
    doc: Mutex<Option<String>>,
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn absolute(path: &str) -> String {
    std::path::absolute(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned())
}

/// First positional argument that names a .docx; `--updated`, `--force-run` and any other flag are ignored.
fn positional_docx() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".docx"))
        .map(|a| absolute(&a))
}

/// The folder the Electron build keeps its userData in. Tauri's own app_data_dir is the identifier
/// path, which is a different folder, so the Electron one is resolved by hand.
fn user_data_dir() -> PathBuf {
    if let Some(dir) = env_nonempty("BENCH_USER_DATA") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"));
    base.unwrap_or_else(std::env::temp_dir).join("seuoffice")
}

/// RFC 3339 UTC time without a date crate (days-to-civil from Howard Hinnant's algorithm).
fn iso_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let secs = now.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60,
        now.subsec_millis()
    )
}

fn append_line(path: &str, line: &str) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")
}

/// The contract's startup duties: the `startup` line for BENCH_OUT, and
/// `<userData>/proto-shell-started.json` always.
fn record_startup(config: &Value) -> std::io::Result<()> {
    let dir = user_data_dir();
    fs::create_dir_all(&dir)?;
    let mut entries: Vec<String> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    if let Some(out) = env_nonempty("BENCH_OUT") {
        let line = json!({
            "kind": "startup",
            "shell": SHELL,
            "pid": std::process::id(),
            "userDataDir": dir.to_string_lossy(),
            "userDataEntries": entries,
            "config": config,
        });
        append_line(&out, &line.to_string())?;
    }
    let started = json!({
        "shell": SHELL,
        "version": VERSION,
        "args": std::env::args().skip(1).collect::<Vec<_>>(),
        "time": iso_now(),
    });
    fs::write(dir.join("proto-shell-started.json"), started.to_string())
}

fn config_value(launch: &Launch) -> Value {
    let positional = launch.doc.lock().unwrap().clone();
    let doc = positional.or_else(|| env_nonempty("BENCH_DOC"));
    let mode = env_nonempty("BENCH_MODE").unwrap_or_else(|| "interactive".into());
    let t0 = env_nonempty("BENCH_T0").and_then(|v| {
        v.parse::<u64>()
            .map(Value::from)
            .or_else(|_| v.parse::<f64>().map(Value::from))
            .ok()
    });
    json!({
        "doc": doc,
        "mode": mode,
        "t0": t0,
        "shellName": env_nonempty("BENCH_SHELL").unwrap_or_else(|| SHELL.into()),
    })
}

#[tauri::command]
fn bench_config(launch: State<'_, Launch>) -> Value {
    config_value(&launch)
}

#[derive(Serialize)]
struct Opened {
    path: String,
}

#[tauri::command]
async fn open_file(app: AppHandle, path: Option<String>) -> Result<Opened, String> {
    if let Some(path) = path {
        return Ok(Opened { path });
    }
    let picked = app
        .dialog()
        .file()
        .add_filter("Word", &["docx"])
        .blocking_pick_file()
        .ok_or("the open dialog was cancelled")?;
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(Opened { path: path.to_string_lossy().into_owned() })
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn save_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file needs a raw body".into());
    };
    let header = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("save_file needs an x-path header")?;
    let path = percent_decode_str(header).decode_utf8().map_err(|e| e.to_string())?;
    fs::write(path.as_ref(), bytes).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn echo(request: Request<'_>) -> Result<Response, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Response::new(bytes.clone())),
        InvokeBody::Json(_) => Err("echo needs a raw body".into()),
    }
}

#[tauri::command]
fn report(line: String) -> Result<(), String> {
    match env_nonempty("BENCH_OUT") {
        Some(out) => append_line(&out, &line).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[derive(Serialize)]
struct PrintResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl PrintResult {
    fn failed(error: impl Into<String>) -> Self {
        Self { ok: false, error: Some(error.into()) }
    }
}

/// Prints this top-level page to `out` as a PDF: paper size in inches, margins 0, backgrounds on.
#[tauri::command]
async fn print_pdf(window: WebviewWindow, out: String, width: f64, height: f64) -> PrintResult {
    let _ = fs::remove_file(&out);
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let target = out.clone();
    let queued = window.with_webview(move |webview| {
        let done = Box::new(move |result: Result<(), String>| {
            let _ = tx.send(result);
        });
        #[cfg(target_os = "macos")]
        // SAFETY: with_webview runs on the main thread and the pointers belong to the live window.
        unsafe {
            print_mac::print_to_pdf(webview.inner(), webview.ns_window(), &target, width, height, done);
        }
        #[cfg(windows)]
        print_win::print_to_pdf(&webview.controller(), &webview.environment(), &target, width, height, done);
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (webview, &target, width, height);
            done(Err("print_pdf is not implemented on this OS".into()));
        }
    });
    if let Err(error) = queued {
        return PrintResult::failed(format!("with_webview: {error}"));
    }
    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Err(_) => PrintResult::failed("print timed out after 120 s"),
        Ok(Err(_)) => PrintResult::failed("print was dropped without a result"),
        Ok(Ok(Err(error))) => PrintResult::failed(error),
        Ok(Ok(Ok(()))) => match fs::metadata(&out) {
            Ok(meta) if meta.len() > 0 => PrintResult { ok: true, error: None },
            Ok(_) => PrintResult::failed("the PDF file is empty"),
            Err(e) => PrintResult::failed(format!("no PDF file after printing: {e}")),
        },
    }
}

fn main() {
    let launch = Launch { doc: Mutex::new(positional_docx()) };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(launch)
        .setup(|app| {
            let config = config_value(&app.state::<Launch>());
            record_startup(&config)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bench_config,
            open_file,
            read_file,
            save_file,
            echo,
            report,
            print_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");
    app.run(|_app, _event| {
        // macOS hands a double-clicked file to the app as an Apple Event, not as an argument.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let docx = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("docx")));
            if let Some(path) = docx {
                *_app.state::<Launch>().doc.lock().unwrap() = Some(path.to_string_lossy().into_owned());
            }
        }
    });
}
