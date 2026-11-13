//! `packages/ai-provider/src/subscription/env.ts`: the environment a
//! subscription CLI is started with.
//!
//! An environment is a `NodeJS.ProcessEnv` record: a [`JsObject`] while it is
//! edited (a key set again keeps its place, integer-like names come first),
//! an ordered list of pairs at the edges. `process.platform` and
//! `process.env` come from the runtime ([`Rt`]).

use jscompat::JsObject;
use jscompat::node_path::host;

use super::task::Rt;

/// `SUBSCRIPTION_STRIPPED_ENV_VARS`: variables a subscription CLI is never
/// started with: each one moves the CLI from the user's subscription to
/// another billing route.
pub const SUBSCRIPTION_STRIPPED_ENV_VARS: [&str; 16] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
];

/// `SubscriptionEnvOptions`
#[derive(Debug, Clone, Default)]
pub struct SubscriptionEnvOptions {
    /// the environment to copy; the app's own when absent. Never modified.
    pub base: Option<Vec<(String, String)>>,
    pub platform: Option<String>,
    /// the file that will be started; its directory goes to the front of PATH when absolute
    pub command: Option<String>,
    /// what the launch itself needs (`SubscriptionProgram.env`), applied last
    pub extra: Vec<(String, String)>,
}

fn record_of(pairs: &[(String, String)]) -> JsObject<String> {
    let mut record = JsObject::new();
    for (name, value) in pairs {
        record.set(name.clone(), value.clone());
    }
    record
}

fn pairs_of(record: &JsObject<String>) -> Vec<(String, String)> {
    record
        .entries()
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.clone()))
        .collect()
}

/// `subscriptionChildEnv(options)`: a copy of `base` without
/// [`SUBSCRIPTION_STRIPPED_ENV_VARS`]. Windows matches variable names without
/// regard to case, as the system does.
pub fn subscription_child_env(rt: &Rt, options: &SubscriptionEnvOptions) -> Vec<(String, String)> {
    let platform = options.platform.clone().unwrap_or_else(|| rt.platform());
    let base = options.base.clone().unwrap_or_else(|| rt.env_all());
    let copy = record_of(&base);
    let mut env: JsObject<String> = JsObject::new();
    for (name, value) in copy.entries() {
        let key = if platform == "win32" {
            name.to_uppercase()
        } else {
            name.to_owned()
        };
        if SUBSCRIPTION_STRIPPED_ENV_VARS.contains(&key.as_str()) {
            continue;
        }
        env.set(name, value.clone());
    }
    // Electron on Windows can omit HOME even though USERPROFILE is present. The
    // CLIs use HOME to find their normal login/config directory.
    if platform == "win32"
        && env.get("HOME").is_none_or(|home| home.is_empty())
        && let Some(profile) = env.get("USERPROFILE").filter(|p| !p.is_empty()).cloned()
    {
        env.set("HOME", profile);
    }
    if let Some(command) = options.command.as_deref()
        && !command.is_empty()
        && host::is_absolute(command)
    {
        let key = env
            .entries()
            .into_iter()
            .map(|(name, _)| name)
            .find(|name| name.to_lowercase() == "path")
            .unwrap_or("PATH")
            .to_owned();
        let current = env.get(&key).cloned().unwrap_or_default();
        env.set(
            key,
            format!("{}{}{}", host::dirname(command), host::DELIMITER, current),
        );
    }
    env.assign(&record_of(&options.extra));
    pairs_of(&env)
}
