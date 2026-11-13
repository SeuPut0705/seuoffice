//! `packages/ai-provider/src/subscription/status.ts`: reading the connection
//! status of a subscription CLI from what the CLI itself reports.
//!
//! No text of a CLI is ever copied into a result: the output is matched
//! against values this file lists, and anything unrecognised becomes the fixed
//! token `unknown`. Two values pass on, each only in its own narrow shape: the
//! plan name when it looks like a plan identifier, and the account when it is
//! an e-mail address.
//!
//! ## What is state, what is a stand-in
//!
//! The module state of the TypeScript (`codexAccountSource`, set by the Codex
//! bridge, and the ChatGPT connection `detectChatGptConnection` reads) is
//! [`SubscriptionStatusState`], which the caller owns (one per app) and passes
//! as `&Rc<RefCell<SubscriptionStatusState>>`; [`set_codex_account_source`] is
//! `setCodexAccountSource`. The stand-ins the options carry (`locate`, `run`,
//! `codexAccount`) are `Rc<dyn Fn>` values taking owned arguments, so the
//! future they answer owns what it needs. Starting a program goes through
//! `task::Rt` like every other await.

use std::cell::RefCell;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::LazyLock;
use std::task::{Context, Poll, Waker};

use jscompat::{JsObject, JsonValue, js_regex, json_parse, math_round, number_to_string, trim};

use super::chatgpt_connection::ChatGptConnectionModuleState;
use super::chatgpt_status::detect_chatgpt_connection;
use super::providers::AI_SUBSCRIPTION_PROVIDERS;
use super::subscription_contract::{
    subscription_account_of, subscription_min_version, subscription_status_error_text,
    subscription_version_at_least, subscription_version_of,
};
use super::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionLocator, SubscriptionProgram,
    locate_subscription_program, subscription_provider_label,
};
use super::subscription_process::{
    SharedChildRegistry, SubscriptionCommandResult, SubscriptionRunOptions, SubscriptionRunner,
    run_subscription_program,
};
use super::task::{FsOp, JsError, LocalBoxFuture, Rt, Signal, Wait};

/// A promise of an `async` stand-in or hook: the future owns what it needs.
pub type Fut<T> = LocalBoxFuture<T>;

/// One turn of the JavaScript microtask queue: what an `await` costs where
/// the awaited value is there already. The runtime polls its tasks in
/// passes, so a task that yields here goes on one pass later, behind the
/// others that were ready, as a promise continuation goes behind the
/// continuations queued before it. The `await`s of the subscription modules
/// that other work can interleave with are each one of these.
pub async fn tick(rt: &Rt) {
    // marks the runtime as having work, so it polls again
    rt.spawn_local(async {});
    let mut yielded = false;
    std::future::poll_fn(move |_| {
        if yielded {
            Poll::Ready(())
        } else {
            yielded = true;
            Poll::Pending
        }
    })
    .await
}

/// An `async` function call: the body runs now, up to its first `await`, as
/// JavaScript runs it; the rest goes on as a task. The answer is the promise.
pub fn start_now<T: Clone + 'static>(
    rt: &Rt,
    future: impl Future<Output = T> + 'static,
) -> Wait<T> {
    let (settle, wait) = rt.deferred::<T>();
    let mut body: Pin<Box<dyn Future<Output = ()>>> =
        Box::pin(async move { settle.settle(future.await) });
    let mut cx = Context::from_waker(Waker::noop());
    if body.as_mut().poll(&mut cx).is_pending() {
        rt.spawn_local(body);
    }
    wait
}

/// A status check that has not answered by then is an `error`
pub const SUBSCRIPTION_STATUS_TIMEOUT_MS: f64 = 20_000.0;

/// What a CLI says about its login; of the account identity only the e-mail
/// address is kept (`SubscriptionLogin`).
#[derive(Debug, Clone, PartialEq)]
pub enum SubscriptionLogin {
    /// `{ signedIn: false }`
    SignedOut,
    SignedIn {
        /// `AiSubscriptionLoginMethod`: `subscription`, `metered`, `unknown`
        login_method: String,
        /// plan the CLI names, for display
        plan_name: Option<String>,
        /// one of [`SUBSCRIPTION_LOGIN_KINDS`]
        login_kind: String,
        /// the e-mail address the CLI names, for display only
        account: Option<String>,
    },
}

impl SubscriptionLogin {
    fn signed_in(login_method: &str, login_kind: &str) -> SubscriptionLogin {
        SubscriptionLogin::SignedIn {
            login_method: login_method.to_owned(),
            plan_name: None,
            login_kind: login_kind.to_owned(),
            account: None,
        }
    }
}

/// Outcome of one status check, before the stored metered acceptance is
/// applied (`SubscriptionDetection`). `state` is never `checking` and never
/// `off`.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionDetection {
    pub provider: String,
    pub state: String,
    pub version: Option<String>,
    pub login_method: Option<String>,
    pub plan_name: Option<String>,
    pub error: Option<String>,
    /// the file the check ran, on a `needs-update` error
    pub program_path: Option<String>,
    pub login_kind: Option<String>,
    /// the e-mail address of the signed-in account, for display only
    pub account: Option<String>,
}

impl SubscriptionDetection {
    /// `{ provider, state }`
    pub fn new(provider: &str, state: &str) -> SubscriptionDetection {
        SubscriptionDetection {
            provider: provider.to_owned(),
            state: state.to_owned(),
            version: None,
            login_method: None,
            plan_name: None,
            error: None,
            program_path: None,
            login_kind: None,
            account: None,
        }
    }

    /// The detection as JSON, the keys in the order the interface lists them
    /// (the TypeScript builds them in another order per constructor; the
    /// comparison writes this one on both sides).
    pub fn to_json(&self) -> JsonValue {
        let mut out = JsObject::new();
        out.set("provider", JsonValue::String(self.provider.clone()));
        out.set("state", JsonValue::String(self.state.clone()));
        for (key, value) in [
            ("version", &self.version),
            ("loginMethod", &self.login_method),
            ("planName", &self.plan_name),
            ("error", &self.error),
            ("programPath", &self.program_path),
            ("loginKind", &self.login_kind),
            ("account", &self.account),
        ] {
            if let Some(value) = value {
                out.set(key, JsonValue::String(value.clone()));
            }
        }
        JsonValue::Object(out)
    }
}

/// `CodexAccountSource`: the raw result of the Codex app-server's
/// `account/read`, supplied by the Codex bridge. The arguments are the
/// configured Codex path and the signal that ends whatever the source started.
pub type CodexAccountSource =
    Rc<dyn Fn(Rt, Option<String>, Signal) -> Fut<Result<JsonValue, JsError>>>;

/// The module state of this file.
pub struct SubscriptionStatusState {
    /// `codexAccountSource`
    pub codex_account_source: Option<CodexAccountSource>,
    /// The module state `detectChatGptConnection()` reads (`chatGptConnection()`
    /// of chatgpt/connection.ts), which the caller owns; the ChatGPT sign-in of
    /// the IPC helper registers its connection in it.
    pub chat_gpt: Rc<RefCell<ChatGptConnectionModuleState>>,
    /// the state `locateSubscriptionProgram` reads (its module state)
    pub locate: LocateState,
    /// `sharedSubscriptionChildRegistry()`, which `runSubscriptionProgram` tracks its children in
    pub shared: SharedChildRegistry,
}

impl SubscriptionStatusState {
    pub fn new(
        locate: LocateState,
        shared: SharedChildRegistry,
        chat_gpt: Rc<RefCell<ChatGptConnectionModuleState>>,
    ) -> SubscriptionStatusState {
        SubscriptionStatusState {
            codex_account_source: None,
            chat_gpt,
            locate,
            shared,
        }
    }
}

pub type StatusState = Rc<RefCell<SubscriptionStatusState>>;

/// `setCodexAccountSource(source)`: let the Codex bridge supply
/// `account/read` to the status check. `None` removes it.
pub fn set_codex_account_source(state: &StatusState, source: Option<CodexAccountSource>) {
    state.borrow_mut().codex_account_source = source;
}

/// `options.codexAccount`: `undefined` (the registered source), `null` (none)
/// or a source of its own.
#[derive(Clone, Default)]
pub enum CodexAccountOption {
    #[default]
    Registered,
    Off,
    Source(CodexAccountSource),
}

/// `SubscriptionDetectOptions`
#[derive(Clone, Default)]
pub struct SubscriptionDetectOptions {
    /// the user's own path to the CLI (the Codex `cliPath` setting)
    pub configured_path: Option<String>,
    pub timeout_ms: Option<f64>,
    pub locate: Option<SubscriptionLocator>,
    pub run: Option<SubscriptionRunner>,
    pub codex_account: CodexAccountOption,
}

/// `SubscriptionDetector`: a stand-in can reject; `detectSubscriptionLogin`
/// itself never does.
pub type SubscriptionDetector = Rc<
    dyn Fn(Rt, String, SubscriptionDetectOptions) -> Fut<Result<SubscriptionDetection, JsError>>,
>;

/// `detectSubscriptionLogin` as a [`SubscriptionDetector`] over `state`.
pub fn subscription_detector(state: &StatusState) -> SubscriptionDetector {
    let state = state.clone();
    Rc::new(move |rt, provider, options| {
        let state = state.clone();
        Box::pin(
            async move { Ok(detect_subscription_login(&rt, &state, &provider, &options).await) },
        )
    })
}

/// The token for a kind of login this file does not list
const UNKNOWN_KIND: &str = "unknown";

/// Values of `authMethod` in `claude auth status`
const CLAUDE_AUTH_KINDS: [&str; 5] = [
    "claude.ai",
    "api_key",
    "api_key_helper",
    "third_party",
    "oauth_token",
];

/// Values of `apiProvider` in `claude auth status`
const CLAUDE_API_PROVIDER_KINDS: [&str; 8] = [
    "firstParty",
    "bedrock",
    "vertex",
    "foundry",
    "anthropicAws",
    "anthropicGoogleCloud",
    "mantle",
    "gateway",
];

const CODEX_LOGIN_KINDS: [&str; 7] = [
    "chatgpt",
    "api-key",
    "bedrock",
    "workload-identity",
    "access-token",
    "personal-access-token",
    "no-account",
];

/// Every value a `loginKind` can take. Claude: `<authMethod>/<apiProvider>`,
/// each half from its list above or `unknown`. Codex: one of its list. All of
/// them are constants of this file; none is built from what a CLI printed.
pub static SUBSCRIPTION_LOGIN_KINDS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut kinds = vec![UNKNOWN_KIND.to_owned()];
    for auth in CLAUDE_AUTH_KINDS.iter().chain([&UNKNOWN_KIND]) {
        for api in CLAUDE_API_PROVIDER_KINDS.iter().chain([&UNKNOWN_KIND]) {
            kinds.push(format!("{auth}/{api}"));
        }
    }
    kinds.extend(CODEX_LOGIN_KINDS.iter().map(|kind| (*kind).to_owned()));
    kinds
});

/// `subscriptionLoginKind(value)`: `value` when it is one of the listed
/// kinds, the fixed token `unknown` otherwise
pub fn subscription_login_kind(value: Option<&str>) -> String {
    match value {
        Some(kind) if SUBSCRIPTION_LOGIN_KINDS.iter().any(|known| known == kind) => kind.to_owned(),
        _ => UNKNOWN_KIND.to_owned(),
    }
}

/// `listed(value, list)`: the entry of `list` equal to `value`; the result is
/// the list's own constant, never the input
fn listed(value: Option<&JsonValue>, list: &[&'static str]) -> &'static str {
    match value {
        Some(JsonValue::String(text)) => list
            .iter()
            .find(|entry| **entry == text.as_str())
            .copied()
            .unwrap_or(UNKNOWN_KIND),
        _ => UNKNOWN_KIND,
    }
}

/// `planLabel(value)`: a plan name as the CLIs give it: one short identifier
/// (`max`, `plus`, `team`). A value of any other shape is not shown.
fn plan_label(value: Option<&JsonValue>) -> Option<String> {
    match value {
        // the pattern is `/^[a-z][a-z0-9_-]{0,31}$/i`; with ASCII letters
        // spelled out, `i` has nothing left to do
        Some(JsonValue::String(text)) if js_regex!(r"^[a-zA-Z][a-zA-Z0-9_-]{0,31}$").test(text) => {
            Some(text.clone())
        }
        _ => None,
    }
}

/// `asRecord(value)`
fn as_record(value: Option<&JsonValue>) -> Option<&JsObject<JsonValue>> {
    match value {
        Some(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

// ── Claude Code: `claude auth status --json` ──

const CLAUDE_METERED_METHODS: [&str; 3] = ["api_key", "api_key_helper", "third_party"];

/// `parseClaudeAuthStatus(stdout)`: read `loggedIn`, `authMethod`,
/// `apiProvider`, `subscriptionType` and `email` from the CLI's JSON; every
/// other field is ignored. A subscription is reported only for a claude.ai
/// login on Anthropic's own API that names a plan. `None` when the output is
/// not the expected JSON.
pub fn parse_claude_auth_status(stdout: &str) -> Option<SubscriptionLogin> {
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    if end <= start {
        return None;
    }
    let parsed = json_parse(&stdout[start..=end]).ok()?;
    let parsed = as_record(Some(&parsed))?;
    let Some(JsonValue::Bool(logged_in)) = parsed.get("loggedIn") else {
        return None;
    };
    if !logged_in {
        return Some(SubscriptionLogin::SignedOut);
    }
    let auth_method = listed(parsed.get("authMethod"), &CLAUDE_AUTH_KINDS);
    let api_provider = listed(parsed.get("apiProvider"), &CLAUDE_API_PROVIDER_KINDS);
    let plan_name = plan_label(parsed.get("subscriptionType"));
    let account = subscription_account_of(parsed.get("email"));
    let login_kind = format!("{auth_method}/{api_provider}");
    // any named backend other than Anthropic's own API is a paid route, known to this file or not
    let other_backend = matches!(
        parsed.get("apiProvider"),
        Some(JsonValue::String(name)) if !name.is_empty() && name != "firstParty"
    );
    if CLAUDE_METERED_METHODS.contains(&auth_method) || other_backend {
        return Some(SubscriptionLogin::SignedIn {
            login_method: "metered".to_owned(),
            plan_name: None,
            login_kind,
            account,
        });
    }
    if auth_method == "claude.ai"
        && api_provider == "firstParty"
        && let Some(plan_name) = plan_name
    {
        return Some(SubscriptionLogin::SignedIn {
            login_method: "subscription".to_owned(),
            plan_name: Some(plan_name),
            login_kind,
            account,
        });
    }
    Some(SubscriptionLogin::SignedIn {
        login_method: "unknown".to_owned(),
        plan_name: None,
        login_kind,
        account,
    })
}

// ── Codex: `codex login status` ──

/// `parseCodexLoginStatus(output)`: read the one line `codex login status`
/// prints (on stderr). The line is only matched against the lines Codex is
/// known to print; nothing of it is kept. `None` when there is no login line
/// at all.
pub fn parse_codex_login_status(output: &str) -> Option<SubscriptionLogin> {
    if js_regex!(r"\bNot logged in\b", "i").test(output) {
        return Some(SubscriptionLogin::SignedOut);
    }
    let found = js_regex!(r"\bLogged in using ([^\r\n]*)", "i").exec(output)?;
    let how = trim(found.get(1).unwrap_or("")).to_lowercase();
    let login = SubscriptionLogin::signed_in;
    if js_regex!(r"^chatgpt\b").test(&how) {
        return Some(login("subscription", "chatgpt"));
    }
    if js_regex!(r"^(an )?api key\b").test(&how) {
        return Some(login("metered", "api-key"));
    }
    if js_regex!(r"^amazon bedrock\b").test(&how) {
        return Some(login("metered", "bedrock"));
    }
    if js_regex!(r"^workload identity\b").test(&how) {
        return Some(login("metered", "workload-identity"));
    }
    if how == "access token" {
        return Some(login("unknown", "access-token"));
    }
    if how == "personal access token" {
        return Some(login("unknown", "personal-access-token"));
    }
    Some(login("unknown", UNKNOWN_KIND))
}

// ── Codex: the app-server's account/read ──

/// `codexAccountInfo(accountRead)`: the login `account/read` describes:
/// `{ account: { type: 'chatgpt', planType } | { type: 'apiKey' } | null,
/// requiresOpenaiAuth }`. Of a ChatGPT account the email is kept when it is an
/// address; an account type this file does not know reads as `unknown`.
/// `None` when the value is not an `account/read` result.
pub fn codex_account_info(account_read: &JsonValue) -> Option<SubscriptionLogin> {
    let result = as_record(Some(account_read))?;
    let Some(account) = as_record(result.get("account")) else {
        if matches!(
            result.get("requiresOpenaiAuth"),
            Some(JsonValue::Bool(true))
        ) {
            return Some(SubscriptionLogin::SignedOut);
        }
        // no account and none required: Codex is pointed at some other model provider
        return Some(SubscriptionLogin::signed_in("unknown", "no-account"));
    };
    match account.get("type") {
        Some(JsonValue::String(kind)) if kind == "chatgpt" => {
            let plan_name = plan_label(account.get("planType"));
            let email = subscription_account_of(account.get("email"));
            Some(SubscriptionLogin::SignedIn {
                login_method: "subscription".to_owned(),
                plan_name: plan_name.filter(|plan| plan != "unknown"),
                login_kind: "chatgpt".to_owned(),
                account: email,
            })
        }
        Some(JsonValue::String(kind)) if kind == "apiKey" => {
            Some(SubscriptionLogin::signed_in("metered", "api-key"))
        }
        _ => Some(SubscriptionLogin::signed_in("unknown", UNKNOWN_KIND)),
    }
}

/// `mergeLogins(cli, account)`: two readings of the same login. The more
/// expensive reading wins: metered if either says so, a subscription only if
/// both do. The account is taken from the reading that names it only when
/// both agree on a subscription.
fn merge_logins(cli: SubscriptionLogin, account: Option<SubscriptionLogin>) -> SubscriptionLogin {
    let Some(account) = account else {
        return cli;
    };
    let SubscriptionLogin::SignedIn {
        login_method: cli_method,
        plan_name: cli_plan,
        login_kind: cli_kind,
        account: cli_account,
    } = &cli
    else {
        return cli;
    };
    let SubscriptionLogin::SignedIn {
        login_method: account_method,
        plan_name: account_plan,
        account: account_email,
        ..
    } = &account
    else {
        return account;
    };
    if cli_method == "metered" {
        return cli;
    }
    if account_method == "metered" {
        return account;
    }
    if cli_method == "subscription" && account_method == "subscription" {
        return SubscriptionLogin::SignedIn {
            login_method: cli_method.clone(),
            plan_name: account_plan
                .clone()
                .filter(|plan| !plan.is_empty())
                .or_else(|| cli_plan.clone()),
            login_kind: cli_kind.clone(),
            account: account_email
                .clone()
                .filter(|email| !email.is_empty())
                .or_else(|| cli_account.clone()),
        };
    }
    if cli_method == "unknown" {
        cli
    } else {
        account
    }
}

// ── From CLI answers to a state ──

/// `errorDetection(provider, kind, text, version?, programPath?)`: an `error`
/// detection. `text` is always a sentence written in this file, with at most
/// facts the code derived itself added to it.
fn error_detection(
    provider: &str,
    kind: &str,
    text: &str,
    version: Option<&str>,
    program_path: Option<&str>,
) -> SubscriptionDetection {
    let mut detection = SubscriptionDetection::new(provider, "error");
    detection.version = version.filter(|v| !v.is_empty()).map(str::to_owned);
    detection.error = Some(subscription_status_error_text(kind, text));
    detection.program_path = program_path.filter(|p| !p.is_empty()).map(str::to_owned);
    detection
}

/// `loginDetection(provider, version, login)`: the one place a login becomes
/// a state. `ready` only for a subscription login; a metered login and one of
/// unknown kind are both `metered`.
fn login_detection(
    provider: &str,
    version: Option<&str>,
    login: &SubscriptionLogin,
) -> SubscriptionDetection {
    let version = version.filter(|v| !v.is_empty()).map(str::to_owned);
    let SubscriptionLogin::SignedIn {
        login_method,
        plan_name,
        login_kind,
        account,
    } = login
    else {
        let mut detection = SubscriptionDetection::new(provider, "signed-out");
        detection.version = version;
        return detection;
    };
    let subscription = login_method == "subscription";
    let mut detection =
        SubscriptionDetection::new(provider, if subscription { "ready" } else { "metered" });
    detection.version = version;
    detection.login_method = Some(login_method.clone());
    detection.plan_name = plan_name
        .clone()
        .filter(|plan| subscription && !plan.is_empty());
    detection.login_kind = Some(subscription_login_kind(Some(login_kind)));
    detection.account = account.clone().filter(|a| !a.is_empty());
    detection
}

/// `errorCodeSuffix(error)`: the system error code of a failure (`ENOENT`,
/// `EACCES`) as a suffix, or nothing. The message of an error is never used:
/// it can contain a path, or whatever a program printed.
fn error_code_suffix(error: &JsError) -> String {
    match error.prop("code") {
        Some(JsonValue::String(code)) if js_regex!(r"^E[A-Z0-9_]{1,30}$").test(code) => {
            format!(" ({code})")
        }
        _ => String::new(),
    }
}

/// `STATUS_ARGS[provider]`
fn status_args(provider: &str) -> Vec<String> {
    match provider {
        "claude-code" => vec!["auth".into(), "status".into(), "--json".into()],
        _ => vec!["login".into(), "status".into()],
    }
}

/// `parseStatus(provider, result)`
fn parse_status(provider: &str, result: &SubscriptionCommandResult) -> Option<SubscriptionLogin> {
    if provider == "claude-code" {
        parse_claude_auth_status(&result.stdout)
    } else {
        parse_codex_login_status(&format!("{}\n{}", result.stderr, result.stdout))
    }
}

/// `programFileOf(program)`: the command is often a link
/// (`/opt/homebrew/bin/claude`); the file behind it tells a Homebrew copy,
/// which only Homebrew updates, from the others.
async fn program_file_of(rt: &Rt, program: &SubscriptionProgram) -> String {
    match rt
        .fs(FsOp::Realpath {
            path: program.entry.clone(),
        })
        .await
    {
        Ok(super::task::FsAnswer::Path(path)) => path,
        _ => program.entry.clone(),
    }
}

/// `run(program, args, { signal, timeoutMs })`
async fn ask(
    rt: Rt,
    run: SubscriptionRunner,
    program: SubscriptionProgram,
    args: Vec<String>,
    signal: Signal,
    timeout_ms: f64,
) -> Result<SubscriptionCommandResult, JsError> {
    let options = SubscriptionRunOptions {
        signal,
        timeout_ms,
        base_env: None,
        cwd: None,
    };
    run(rt, program, args, options).await
}

/// `options.run ?? runSubscriptionProgram`
fn runner_of(state: &StatusState, run: &Option<SubscriptionRunner>) -> SubscriptionRunner {
    if let Some(run) = run {
        return run.clone();
    }
    let shared = state.borrow().shared.clone();
    Rc::new(move |rt, program, args, options| {
        let shared = shared.clone();
        Box::pin(
            async move { run_subscription_program(&rt, &shared, &program, &args, &options).await },
        )
    })
}

/// What the three readings of the Codex branch settle to.
enum Reading {
    Version(Option<SubscriptionCommandResult>),
    Status(SubscriptionCommandResult),
    Account(Option<JsonValue>),
}

const UNKNOWN_COMMAND_PATTERN: &str =
    r"unknown (command|option)|unrecognized (subcommand|option)|unexpected argument";

async fn inspect(
    rt: &Rt,
    state: &StatusState,
    provider: &str,
    options: &SubscriptionDetectOptions,
    signal: &Signal,
    timeout_ms: f64,
) -> SubscriptionDetection {
    let name = subscription_provider_label(provider);
    let locate_options = SubscriptionLocateOptions {
        configured_path: options.configured_path.clone(),
        ..SubscriptionLocateOptions::default()
    };
    let located = match &options.locate {
        Some(locate) => locate(rt.clone(), provider.to_owned(), locate_options).await,
        None => {
            let locate_state = state.borrow().locate.clone();
            locate_subscription_program(rt, &locate_state, provider, &locate_options).await
        }
    };
    let program = match located {
        Ok(Some(program)) => program,
        Ok(None) => return SubscriptionDetection::new(provider, "not-installed"),
        Err(error) => {
            return error_detection(
                provider,
                "failed",
                &format!("Could not look for {name}{}", error_code_suffix(&error)),
                None,
                None,
            );
        }
    };

    let minimum = subscription_min_version(provider);

    let version: Option<String>;
    let status: SubscriptionCommandResult;
    let mut account: Option<SubscriptionLogin> = None;
    let run = runner_of(state, &options.run);
    let asker = |args: Vec<String>| {
        ask(
            rt.clone(),
            run.clone(),
            program.clone(),
            args,
            signal.clone(),
            timeout_ms,
        )
    };
    if let Some(minimum) = minimum {
        // version first: nothing else is asked of a CLI that may not know the question
        let reported = match asker(vec!["--version".into()]).await {
            Ok(result) => subscription_version_of(&result.stdout),
            Err(error) => {
                return error_detection(
                    provider,
                    "failed",
                    &format!("{name} could not be run{}", error_code_suffix(&error)),
                    None,
                    None,
                );
            }
        };
        let Some(reported) = reported else {
            return error_detection(
                provider,
                "failed",
                &format!("{name} did not report its version"),
                None,
                None,
            );
        };
        if !subscription_version_at_least(&reported, minimum) {
            let file = program_file_of(rt, &program).await;
            return error_detection(
                provider,
                "needs-update",
                &format!("{name} {reported} is too old; version {minimum} or newer is required"),
                Some(&reported),
                Some(&file),
            );
        }
        version = Some(reported.clone());
        match asker(status_args(provider)).await {
            Ok(result) => status = result,
            Err(error) => {
                return error_detection(
                    provider,
                    "failed",
                    &format!("{name} could not be run{}", error_code_suffix(&error)),
                    Some(&reported),
                    None,
                );
            }
        }
    } else {
        let source = match &options.codex_account {
            CodexAccountOption::Registered => state.borrow().codex_account_source.clone(),
            CodexAccountOption::Off => None,
            CodexAccountOption::Source(source) => Some(source.clone()),
        };
        let mut readings: Vec<LocalBoxFuture<Result<Reading, JsError>>> = Vec::new();
        {
            let (rt, run, program, signal) =
                (rt.clone(), run.clone(), program.clone(), signal.clone());
            readings.push(Box::pin(async move {
                Ok(Reading::Version(
                    ask(
                        rt,
                        run,
                        program,
                        vec!["--version".into()],
                        signal,
                        timeout_ms,
                    )
                    .await
                    .ok(),
                ))
            }));
        }
        {
            let (rt, run, program, signal) =
                (rt.clone(), run.clone(), program.clone(), signal.clone());
            readings.push(Box::pin(async move {
                ask(rt, run, program, status_args("codex"), signal, timeout_ms)
                    .await
                    .map(Reading::Status)
            }));
        }
        match (provider == "codex", source) {
            (true, Some(source)) => {
                let (rt, configured, signal) =
                    (rt.clone(), options.configured_path.clone(), signal.clone());
                readings.push(Box::pin(async move {
                    Ok(Reading::Account(source(rt, configured, signal).await.ok()))
                }));
            }
            _ => readings.push(Box::pin(async { Ok(Reading::Account(None)) })),
        }
        let settled = match rt.try_join_all(readings).await {
            Ok(settled) => settled,
            Err(error) => {
                return error_detection(
                    provider,
                    "failed",
                    &format!("{name} could not be run{}", error_code_suffix(&error)),
                    None,
                    None,
                );
            }
        };
        let mut version_result = None;
        let mut status_result = None;
        let mut account_result = None;
        for reading in settled {
            match reading {
                Reading::Version(result) => version_result = result,
                Reading::Status(result) => status_result = Some(result),
                Reading::Account(result) => account_result = result,
            }
        }
        version = version_result.and_then(|result| subscription_version_of(&result.stdout));
        let Some(status_result) = status_result else {
            return error_detection(provider, "failed", "The status check failed", None, None);
        };
        status = status_result;
        account = codex_account_info(&account_result.unwrap_or(JsonValue::Null));
    }

    let Some(login) = parse_status(provider, &status) else {
        let output = format!("{}\n{}", status.stderr, status.stdout);
        if js_regex!(UNKNOWN_COMMAND_PATTERN, "i").test(&output) {
            // A helper program can answer an unknown subcommand without ever naming a
            // version. That is not an old Codex, and updating it would change nothing.
            if provider == "codex" && version.as_deref().is_none_or(str::is_empty) {
                return error_detection(
                    provider,
                    "failed",
                    &format!("{name} did not report its version"),
                    None,
                    None,
                );
            }
            let file = program_file_of(rt, &program).await;
            let shown = match version.as_deref().filter(|v| !v.is_empty()) {
                Some(version) => format!(" {version}"),
                None => String::new(),
            };
            return error_detection(
                provider,
                "needs-update",
                &format!("{name}{shown} is too old to report its login status"),
                version.as_deref(),
                Some(&file),
            );
        }
        // what the CLI printed instead stays here: it may name the account
        let exit = match status.code {
            Some(code) => format!("exit code {}", number_to_string(code)),
            None => "no exit code".to_owned(),
        };
        return error_detection(
            provider,
            "failed",
            &format!("{name} did not report its login status ({exit})"),
            version.as_deref(),
            None,
        );
    };
    login_detection(provider, version.as_deref(), &merge_logins(login, account))
}

/// `detectSubscriptionLogin(provider, options)`: the connection status of one
/// provider, from the CLI itself: is it installed, signed in, and on what kind
/// of login. Never fails: every failure, a check that outlasts `timeoutMs`
/// included, is an `error` detection.
///
/// The TypeScript also catches a rejection of `inspect`; none can come out of
/// it (every await of it is caught inside), so that branch has no counterpart.
pub async fn detect_subscription_login(
    rt: &Rt,
    state: &StatusState,
    provider: &str,
    options: &SubscriptionDetectOptions,
) -> SubscriptionDetection {
    // no program: the app's own sign-in is what there is to look at
    if provider == "chatgpt" {
        let connection = state.borrow().chat_gpt.borrow().chatgpt_connection();
        let answer = detect_chatgpt_connection(rt, connection.as_ref()).await;
        return detection_of_json(&answer);
    }
    let timeout_ms = options.timeout_ms.unwrap_or(SUBSCRIPTION_STATUS_TIMEOUT_MS);
    let controller = rt.controller();
    let (settle, deadline) = rt.deferred::<SubscriptionDetection>();
    let timer = {
        let provider = provider.to_owned();
        rt.set_timeout(timeout_ms, move || {
            settle.settle(error_detection(
                &provider,
                "timeout",
                &format!(
                    "{} did not answer within {} s",
                    subscription_provider_label(&provider),
                    number_to_string(math_round(timeout_ms / 1000.0))
                ),
                None,
                None,
            ));
        })
    };
    let checking: LocalBoxFuture<SubscriptionDetection> = {
        let (rt, state, provider, options, signal) = (
            rt.clone(),
            state.clone(),
            provider.to_owned(),
            options.clone(),
            controller.clone(),
        );
        Box::pin(
            async move { inspect(&rt, &state, &provider, &options, &signal, timeout_ms).await },
        )
    };
    let deadline: LocalBoxFuture<SubscriptionDetection> = Box::pin(deadline);
    let (_, detection) = rt.race(vec![checking, deadline]).await;
    rt.clear_timeout(Some(timer));
    // ends whatever the check still has running, on a timeout and otherwise
    controller.abort(None);
    detection
}

/// The options of `detectSubscriptionLogins`: the detect options plus a path
/// per provider and a detector of its own.
#[derive(Clone, Default)]
pub struct SubscriptionDetectAllOptions {
    pub options: SubscriptionDetectOptions,
    /// per provider; overrides `configuredPath`. `None`: not given.
    pub configured_paths: Option<JsObject<Option<String>>>,
    pub detect: Option<SubscriptionDetector>,
}

/// `detectSubscriptionLogins(options)`: both providers, checked at the same
/// time; the detections by provider. Rejects with the first detector that does.
pub async fn detect_subscription_logins(
    rt: &Rt,
    state: &StatusState,
    all: &SubscriptionDetectAllOptions,
) -> Result<JsObject<SubscriptionDetection>, JsError> {
    let detect = all
        .detect
        .clone()
        .unwrap_or_else(|| subscription_detector(state));
    let detections = rt
        .try_join_all(
            AI_SUBSCRIPTION_PROVIDERS
                .iter()
                .map(|provider| {
                    let mut options = all.options.clone();
                    if let Some(paths) = &all.configured_paths {
                        options.configured_path = paths.get(provider).cloned().flatten();
                    }
                    detect(rt.clone(), (*provider).to_owned(), options)
                })
                .collect(),
        )
        .await?;
    let mut out = JsObject::new();
    for detection in detections {
        out.set(detection.provider.clone(), detection);
    }
    Ok(out)
}

/// The detection `detectChatGptConnection` answered, as the struct: it
/// writes `{ provider, state, loginMethod?, account?, error? }`.
fn detection_of_json(answer: &JsonValue) -> SubscriptionDetection {
    let field = |key: &str| match answer {
        JsonValue::Object(object) => match object.get(key) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        },
        _ => None,
    };
    let mut detection = SubscriptionDetection::new(
        &field("provider").unwrap_or_default(),
        &field("state").unwrap_or_default(),
    );
    detection.login_method = field("loginMethod");
    detection.account = field("account");
    detection.error = field("error");
    detection
}
