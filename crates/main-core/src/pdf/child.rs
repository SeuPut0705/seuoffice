//! A child process run to completion with its output captured, as
//! `execFile` and `spawnSync` of Node do it for `ocr.ts` and
//! `system-certificates.ts`: no shell, a time limit, a cap on each output.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How a run ended
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// the process was started and left with `Some(code)`, or by a signal (`None`)
    Exited(Option<i32>),
    /// killed after the time limit (`error.killed`)
    TimedOut,
    /// killed after an output passed the cap (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`)
    OutputTooLong,
    /// the executable does not exist (`ENOENT`)
    NotFound,
    /// it could not be started for another reason (`EACCES`, ...)
    SpawnFailed,
}

#[derive(Debug, Clone)]
pub struct Captured {
    pub ended: Ended,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs `file args` with `env` added to the environment of this process.
/// `input` is written to its stdin, which is then closed; with `None` the
/// stdin is closed at once (a tool that wants a password must fail instead of
/// waiting on a terminal that is not there).
pub fn capture(
    file: &str,
    args: &[String],
    env: &[(String, String)],
    input: Option<&[u8]>,
    timeout: Duration,
    max_buffer: usize,
) -> Captured {
    let mut command = Command::new(file);
    command
        .args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: windowsHide
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Captured {
                ended: if e.kind() == std::io::ErrorKind::NotFound {
                    Ended::NotFound
                } else {
                    Ended::SpawnFailed
                },
                stdout: Vec::new(),
                stderr: Vec::new(),
            };
        }
    };
    let writer = child.stdin.take().map(|mut stdin| {
        let data = input.map(<[u8]>::to_vec).unwrap_or_default();
        std::thread::spawn(move || {
            // a child that exits without reading its input is not an error here
            let _ = stdin.write_all(&data);
        })
    });
    let too_long = Arc::new(AtomicBool::new(false));
    let reader = |mut pipe: Box<dyn Read + Send>| {
        let too_long = Arc::clone(&too_long);
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let room = max_buffer.saturating_sub(kept.len());
                        kept.extend_from_slice(&chunk[..n.min(room)]);
                        if n > room {
                            too_long.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
            kept
        })
    };
    let out_reader = child
        .stdout
        .take()
        .map(|p| reader(Box::new(p) as Box<dyn Read + Send>));
    let err_reader = child
        .stderr
        .take()
        .map(|p| reader(Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + timeout;
    let mut ended = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                ended = Some(Ended::Exited(status.code()));
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if too_long.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let ended = match ended {
        Some(ended) => ended,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            if too_long.load(Ordering::SeqCst) {
                Ended::OutputTooLong
            } else {
                Ended::TimedOut
            }
        }
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stdout = out_reader
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr = err_reader
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    Captured {
        ended,
        stdout,
        stderr,
    }
}
