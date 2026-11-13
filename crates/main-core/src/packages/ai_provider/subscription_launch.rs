//! `packages/ai-provider/src/subscription/launch.ts`: the things a user can
//! start for a subscription CLI: the CLI's own login and the vendor's install
//! command (both open a terminal window of their own and belong to the vendor
//! from there on), the CLI's own logout (a short command that needs no
//! window), and the update of the CLI the app found.
//!
//! Node cannot give a child process a console window of its own on Windows (a
//! detached child gets no console at all), so the login goes through
//! `Start-Process` and the install and update commands through `start`.
//!
//! ## State, stand-ins
//!
//! The two listener sets (`loginChangeListeners`, `offChangeListeners`) are
//! [`SubscriptionLaunchState`], which the caller owns (one per app). So are
//! the locate state and the shared child registry the launchers reach for
//! when an option leaves `locate` / `registry` out. A listener answers
//! `Result`: an `Err` is a listener that threw, and the others are still told.
//! The stand-ins `spawn` and `platform`'s fakes of the TypeScript are the
//! host (`Rt::spawn`) and [`Rt::platform`]; `locate`, `run` and `killTree`
//! stay options. `child.unref()` has no counterpart: no thread of this crate
//! waits for a child.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, js_regex};

use super::providers::is_subscription_cli;
use super::subscription_contract::{subscription_install_command, subscription_install_url};
use super::subscription_env::{SubscriptionEnvOptions, subscription_child_env};
use super::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionLocator, SubscriptionProgram,
    locate_subscription_program,
};
use super::subscription_process::{
    RegistryChoice, SharedChildRegistry, SubscriptionRunOptions, SubscriptionRunner,
    SubscriptionSpawnOptions, TrackedChildInfo, kill_process_tree_rt, run_subscription_program,
    spawn_subscription_program, track_child, windows_system_dir, windows_system_tool,
};
use super::task::{Child, ChildEvent, JsError, Rt, SpawnRequest, Stdio};

/// The CLI's own sign-in command
fn login_args(provider: &str) -> Vec<String> {
    match provider {
        "claude-code" => vec!["auth".into(), "login".into()],
        _ => vec!["login".into()],
    }
}

/// The CLI's own sign-out command
fn logout_args(provider: &str) -> Vec<String> {
    match provider {
        "claude-code" => vec!["auth".into(), "logout".into()],
        _ => vec!["logout".into()],
    }
}

/// A logout that has not finished by then is given up and its program ended
pub const SUBSCRIPTION_LOGOUT_TIMEOUT_MS: f64 = 20_000.0;

/// `SubscriptionLaunchResult`: `ok`, and why not. The JSON keys come in the
/// order `ok`, `reason`, `error`, `installUrl`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SubscriptionLaunchResult {
    pub ok: bool,
    /// `not-installed`, `unsupported`, `failed`, `invalid`
    pub reason: Option<String>,
    pub error: Option<String>,
    /// the vendor's install page, when installing by hand is the way forward
    pub install_url: Option<String>,
}

impl SubscriptionLaunchResult {
    pub fn ok() -> SubscriptionLaunchResult {
        SubscriptionLaunchResult {
            ok: true,
            ..SubscriptionLaunchResult::default()
        }
    }

    pub fn failure(reason: &str) -> SubscriptionLaunchResult {
        SubscriptionLaunchResult {
            ok: false,
            reason: Some(reason.to_owned()),
            error: None,
            install_url: None,
        }
    }

    fn failed(error: String, install_url: Option<String>) -> SubscriptionLaunchResult {
        SubscriptionLaunchResult {
            ok: false,
            reason: Some("failed".to_owned()),
            error: Some(error),
            install_url,
        }
    }

    fn with_url(reason: &str, install_url: String) -> SubscriptionLaunchResult {
        SubscriptionLaunchResult {
            ok: false,
            reason: Some(reason.to_owned()),
            error: None,
            install_url: Some(install_url),
        }
    }

    pub fn to_json(&self) -> JsonValue {
        let mut out = jscompat::JsObject::new();
        out.set("ok", JsonValue::Bool(self.ok));
        if let Some(reason) = &self.reason {
            out.set("reason", JsonValue::String(reason.clone()));
        }
        if let Some(error) = &self.error {
            out.set("error", JsonValue::String(error.clone()));
        }
        if let Some(url) = &self.install_url {
            out.set("installUrl", JsonValue::String(url.clone()));
        }
        JsonValue::Object(out)
    }
}

/// `SubscriptionOffChange`
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionOffChange {
    pub provider: String,
    pub off: bool,
}

pub type LoginChangeListener = Rc<dyn Fn(&str) -> Result<(), JsError>>;
pub type OffChangeListener = Rc<dyn Fn(&SubscriptionOffChange) -> Result<(), JsError>>;

/// The module state of this file: the listener sets, and the state of the
/// modules the launchers default to.
pub struct SubscriptionLaunchState {
    login_change: Vec<LoginChangeListener>,
    off_change: Vec<OffChangeListener>,
    /// the state `locateSubscriptionProgram` reads
    pub locate: LocateState,
    /// `sharedSubscriptionChildRegistry()`
    pub shared: SharedChildRegistry,
}

pub type LaunchState = Rc<RefCell<SubscriptionLaunchState>>;

impl SubscriptionLaunchState {
    pub fn new(locate: LocateState, shared: SharedChildRegistry) -> SubscriptionLaunchState {
        SubscriptionLaunchState {
            login_change: Vec::new(),
            off_change: Vec::new(),
            locate,
            shared,
        }
    }
}

/// A `Set` holds a function once: the same `Rc` added again is the entry it is.
fn same<T: ?Sized>(a: &Rc<T>, b: &Rc<T>) -> bool {
    std::ptr::addr_eq(Rc::as_ptr(a), Rc::as_ptr(b))
}

/// `onSubscriptionLoginChange(listener)`: be told when the app ran a CLI's
/// login or logout to its end. A process started before that may still hold
/// the login it started with, so a bridge that keeps one running listens
/// here. Answers the function that stops the listening.
pub fn on_subscription_login_change(
    state: &LaunchState,
    listener: LoginChangeListener,
) -> Rc<dyn Fn()> {
    {
        let mut st = state.borrow_mut();
        if !st.login_change.iter().any(|known| same(known, &listener)) {
            st.login_change.push(listener.clone());
        }
    }
    let state = state.clone();
    Rc::new(move || {
        state
            .borrow_mut()
            .login_change
            .retain(|known| !same(known, &listener));
    })
}

/// `notifySubscriptionLoginChange(provider)`: tell the listeners of
/// `onSubscriptionLoginChange`; one that throws does not stop the others
pub fn notify_subscription_login_change(state: &LaunchState, provider: &str) {
    let listeners: Vec<LoginChangeListener> = state.borrow().login_change.clone();
    for listener in listeners {
        // keep telling the others
        let _ = listener(provider);
    }
}

/// `onSubscriptionOffChange(listener)`: be told when a CLI was turned off in
/// this app, or back on (decision 0114). A bridge that keeps one of its
/// processes running ends it, and keeps none while the CLI is off.
pub fn on_subscription_off_change(
    state: &LaunchState,
    listener: OffChangeListener,
) -> Rc<dyn Fn()> {
    {
        let mut st = state.borrow_mut();
        if !st.off_change.iter().any(|known| same(known, &listener)) {
            st.off_change.push(listener.clone());
        }
    }
    let state = state.clone();
    Rc::new(move || {
        state
            .borrow_mut()
            .off_change
            .retain(|known| !same(known, &listener));
    })
}

/// `notifySubscriptionOffChange(change)`: tell the listeners of
/// `onSubscriptionOffChange`; one that throws does not stop the others
pub fn notify_subscription_off_change(state: &LaunchState, change: &SubscriptionOffChange) {
    let listeners: Vec<OffChangeListener> = state.borrow().off_change.clone();
    for listener in listeners {
        // keep telling the others
        let _ = listener(change);
    }
}

/// Carry the program and its arguments to the login window script as data
pub const SUBSCRIPTION_LOGIN_EXE_ENV: &str = "SEUOFFICE_SUBSCRIPTION_LOGIN_EXE";
pub const SUBSCRIPTION_LOGIN_ARGS_ENV: &str = "SEUOFFICE_SUBSCRIPTION_LOGIN_ARGS";

/// `loginWindowScript(windowStyle)`: opens the login program in a console
/// window of its own and waits for it. A constant: the program path and its
/// arguments arrive in two environment variables and are handed to
/// `Start-Process` as values, so nothing the user configured is ever read as
/// PowerShell code. The two variables are removed before the program starts.
fn login_window_script(window_style: &str) -> String {
    [
        format!("$exe = $env:{SUBSCRIPTION_LOGIN_EXE_ENV}"),
        format!("$arguments = $env:{SUBSCRIPTION_LOGIN_ARGS_ENV} -split \"`n\""),
        format!(
            "Remove-Item Env:{SUBSCRIPTION_LOGIN_EXE_ENV}, Env:{SUBSCRIPTION_LOGIN_ARGS_ENV}"
        ),
        format!(
            "Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle {window_style} -Wait"
        ),
    ]
    .join("; ")
}

/// Carry the visible window's own words to its script as data
/// (`SubscriptionLoginWindowText`)
pub const SUBSCRIPTION_LOGIN_TITLE_ENV: &str = "SEUOFFICE_SUBSCRIPTION_LOGIN_TITLE";
pub const SUBSCRIPTION_LOGIN_GUIDE_ENV: &str = "SEUOFFICE_SUBSCRIPTION_LOGIN_GUIDE";
pub const SUBSCRIPTION_LOGIN_CLOSING_ENV: &str = "SEUOFFICE_SUBSCRIPTION_LOGIN_CLOSING";

const LOGIN_WINDOW_ENVS: [&str; 5] = [
    SUBSCRIPTION_LOGIN_EXE_ENV,
    SUBSCRIPTION_LOGIN_ARGS_ENV,
    SUBSCRIPTION_LOGIN_TITLE_ENV,
    SUBSCRIPTION_LOGIN_GUIDE_ENV,
    SUBSCRIPTION_LOGIN_CLOSING_ENV,
];

/// `LOGIN_GUIDED_SCRIPT`: what runs in the console window the user sees. A
/// second PowerShell owns that console: it names the window, prints the guide
/// in the app's language, runs the CLI in the same console (so the CLI still
/// reads what the user pastes) and, when the CLI ends without signing in,
/// keeps the window open until Enter so what the CLI printed can still be
/// read. A constant like the hidden one: every value arrives in an
/// environment variable, and all of them are removed before the CLI starts.
///
/// `Start-Process` passes its argument list on joined with spaces and the new
/// PowerShell joins its arguments back into one command, so this text must
/// not hold a double quote.
fn login_guided_script() -> String {
    let removals = LOGIN_WINDOW_ENVS
        .iter()
        .map(|name| format!("Env:{name}"))
        .collect::<Vec<_>>()
        .join(", ");
    [
        format!("$exe = $env:{SUBSCRIPTION_LOGIN_EXE_ENV}"),
        format!("$arguments = $env:{SUBSCRIPTION_LOGIN_ARGS_ENV} -split [char]10"),
        format!("$title = $env:{SUBSCRIPTION_LOGIN_TITLE_ENV}"),
        format!("$guide = $env:{SUBSCRIPTION_LOGIN_GUIDE_ENV}"),
        format!("$closing = $env:{SUBSCRIPTION_LOGIN_CLOSING_ENV}"),
        format!("Remove-Item {removals} -ErrorAction SilentlyContinue"),
        "if ($title) { $Host.UI.RawUI.WindowTitle = $title }".to_owned(),
        "if ($guide) { Write-Host -Object $guide; Write-Host }".to_owned(),
        "$login = Start-Process -FilePath $exe -ArgumentList $arguments -NoNewWindow -Wait -PassThru"
            .to_owned(),
        "if ($login.ExitCode -ne 0 -and $closing) { Write-Host; Write-Host -Object $closing; [void][Console]::ReadLine() }"
            .to_owned(),
    ]
    .join("; ")
}

/// `LOGIN_WINDOW_SCRIPT`: the login in a console window the user sees, with
/// the app's guide above what the CLI prints
fn login_window_visible_script() -> String {
    [
        format!("$guided = '{}'", login_guided_script().replace('\'', "''")),
        "Start-Process -FilePath \"$PSHOME\\powershell.exe\" -ArgumentList '-NoProfile', '-NoLogo', '-Command', $guided -WindowStyle Normal -Wait"
            .to_owned(),
    ]
    .join("; ")
}

/// `LOGIN_HIDDEN_SCRIPT`: the login in a console of its own that is never
/// shown: the CLI still has a real console, opens the browser itself and
/// takes the sign-in back from it. Only a code to paste needs the window; the
/// visible login is for that.
fn login_hidden_script() -> String {
    login_window_script("Hidden")
}

/// `quoteWindowsArgument(argument)`: `Start-Process` joins its argument list
/// with spaces, so an argument with a space is quoted here
fn quote_windows_argument(argument: &str) -> String {
    if !js_regex!(r#"[\s"]"#).test(argument) {
        return argument.to_owned();
    }
    let doubled = js_regex!(r#"(\\*)""#).replace_all(argument, |m| {
        let slashes = m.get(1).unwrap_or("");
        format!("{slashes}{slashes}\\\"")
    });
    let closed = js_regex!(r"(\\+)$").replace_all(&doubled, |m| {
        let slashes = m.get(1).unwrap_or("");
        format!("{slashes}{slashes}")
    });
    format!("\"{closed}\"")
}

/// How long a child without a pid is given to say why it did not start
const START_FAILURE_WAIT_MS: f64 = 300.0;

/// `message(error)`
fn message(error: &JsError) -> String {
    error.message_or_string()
}

/// `startFailure(child)`: `None` when the child started; the reason when it
/// did not
async fn start_failure(rt: &Rt, child: &Child) -> Option<String> {
    let (settle, wait) = rt.deferred::<Option<String>>();
    // a later error (the window was closed, the program crashed) is not a failed start
    {
        let settle = settle.clone();
        child.on(move |event| {
            if let ChildEvent::Error(error) = event {
                settle.settle(Some(message(error)));
            }
        });
    }
    if child.pid().is_some() {
        settle.settle(None);
    } else {
        rt.set_timeout(START_FAILURE_WAIT_MS, move || {
            settle.settle(Some("The program could not be started".to_owned()));
        });
    }
    wait.await
}

/// `SubscriptionLoginWindowText`: the visible login window's own words, in
/// the app's language. Each one is optional.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubscriptionLoginWindowText {
    /// the window's title
    pub title: Option<String>,
    /// printed above what the CLI prints
    pub guide: Option<String>,
    /// printed when the CLI ended without signing in; the window then waits for Enter
    pub closing: Option<String>,
}

/// `SubscriptionLoginOptions`
#[derive(Clone, Default)]
pub struct SubscriptionLoginOptions {
    /// the user's own path to the CLI (the Codex `cliPath` setting)
    pub configured_path: Option<String>,
    /// called once when the login has ended, however it ended
    pub on_exit: Option<Rc<dyn Fn()>>,
    /// Windows: `hidden` runs the CLI's login without showing its window (the
    /// user signs in in the browser it opens); `visible`, the default, shows
    /// the window, where a code the browser hands back can be pasted.
    pub window: Option<String>,
    /// Windows, `visible` only: what the window says besides what the CLI prints
    pub window_text: Option<SubscriptionLoginWindowText>,
    /// called once the login has started, with a way to end it (its window
    /// and the CLI in it)
    pub on_started: Option<Rc<dyn Fn(Rc<dyn Fn()>)>>,
    /// stand-in for tests: how `stop` ends the login's process tree
    /// (`killProcessTree` when absent)
    pub kill_tree: Option<Rc<dyn Fn(&Child)>>,
    pub locate: Option<SubscriptionLocator>,
    pub platform: Option<String>,
    pub base_env: Option<Vec<(String, String)>>,
    /// where the login is registered for shutdown; the shared registry when
    /// absent, none for [`RegistryChoice::None`]
    pub registry: RegistryChoice,
}

/// `windowTextEnv(text)`: the window's words as the variables its script
/// reads; an empty one is left out
fn window_text_env(text: Option<&SubscriptionLoginWindowText>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(text) = text {
        for (name, value) in [
            (SUBSCRIPTION_LOGIN_TITLE_ENV, &text.title),
            (SUBSCRIPTION_LOGIN_GUIDE_ENV, &text.guide),
            (SUBSCRIPTION_LOGIN_CLOSING_ENV, &text.closing),
        ] {
            if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
                env.push((name.to_owned(), value.clone()));
            }
        }
    }
    env
}

/// An environment record as the lookup `windowsSystemDir(env)` reads: its own
/// keys, matched as written.
fn lookup(pairs: &[(String, String)]) -> impl Fn(&str) -> Option<String> + '_ {
    move |key| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }
}

fn is_cli(provider: &str) -> bool {
    is_subscription_cli(Some(&JsonValue::String(provider.to_owned())))
}

fn install_url_of(provider: &str) -> String {
    subscription_install_url(provider).to_owned()
}

/// `locate ?? locateSubscriptionProgram`
async fn locate_with(
    rt: &Rt,
    state: &LaunchState,
    locate: &Option<SubscriptionLocator>,
    provider: &str,
    configured_path: &Option<String>,
) -> Result<Option<SubscriptionProgram>, JsError> {
    let options = SubscriptionLocateOptions {
        configured_path: configured_path.clone(),
        ..SubscriptionLocateOptions::default()
    };
    match locate {
        Some(locate) => locate(rt.clone(), provider.to_owned(), options).await,
        None => {
            let locate_state = state.borrow().locate.clone();
            locate_subscription_program(rt, &locate_state, provider, &options).await
        }
    }
}

/// `startLogin(program, options)`
async fn start_login(
    rt: &Rt,
    state: &LaunchState,
    program: &SubscriptionProgram,
    options: &SubscriptionLoginOptions,
) -> Result<Child, JsError> {
    let platform = options.platform.clone().unwrap_or_else(|| rt.platform());
    let args = login_args(&program.provider);
    if platform != "win32" {
        // the CLI opens the browser itself; there is no terminal to show
        let shared = state.borrow().shared.clone();
        return spawn_subscription_program(
            rt,
            &shared,
            program,
            &args,
            &SubscriptionSpawnOptions {
                // not the folder the app was started in: no project-level configuration of it applies
                cwd: Some(rt.tmpdir()),
                stdio: Some([Stdio::Ignore; 3]),
                base_env: options.base_env.clone(),
                platform: Some(platform),
                registry: options.registry.clone(),
                ..SubscriptionSpawnOptions::default()
            },
        )
        .await;
    }
    let mut extra: Vec<(String, String)> = program.env.clone();
    extra.push((
        SUBSCRIPTION_LOGIN_EXE_ENV.to_owned(),
        program.command.clone(),
    ));
    extra.push((
        SUBSCRIPTION_LOGIN_ARGS_ENV.to_owned(),
        program
            .prefix_args
            .iter()
            .chain(args.iter())
            .map(|argument| quote_windows_argument(argument))
            .collect::<Vec<_>>()
            .join("\n"),
    ));
    if options.window.as_deref() != Some("hidden") {
        extra.extend(window_text_env(options.window_text.as_ref()));
    }
    let env = subscription_child_env(
        rt,
        &SubscriptionEnvOptions {
            base: options.base_env.clone(),
            platform: Some(platform),
            command: Some(program.command.clone()),
            extra,
        },
    );
    let get = lookup(&env);
    let launcher = windows_system_tool(&get, &["WindowsPowerShell", "v1.0", "powershell.exe"]);
    let script = if options.window.as_deref() == Some("hidden") {
        login_hidden_script()
    } else {
        login_window_visible_script()
    };
    let child = rt
        .spawn(SpawnRequest {
            command: launcher.clone(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-NoLogo".into(),
                "-WindowStyle".into(),
                "Hidden".into(),
                "-Command".into(),
                script,
            ],
            // the login program inherits this directory, not the folder the app was started in
            cwd: Some(windows_system_dir(&get)),
            env: Some(env.clone()),
            stdio: [Stdio::Ignore; 3],
            detached: false,
            windows_hide: true,
            shell: None,
        })
        .await?;
    // The login program is a child of this launcher, so ending the launcher's tree ends it.
    // The launcher is what gets recorded: it is the process whose pid the app holds.
    let shared = state.borrow().shared.clone();
    track_child(
        rt,
        &shared,
        &options.registry,
        &child,
        &TrackedChildInfo {
            provider: program.provider.clone(),
            command: launcher,
            started_at: None,
        },
    );
    Ok(child)
}

/// `launchSubscriptionLogin(provider, options)`: start the CLI's own login
/// (`claude auth login`, `codex login`) with the sanitised environment. On
/// Windows it runs in a console of its own: hidden (`window: 'hidden'`),
/// where the user signs in in the browser the CLI opens, or shown, where the
/// vendor's flow prints its link and takes a pasted code below the app's
/// guide (`windowText`); elsewhere the flow runs in the browser the CLI
/// opens. The app shows no login form and never sees the code or the
/// credentials. A window the user closes without signing in simply leaves the
/// provider `signed-out`.
pub async fn launch_subscription_login(
    rt: &Rt,
    state: &LaunchState,
    provider: &str,
    options: &SubscriptionLoginOptions,
) -> SubscriptionLaunchResult {
    // only a vendor CLI has a program to launch (ChatGPT signs in with the app's own flow)
    if !is_cli(provider) {
        return SubscriptionLaunchResult::failure("invalid");
    }
    let program = match locate_with(
        rt,
        state,
        &options.locate,
        provider,
        &options.configured_path,
    )
    .await
    {
        Ok(program) => program,
        Err(error) => return SubscriptionLaunchResult::failed(message(&error), None),
    };
    let Some(program) = program else {
        return SubscriptionLaunchResult::with_url("not-installed", install_url_of(provider));
    };
    let child = match start_login(rt, state, &program, options).await {
        Ok(child) => child,
        Err(error) => return SubscriptionLaunchResult::failed(message(&error), None),
    };
    if let Some(failure) = start_failure(rt, &child).await {
        return SubscriptionLaunchResult::failed(failure, None);
    }
    // whoever is signed in now, it may not be who was before
    let on_exit = options.on_exit.clone();
    let fired = Rc::new(Cell::new(false));
    {
        let (state, provider, fired) = (state.clone(), provider.to_owned(), fired.clone());
        child.on(move |event| {
            if matches!(event, ChildEvent::Exit { .. }) && !fired.replace(true) {
                notify_subscription_login_change(&state, &provider);
            }
        });
    }
    if let Some(on_exit) = on_exit {
        let fired = Rc::new(Cell::new(false));
        child.on(move |event| {
            if matches!(event, ChildEvent::Exit { .. }) && !fired.replace(true) {
                on_exit();
            }
        });
    }
    // the launcher's tree holds the CLI, so ending the tree ends the login
    if let Some(on_started) = &options.on_started {
        let kill_tree = options.kill_tree.clone();
        let (rt, child) = (rt.clone(), child.clone());
        on_started(Rc::new(move || match &kill_tree {
            Some(kill_tree) => kill_tree(&child),
            None => kill_process_tree_rt(&rt, child.pid(), true),
        }));
    }
    SubscriptionLaunchResult::ok()
}

/// `SubscriptionLogoutOptions`
#[derive(Clone, Default)]
pub struct SubscriptionLogoutOptions {
    /// the user's own path to the CLI (the Codex `cliPath` setting)
    pub configured_path: Option<String>,
    pub timeout_ms: Option<f64>,
    pub locate: Option<SubscriptionLocator>,
    /// runs the command to its end; `runSubscriptionProgram` when absent
    pub run: Option<SubscriptionRunner>,
    pub base_env: Option<Vec<(String, String)>>,
}

/// `launchSubscriptionLogout(provider, options)`: run the CLI's own logout
/// (`claude auth logout`, `codex logout`) to its end: the located file, an
/// argument list, the sanitised environment, no shell, no window, and a
/// bounded time. The app removes nothing itself and never sees the login;
/// what the command did shows in the next status check.
///
/// The logout is the CLI's, for the whole PC: a terminal using the same
/// program is signed out with it. Asking the user first is the caller's part.
pub async fn launch_subscription_logout(
    rt: &Rt,
    state: &LaunchState,
    provider: &str,
    options: &SubscriptionLogoutOptions,
) -> SubscriptionLaunchResult {
    // only a vendor CLI has a program to launch (ChatGPT signs in with the app's own flow)
    if !is_cli(provider) {
        return SubscriptionLaunchResult::failure("invalid");
    }
    let program = match locate_with(
        rt,
        state,
        &options.locate,
        provider,
        &options.configured_path,
    )
    .await
    {
        Ok(program) => program,
        Err(error) => return SubscriptionLaunchResult::failed(message(&error), None),
    };
    let Some(program) = program else {
        return SubscriptionLaunchResult::with_url("not-installed", install_url_of(provider));
    };
    let run_options = SubscriptionRunOptions {
        signal: rt.controller(),
        timeout_ms: options.timeout_ms.unwrap_or(SUBSCRIPTION_LOGOUT_TIMEOUT_MS),
        base_env: options.base_env.clone(),
        cwd: None,
    };
    let args = logout_args(provider);
    let ran = match &options.run {
        Some(run) => run(rt.clone(), program, args, run_options).await,
        None => {
            let shared = state.borrow().shared.clone();
            run_subscription_program(rt, &shared, &program, &args, &run_options).await
        }
    };
    let result = match ran {
        // what the CLI printed stays here: it may name the account
        Ok(result) if result.code == Some(0.0) => SubscriptionLaunchResult::ok(),
        Ok(_) => SubscriptionLaunchResult::failure("failed"),
        Err(error) => SubscriptionLaunchResult::failed(message(&error), None),
    };
    // run to its end or not, the login may no longer be the one a running process holds
    notify_subscription_login_change(state, provider);
    result
}

/// `subscriptionInstallCommandLine(provider, env)`: the command line of the
/// install window: `start` opens a new console, and the PowerShell in it runs
/// the vendor command and stays open. Built only from the constant in
/// `SUBSCRIPTION_INSTALL_COMMANDS` and the full path of PowerShell in the
/// system directory: `start` looks for a bare program name in the working
/// directory before anywhere else.
pub fn subscription_install_command_line(
    provider: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> String {
    let powershell = windows_system_tool(env, &["WindowsPowerShell", "v1.0", "powershell.exe"]);
    format!(
        "start \"\" \"{powershell}\" -NoLogo -NoExit -Command \"{}\"",
        subscription_install_command(provider)
    )
}

/// `SubscriptionInstallOptions`
#[derive(Clone, Default)]
pub struct SubscriptionInstallOptions {
    pub platform: Option<String>,
    /// `NodeJS.ProcessEnv`; the process's own when absent
    pub env: Option<Vec<(String, String)>>,
}

/// The environment of an install or update window: the options' record, or
/// the process's own
fn window_env(rt: &Rt, options: &SubscriptionInstallOptions) -> Vec<(String, String)> {
    options.env.clone().unwrap_or_else(|| rt.env_all())
}

/// `env[key]` of that environment: `process.env` answers by the platform's
/// own rules, a record by its own keys
fn window_get(rt: &Rt, options: &SubscriptionInstallOptions, key: &str) -> Option<String> {
    match &options.env {
        Some(pairs) => lookup(pairs)(key),
        None => rt.env(key),
    }
}

/// `spawn(commandLine, [], { cwd, env, shell, stdio: 'ignore', windowsHide: true })`
async fn spawn_window(
    rt: &Rt,
    command_line: String,
    env: Vec<(String, String)>,
    get: &dyn Fn(&str) -> Option<String>,
) -> Result<Child, JsError> {
    rt.spawn(SpawnRequest {
        command: command_line,
        args: Vec::new(),
        // the window starts in the system directory, not the folder the app was started in
        cwd: Some(windows_system_dir(get)),
        env: Some(env),
        stdio: [Stdio::Ignore; 3],
        detached: false,
        windows_hide: true,
        // cmd.exe by full path; it exits as soon as `start` has opened the window
        shell: Some(windows_system_tool(get, &["cmd.exe"])),
    })
    .await
}

/// `launchSubscriptionInstall(provider, options)`: run the vendor's install
/// command in a new, visible terminal window that stays open, so the user
/// sees it work or fail. This is the one place a shell interprets a command
/// line, and the line is a constant: it is looked up by provider id and
/// contains no setting, path or other outside text.
///
/// The app downloads nothing itself and does not wait for the installer. If
/// the command fails (no winget, no network) the provider simply stays
/// `not-installed`; `installUrl` is where to install by hand. The commands
/// are Windows ones: other systems get `unsupported` and the same link.
pub async fn launch_subscription_install(
    rt: &Rt,
    provider: &str,
    options: &SubscriptionInstallOptions,
) -> SubscriptionLaunchResult {
    // only a vendor CLI has a program to launch (ChatGPT signs in with the app's own flow)
    if !is_cli(provider) {
        return SubscriptionLaunchResult::failure("invalid");
    }
    let install_url = install_url_of(provider);
    let platform = options.platform.clone().unwrap_or_else(|| rt.platform());
    if platform != "win32" {
        return SubscriptionLaunchResult::with_url("unsupported", install_url);
    }
    let env = window_env(rt, options);
    let get = |key: &str| window_get(rt, options, key);
    let command_line = subscription_install_command_line(provider, &get);
    let child = match spawn_window(rt, command_line, env, &get).await {
        Ok(child) => child,
        Err(error) => {
            return SubscriptionLaunchResult::failed(message(&error), Some(install_url));
        }
    };
    if let Some(failure) = start_failure(rt, &child).await {
        return SubscriptionLaunchResult::failed(failure, Some(install_url));
    }
    // the installer window is the user's: it is not tracked and not ended with the app
    SubscriptionLaunchResult::ok()
}

/// Carry the program and its arguments to the update window as data, like the login's
pub const SUBSCRIPTION_UPDATE_EXE_ENV: &str = "SEUOFFICE_SUBSCRIPTION_UPDATE_EXE";
pub const SUBSCRIPTION_UPDATE_ARGS_ENV: &str = "SEUOFFICE_SUBSCRIPTION_UPDATE_ARGS";

/// `SUBSCRIPTION_CODEX_UPDATE_COMMANDS.npm`: the package manager command that
/// brings an npm Codex install up to date
pub const SUBSCRIPTION_CODEX_UPDATE_COMMAND_NPM: &str = "npm install -g @openai/codex@latest";
/// `SUBSCRIPTION_CODEX_UPDATE_COMMANDS.winget`
pub const SUBSCRIPTION_CODEX_UPDATE_COMMAND_WINGET: &str = "winget upgrade --id OpenAI.Codex -e";

/// `SubscriptionUpdatePlan`: how the CLI the app found is brought up to date:
/// the program's own update command (`Program`, run as the located file,
/// never by name, since a PC can hold another copy the name finds first), or
/// the fixed command of the package manager that installed it (`Command`).
#[derive(Debug, Clone, PartialEq)]
pub enum SubscriptionUpdatePlan {
    Program { args: Vec<String> },
    Command { command: String },
}

/// `subscriptionUpdatePlan(program)`: `None` when the app cannot tell how it
/// was installed (the Codex desktop app's copy, a path the user set to some
/// other place, a winget link that cannot be resolved to its package): the
/// vendor's install page is the way then.
pub fn subscription_update_plan(program: &SubscriptionProgram) -> Option<SubscriptionUpdatePlan> {
    // `claude update` updates a native install and an npm one alike
    if program.provider == "claude-code" {
        return Some(SubscriptionUpdatePlan::Program {
            args: vec!["update".to_owned()],
        });
    }
    let paths = [&program.entry, &program.command];
    if paths
        .iter()
        .any(|path| js_regex!(r"[\\/]node_modules[\\/]@openai[\\/]codex", "i").test(path))
    {
        return Some(SubscriptionUpdatePlan::Command {
            command: SUBSCRIPTION_CODEX_UPDATE_COMMAND_NPM.to_owned(),
        });
    }
    // A Links entry alone does not say which package owns the alias; the locator
    // resolves it to the package file before this runs
    if paths.iter().any(|path| {
        js_regex!(
            r"[\\/]microsoft[\\/]winget[\\/]packages[\\/]openai\.codex_",
            "i"
        )
        .test(path)
    }) {
        return Some(SubscriptionUpdatePlan::Command {
            command: SUBSCRIPTION_CODEX_UPDATE_COMMAND_WINGET.to_owned(),
        });
    }
    None
}

/// `UPDATE_PROGRAM_SCRIPT`: runs the located program with its update
/// arguments and leaves the window open. A constant, like the login's: the
/// path and the arguments arrive in two environment variables and are removed
/// before the program starts. The arguments are split on a line feed written
/// as `[char]10`, since a quote would end the command line `start` is given.
fn update_program_script() -> String {
    [
        format!("$exe = $env:{SUBSCRIPTION_UPDATE_EXE_ENV}"),
        format!("$arguments = $env:{SUBSCRIPTION_UPDATE_ARGS_ENV} -split [char]10"),
        format!(
            "Remove-Item Env:{SUBSCRIPTION_UPDATE_EXE_ENV}, Env:{SUBSCRIPTION_UPDATE_ARGS_ENV}"
        ),
        "& $exe @arguments".to_owned(),
    ]
    .join("; ")
}

/// `subscriptionUpdateCommandLine(plan, env)`: the command line of the update
/// window, like the install window's: `start` opens a new console whose
/// PowerShell runs the update and stays open. Built only from constants and
/// the full path of PowerShell in the system directory.
pub fn subscription_update_command_line(
    plan: &SubscriptionUpdatePlan,
    env: &dyn Fn(&str) -> Option<String>,
) -> String {
    let powershell = windows_system_tool(env, &["WindowsPowerShell", "v1.0", "powershell.exe"]);
    let command = match plan {
        SubscriptionUpdatePlan::Program { .. } => update_program_script(),
        SubscriptionUpdatePlan::Command { command } => command.clone(),
    };
    format!("start \"\" \"{powershell}\" -NoLogo -NoExit -Command \"{command}\"")
}

/// `SubscriptionUpdateOptions`
#[derive(Clone, Default)]
pub struct SubscriptionUpdateOptions {
    pub install: SubscriptionInstallOptions,
    /// the user's own path to the CLI (the Codex `cliPath` setting)
    pub configured_path: Option<String>,
    pub locate: Option<SubscriptionLocator>,
}

/// `launchSubscriptionUpdate(provider, options)`: bring the CLI the app runs
/// up to date, in a new, visible terminal window that stays open so the user
/// sees it work or fail. Like the install, the shell is given a constant
/// line; the program's path travels as a value.
///
/// The app does not wait: the next status check (the window regains focus,
/// or "check again") shows the new version. Windows only, like the install.
pub async fn launch_subscription_update(
    rt: &Rt,
    state: &LaunchState,
    provider: &str,
    options: &SubscriptionUpdateOptions,
) -> SubscriptionLaunchResult {
    // only a vendor CLI has a program to launch (ChatGPT signs in with the app's own flow)
    if !is_cli(provider) {
        return SubscriptionLaunchResult::failure("invalid");
    }
    let install_url = install_url_of(provider);
    let platform = options
        .install
        .platform
        .clone()
        .unwrap_or_else(|| rt.platform());
    if platform != "win32" {
        return SubscriptionLaunchResult::with_url("unsupported", install_url);
    }
    let program = match locate_with(
        rt,
        state,
        &options.locate,
        provider,
        &options.configured_path,
    )
    .await
    {
        Ok(program) => program,
        Err(error) => {
            return SubscriptionLaunchResult::failed(message(&error), Some(install_url));
        }
    };
    let Some(program) = program else {
        return SubscriptionLaunchResult::with_url("not-installed", install_url);
    };
    let Some(plan) = subscription_update_plan(&program) else {
        return SubscriptionLaunchResult::with_url("unsupported", install_url);
    };
    let env = match &plan {
        SubscriptionUpdatePlan::Program { args } => {
            let mut extra = program.env.clone();
            extra.push((
                SUBSCRIPTION_UPDATE_EXE_ENV.to_owned(),
                program.command.clone(),
            ));
            extra.push((
                SUBSCRIPTION_UPDATE_ARGS_ENV.to_owned(),
                program
                    .prefix_args
                    .iter()
                    .chain(args.iter())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n"),
            ));
            subscription_child_env(
                rt,
                &SubscriptionEnvOptions {
                    base: Some(window_env(rt, &options.install)),
                    platform: Some(platform),
                    command: Some(program.command.clone()),
                    extra,
                },
            )
        }
        SubscriptionUpdatePlan::Command { .. } => window_env(rt, &options.install),
    };
    // the record the program plan built is the environment from here on; the
    // other plan keeps the options' own (or the process's), looked up as such
    let program_plan = matches!(plan, SubscriptionUpdatePlan::Program { .. });
    let own = lookup(&env);
    let get = |key: &str| {
        if program_plan {
            own(key)
        } else {
            window_get(rt, &options.install, key)
        }
    };
    let command_line = subscription_update_command_line(&plan, &get);
    let child = match spawn_window(rt, command_line, env.clone(), &get).await {
        Ok(child) => child,
        Err(error) => {
            return SubscriptionLaunchResult::failed(message(&error), Some(install_url));
        }
    };
    if let Some(failure) = start_failure(rt, &child).await {
        return SubscriptionLaunchResult::failed(failure, Some(install_url));
    }
    // the update window is the user's, like the installer's
    SubscriptionLaunchResult::ok()
}
