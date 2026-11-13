//! Batch U's hosts (host/os.rs): the single instance, files the OS opens
//! with the app, and the command line's runtime.
//!
//! - **The command line.** The seuoffice launchers and the MCP entries agents
//!   already have start the app binary with `ELECTRON_RUN_AS_NODE=1` and the
//!   CLI bundle (the Electron build was a Node). This binary then runs the
//!   Node the installer carries (`resources/cli/node`) with the same
//!   arguments and ends with its exit code; no window opens.
//! - **One instance** (`requestSingleInstanceLock`). The first instance holds
//!   an OS lock on `<userData>/shell-instance.lock` for its lifetime and
//!   listens on a loopback port named, with a random token, in
//!   `<userData>/shell-instance.json`. A later launch sends its arguments and
//!   working folder there and ends (`second-instance`).
//! - **Opened files.** Paths of a later launch, and of macOS's open-file
//!   event, open as documents (`openLaunchPaths`), or wait while the launch
//!   recovery list is up (`deferredLaunchPaths`). Those of the first launch,
//!   and open-file events before the shell is ready, open once it is.
//! - **The start mark.** Once the shell window is ready, the version goes to
//!   `<userData>/shell-started.txt`; an updating installer waits for it
//!   before it lets the previous version go (bundle/hooks.nsh).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use main_core::shell::launch_paths::collect_launch_paths;
use serde_json::{Value, json};
use shell_contract::Hosts;
use shell_contract::runtime::AppPaths;
use shell_ipc_u::launch_list;
use shell_ipc_w::tabs::TabsState;
use tauri::{AppHandle, RunEvent};

use super::HostContext;
use super::w::post_core;
use crate::paths::ShellPaths;

const LOCK_FILE: &str = "shell-instance.lock";
const ENDPOINT_FILE: &str = "shell-instance.json";
const START_MARK: &str = "shell-started.txt";
/// how long a later launch tries to reach a first one that is still starting
const HAND_OVER_TRIES: u32 = 20;
const HAND_OVER_WAIT: Duration = Duration::from_millis(250);
/// a line longer than this is not a launch
const MAX_LINE: usize = 1 << 20;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}

/// What the first launch brought, and what came before the shell was ready
struct Launch {
    /// the instance lock, held for the process's lifetime
    _lock: Option<File>,
    /// documents of the first launch and open-file events before ready
    pending: Vec<String>,
    /// the shell window is up: later paths open at once
    ready: bool,
}

static LAUNCH: Mutex<Launch> = Mutex::new(Launch {
    _lock: None,
    pending: Vec::new(),
    ready: false,
});

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// `collectLaunchPaths(argv, additionalData)`, relative paths taken from `cwd`
fn collect(argv: &[String], cwd: Option<&Path>) -> Vec<String> {
    let absolute: Vec<String> = argv
        .iter()
        .map(|arg| match cwd {
            Some(cwd) if !arg.starts_with('-') && Path::new(arg).is_relative() => {
                cwd.join(arg).to_string_lossy().into_owned()
            }
            _ => arg.clone(),
        })
        .collect();
    let refs: Vec<&str> = absolute.iter().map(String::as_str).collect();
    collect_launch_paths(&refs, None, &exists)
}

/// The first thing `main` does: true when this process has nothing more to
/// do (it ran the command line, or handed its launch to the running app)
pub fn hand_over_to_running_instance() -> bool {
    if std::env::var("ELECTRON_RUN_AS_NODE").is_ok_and(|v| !v.is_empty() && v != "0") {
        std::process::exit(run_as_node());
    }
    let paths = ShellPaths::new();
    let user_data = paths.path(shell_contract::runtime::PathName::UserData);
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if fs::create_dir_all(&user_data).is_err() {
        // no profile folder: nothing to share, this launch goes on alone
        return false;
    }
    for _ in 0..HAND_OVER_TRIES {
        if let Some(lock) = take_lock(&user_data) {
            let mut launch = LAUNCH.lock().unwrap();
            launch._lock = Some(lock);
            launch.pending = collect(&argv, None);
            drop(launch);
            listen(&user_data);
            return false;
        }
        if send_launch(&user_data, &argv) {
            return true;
        }
        std::thread::sleep(HAND_OVER_WAIT);
    }
    // the lock is held by an instance that does not answer: as Electron,
    // the later launch ends instead of making a second instance
    eprintln!("shell: another instance holds {LOCK_FILE} and does not answer");
    true
}

fn take_lock(user_data: &Path) -> Option<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(user_data.join(LOCK_FILE))
        .ok()?;
    file.try_lock().ok()?;
    Some(file)
}

/// A token no other user can guess: the OS-seeded hasher keys, twice
fn token() -> String {
    use std::hash::{BuildHasher, RandomState};
    let a = RandomState::new().hash_one(std::process::id());
    let b = RandomState::new().hash_one(std::time::SystemTime::now());
    format!("{a:016x}{b:016x}")
}

fn listen(user_data: &Path) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("shell: no single-instance listener: {error}");
            return;
        }
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    let token = token();
    let endpoint = json!({ "port": addr.port(), "token": token, "pid": std::process::id() });
    if let Err(error) = fs::write(user_data.join(ENDPOINT_FILE), endpoint.to_string()) {
        eprintln!("shell: cannot write {ENDPOINT_FILE}: {error}");
        return;
    }
    std::thread::Builder::new()
        .name("seuoffice-instance".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Some(launch) = read_launch(stream, &token) {
                    second_instance(launch);
                }
            }
        })
        .ok();
}

/// One line of JSON, `{token, argv, cwd}`; the reply `ok` lets the sender end
fn read_launch(stream: TcpStream, token: &str) -> Option<(Vec<String>, Option<PathBuf>)> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?).take(MAX_LINE as u64);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let message: Value = serde_json::from_str(&line).ok()?;
    if message["token"].as_str() != Some(token) {
        return None;
    }
    let argv = message["argv"]
        .as_array()?
        .iter()
        .filter_map(|a| a.as_str().map(str::to_owned))
        .collect();
    let cwd = message["cwd"].as_str().map(PathBuf::from);
    let mut stream = stream;
    let _ = stream.write_all(b"ok\n");
    Some((argv, cwd))
}

fn send_launch(user_data: &Path, argv: &[String]) -> bool {
    let Ok(text) = fs::read_to_string(user_data.join(ENDPOINT_FILE)) else {
        return false;
    };
    let Ok(endpoint) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let (Some(port), Some(token)) = (endpoint["port"].as_u64(), endpoint["token"].as_str()) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port as u16)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let cwd = std::env::current_dir().ok();
    let message = json!({ "token": token, "argv": argv, "cwd": cwd });
    if writeln!(stream, "{message}").is_err() {
        return false;
    }
    let mut answer = String::new();
    BufReader::new(stream).read_line(&mut answer).is_ok() && answer.trim() == "ok"
}

/// `app.on('second-instance')`: reveal the shell window, open the paths
fn second_instance((argv, cwd): (Vec<String>, Option<PathBuf>)) {
    open_paths(collect(&argv, cwd.as_deref()), true);
}

/// The paths of a later launch or an open-file event: kept for the launch
/// flow before the shell is ready, deferred while the launch list is up,
/// else opened (`openLaunchPaths`)
fn open_paths(paths: Vec<String>, reveal: bool) {
    {
        let mut launch = LAUNCH.lock().unwrap();
        if !launch.ready {
            for path in paths {
                if !launch.pending.contains(&path) {
                    launch.pending.push(path);
                }
            }
            return;
        }
    }
    post_core(move |provided, _| {
        let Some(tabs) = provided.all::<TabsState>().into_iter().next() else {
            return;
        };
        if reveal {
            tabs.reveal_shell_window();
        }
        // while the launch recovery list is up, nothing restored may load:
        // the paths open once it is answered (`deferredLaunchPaths`)
        let open: Box<dyn FnOnce()> = Box::new(move || {
            let mut opened = false;
            for path in &paths {
                opened = tabs.open_document_path(path) || opened;
            }
            if !opened {
                tabs.open_home_tab();
            }
        });
        match launch_list::current() {
            Some(list) => list.when_unblocked(open),
            None => open(),
        }
    });
}

/// The event loop's events U answers
pub fn on_run_event(_app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::Ready => {
            let first = {
                let mut launch = LAUNCH.lock().unwrap();
                launch.ready = true;
                std::mem::take(&mut launch.pending)
            };
            write_start_mark();
            // the first launch's documents, after whatever the launch restores
            if !first.is_empty() {
                open_paths(first, false);
            }
        }
        // macOS: a file opened from Finder or dropped on the Dock icon
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            open_paths(paths, true);
        }
        _ => {}
    }
}

fn write_start_mark() {
    let user_data = ShellPaths::new().path(shell_contract::runtime::PathName::UserData);
    if let Err(error) = fs::write(
        user_data.join(START_MARK),
        format!("{}\n", env!("CARGO_PKG_VERSION")),
    ) {
        eprintln!("shell: cannot write {START_MARK}: {error}");
    }
}

/// `ELECTRON_RUN_AS_NODE=1 <app> <script> args...`: the installer's Node
/// runs it instead; its exit code is this process's
fn run_as_node() -> i32 {
    let Some(node) = bundled_node() else {
        eprintln!("seuoffice: the command line's Node runtime is not installed (resources/cli/node)");
        return 1;
    };
    let mut command = std::process::Command::new(node);
    command
        .args(std::env::args_os().skip(1))
        .env_remove("ELECTRON_RUN_AS_NODE");
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("seuoffice: cannot start the command line's Node: {error}");
            1
        }
    }
}

/// `resources/cli/node/node[.exe]` beside this binary, as the bundle places it
fn bundled_node() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let node = if cfg!(target_os = "macos") {
        dir.join("../Resources/cli/node/node")
    } else if cfg!(windows) {
        dir.join("resources/cli/node/node.exe")
    } else {
        dir.join("resources/cli/node/node")
    };
    node.is_file().then_some(node)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_launch_reaches_the_first_through_the_endpoint() {
        let dir = std::env::temp_dir().join(format!("seuoffice-instance-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let first = take_lock(&dir).expect("the first instance takes the lock");
        assert!(take_lock(&dir).is_none(), "a second open of the lock fails");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::write(
            dir.join(ENDPOINT_FILE),
            json!({ "port": port, "token": "t0k" }).to_string(),
        )
        .unwrap();
        let got = std::thread::spawn(move || {
            let stream = listener.incoming().next().unwrap().unwrap();
            read_launch(stream, "t0k")
        });
        let argv = vec!["--updated".to_owned(), "report.docx".to_owned()];
        assert!(send_launch(&dir, &argv));
        let (seen, cwd) = got.join().unwrap().expect("the token matches");
        assert_eq!(seen, argv);
        assert_eq!(cwd, std::env::current_dir().ok());

        // a wrong token is not answered
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::write(
            dir.join(ENDPOINT_FILE),
            json!({ "port": port, "token": "other" }).to_string(),
        )
        .unwrap();
        let refused = std::thread::spawn(move || {
            let stream = listener.incoming().next().unwrap().unwrap();
            read_launch(stream, "t0k")
        });
        assert!(!send_launch(&dir, &argv));
        assert!(refused.join().unwrap().is_none());

        drop(first);
        assert!(take_lock(&dir).is_some(), "the lock goes with its holder");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn launch_arguments_keep_the_documents_only() {
        let dir = std::env::temp_dir().join(format!("seuoffice-args-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.docx"), b"").unwrap();
        fs::write(dir.join("notes.bin"), b"").unwrap();
        let argv: Vec<String> = ["--updated", "a.docx", "notes.bin", "missing.xlsx"]
            .map(str::to_owned)
            .into();
        let paths = collect(&argv, Some(&dir));
        assert_eq!(paths, vec![dir.join("a.docx").to_string_lossy().into_owned()]);
        let _ = fs::remove_dir_all(dir);
    }
}
