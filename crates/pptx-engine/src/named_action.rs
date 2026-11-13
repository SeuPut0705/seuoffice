//! PowerPoint show actions (packages/pptx-engine/src/named-action.ts):
//! `<a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=<name>"/>`.

const SHOWJUMP_ACTION: &str = "ppaction://hlinkshowjump?jump=";

pub const NAMED_ACTIONS: [&str; 6] = [
    "nextslide",
    "previousslide",
    "firstslide",
    "lastslide",
    "lastslideviewed",
    "endshow",
];

/// The named action of an hlinkClick `action` attribute value; `None` (null)
/// for other actions. `action` `None` is `undefined` or `null`.
pub fn named_action_of(action: Option<&str>) -> Option<&'static str> {
    let name = action?.strip_prefix(SHOWJUMP_ACTION)?;
    NAMED_ACTIONS.iter().copied().find(|named| *named == name)
}

pub fn named_action_attr(action: &str) -> String {
    format!("{SHOWJUMP_ACTION}{action}")
}
