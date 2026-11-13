//! `packages/ai-provider/src/chatgpt/status.ts`: the ChatGPT connection as a
//! subscription status. Nothing is started and nothing goes over the network:
//! a stored session is `ready` (it is scoped to the ChatGPT plan alone, so it
//! is never metered), no session is `signed-out`. A session OpenAI no longer
//! accepts is found by the next request or refresh, which drops it, and the
//! status follows.

use jscompat::JsonValue;

use super::chatgpt_connection::ChatGptConnection;
use super::jsval::{object, text};
use super::subscription_contract::subscription_status_error_text;
use super::task::Rt;

/// `detectChatGptConnection(connection)`: a `SubscriptionDetection`.
/// `connection` is the argument itself: `None` is a process without the
/// connection (the terminal command); the default of the TypeScript, the
/// process's registered connection, is what the caller passes for `undefined`
/// (`ChatGptConnectionModuleState::chatgpt_connection`).
pub async fn detect_chatgpt_connection(
    rt: &Rt,
    connection: Option<&ChatGptConnection>,
) -> JsonValue {
    // a process without the connection (the terminal command) cannot run on it
    let Some(connection) = connection else {
        return object(vec![
            ("provider", text("chatgpt")),
            ("state", text("signed-out")),
        ]);
    };
    match connection.state(rt).await {
        Ok(state) => {
            if !state.signed_in {
                return object(vec![
                    ("provider", text("chatgpt")),
                    ("state", text("signed-out")),
                ]);
            }
            let mut entries = vec![
                ("provider", text("chatgpt")),
                ("state", text("ready")),
                ("loginMethod", text("subscription")),
            ];
            if let Some(account) = state.account.filter(|a| !a.is_empty()) {
                entries.push(("account", text(account)));
            }
            object(entries)
        }
        Err(_) => object(vec![
            ("provider", text("chatgpt")),
            ("state", text("error")),
            (
                "error",
                text(subscription_status_error_text(
                    "failed",
                    "The ChatGPT connection could not be read",
                )),
            ),
        ]),
    }
}
