//! `packages/ai-provider/src/subscription/contract.ts`: what the renderers
//! and the main side agree on for the subscription providers: the channel
//! names, the fixed values the UI shows (install command, install page), the
//! floor of the CLI versions, and the readers of an IPC answer.
//!
//! A status, a status map, a launch result and a model list are plain
//! [`JsonValue`]s: the readers take `unknown` and build new objects, so the
//! order of their keys is the order of the TypeScript literals. The
//! TypeScript-only parts (the request and result interfaces, the
//! `SubscriptionIpcContract` map) have no run-time form and are not ported.

use jscompat::{JsonValue, js_regex, to_number, trim};

use super::effort::{ai_effort_of, ai_efforts_of};
use super::jsval::{
    Obj, as_record, as_str, is_integer, length16, number, object, prop, slice_to, spread,
    string_list, text, without,
};
use super::types::{AI_SUBSCRIPTION_LOGIN_FAILURE_REASONS, AI_SUBSCRIPTION_LOGIN_FAILURE_STEPS};

/// `SUBSCRIPTION_IPC_CHANNELS`: request channels are invoked by the renderer;
/// `changed` is sent from main to every window. Name and channel, in the
/// order of the TypeScript literal.
pub const SUBSCRIPTION_IPC_CHANNELS: [(&str, &str); 11] = [
    ("statuses", "ai:subscription-statuses"),
    ("recheck", "ai:subscription-recheck"),
    ("login", "ai:subscription-login"),
    ("logout", "ai:subscription-logout"),
    ("install", "ai:subscription-install"),
    ("update", "ai:subscription-update"),
    ("cancelLogin", "ai:subscription-cancel-login"),
    ("metered", "ai:subscription-metered"),
    ("off", "ai:subscription-off"),
    ("codexImage", "ai:subscription-codex-image"),
    ("changed", "ai:subscription-changed"),
];

/// `SUBSCRIPTION_INSTALL_COMMANDS`: the vendor's own install command, run as
/// is in a terminal window.
pub const SUBSCRIPTION_INSTALL_COMMANDS: [(&str, &str); 2] = [
    ("claude-code", "irm https://claude.ai/install.ps1 | iex"),
    ("codex", "winget install OpenAI.Codex"),
];

/// `SUBSCRIPTION_INSTALL_COMMANDS[provider]`; empty for a provider with none
pub fn subscription_install_command(provider: &str) -> &'static str {
    SUBSCRIPTION_INSTALL_COMMANDS
        .iter()
        .find(|(id, _)| *id == provider)
        .map_or("", |(_, command)| command)
}

/// `SUBSCRIPTION_MIN_VERSIONS`: the oldest CLI version the app works with;
/// an older one is reported as "needs update". `None` is `null`.
pub const SUBSCRIPTION_MIN_VERSIONS: [(&str, Option<&str>); 3] = [
    ("claude-code", Some("2.1.248")),
    ("codex", None),
    // no program
    ("chatgpt", None),
];

/// `SUBSCRIPTION_MIN_VERSIONS[provider]`
pub fn subscription_min_version(provider: &str) -> Option<&'static str> {
    SUBSCRIPTION_MIN_VERSIONS
        .iter()
        .find(|(id, _)| *id == provider)
        .and_then(|(_, version)| *version)
}

/// `SUBSCRIPTION_UPDATE_COMMANDS`: the vendor's own update command, named on
/// the card when the CLI is older than the floor asks.
pub const SUBSCRIPTION_UPDATE_COMMANDS: [(&str, Option<&str>); 3] = [
    ("claude-code", Some("claude update")),
    ("codex", None),
    ("chatgpt", None),
];

/// `SUBSCRIPTION_UPDATE_COMMANDS[provider]`
fn subscription_update_command(provider: &str) -> Option<&'static str> {
    SUBSCRIPTION_UPDATE_COMMANDS
        .iter()
        .find(|(id, _)| *id == provider)
        .and_then(|(_, command)| *command)
}

/// `SUBSCRIPTION_INSTALL_URLS`: the vendor's install instructions
pub const SUBSCRIPTION_INSTALL_URLS: [(&str, &str); 2] = [
    ("claude-code", "https://code.claude.com/docs/en/setup"),
    ("codex", "https://developers.openai.com/codex/cli"),
];

/// `SUBSCRIPTION_INSTALL_URLS[provider]`; empty for a provider with none
pub fn subscription_install_url(provider: &str) -> &'static str {
    SUBSCRIPTION_INSTALL_URLS
        .iter()
        .find(|(id, _)| *id == provider)
        .map_or("", |(_, url)| url)
}

/// `SUBSCRIPTION_CHATGPT_USAGE_URL`
pub const SUBSCRIPTION_CHATGPT_USAGE_URL: &str = "https://chatgpt.com/#settings/Usage";

/// `subscriptionVersionOf(output)`: the dotted version number in what a CLI
/// printed for `--version`.
pub fn subscription_version_of(output: &str) -> Option<String> {
    js_regex!(r"\d+\.\d+\.\d+")
        .exec(output)
        .map(|m| m.as_str().to_owned())
}

/// `subscriptionVersionAtLeast(version, minimum)`: whether a dotted version
/// number is at least `minimum`.
pub fn subscription_version_at_least(version: &str, minimum: &str) -> bool {
    let have: Vec<f64> = version.split('.').map(to_number).collect();
    let need: Vec<f64> = minimum.split('.').map(to_number).collect();
    for (index, wanted) in need.iter().enumerate() {
        let difference = have.get(index).copied().unwrap_or(0.0) - wanted;
        if difference != 0.0 {
            return difference > 0.0;
        }
    }
    true
}

/// `checkingSubscriptionStatus(provider)`: the status of a provider nothing
/// is known about yet.
pub fn checking_subscription_status(provider: &str) -> JsonValue {
    object(vec![
        ("provider", text(provider)),
        ("state", text("checking")),
        ("meteredAccepted", JsonValue::Bool(false)),
    ])
}

/// `offSubscriptionStatus(provider)`: the status of a CLI the person turned
/// off in this app.
pub fn off_subscription_status(provider: &str) -> JsonValue {
    object(vec![
        ("provider", text(provider)),
        ("state", text("off")),
        ("meteredAccepted", JsonValue::Bool(false)),
    ])
}

/// `subscriptionStatusErrorText(kind, detail)`: an `error` status starts its
/// text with one of `needs-update`, `timeout`, `failed`.
pub fn subscription_status_error_text(kind: &str, detail: &str) -> String {
    format!("{kind}: {detail}")
}

/// `subscriptionStatusErrorKind(status)` of a status whose state and error
/// text are given: which kind of error an `error` status reports; `None`
/// (`null`) for every other state.
pub fn subscription_status_error_kind(state: &str, error: Option<&str>) -> Option<&'static str> {
    if state != "error" {
        return None;
    }
    let text = error.unwrap_or("");
    if text.starts_with("needs-update:") {
        return Some("needs-update");
    }
    if text.starts_with("timeout:") {
        return Some("timeout");
    }
    Some("failed")
}

/// `subscriptionStatusErrorKind(status)` of a status object
fn status_error_kind_of(status: &JsonValue) -> Option<&'static str> {
    subscription_status_error_kind(
        as_str(prop(status, "state")).unwrap_or(""),
        as_str(prop(status, "error")),
    )
}

/// `subscriptionNeedsUpdate(status)`: what a "needs update" card can tell the
/// user: the version found, the oldest one the app works with, and the
/// command that updates it (Homebrew's, for the copy a Homebrew cask
/// installed). `None` unless the status is that error and the CLI reported a
/// version below the floor. The answer is `{ version, minimum, command }`.
pub fn subscription_needs_update(status: &JsonValue) -> Option<JsonValue> {
    if status_error_kind_of(status) != Some("needs-update") {
        return None;
    }
    let provider = as_str(prop(status, "provider")).unwrap_or("");
    let minimum = subscription_min_version(provider);
    // Homebrew's Claude Code casks; `claude update` leaves a copy they installed as it is
    let cask = if provider == "claude-code" {
        js_regex!(r"[\\/]Caskroom[\\/](claude-code(?:@latest)?)[\\/]")
            .exec(as_str(prop(status, "programPath")).unwrap_or(""))
            .and_then(|m| m.get(1).map(str::to_owned))
    } else {
        None
    };
    let command = match cask {
        Some(cask) => Some(format!("brew upgrade {cask}")),
        None => subscription_update_command(provider).map(str::to_owned),
    };
    let version = as_str(prop(status, "version")).filter(|v| !v.is_empty());
    let (Some(minimum), Some(command), Some(version)) = (minimum, command, version) else {
        return None;
    };
    if subscription_version_at_least(version, minimum) {
        return None;
    }
    Some(object(vec![
        ("version", text(version)),
        ("minimum", text(minimum)),
        ("command", text(command)),
    ]))
}

/// `SUBSCRIPTION_PROGRAM_PATH_MAX_LENGTH`: a Windows long path is at most
/// this long; a longer value is not a path we found.
const SUBSCRIPTION_PROGRAM_PATH_MAX_LENGTH: usize = 32_767;

/// `subscriptionProgramPathOf(value)`: the program path a status carries,
/// when it is one: an absolute path on one line.
pub fn subscription_program_path_of(value: Option<&JsonValue>) -> Option<String> {
    let value = as_str(value)?;
    if value.is_empty() || length16(value) > SUBSCRIPTION_PROGRAM_PATH_MAX_LENGTH {
        return None;
    }
    // `\p{Cc}`
    if value.chars().any(char::is_control) {
        return None;
    }
    // a drive (`C:\`), a UNC share (`\\server`), or a POSIX root
    js_regex!(r"^(?:[A-Za-z]:[\\/]|\\\\|\/)")
        .test(value)
        .then(|| value.to_owned())
}

/// `SUBSCRIPTION_PROVIDER_IDS`
const SUBSCRIPTION_PROVIDER_IDS: [&str; 3] = ["claude-code", "chatgpt", "codex"];

/// `SUBSCRIPTION_STATES`
const SUBSCRIPTION_STATES: [&str; 7] = [
    "checking",
    "not-installed",
    "signed-out",
    "ready",
    "metered",
    "error",
    "off",
];

/// `SUBSCRIPTION_LAUNCH_FAILURES`
const SUBSCRIPTION_LAUNCH_FAILURES: [&str; 4] =
    ["not-installed", "unsupported", "failed", "invalid"];

/// `checkingSubscriptionStatuses()`: every provider `checking`
pub fn checking_subscription_statuses() -> JsonValue {
    object(vec![
        ("claude-code", checking_subscription_status("claude-code")),
        ("chatgpt", checking_subscription_status("chatgpt")),
        ("codex", checking_subscription_status("codex")),
    ])
}

/// `isSubscriptionProviderId(value)`
pub fn is_subscription_provider_id(value: Option<&JsonValue>) -> bool {
    as_str(value).is_some_and(|id| SUBSCRIPTION_PROVIDER_IDS.contains(&id))
}

/// `SUBSCRIPTION_ACCOUNT_MAX_LENGTH`: an e-mail address is at most this
/// long; a longer value is not one.
pub const SUBSCRIPTION_ACCOUNT_MAX_LENGTH: usize = 254;

/// `\p{L}` or `\p{N}`
fn is_letter_or_number(c: char) -> bool {
    js_regex!(r"^[\p{L}\p{N}]$", "u").test(c.encode_utf8(&mut [0; 4]))
}

/// `ACCOUNT_PATTERN.test(account)` for
/// `/^[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+$/u`:
/// one address and nothing around it. A loop of that kind is not a `JsRegex`
/// (it grows the backtrack stack with the text), so the same language is
/// matched by hand: `@` and `.` are in no other class, so the text is a local
/// part of 1 to 64 characters, one `@`, and at least two labels of 1 to 63
/// characters (counted in code points, as the `u` flag counts).
fn account_matches(account: &str) -> bool {
    let Some((local, domain)) = account.split_once('@') else {
        return false;
    };
    if domain.contains('@') {
        return false;
    }
    if !(1..=64).contains(&local.chars().count())
        || !local
            .chars()
            .all(|c| is_letter_or_number(c) || matches!(c, '.' | '_' | '%' | '+' | '-'))
    {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            (1..=63).contains(&label.chars().count())
                && label.chars().all(|c| is_letter_or_number(c) || c == '-')
        })
}

/// `subscriptionAccountOf(value)`: the account a CLI names, when it is an
/// e-mail address. Anything else (free text, an organisation name, a value of
/// another type) is absent.
pub fn subscription_account_of(value: Option<&JsonValue>) -> Option<String> {
    let account = trim(as_str(value)?);
    (length16(account) <= SUBSCRIPTION_ACCOUNT_MAX_LENGTH && account_matches(account))
        .then(|| account.to_owned())
}

/// `SUBSCRIPTION_MODELS_MAX`: most models a status lists
pub const SUBSCRIPTION_MODELS_MAX: usize = 50;

const SUBSCRIPTION_MODEL_LABEL_MAX: usize = 80;

/// `modelIdOf(value)`: a model alias or id as the CLIs take it, so nothing
/// that could read as an option.
fn model_id_of(value: Option<&JsonValue>) -> Option<String> {
    let id = trim(as_str(value)?);
    js_regex!(r"^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$")
        .test(id)
        .then(|| id.to_owned())
}

/// `modelLabelOf(value)`: a display name on one line, without control
/// characters, of bounded length.
fn model_label_of(value: Option<&JsonValue>) -> String {
    let Some(value) = as_str(value) else {
        return String::new();
    };
    // `.replace(/\p{Cc}+/gu, '')`
    let without_controls: String = value.chars().filter(|c| !c.is_control()).collect();
    let one_line = js_regex!(r"\s+", "g").replace_all(&without_controls, |_| " ".to_owned());
    slice_to(trim(&one_line), SUBSCRIPTION_MODEL_LABEL_MAX)
}

/// `subscriptionModelsOf(value)`: a model list as a status carries it: the
/// listed fields only, ids the CLI could be given, names trimmed and
/// bounded, effort levels from the known list only, one entry per id, at
/// most [`SUBSCRIPTION_MODELS_MAX`] entries. The entry with an empty id
/// stands for the CLI's own default and is kept only when it tells what that
/// resolves to. `None` when nothing usable is left.
pub fn subscription_models_of(value: Option<&JsonValue>) -> Option<Vec<JsonValue>> {
    let Some(JsonValue::Array(entries)) = value else {
        return None;
    };
    let mut models: Vec<JsonValue> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in entries {
        if models.len() >= SUBSCRIPTION_MODELS_MAX {
            break;
        }
        let Some(record) = as_record(entry) else {
            continue;
        };
        let is_default_entry = as_str(record.get("id")) == Some("");
        let id = if is_default_entry {
            Some(String::new())
        } else {
            model_id_of(record.get("id"))
        };
        let Some(id) = id else {
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        let resolved = model_id_of(record.get("resolved"));
        if is_default_entry && resolved.is_none() {
            continue;
        }
        seen.push(id.clone());
        // levels outside the known list are dropped; the default counts only as one the model takes
        let efforts = ai_efforts_of(record.get("efforts"));
        let default_effort = ai_effort_of(record.get("defaultEffort"));
        let mut label = model_label_of(record.get("label"));
        if label.is_empty() {
            label = if id.is_empty() {
                resolved.clone().unwrap_or_default()
            } else {
                id.clone()
            };
        }
        let mut model = Obj::new();
        model.set("id", text(id));
        model.set("label", text(label));
        if let Some(resolved) = &resolved {
            model.set("resolved", text(resolved.clone()));
        }
        if is_default_entry || matches!(record.get("isDefault"), Some(JsonValue::Bool(true))) {
            model.set("isDefault", JsonValue::Bool(true));
        }
        if let Some(efforts) = &efforts {
            model.set("efforts", string_list(efforts));
            if let Some(default_effort) = default_effort
                && efforts.contains(&default_effort)
            {
                model.set("defaultEffort", text(default_effort));
            }
        }
        models.push(JsonValue::Object(model));
    }
    (!models.is_empty()).then_some(models)
}

/// `subscriptionModelsOf(value)` of a value that is there, as the list a
/// status carries (a JSON array)
pub fn subscription_models_value_of(value: &JsonValue) -> Option<JsonValue> {
    subscription_models_of(Some(value)).map(JsonValue::Array)
}

/// `SUBSCRIPTION_LOGIN_ERROR_CODE.test(code)`: an OAuth error code is kept
/// only with this shape, `/^[a-z0-9_.-]{1,64}$/`: an identifier, never text.
pub fn subscription_login_error_code_test(code: &str) -> bool {
    js_regex!(r"^[a-z0-9_.-]{1,64}$").test(code)
}

/// `subscriptionLoginFailureOf(value)`: why a sign-in failed, read back from
/// an IPC answer: fixed names and a status number only.
pub fn subscription_login_failure_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let record = as_record(value?)?;
    let reason = AI_SUBSCRIPTION_LOGIN_FAILURE_REASONS
        .iter()
        .find(|known| Some(**known) == as_str(record.get("reason")))?;
    let mut failure = Obj::new();
    failure.set("reason", text(*reason));
    if let Some(step) = AI_SUBSCRIPTION_LOGIN_FAILURE_STEPS
        .iter()
        .find(|known| Some(**known) == as_str(record.get("step")))
    {
        failure.set("step", text(*step));
    }
    if let Some(JsonValue::Number(status)) = record.get("httpStatus")
        && is_integer(*status)
        && (100.0..=599.0).contains(status)
    {
        failure.set("httpStatus", number(*status));
    }
    if let Some(code) = as_str(record.get("oauthError"))
        && subscription_login_error_code_test(code)
    {
        failure.set("oauthError", text(code));
    }
    Some(JsonValue::Object(failure))
}

/// `subscriptionStatusMapOf(result)`: an IPC answer as a status map with
/// every provider present. A provider whose entry is missing or malformed
/// reads as `checking`, so a renderer never has to guard against a
/// half-filled answer. The account and the model list pass only when they
/// have their shape, and only on a state that names a login.
pub fn subscription_status_map_of(result: Option<&JsonValue>) -> JsonValue {
    let status_of = |provider: &str| -> JsonValue {
        let status = result.and_then(|r| prop(r, provider));
        // a main process that answered without a ChatGPT status has no such connection (an older app)
        if result.is_some_and(|r| as_record(r).is_some())
            && status.is_none()
            && provider == "chatgpt"
        {
            return object(vec![
                ("provider", text(provider)),
                ("state", text("signed-out")),
                ("meteredAccepted", JsonValue::Bool(false)),
            ]);
        }
        let Some(status) = status.filter(|s| as_record(s).is_some()) else {
            return checking_subscription_status(provider);
        };
        let state = as_str(prop(status, "state"));
        if !state.is_some_and(|s| SUBSCRIPTION_STATES.contains(&s)) {
            return checking_subscription_status(provider);
        }
        let mut read = spread(Some(status));
        read.set("provider", text(provider));
        read.set(
            "meteredAccepted",
            JsonValue::Bool(matches!(
                prop(status, "meteredAccepted"),
                Some(JsonValue::Bool(true))
            )),
        );
        let read_state = as_str(read.get("state")).unwrap_or("").to_owned();
        let signed_in = read_state == "ready" || read_state == "metered";
        let account = if signed_in {
            subscription_account_of(prop(status, "account"))
        } else {
            None
        };
        let models = if signed_in {
            subscription_models_of(prop(status, "models"))
        } else {
            None
        };
        let read_value = JsonValue::Object(read.clone());
        let program_path = if status_error_kind_of(&read_value) == Some("needs-update") {
            subscription_program_path_of(prop(status, "programPath"))
        } else {
            None
        };
        let mut read = without(
            &read,
            &[
                "account",
                "models",
                "signingIn",
                "loginUnfinished",
                "loginFailure",
                "programPath",
            ],
        );
        if let Some(account) = account {
            read.set("account", text(account));
        }
        if let Some(models) = models {
            read.set("models", JsonValue::Array(models));
        }
        if let Some(program_path) = program_path {
            read.set("programPath", text(program_path));
        }
        // a program turned off in this app has no sign-in to show
        if let Some(signing_in) = as_str(prop(status, "signingIn"))
            && (signing_in == "browser" || signing_in == "window")
            && read_state != "off"
        {
            read.set("signingIn", text(signing_in));
        }
        // a login that ended without one belongs to signed-out and nowhere else
        if read_state == "signed-out"
            && matches!(prop(status, "loginUnfinished"), Some(JsonValue::Bool(true)))
        {
            read.set("loginUnfinished", JsonValue::Bool(true));
            if let Some(failure) = subscription_login_failure_of(prop(status, "loginFailure")) {
                read.set("loginFailure", failure);
            }
        }
        JsonValue::Object(read)
    };
    object(vec![
        ("claude-code", status_of("claude-code")),
        ("chatgpt", status_of("chatgpt")),
        ("codex", status_of("codex")),
    ])
}

/// `subscriptionLaunchResultOf(result)`: an IPC answer as a launch result;
/// anything unreadable is a plain failure. The spawn error text is left
/// behind: it can carry an executable path.
pub fn subscription_launch_result_of(result: Option<&JsonValue>) -> JsonValue {
    let get = |key: &str| result.and_then(|r| prop(r, key));
    if matches!(get("ok"), Some(JsonValue::Bool(true))) {
        return object(vec![("ok", JsonValue::Bool(true))]);
    }
    let reason = as_str(get("reason"))
        .filter(|reason| SUBSCRIPTION_LAUNCH_FAILURES.contains(reason))
        .unwrap_or("failed");
    let mut entries = vec![("ok", JsonValue::Bool(false)), ("reason", text(reason))];
    if let Some(url) = as_str(get("installUrl")) {
        entries.push(("installUrl", text(url)));
    }
    object(entries)
}

/// `subscriptionMeteredResultOf(result)`: an IPC answer to "use anyway":
/// accepted only on a literal `true`, the statuses always a full map.
pub fn subscription_metered_result_of(result: Option<&JsonValue>) -> JsonValue {
    let get = |key: &str| result.and_then(|r| prop(r, key));
    object(vec![
        (
            "ok",
            JsonValue::Bool(matches!(get("ok"), Some(JsonValue::Bool(true)))),
        ),
        ("statuses", subscription_status_map_of(get("statuses"))),
    ])
}

/// `subscriptionOffResultOf(result)`: an IPC answer to turning a CLI off or
/// on: done only on a literal `true`, the statuses always a full map.
pub fn subscription_off_result_of(result: Option<&JsonValue>) -> JsonValue {
    subscription_metered_result_of(result)
}
