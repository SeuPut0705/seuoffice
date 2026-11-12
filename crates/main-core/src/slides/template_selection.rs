//! `apps/slides/src/shared/template-selection.ts`: the design a deck is made
//! with, as it is remembered per document. Only what the store reads.

use jscompat::{JsonValue, trim};

/// A key longer than this is not a template id or a style name (tunable default)
pub const TEMPLATE_KEY_MAX_CHARS: usize = 128;
/// Total length of the added requests; beyond it the oldest are dropped (tunable default)
pub const TEMPLATE_ADJUSTMENTS_MAX_CHARS: usize = 600;

/// `TemplateSelectionKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateSelectionKind {
    Builtin,
    Saved,
}

impl TemplateSelectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Saved => "saved",
        }
    }
}

/// `TemplateSelection`
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateSelection {
    pub kind: TemplateSelectionKind,
    /// The built-in template's id, or the saved style's name
    pub key: String,
    /// Requests added on top of the template, oldest first
    pub adjustments: Vec<String>,
    /// When this record was written (ms since the epoch); stamped by the store
    pub updated_at: f64,
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Cut to `max` UTF-16 units without leaving half of a surrogate pair at the end
fn cut_to(text: &str, max: usize) -> String {
    let all: Vec<u16> = text.encode_utf16().collect();
    let mut cut = &all[..all.len().min(max)];
    if let Some(last) = cut.last()
        && (0xd800..=0xdbff).contains(last)
    {
        cut = &cut[..cut.len() - 1];
    }
    String::from_utf16_lossy(cut)
}

/// `normalizeTemplateAdjustments(raw)`
pub fn normalize_template_adjustments(raw: Option<&JsonValue>) -> Vec<String> {
    let Some(JsonValue::Array(items)) = raw else {
        return Vec::new();
    };
    let mut kept: Vec<String> = Vec::new();
    let mut total = 0usize;
    for entry in items.iter().rev() {
        let JsonValue::String(entry) = entry else {
            continue;
        };
        let text = trim(entry);
        if text.is_empty() {
            continue;
        }
        if kept.is_empty() {
            let newest = cut_to(text, TEMPLATE_ADJUSTMENTS_MAX_CHARS);
            total = units(&newest);
            if !newest.is_empty() {
                kept.push(newest);
            }
            continue;
        }
        if total + units(text) > TEMPLATE_ADJUSTMENTS_MAX_CHARS {
            break;
        }
        kept.push(text.to_owned());
        total += units(text);
    }
    kept.reverse();
    kept
}

/// `normalizeTemplateSelection(input, now)`: `None` is `null`
pub fn normalize_template_selection(
    input: Option<&JsonValue>,
    now: f64,
) -> Option<TemplateSelection> {
    let Some(JsonValue::Object(object)) = input else {
        return None;
    };
    let kind = match object.get("kind") {
        Some(JsonValue::String(kind)) if kind == "builtin" => TemplateSelectionKind::Builtin,
        Some(JsonValue::String(kind)) if kind == "saved" => TemplateSelectionKind::Saved,
        _ => return None,
    };
    let Some(JsonValue::String(key)) = object.get("key") else {
        return None;
    };
    if trim(key).is_empty() || units(key) > TEMPLATE_KEY_MAX_CHARS {
        return None;
    }
    let adjustments = object.get("adjustments");
    if !matches!(
        adjustments,
        None | Some(JsonValue::Null) | Some(JsonValue::Array(_))
    ) {
        return None;
    }
    Some(TemplateSelection {
        kind,
        key: key.clone(),
        adjustments: normalize_template_adjustments(adjustments),
        updated_at: now,
    })
}
