//! `packages/ai-provider/src/subscription/contract.ts`: the one function the
//! tool routing needs of it, `offSubscriptionStatus`. The rest of the file
//! (the IPC contract, the install commands, the readers of a status answer)
//! is not ported.

use super::jsval::{object, text};
use jscompat::JsonValue;

/// `offSubscriptionStatus(provider)`: the status of a CLI the person turned
/// off in this app.
pub fn off_subscription_status(provider: &str) -> JsonValue {
    object(vec![
        ("provider", text(provider)),
        ("state", text("off")),
        ("meteredAccepted", JsonValue::Bool(false)),
    ])
}
