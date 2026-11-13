//! `process.kill(pid, signal)` and `child.kill(signal)`: signals by the names
//! Node knows them under (`os.constants.signals`), sent with `kill(2)` on
//! Unix and `TerminateProcess` on Windows, failing as Node's `process.kill`
//! fails (`kill ESRCH`, `kill EPERM`).

use jscompat::JsonValue;
use main_core::packages::ai_provider::task::JsError;

/// `os.constants.signals` of this platform: name and number
#[cfg(unix)]
const SIGNALS: &[(&str, i32)] = &[
    ("SIGHUP", libc::SIGHUP),
    ("SIGINT", libc::SIGINT),
    ("SIGQUIT", libc::SIGQUIT),
    ("SIGILL", libc::SIGILL),
    ("SIGTRAP", libc::SIGTRAP),
    ("SIGABRT", libc::SIGABRT),
    ("SIGBUS", libc::SIGBUS),
    ("SIGFPE", libc::SIGFPE),
    ("SIGKILL", libc::SIGKILL),
    ("SIGUSR1", libc::SIGUSR1),
    ("SIGSEGV", libc::SIGSEGV),
    ("SIGUSR2", libc::SIGUSR2),
    ("SIGPIPE", libc::SIGPIPE),
    ("SIGALRM", libc::SIGALRM),
    ("SIGTERM", libc::SIGTERM),
    ("SIGCHLD", libc::SIGCHLD),
    ("SIGCONT", libc::SIGCONT),
    ("SIGSTOP", libc::SIGSTOP),
    ("SIGTSTP", libc::SIGTSTP),
    ("SIGTTIN", libc::SIGTTIN),
    ("SIGTTOU", libc::SIGTTOU),
    ("SIGURG", libc::SIGURG),
    ("SIGXCPU", libc::SIGXCPU),
    ("SIGXFSZ", libc::SIGXFSZ),
    ("SIGVTALRM", libc::SIGVTALRM),
    ("SIGPROF", libc::SIGPROF),
    ("SIGWINCH", libc::SIGWINCH),
    ("SIGIO", libc::SIGIO),
    ("SIGSYS", libc::SIGSYS),
];

#[cfg(windows)]
const SIGNALS: &[(&str, i32)] = &[
    ("SIGHUP", 1),
    ("SIGINT", 2),
    ("SIGILL", 4),
    ("SIGABRT", 22),
    ("SIGFPE", 8),
    ("SIGKILL", 9),
    ("SIGSEGV", 11),
    ("SIGTERM", 15),
    ("SIGBREAK", 21),
    ("SIGWINCH", 28),
];

/// The name a signal that ended a process goes by in an `exit` event
#[cfg(unix)]
pub fn name_of(number: i32) -> Option<&'static str> {
    SIGNALS
        .iter()
        .find(|(_, n)| *n == number)
        .map(|(name, _)| *name)
}

/// The number of `signal` (`None`: `SIGTERM`); `"0"` and other plain numbers
/// stand for themselves, as `process.kill(pid, 0)` has them
fn number_of(signal: Option<&str>) -> Result<i32, JsError> {
    let Some(name) = signal else {
        return Ok(15);
    };
    if let Some((_, number)) = SIGNALS.iter().find(|(s, _)| *s == name) {
        return Ok(*number);
    }
    if !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_digit())
        && let Ok(number) = name.parse::<i32>()
    {
        return Ok(number);
    }
    Err(JsError::type_error(format!("Unknown signal: {name}"))
        .with("code", JsonValue::String("ERR_UNKNOWN_SIGNAL".into())))
}

/// What `process.kill` throws for a system error: `kill ESRCH`, with the
/// negative errno libuv gives
fn errno_error(code: &str, errno: f64) -> JsError {
    JsError::error(format!("kill {code}"))
        .with("errno", JsonValue::Number(errno))
        .with("code", JsonValue::String(code.into()))
        .with("syscall", JsonValue::String("kill".into()))
}

/// A pid that would reach every process of the user (`-1`) or the app's own
/// group (`0`), or is no pid at all, is no process: the ported code only
/// signals ids it was given, and one of these is a bug that must not end the
/// app or the session
fn is_target(pid: f64) -> bool {
    pid.is_finite()
        && pid.fract() == 0.0
        && pid != 0.0
        && pid != -1.0
        && pid.abs() <= i32::MAX as f64
}

/// `process.kill(pid, signal)`: a negative pid is a process group (Unix);
/// signal `0` only asks whether the process exists
#[cfg(unix)]
pub fn kill(pid: f64, signal: Option<&str>) -> Result<(), JsError> {
    let number = number_of(signal)?;
    if !is_target(pid) {
        return Err(errno_error("ESRCH", -f64::from(libc::ESRCH)));
    }
    // SAFETY: `kill(2)` takes two integers and touches no memory of ours
    if unsafe { libc::kill(pid as libc::pid_t, number) } == 0 {
        return Ok(());
    }
    let raw = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let code = match raw {
        libc::ESRCH => "ESRCH",
        libc::EPERM => "EPERM",
        libc::EINVAL => "EINVAL",
        _ => "UNKNOWN",
    };
    Err(errno_error(code, -f64::from(raw)))
}

/// `process.kill(pid, signal)` of libuv on Windows: `SIGTERM`, `SIGKILL`
/// and `SIGINT` terminate the process (exit code 1), `0` asks whether it
/// exists, any other signal is `ENOSYS`; a negative pid is no process
#[cfg(windows)]
pub fn kill(pid: f64, signal: Option<&str>) -> Result<(), JsError> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        TerminateProcess,
    };

    // libuv's errno of each name on Windows
    const ESRCH: f64 = -4040.0;
    const EPERM: f64 = -4048.0;
    const ENOSYS: f64 = -4054.0;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_INVALID_PARAMETER: u32 = 87;
    const STILL_ACTIVE: u32 = 259;

    let number = number_of(signal)?;
    if !is_target(pid) || pid < 0.0 {
        return Err(errno_error("ESRCH", ESRCH));
    }
    let access = match number {
        0 => PROCESS_QUERY_LIMITED_INFORMATION,
        2 | 9 | 15 => PROCESS_TERMINATE,
        _ => return Err(errno_error("ENOSYS", ENOSYS)),
    };
    // SAFETY: plain handle calls; the handle opened here is closed before returning
    unsafe {
        let process = OpenProcess(access, 0, pid as u32);
        if process.is_null() {
            return Err(match GetLastError() {
                ERROR_INVALID_PARAMETER => errno_error("ESRCH", ESRCH),
                ERROR_ACCESS_DENIED => errno_error("EPERM", EPERM),
                _ => errno_error("UNKNOWN", -4094.0),
            });
        }
        let outcome = if number == 0 {
            let mut code = 0u32;
            if GetExitCodeProcess(process, &mut code) != 0 && code == STILL_ACTIVE {
                Ok(())
            } else {
                Err(errno_error("ESRCH", ESRCH))
            }
        } else if TerminateProcess(process, 1) != 0 {
            Ok(())
        } else {
            Err(match GetLastError() {
                ERROR_ACCESS_DENIED => errno_error("EPERM", EPERM),
                _ => errno_error("UNKNOWN", -4094.0),
            })
        };
        CloseHandle(process);
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_its_number_and_no_name_is_sigterm() {
        assert_eq!(number_of(None).unwrap(), 15);
        assert_eq!(number_of(Some("SIGKILL")).unwrap(), 9);
        assert_eq!(number_of(Some("0")).unwrap(), 0);
        let err = number_of(Some("SIGNOPE")).unwrap_err();
        assert_eq!(err.message, "Unknown signal: SIGNOPE");
        assert_eq!(
            err.prop("code"),
            Some(&JsonValue::String("ERR_UNKNOWN_SIGNAL".into()))
        );
    }

    #[test]
    fn a_pid_that_reaches_everyone_is_no_process() {
        for pid in [0.0, -1.0, f64::NAN, 1.5, f64::INFINITY] {
            let err = kill(pid, None).unwrap_err();
            assert_eq!(err.message, "kill ESRCH", "pid {pid}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_exit_by_signal_is_named_as_node_names_it() {
        assert_eq!(name_of(libc::SIGTERM), Some("SIGTERM"));
        assert_eq!(name_of(libc::SIGKILL), Some("SIGKILL"));
        assert_eq!(name_of(0), None);
    }

    #[cfg(unix)]
    #[test]
    fn signal_zero_finds_a_live_process_and_not_a_gone_one() {
        assert!(kill(f64::from(std::process::id()), Some("0")).is_ok());
        // the largest pid cannot be running
        let err = kill(f64::from(i32::MAX), Some("0")).unwrap_err();
        assert_eq!(err.prop("code"), Some(&JsonValue::String("ESRCH".into())));
    }
}
