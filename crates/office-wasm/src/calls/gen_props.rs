//! The paragraph property builders of generate.ts, called by name.

use docx_engine::generate::props::{
    merge_cell_para_format, merge_p_pr_format, para_mark_color, para_mark_revision_xml,
    resolve_para_mark_r_pr_change, set_p_pr_change, set_para_mark_revision, strip_p_pr_change,
    strip_para_mark_color, strip_para_mark_revision,
};
use docx_engine::generate::split_xml_children;
use docx_engine::model::ParaFormat;
use serde_json::{Value, json};

use super::{Returned, arg, optional, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "mergePPrFormat" => {
            let format: Option<ParaFormat> = arg(args, "format")?;
            let original: Option<ParaFormat> = arg(args, "original")?;
            let only: Option<Vec<String>> = arg(args, "onlyTags")?;
            value(
                merge_p_pr_format(text, format.as_ref(), original.as_ref(), only.as_deref())
                    .map_err(|limit| limit.to_string())?,
            )
        }
        "mergeCellParaFormat" => {
            let format: ParaFormat = required(args, "format")?;
            let original: Option<ParaFormat> = arg(args, "original")?;
            value(
                merge_cell_para_format(text, &format, original.as_ref())
                    .map_err(|limit| limit.to_string())?,
            )
        }
        "paraMarkColor" => optional(para_mark_color(text)),
        "stripParaMarkColor" => value(strip_para_mark_color(text)),
        "paraMarkRevisionXml" => {
            let kind: String = required(args, "kind")?;
            let null_record: bool = arg(args, "nullRecord")?.unwrap_or(false);
            let mint: Option<String> = arg(args, "mintId")?;
            let mut mint_id = || mint.clone().unwrap_or_default();
            value(para_mark_revision_xml(
                &kind,
                (!null_record).then_some(text),
                &mut mint_id,
            ))
        }
        "setParaMarkRevision" => {
            let marker: String = required(args, "markerXml")?;
            value(set_para_mark_revision(text, &marker))
        }
        "stripParaMarkRevision" => {
            let kind: String = required(args, "kind")?;
            value(strip_para_mark_revision(text, &kind))
        }
        "resolveParaMarkRPrChange" => {
            let mode: String = required(args, "mode")?;
            value(resolve_para_mark_r_pr_change(text, &mode))
        }
        "stripPPrChange" => value(strip_p_pr_change(text)),
        "setPPrChange" => {
            let change: String = required(args, "changeJson")?;
            value(set_p_pr_change(text, &change)?)
        }
        "splitXmlChildren" => value(
            split_xml_children(text)
                .map_err(|limit| limit.to_string())?
                .into_iter()
                .map(|(name, xml)| json!({ "name": name, "xml": xml }))
                .collect::<Vec<_>>(),
        ),
        _ => Err(format!("genProps has no function {function}")),
    }
}
