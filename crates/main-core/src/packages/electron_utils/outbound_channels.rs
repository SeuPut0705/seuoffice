//! `packages/electron-utils/src/outbound-channels.ts`.

use jscompat::{JsonValue, js_regex, trim};

/// `OUTBOUND_CHANNELS`, as (key, channel) in the order the object has them.
pub const OUTBOUND_CHANNELS: [(&str, &str); 3] = [
    ("internetTools", "ai:internet-tools"),
    ("confirmAddresses", "ai:confirm-addresses"),
    ("settingsChanged", "ai:settings-changed"),
];

/// `MAX_CONFIRM_ADDRESSES`
pub const MAX_CONFIRM_ADDRESSES: usize = 8;
/// `MAX_CONFIRM_ADDRESS_LENGTH`
pub const MAX_CONFIRM_ADDRESS_LENGTH: usize = 4096;

/// What `confirmRequestOf` answers: `{ tool, addresses }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmRequest {
    pub tool: String,
    pub addresses: Vec<String>,
}

/// `confirmRequestOf(raw)`
pub fn confirm_request_of(raw: Option<&JsonValue>) -> Option<ConfirmRequest> {
    // `(raw && typeof raw === 'object' ? raw : {})`: an array is an object too,
    // but has neither key
    let (tool, addresses) = match raw {
        Some(JsonValue::Object(object)) => (object.get("tool"), object.get("addresses")),
        _ => (None, None),
    };
    let Some(JsonValue::String(tool)) = tool else {
        return None;
    };
    if !js_regex!(r"^[a-z_]{1,64}$").test(tool) {
        return None;
    }
    let Some(JsonValue::Array(items)) = addresses else {
        return None;
    };
    if items.is_empty() || items.len() > MAX_CONFIRM_ADDRESSES {
        return None;
    }
    let mut addresses = Vec::new();
    for item in items {
        let JsonValue::String(a) = item else {
            return None;
        };
        if a.encode_utf16().count() > MAX_CONFIRM_ADDRESS_LENGTH {
            return None;
        }
        if !js_regex!(r"^https?:\/\/", "i").test(trim(a)) {
            return None;
        }
        addresses.push(trim(a).to_owned());
    }
    Some(ConfirmRequest {
        tool: tool.clone(),
        addresses,
    })
}
