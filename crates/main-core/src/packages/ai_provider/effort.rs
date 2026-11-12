//! `packages/ai-provider/src/effort.ts`

use super::jsval::{Obj, as_record, as_str, assign, length16, object, string_list, text};
use jscompat::{JsonValue, trim};

/// `AI_EFFORTS`
pub const AI_EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// `CLAUDE_EFFORTS`
pub const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// most models a stored effort table keeps
const MAX_MODEL_EFFORTS: usize = 2000;
const MAX_MODEL_ID_LENGTH: usize = 256;

/// `aiEffortOf(value)`: a known level, or `None` for anything else.
pub fn ai_effort_of(value: Option<&JsonValue>) -> Option<&'static str> {
    let effort = trim(as_str(value)?);
    AI_EFFORTS.iter().copied().find(|e| *e == effort)
}

/// `aiEffortsOf(value)`: known levels in the order of `AI_EFFORTS`, each
/// once; `None` when none is left.
pub fn ai_efforts_of(value: Option<&JsonValue>) -> Option<Vec<&'static str>> {
    let Some(JsonValue::Array(items)) = value else {
        return None;
    };
    let known: Vec<&'static str> = items.iter().filter_map(|i| ai_effort_of(Some(i))).collect();
    let efforts: Vec<&'static str> = AI_EFFORTS
        .iter()
        .copied()
        .filter(|e| known.contains(e))
        .collect();
    (!efforts.is_empty()).then_some(efforts)
}

/// `AiModelEffort`
#[derive(Debug, Clone, PartialEq)]
pub struct AiModelEffort {
    pub efforts: Vec<&'static str>,
    pub default_effort: Option<&'static str>,
}

impl AiModelEffort {
    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![("efforts", string_list(&self.efforts))];
        if let Some(d) = self.default_effort {
            entries.push(("defaultEffort", text(d)));
        }
        object(entries)
    }
}

/// `aiModelEffortOf(value)`: one model's levels with unknown ones dropped.
pub fn ai_model_effort_of(value: Option<&JsonValue>) -> Option<AiModelEffort> {
    let raw = as_record(value?)?;
    let efforts = ai_efforts_of(raw.get("efforts"))?;
    let default_effort = ai_effort_of(raw.get("defaultEffort")).filter(|d| efforts.contains(d));
    Some(AiModelEffort {
        efforts,
        default_effort,
    })
}

/// `aiModelEffortsOf(value)`: a stored table of levels by model id, bounded
/// and with malformed entries dropped.
pub fn ai_model_efforts_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = as_record(value?)?;
    let mut table = Obj::new();
    let mut count = 0;
    for (key, entry) in raw.entries() {
        if count >= MAX_MODEL_EFFORTS {
            break;
        }
        let id = trim(key);
        if id.is_empty() || length16(id) > MAX_MODEL_ID_LENGTH {
            continue;
        }
        let Some(effort) = ai_model_effort_of(Some(entry)) else {
            continue;
        };
        // an id `__proto__` sets the prototype of the table: counted, no key
        assign(&mut table, id, effort.to_json());
        count += 1;
    }
    (count > 0).then_some(JsonValue::Object(table))
}
