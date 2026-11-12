//! Tables and headers and footers. A function over a node takes its XML text,
//! read as `deepXmlParser` reads it, and the first element there (none: the
//! TypeScript's `undefined`, or `{}` where it passes that). Model values cross
//! as JSON; a function that changes its argument returns it beside its result.

use docx_engine::model::{CellBorder, HfImage, HfPartInfo, ParaFormat, SectionSettings, TableCell};
use docx_engine::parse::tables::{self, DEEP_XML_PARSER_MAX_NESTED_TAGS, TblLookFlags, hf};
use jscompat::JsNum;
use ooxml_xml::{XNode, parse_ordered};
use serde_json::{Value, json};

use super::super::{Returned, arg, optional, required, value};

/// None: not a function of this module.
pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Option<Returned> {
    let call: fn(&str, &Value) -> Returned = match function {
        "tableSummary" => |text, _| value(tables::table_summary(text)),
        "tableLacksTcW" => |text, _| with_element(text, |tbl| value(tables::table_lacks_tc_w(tbl))),
        "rowGridEdges" => |text, _| with_element(text, |tr| value(tables::row_grid_edges(tr))),
        "reconcileGridColumns" => reconcile_grid_columns,
        "flattenedTableModel" => {
            |text, _| with_element(text, |tbl| optional(tables::flattened_table_model(tbl)))
        }
        "usableTableWidths" => usable_table_widths,
        "isUniformGrid" => |_, args| {
            let widths: Option<Vec<JsNum>> = arg(args, "widths")?;
            value(tables::is_uniform_grid(widths.as_deref()))
        },
        "rowRevisionOf" => {
            |text, _| with_element(text, |tr_pr| value(tables::row_revision_of(tr_pr)))
        }
        "tblLookFlags" => |text, _| with_node(text, |tbl_pr| value(tables::tbl_look_flags(tbl_pr))),
        "cellConds" => cell_conds,
        "hfMovablePictureFrag" => |text, _| value(hf::hf_movable_picture_frag(text)),
        "anchorDocPrIds" => |text, _| with_element(text, |node| value(hf::anchor_doc_pr_ids(node))),
        "hasDeepChildOutside" => has_deep_child_outside,
        "hfPartInfo" => |_, args| value(hf::hf_part_info(arg::<HfPartInfo>(args, "part")?)),
        "bindHfImageAnchors" => bind_hf_image_anchors,
        "stripHfDeletions" => {
            |text, _| value(hf::strip_hf_deletions(text).map_err(|limit| limit.to_string())?)
        }
        "hfTblRanges" => |text, _| value(hf::hf_tbl_ranges(text)),
        "hfCellColumnLeftPx" => {
            |text, args| value(JsNum(hf::hf_cell_column_left_px(text, number(args, "at")?)))
        }
        "hfOnlyEmptyRuns" => |text, _| with_element(text, |p| value(hf::hf_only_empty_runs(p))),
        "hfLine" => |_, args| optional(hf::hf_line(arg::<CellBorder>(args, "b")?)),
        "hfTableFloatOf" => {
            |text, _| with_node(text, |tbl_pr| optional(hf::hf_table_float_of(tbl_pr)))
        }
        "withoutResolvedGeometry" => |_, args| {
            value(hf::without_resolved_geometry(arg::<ParaFormat>(
                args, "direct",
            )?))
        },
        _ => return None,
    };
    Some(call(text_arg, args))
}

/// The first element of `text`; `Err` where the parser refuses it.
fn with_node(text: &str, call: impl FnOnce(Option<&XNode>) -> Returned) -> Returned {
    let nodes =
        parse_ordered(text, DEEP_XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    call(nodes.iter().find(|node| node.name().is_some()))
}

/// `nodeOf(text) ?? {}`
fn with_element(text: &str, call: impl FnOnce(&XNode) -> Returned) -> Returned {
    with_node(text, |node| call(node.unwrap_or(&XNode::empty())))
}

/// A number argument; null is NaN, which JSON writes as null.
fn number(args: &Value, key: &str) -> Result<f64, String> {
    Ok(arg::<JsNum>(args, key)?.map_or(f64::NAN, |n| n.0))
}

fn reconcile_grid_columns(_text: &str, args: &Value) -> Returned {
    let mut rows: Vec<Vec<TableCell>> = required(args, "rows")?;
    let row_tcws: Vec<Vec<Option<JsNum>>> = required(args, "rowTcws")?;
    let grid_cols: Option<Vec<JsNum>> = arg(args, "gridCols")?;
    let result = tables::reconcile_grid_columns(&mut rows, &row_tcws, grid_cols.as_deref())?;
    let mut out = serde_json::Map::new();
    if let Some(result) = result {
        out.insert("result".to_owned(), json!(result));
    }
    out.insert(
        "rows".to_owned(),
        serde_json::to_value(rows).map_err(|error| error.to_string())?,
    );
    value(out)
}

fn usable_table_widths(_text: &str, args: &Value) -> Returned {
    let sect: SectionSettings = required(args, "sect")?;
    let hang: Option<JsNum> = arg(args, "hangTwips")?;
    value(tables::usable_table_widths(
        &sect,
        number(args, "tblIndTwips")?,
        hang.map_or(0.0, |hang| hang.0),
    ))
}

fn cell_conds(_text: &str, args: &Value) -> Returned {
    let look: TblLookFlags = required(args, "look")?;
    value(tables::cell_conds(
        &look,
        number(args, "r")?,
        number(args, "rowCount")?,
        number(args, "col")?,
        number(args, "span")?,
        number(args, "totalCols")?,
    ))
}

fn has_deep_child_outside(text: &str, args: &Value) -> Returned {
    let names: Vec<String> = required(args, "names")?;
    let skip: Option<Vec<String>> = arg(args, "skip")?;
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let skip: Option<Vec<&str>> = skip
        .as_ref()
        .map(|skip| skip.iter().map(String::as_str).collect());
    with_element(text, |node| {
        value(hf::has_deep_child_outside(node, &names, skip.as_deref()))
    })
}

fn bind_hf_image_anchors(_text: &str, args: &Value) -> Returned {
    let mut images: Vec<HfImage> = required(args, "images")?;
    let image_anchor_ids: Vec<Option<String>> = required(args, "imageAnchorIds")?;
    let row_anchor_ids: Vec<Option<Vec<String>>> = required(args, "rowAnchorIds")?;
    hf::bind_hf_image_anchors(&mut images, &image_anchor_ids, &row_anchor_ids);
    value(images)
}
