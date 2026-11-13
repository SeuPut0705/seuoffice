//! `apps/shell/src/main/mcp/cli-runner.ts`: the shell-main half of the
//! MCP to `seuoffice` CLI delegation.
//!
//! The app already ships the CLI (`@seuoffice/cli`) and runs it on its own
//! Node runtime, so the headless MCP tools do not reimplement document
//! engines: they spawn the same CLI a shell user or another agent would, with
//! `--json`, and map its result contract (`{ status, command, summary,
//! output_path, detail }`, exit codes 0-4) back to a tool result.
//!
//! Two views of the runner:
//!
//! - [`CliRunner`] is what the headless tools call: `run(args, options)`
//!   answers one [`CliRunOutcome`] and never fails (a failure is `ok: false`).
//!   The host implements it over a process; the tests implement it with a
//!   script.
//! - [`CliRun`] is `createCliRunner(paths).run(..)` of the TypeScript: one
//!   child process, its timer and its output budget, as a state machine the
//!   host drives. The process and the timer are behind [`CliRunHost`]; what
//!   happens to them is a step the caller drives:
//!   [`CliRun::start`] spawns, arms the watchdog and closes stdin;
//!   [`CliRun::on_stdout`] and [`CliRun::on_stderr`] are a chunk of the child's
//!   output, [`CliRun::on_timeout`] the watchdog firing,
//!   [`CliRun::on_error`] the `error` event and [`CliRun::on_close`] the
//!   `close` event. Each answers the outcome when that step settles the run
//!   (the promise of the TypeScript), `None` otherwise; once settled, later
//!   steps change nothing the outcome holds (the TypeScript still counts the
//!   bytes of a chunk that arrives late, and kills the child once more if it
//!   crosses the budget).
//!
//! The JSON a child prints is the child's, not this module's: it stays a
//! [`JsonValue`], and what the tools read of it (`summary`, `output_path`,
//! `detail`, `message`) is read field by field as the TypeScript reads it.

use jscompat::{JsonValue, json_parse, number_to_string, slice_utf16, to_primitive, trim};

/// `CliRunOutcome`
#[derive(Debug, Clone, PartialEq)]
pub struct CliRunOutcome {
    pub ok: bool,
    /// process exit code, or -1 when the process never started/produced output
    pub code: f64,
    /// the object the CLI printed last, when it holds a `status`: a `CliJsonOk`
    /// (`{ status: 'ok', command, summary, output_path?, detail? }`) or a
    /// `CliJsonError` (`{ status: 'error', command, code, message, detail? }`)
    pub json: Option<JsonValue>,
    pub stdout: String,
    pub stderr: String,
}

/// `CliRunOptions`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CliRunOptions {
    /// text piped to stdin (for commands that read `-`, e.g. `create --ops -`)
    pub input: Option<String>,
    /// abort the child after this long; default 120s (the CLI lazily loads jsdom)
    pub timeout_ms: Option<f64>,
}

/// `CliRunner`: run `seuoffice <args> --json`; never fails, failures come back
/// as `ok: false`.
pub trait CliRunner {
    fn run(&self, args: &[String], options: &CliRunOptions) -> CliRunOutcome;
}

/// `CliRunnerPaths`
#[derive(Debug, Clone, PartialEq)]
pub struct CliRunnerPaths {
    /// node/electron executable that runs the CLI entry
    pub executable: String,
    /// absolute path to the bundled CLI entry (dist/seuoffice.cjs)
    pub entry: String,
    /// extra environment (the runner adds ELECTRON_RUN_AS_NODE when needed); a
    /// `None` value is a variable set to `undefined`
    pub env: Vec<(String, Option<String>)>,
}

/// `parseJson(stdout)`: the CLI prints exactly one JSON object with `--json`;
/// take the last line so a stray warning on stdout cannot mask it. `None`
/// where there is no such object (nothing printed, not JSON, no `status`).
pub fn parse_json(stdout: &str) -> Option<JsonValue> {
    let text = trim(stdout);
    if text.is_empty() {
        return None;
    }
    let last_line = text
        .split('\n')
        .rfind(|line| !line.is_empty())
        .unwrap_or(text);
    match json_parse(last_line) {
        Ok(parsed @ JsonValue::Object(_)) if parsed.get("status").is_some() => Some(parsed),
        _ => None,
    }
}

/// `MAX_CLI_OUTPUT_BYTES`: child output budget; past this the buffers are
/// truncated and the child killed.
pub const MAX_CLI_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

/// the timeout a run uses for `options.timeoutMs`: `timeoutMs` arrives from
/// tool callers, and a NaN or Infinity value would break the watchdog (NaN
/// fires immediately, Infinity never), so it is normalized: not finite is
/// 120000, else the floor clamped to 1000..=600000.
pub fn clamp_timeout_ms(timeout_ms: Option<f64>) -> f64 {
    match timeout_ms {
        Some(ms) if ms.is_finite() => ms.floor().clamp(1000.0, 600_000.0),
        _ => 120_000.0,
    }
}

/// `spawn(paths.executable, [paths.entry, ...args, '--json'], { env: { ...process.env,
/// ELECTRON_RUN_AS_NODE: '1', ...paths.env }, windowsHide: true })`
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnRequest {
    pub executable: String,
    pub args: Vec<String>,
    /// laid over the host's own environment, in this order: `ELECTRON_RUN_AS_NODE`
    /// first, then `paths.env`
    pub env: Vec<(String, Option<String>)>,
}

/// What a [`CliRun`] does to the world.
pub trait CliRunHost {
    /// `spawn(..)` with the stdout and stderr pipes
    fn spawn(&mut self, request: &SpawnRequest);
    /// `child.kill()`
    fn kill(&mut self);
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`CliRun::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// `child.stdin.end(input)`, or `child.stdin.end()` for `None`
    fn end_stdin(&mut self, input: Option<&str>);
}

/// One run of `createCliRunner(paths).run(args, options)`.
pub struct CliRun<H: CliRunHost> {
    host: H,
    stdout: String,
    stderr: String,
    /// `stdout.length` and `stderr.length`: UTF-16 code units
    stdout_units: usize,
    stderr_units: usize,
    settled: bool,
    truncated: bool,
    timer: u64,
}

impl<H: CliRunHost> CliRun<H> {
    /// `run(args, options)` up to the point it waits: spawn, arm the watchdog,
    /// close stdin.
    pub fn start(
        mut host: H,
        paths: &CliRunnerPaths,
        args: &[String],
        options: &CliRunOptions,
    ) -> Self {
        let timeout_ms = clamp_timeout_ms(options.timeout_ms);
        let mut spawn_args = Vec::with_capacity(args.len() + 2);
        spawn_args.push(paths.entry.clone());
        spawn_args.extend(args.iter().cloned());
        spawn_args.push("--json".to_owned());
        let mut env = vec![("ELECTRON_RUN_AS_NODE".to_owned(), Some("1".to_owned()))];
        env.extend(paths.env.iter().cloned());
        host.spawn(&SpawnRequest {
            executable: paths.executable.clone(),
            args: spawn_args,
            env,
        });
        let timer = host.set_timeout(timeout_ms);
        host.end_stdin(options.input.as_deref());
        CliRun {
            host,
            stdout: String::new(),
            stderr: String::new(),
            stdout_units: 0,
            stderr_units: 0,
            settled: false,
            truncated: false,
            timer,
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// `finish(outcome)`: the first call settles the run
    fn finish(&mut self, outcome: CliRunOutcome) -> Option<CliRunOutcome> {
        if self.settled {
            return None;
        }
        self.settled = true;
        self.host.clear_timeout(self.timer);
        Some(outcome)
    }

    /// `onChunk(chunk, stream)`: unbounded child output would OOM the shell
    /// main process, so the buffers are capped and the child killed past the
    /// budget. Each chunk is decoded on its own, as `chunk.toString()` does.
    fn on_chunk(&mut self, chunk: &[u8], is_stdout: bool) -> Option<CliRunOutcome> {
        let text = String::from_utf8_lossy(chunk);
        let units = text.encode_utf16().count();
        if is_stdout {
            self.stdout.push_str(&text);
            self.stdout_units += units;
        } else {
            self.stderr.push_str(&text);
            self.stderr_units += units;
        }
        if self.stdout_units + self.stderr_units > MAX_CLI_OUTPUT_BYTES && !self.truncated {
            self.truncated = true;
            self.host.kill();
            self.stdout = slice_utf16(&self.stdout, 0.0, Some(MAX_CLI_OUTPUT_BYTES as f64));
            self.stderr = format!(
                "{}\n…output truncated past {MAX_CLI_OUTPUT_BYTES} bytes",
                slice_utf16(&self.stderr, 0.0, Some(1000.0))
            );
            self.stdout_units = self.stdout.encode_utf16().count();
            self.stderr_units = self.stderr.encode_utf16().count();
            let outcome = CliRunOutcome {
                ok: false,
                code: -1.0,
                json: None,
                stdout: self.stdout.clone(),
                stderr: self.stderr.clone(),
            };
            return self.finish(outcome);
        }
        None
    }

    /// `child.stdout.on('data', ..)`
    pub fn on_stdout(&mut self, chunk: &[u8]) -> Option<CliRunOutcome> {
        self.on_chunk(chunk, true)
    }

    /// `child.stderr.on('data', ..)`
    pub fn on_stderr(&mut self, chunk: &[u8]) -> Option<CliRunOutcome> {
        self.on_chunk(chunk, false)
    }

    /// the watchdog timer `timer` fires
    pub fn on_timeout(&mut self, timer: u64) -> Option<CliRunOutcome> {
        if timer != self.timer {
            return None;
        }
        self.host.kill();
        let outcome = CliRunOutcome {
            ok: false,
            code: -1.0,
            json: None,
            stdout: self.stdout.clone(),
            stderr: format!("{}\nseuoffice timed out", self.stderr),
        };
        self.finish(outcome)
    }

    /// `child.on('error', ..)`; `error` is `String(err)`
    pub fn on_error(&mut self, error: &str) -> Option<CliRunOutcome> {
        let outcome = CliRunOutcome {
            ok: false,
            code: -1.0,
            json: None,
            stdout: self.stdout.clone(),
            stderr: format!("{}\n{error}", self.stderr),
        };
        self.finish(outcome)
    }

    /// `child.on('close', ..)`; `code` is `null` for a child a signal ended
    pub fn on_close(&mut self, code: Option<f64>) -> Option<CliRunOutcome> {
        let json = parse_json(&self.stdout);
        let status_ok = matches!(
            json.as_ref().and_then(|j| j.get("status")).as_deref(),
            Some(JsonValue::String(status)) if status == "ok"
        );
        let outcome = CliRunOutcome {
            ok: code == Some(0.0) && status_ok,
            code: code.unwrap_or(-1.0),
            json,
            stdout: self.stdout.clone(),
            stderr: self.stderr.clone(),
        };
        self.finish(outcome)
    }
}

/// `cliErrorMessage(outcome)`: turn a failed CLI run into a tool error
/// message an agent can act on. Where the CLI's own error object has no
/// `message` the TypeScript answers `undefined` (`None`), and one that is not
/// a string is answered as it is.
pub fn cli_error_message(outcome: &CliRunOutcome) -> Option<JsonValue> {
    if let Some(json) = &outcome.json
        && matches!(json.get("status").as_deref(), Some(JsonValue::String(status)) if status == "error")
    {
        return json.get("message").map(|message| message.into_owned());
    }
    let detail = match trim(&outcome.stderr) {
        "" => trim(&outcome.stdout),
        stderr => stderr,
    };
    Some(JsonValue::String(if detail.is_empty() {
        format!(
            "seuoffice exited with code {}",
            number_to_string(outcome.code)
        )
    } else {
        format!("seuoffice failed: {detail}")
    }))
}

/// the message of `new Error(cliErrorMessage(outcome))`, which is what
/// every headless call throws: `undefined` makes an empty message, anything
/// else is converted as `Error` converts it (a `TypeError` where it cannot).
pub fn cli_error(outcome: &CliRunOutcome) -> String {
    match cli_error_message(outcome) {
        None => String::new(),
        Some(message) => match to_primitive(Some(&message)) {
            Ok(primitive) => primitive.to_js_string(),
            Err(error) => error.0,
        },
    }
}
