//! The functions of revision-xml.ts under their TypeScript names.

use docx_engine::revision_xml;
use serde_json::Value;

use super::{Returned, optional, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "countTrackedChangesXml" => value(revision_xml::count_tracked_changes_xml(text)),
        "applyTrackedChangesXml" => value(revision_xml::apply_tracked_changes_xml(
            text,
            mode(args),
            args.get("filter"),
        )?),
        "applyRevisionResolutions" => value(revision_xml::apply_revision_resolutions(
            text,
            args.get("resolutions"),
        )?),
        "readPropChangeXml" => {
            optional(revision_xml::read_prop_change_xml(text, change_name(args)?))
        }
        "resolvePropChangeXml" => value(revision_xml::resolve_prop_change_xml(
            text,
            change_name(args)?,
            mode(args),
        )),
        "cleanMoveRangeMarkers" => value(revision_xml::clean_move_range_markers(text)),
        _ => Err(format!("unknown function {function}")),
    }
}

/// `args.mode`: a value that is not a string compares equal to neither mode.
fn mode(args: &Value) -> &str {
    args.get("mode").and_then(Value::as_str).unwrap_or("")
}

fn change_name(args: &Value) -> Result<&str, String> {
    args.get("changeName")
        .and_then(Value::as_str)
        .ok_or_else(|| "the changeName argument is missing".to_owned())
}
