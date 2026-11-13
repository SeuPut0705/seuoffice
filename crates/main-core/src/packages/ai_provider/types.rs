//! `packages/ai-provider/src/types.ts`: the two lists it holds at run time.
//! The rest of the file is types; the ports carry those values as
//! [`jscompat::JsonValue`] or as the structs of the module that reads them.

/// `AI_SUBSCRIPTION_LOGIN_FAILURE_REASONS`: timeout (nobody finished in
/// time), denied (OpenAI refused or its answer did not check out), no-plan
/// (signed in without allowing the plan), network (OpenAI could not be
/// reached)
pub const AI_SUBSCRIPTION_LOGIN_FAILURE_REASONS: [&str; 4] =
    ["timeout", "denied", "no-plan", "network"];

/// `AI_SUBSCRIPTION_LOGIN_FAILURE_STEPS`: which step of the app's ChatGPT
/// sign-in failed, for the help text a user copies: fixed names, never
/// anything OpenAI or the browser sent.
pub const AI_SUBSCRIPTION_LOGIN_FAILURE_STEPS: [&str; 15] = [
    // no browser took the sign-in page
    "browser",
    // the waiting server could not start
    "loopback",
    // the browser came back with an `error`
    "callback-error",
    // the browser came back without a code or a client id
    "callback-incomplete",
    // signing an issued client id in again, the browser came back naming another one
    "callback-client-mismatch",
    // the token endpoint refused the code (400, 401, 403)
    "token-refused",
    // the code went out twice (the first try failed on the way) and was refused as used
    "token-resent",
    // the token endpoint answered another failing status
    "token-http",
    // the token endpoint could not be reached
    "token-unreachable",
    // the token answer lacked the access or refresh token, or was no JSON
    "token-unreadable",
    // the token answer had no ID token
    "id-token-missing",
    // OpenAI's signing keys could not be read
    "signing-keys",
    // the ID token failed a check: signature, issuer, audience, expiry or nonce
    "id-token-invalid",
    // the token answer named no scope at all
    "scope-missing",
    // the token answer named scopes, without the plan's
    "plan-scope-missing",
];

/// `AiChatResponse`: the answer of a one-shot chat, `{ ok, content?, error? }`
/// in that key order. `content` is whatever the provider sent, unchanged: a
/// protocol that reads a string out of its answer wraps it with `text`, the
/// OpenAI-compatible protocol hands over any truthy `content` it parsed (an
/// array of parts, an object, `true`, a number).
#[derive(Debug, Clone, PartialEq)]
pub struct AiChatResponse {
    pub ok: bool,
    pub content: Option<jscompat::JsonValue>,
    pub error: Option<String>,
}

impl AiChatResponse {
    /// `{ ok: true, content }`
    pub fn succeeded(content: jscompat::JsonValue) -> AiChatResponse {
        AiChatResponse {
            ok: true,
            content: Some(content),
            error: None,
        }
    }

    /// `{ ok: false, error }`
    pub fn failed(error: String) -> AiChatResponse {
        AiChatResponse {
            ok: false,
            content: None,
            error: Some(error),
        }
    }

    /// The object `JSON.stringify` writes for it.
    pub fn to_json(&self) -> jscompat::JsonValue {
        let mut out = super::jsval::Obj::new();
        out.set("ok", jscompat::JsonValue::Bool(self.ok));
        if let Some(content) = &self.content {
            out.set("content", content.clone());
        }
        if let Some(error) = &self.error {
            out.set("error", jscompat::JsonValue::String(error.clone()));
        }
        jscompat::JsonValue::Object(out)
    }
}
