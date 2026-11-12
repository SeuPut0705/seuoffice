//! `packages/electron-utils/src/drive-ai-channels.ts`: the channels an
//! editor's AI uses to search and read the user's Google Drive (decision
//! 0033). The shell's main process answers them; it alone holds the Drive
//! connection, and it refuses them while Drive is disconnected or the person
//! has not let the AI use it.

use crate::packages::ai_provider::jsval::prop;
use jscompat::JsonValue;

/// `DRIVE_AI_CHANNELS` as `(key, channel)` in the order of the object.
pub const DRIVE_AI_CHANNELS: [(&str, &str); 6] = [
    ("enabled", "drive:ai-enabled"),
    ("search", "drive:ai-search"),
    ("read", "drive:ai-read"),
    // Drive is connected (attaching from Drive does not need the AI switch)
    ("connected", "drive:connected"),
    // opens the attach-from-Drive window; answers with the downloaded paths
    ("pickAttachments", "drive:pick-attachments"),
    // main to every window: the Drive state changed (payload: the shell's DriveUiState)
    ("changed", "drive:state-changed"),
];

/// `driveConnectedOf(state)`: whether a broadcast Drive state is a connection.
pub fn drive_connected_of(state: &JsonValue) -> bool {
    matches!(prop(state, "state"), Some(JsonValue::String(s)) if s == "connected")
}

/// `driveAiOn(state)`: whether a broadcast Drive state lets the AI use Drive.
/// The model-training confirmation gates the AI's Drive tools too (decision
/// 0085).
pub fn drive_ai_on(state: &JsonValue) -> bool {
    matches!(prop(state, "state"), Some(JsonValue::String(s)) if s == "connected")
        && matches!(prop(state, "aiAccess"), Some(JsonValue::Bool(true)))
        && matches!(prop(state, "trainingAck"), Some(JsonValue::Bool(true)))
}
