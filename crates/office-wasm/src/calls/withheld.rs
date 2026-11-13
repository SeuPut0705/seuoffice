//! `withheld.<name>`: withheld.ts, comment-slices.ts, `editedCommentModelText`
//! of parse-package.ts, and the readers of text-patch.ts and hf-root.ts that
//! find tags past comments and CDATA.

use docx_engine::parse::tables::hf_root::{HfRootName, hf_kept_root, is_text_para};
use docx_engine::save::parts::text_patch::patch_paragraph_texts;
use docx_engine::settings::edited_comment_model_text;
use docx_engine::withheld::{
    comment_entries, first_mark_label, has_mark_element, has_withheld_trace, over_withheld,
    over_withheld_model_text, parse_entry, withheld_block_label, withheld_part_label, hidden_run_properties, runs_text, with_redact_namespace, withheld_label_of,
    withheld_node, withheld_text,
};
use ooxml_xml::XNode;
use serde_json::{Value, json};

use super::fields::node_json;
use super::{Returned, optional, required, value};

/// What a call that takes a node gives for a text that holds none.
const UNPARSED: &str = "unparsed";

fn over_node(text: &str, read: impl FnOnce(&XNode) -> Returned) -> Returned {
    match parse_entry(text) {
        Some(node) => read(&node),
        None => value(UNPARSED),
    }
}

/// How `withheldText` reads a view's text, by name: the readers a spec passes.
type Reader = Box<dyn Fn(&XNode) -> String>;

fn text_reader(name: &str) -> Result<Reader, String> {
    match name {
        "runsText" => Ok(Box::new(runs_text)),
        "wrapped" => Ok(Box::new(|node| format!("<{}>", runs_text(node)))),
        other => Err(format!("unknown reader {other}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "withheldLabelOf" => {
            let absent: Option<bool> = super::arg(args, "absent")?;
            value(withheld_label_of((absent != Some(true)).then_some(text)))
        }
        "withheldPartLabel" => optional(withheld_part_label(text)),
        "withheldBlockLabel" => optional(withheld_block_label(text)),
        "hiddenRunProperties" => value(hidden_run_properties(text)),
        "hasWithheldTrace" => value(has_withheld_trace(text)),
        "hasMarkElement" => over_node(text, |node| value(has_mark_element(node))),
        "withheldNode" => over_node(text, |node| {
            value(withheld_node(node).as_ref().map(node_json))
        }),
        "runsText" => over_node(text, |node| value(runs_text(node))),
        "parseEntry" => optional(parse_entry(text).as_ref().map(node_json)),
        "withheldText" => {
            let reader: String = required(args, "reader")?;
            let reader = text_reader(&reader)?;
            over_node(text, |node| optional(withheld_text(node, &*reader)))
        }
        "firstMarkLabel" => value(first_mark_label(text)),
        "overWithheldModelText" => {
            let label: String = required(args, "label")?;
            value(over_withheld_model_text(text, &label))
        }
        "overWithheld" => {
            let label: String = required(args, "label")?;
            value(over_withheld(text, &label))
        }
        "withRedactNamespace" => {
            let root_tag: String = required(args, "rootTag")?;
            value(with_redact_namespace(text, &root_tag).map_err(|error| error.to_string())?)
        }
        "commentEntries" => value(comment_entries(text).map_err(|limit| limit.to_string())?),
        "editedCommentModelText" => {
            let edited: String = required(args, "text")?;
            optional(edited_comment_model_text(text, &edited).map_err(|limit| limit.to_string())?)
        }
        "patchParagraphTexts" => {
            let new_text: String = required(args, "newText")?;
            let strip: bool = required(args, "strip")?;
            value(patch_paragraph_texts(text, &new_text, strip).map_err(|limit| limit.to_string())?)
        }
        "hfKeptRoot" => {
            let root = match required::<String>(args, "root")?.as_str() {
                "w:hdr" => HfRootName::Hdr,
                _ => HfRootName::Ftr,
            };
            let kept = hf_kept_root(root, text).map_err(|limit| limit.to_string())?;
            value(kept.map(|kept| {
                json!({
                    "before": kept.before,
                    "open": kept.open,
                    "children": kept
                        .children
                        .iter()
                        .map(|(name, xml)| json!({ "name": name, "xml": xml, "textPara": is_text_para(name, xml) }))
                        .collect::<Vec<_>>(),
                })
            }))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
