//! `spawn` of `node:child_process` for the ported code: the child is started
//! on a worker, its output and its end are read on threads of their own and
//! posted to the core thread, its stdin is written by a thread of its own so
//! that a child that does not read never stalls the core thread.
//!
//! Events of one child reach the core in this order: the spawn's answer,
//! then output as it is read, `exit` when the process ended (output still in
//! the pipes may follow it, as in Node), and `close` only after both output
//! pipes hit their end, so no output follows `close`.
//! A child that does not start answers `pid: None` and then emits `error`
//! and `close` with libuv's negative errno, as Node does.

use std::io::{self, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio as OsStdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use jscompat::JsonValue;
use main_core::node_fs::code_of;
use main_core::packages::ai_provider::task::{
    Answer, ChildEvent, Event, Id, JsError, SpawnRequest, Stdio,
};

use super::{Poster, signal};

/// What the stdin thread is told
enum Input {
    Data(Vec<u8>),
    End,
}

/// What the core thread keeps of a child: where to write, whom to signal
pub struct ChildIo {
    /// the process id until the process was reaped
    pid: Mutex<Option<u32>>,
    stdin: Option<Sender<Input>>,
}

impl ChildIo {
    /// `child.stdin.write(data)`; a write to a closed pipe is dropped, as an
    /// `EPIPE` on a stream nobody listens to is
    pub fn write(&self, data: Vec<u8>) {
        if let Some(stdin) = &self.stdin {
            let _ = stdin.send(Input::Data(data));
        }
    }

    /// `child.stdin.end()`
    pub fn end_stdin(&self) {
        if let Some(stdin) = &self.stdin {
            let _ = stdin.send(Input::End);
        }
    }

    /// `child.kill(signal)`: signals the process (not its group), unless it
    /// ended already; `kill` answers false in Node for a process that is gone
    /// and the ported code does not read it
    pub fn kill(&self, signal: Option<&str>) {
        if let Some(pid) = *self.pid.lock().unwrap() {
            let _ = signal::kill(f64::from(pid), signal);
        }
    }
}

/// The program, its arguments and whether Windows passes them verbatim, as
/// Node builds them: with `options.shell` the command line is one string
/// handed to the shell
fn program(spawn: &SpawnRequest) -> (String, Vec<String>, bool) {
    let Some(shell) = &spawn.shell else {
        return (spawn.command.clone(), spawn.args.clone(), false);
    };
    let line = std::iter::once(spawn.command.as_str())
        .chain(spawn.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let name = shell.rsplit(['\\', '/']).next().unwrap_or(shell);
    let name = name.to_ascii_lowercase();
    if cfg!(windows) && (name == "cmd" || name == "cmd.exe") {
        (
            shell.clone(),
            vec!["/d".into(), "/s".into(), "/c".into(), format!("\"{line}\"")],
            true,
        )
    } else {
        (shell.clone(), vec!["-c".into(), line], false)
    }
}

fn stdio_of(kind: Stdio) -> OsStdio {
    match kind {
        Stdio::Pipe => OsStdio::piped(),
        Stdio::Ignore => OsStdio::null(),
        Stdio::Inherit => OsStdio::inherit(),
    }
}

fn command_of(spawn: &SpawnRequest, file: &str, args: &[String], verbatim: bool) -> Command {
    let mut command = Command::new(file);
    #[cfg(windows)]
    if verbatim {
        use std::os::windows::process::CommandExt;
        for arg in args {
            command.raw_arg(arg);
        }
    } else {
        command.args(args);
    }
    #[cfg(not(windows))]
    {
        let _ = verbatim;
        command.args(args);
    }
    if let Some(cwd) = &spawn.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &spawn.env {
        command.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    }
    command
        .stdin(stdio_of(spawn.stdio[0]))
        .stdout(stdio_of(spawn.stdio[1]))
        .stderr(stdio_of(spawn.stdio[2]));
    #[cfg(unix)]
    if spawn.detached {
        // its own process group, which `process.kill(-pid)` reaches
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut flags = 0;
        if spawn.windows_hide && !spawn.stdio.contains(&Stdio::Inherit) {
            flags |= CREATE_NO_WINDOW;
        }
        if spawn.detached {
            flags |= DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        }
        command.creation_flags(flags);
    }
    command
}

/// libuv's negative errno of a spawn failure
fn uv_errno(e: &io::Error) -> f64 {
    #[cfg(unix)]
    {
        -f64::from(e.raw_os_error().unwrap_or(0))
    }
    #[cfg(windows)]
    {
        match code_of(e) {
            Some("ENOENT") => -4058.0,
            Some("EACCES") => -4092.0,
            _ => -4094.0,
        }
    }
}

/// The `'error'` of a child that did not start: `spawn x ENOENT`
fn start_error(e: &io::Error, file: &str, args: &[String]) -> (JsError, f64) {
    let code = code_of(e).unwrap_or("UNKNOWN");
    let errno = uv_errno(e);
    let error = JsError::error(format!("spawn {file} {code}"))
        .with("errno", JsonValue::Number(errno))
        .with("code", JsonValue::String(code.into()))
        .with("syscall", JsonValue::String(format!("spawn {file}")))
        .with("path", JsonValue::String(file.into()))
        .with(
            "spawnargs",
            JsonValue::Array(args.iter().cloned().map(JsonValue::String).collect()),
        );
    (error, errno)
}

/// `(code, signal)` of an `exit`/`close` event
fn ended(status: io::Result<ExitStatus>) -> (Option<f64>, Option<String>) {
    let Ok(status) = status else {
        return (None, None);
    };
    #[cfg(unix)]
    if let Some(number) = std::os::unix::process::ExitStatusExt::signal(&status) {
        return (None, signal::name_of(number).map(str::to_owned));
    }
    #[cfg(unix)]
    {
        (status.code().map(f64::from), None)
    }
    #[cfg(not(unix))]
    {
        // Windows exit codes are unsigned
        (status.code().map(|code| f64::from(code as u32)), None)
    }
}

fn post_child(poster: &Poster, child: Id, event: ChildEvent) {
    poster.send(Event::Child { child, event });
}

fn read_pipe(mut pipe: impl Read, poster: &Poster, child: Id, stderr: bool) {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                let bytes = buffer[..n].to_vec();
                post_child(
                    poster,
                    child,
                    if stderr {
                        ChildEvent::Stderr(bytes)
                    } else {
                        ChildEvent::Stdout(bytes)
                    },
                );
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

fn write_pipe(mut stdin: impl Write, inputs: Receiver<Input>) {
    for input in inputs {
        match input {
            Input::Data(data) => {
                if stdin.write_all(&data).and_then(|()| stdin.flush()).is_err() {
                    return;
                }
            }
            Input::End => return,
        }
    }
}

fn thread_named<T: Send + 'static>(
    name: &str,
    job: impl FnOnce() -> T + Send + 'static,
) -> JoinHandle<T> {
    thread::Builder::new()
        .name(name.into())
        .spawn(job)
        .expect("start a child process thread")
}

/// Carries `Cmd::Spawn` out; runs on a worker
pub fn start(id: Id, spawn: SpawnRequest, poster: Poster) {
    let (file, args, verbatim) = program(&spawn);
    let mut child: Child = match command_of(&spawn, &file, &args, verbatim).spawn() {
        Ok(child) => child,
        Err(e) => {
            let (error, errno) = start_error(&e, &file, &args);
            poster.send(Event::Done {
                id,
                answer: Answer::Spawned { pid: None },
            });
            post_child(&poster, id, ChildEvent::Error(error));
            post_child(
                &poster,
                id,
                ChildEvent::Close {
                    code: Some(errno),
                    signal: None,
                },
            );
            return;
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take().map(|pipe| {
        let (inputs, receiver) = mpsc::channel();
        thread_named("ai-runtime-stdin", move || write_pipe(pipe, receiver));
        inputs
    });
    let io = Arc::new(ChildIo {
        pid: Mutex::new(Some(pid)),
        stdin,
    });
    // the core knows the child before it hears of it
    let known = io.clone();
    poster.run(move |shared| shared.adopt(id, known));
    poster.send(Event::Done {
        id,
        answer: Answer::Spawned {
            pid: Some(f64::from(pid)),
        },
    });

    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        let poster = poster.clone();
        readers.push(thread_named("ai-runtime-output", move || {
            read_pipe(pipe, &poster, id, false)
        }));
    }
    if let Some(pipe) = stderr {
        let poster = poster.clone();
        readers.push(thread_named("ai-runtime-output", move || {
            read_pipe(pipe, &poster, id, true)
        }));
    }
    thread_named("ai-runtime-child", move || {
        let status = child.wait();
        // a signal sent now would reach whatever took the pid
        *io.pid.lock().unwrap() = None;
        let (code, signal) = ended(status);
        post_child(
            &poster,
            id,
            ChildEvent::Exit {
                code,
                signal: signal.clone(),
            },
        );
        for reader in readers {
            let _ = reader.join();
        }
        post_child(&poster, id, ChildEvent::Close { code, signal });
    });
}
