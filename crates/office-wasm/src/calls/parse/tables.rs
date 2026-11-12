//! Tables, headers and footers, and inline-opaque.ts. A function over a node
//! takes its XML text, read as `deepXmlParser` reads it, and the first element
//! there (none: the TypeScript's `undefined`, or `{}` where it passes that).
//! Model values cross as JSON; a function that changes its argument returns it
//! beside its result. A `BuildContext` comes as `args.parts` (the package its
//! styles, numbering, theme and relationships are read from), `args.compat`
//! (the settings the resolver takes) and `args.sectionAt`, whether the context
//! holds the section reader of document.xml; a header/footer context
//! (`args.hf`) is the bare one of `hfParagraphs`.

use std::rc::Rc;

use docx_engine::inline_opaque as opaque;
use docx_engine::model::{
    HfImage, HfPartInfo, InlineWrap, ParaFormat, Run, SectionSettings, TableBorders, TableCell,
    TableModel,
};
use docx_engine::numbering::parse_numbering;
use docx_engine::package::{parse_rels, part_text};
use docx_engine::parse::drawings::host::{MediaEnv, NoHost};
use docx_engine::parse::drawings::settings::parse_settings_flag;
use docx_engine::parse::tables::extract::{self, RowPropExceptions};
use docx_engine::parse::tables::hf_fields;
use docx_engine::parse::tables::hf_images::{hf_group_pictures, hf_images, hf_table_media};
use docx_engine::parse::tables::hf_paras::{self, HfRawCell};
use docx_engine::parse::tables::hf_part::{
    hf_content_from_xml, parse_all_hf_parts, read_header_footer_part,
};
use docx_engine::parse::tables::{self, DEEP_XML_PARSER_MAX_NESTED_TAGS};
use docx_engine::parse::text::{BuildContext, SectionIndex};
use docx_engine::resolve::{ResolveCtx, TableCond};
use docx_engine::section::HfKind;
use jscompat::{JsMap, JsNum};
use ooxml_xml::{XNode, parse_ordered, serialize};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::super::resolve::with_ctx;
use super::super::{Returned, arg, optional, package, required, value};

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
        "hfMovablePictureFrag" => |text, _| value(tables::hf::hf_movable_picture_frag(text)),
        "anchorDocPrIds" => {
            |text, _| with_element(text, |node| value(tables::hf::anchor_doc_pr_ids(node)))
        }
        "hasDeepChildOutside" => has_deep_child_outside,
        "hfPartInfo" => |_, args| value(tables::hf::hf_part_info(arg::<HfPartInfo>(args, "part")?)),
        "bindHfImageAnchors" => bind_hf_image_anchors,
        "stripHfDeletions" => |text, _| {
            value(tables::hf::strip_hf_deletions(text).map_err(|limit| limit.to_string())?)
        },
        "hfTblRanges" => |text, _| value(tables::hf::hf_tbl_ranges(text)),
        "hfCellColumnLeftPx" => |text, args| {
            value(JsNum(tables::hf::hf_cell_column_left_px(
                text,
                number(args, "at")?,
            )))
        },
        "hfOnlyEmptyRuns" => {
            |text, _| with_element(text, |p| value(tables::hf::hf_only_empty_runs(p)))
        }
        "hfLine" => |_, args| optional(tables::hf::hf_line(arg(args, "b")?)),
        "hfTableFloatOf" => |text, _| {
            with_node(text, |tbl_pr| {
                optional(tables::hf::hf_table_float_of(tbl_pr))
            })
        },
        "withoutResolvedGeometry" => |_, args| {
            value(tables::hf::without_resolved_geometry(arg::<ParaFormat>(
                args, "direct",
            )?))
        },
        "tcwColumnWidths" => tcw_column_widths,
        "tablePropExceptionsOf" => table_prop_exceptions_of,
        "applyRowPropExceptions" => apply_row_prop_exceptions,
        "applyTableStyleDisplay" => apply_table_style_display,
        "attachRawTablePr" => attach_raw_table_pr,
        "extractTable" => extract_table,
        "extractTableModel" => extract_table_model,
        "extractCell" => extract_cell,
        "hfEmptyMarkFont" => hf_empty_mark_font,
        "hfParaStyleLayers" => hf_para_style_layers,
        "hfStyledParaFormat" => hf_styled_para_format,
        "hfCellBorders" => hf_cell_borders,
        "hfVSpanOf" => hf_v_span_of,
        "hfTableMedia" => hf_table_media_call,
        "hfCellContent" => hf_cell_content,
        "hfTableRowParagraphs" => hf_table_row_paragraphs,
        "hfParagraphs" => hf_paragraphs,
        "hfContentFromXml" => hf_content,
        "readHeaderFooterPart" => read_hf_part,
        "parseAllHfParts" => parse_all_hf,
        "hfImages" => hf_images_call,
        "hfGroupPictures" => hf_group_pictures_call,
        "parseFieldTree" => parse_field_tree,
        "partNamespaces" => part_namespaces,
        "isInlineWrapper" => |_, args| {
            value(opaque::is_inline_wrapper(&required::<String>(
                args, "name",
            )?))
        },
        "inlineWrapPrefixes" => inline_wrap_prefixes,
        "validInlineWrap" => valid_inline_wrap,
        "rawElements" => raw_elements,
        "inlineWrapperShell" => inline_wrapper_shell,
        "sameInlineWrap" => same_inline_wrap,
        "inlineWrapKey" => |_, args| {
            value(opaque::inline_wrap_key(&required::<InlineWrap>(
                args, "wrap",
            )?))
        },
        "sameInlineWrapChain" => same_inline_wrap_chain,
        "inlineWrapContentLocked" => |_, args| {
            value(opaque::inline_wrap_content_locked(&required::<InlineWrap>(
                args, "wrap",
            )?))
        },
        "inlineWrapWritesOnce" => |_, args| {
            value(opaque::inline_wrap_writes_once(&required::<InlineWrap>(
                args, "wrap",
            )?))
        },
        "sdtFollowsItsText" => |text, _| value(opaque::sdt_follows_its_text(text)),
        "inlineWrapTextOf" => inline_wrap_text_of,
        "sdtOpenForChangedText" => |text, _| {
            value(opaque::sdt_open_for_changed_text(text).map_err(|limit| limit.to_string())?)
        },
        "placeInlineWraps" => place_inline_wraps,
        "runCopiedElsewhere" => {
            |_, args| value(opaque::run_copied_elsewhere(&required::<Run>(args, "run")?))
        }
        _ => return None,
    };
    Some(call(text_arg, args))
}

/// The first element of `text`; `Err` where the parser refuses it.
fn with_node<T>(
    text: &str,
    call: impl FnOnce(Option<&XNode>) -> Result<T, String>,
) -> Result<T, String> {
    let nodes =
        parse_ordered(text, DEEP_XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    call(nodes.iter().find(|node| node.name().is_some()))
}

/// `nodeOf(text) ?? {}`
fn with_element<T>(
    text: &str,
    call: impl FnOnce(&XNode) -> Result<T, String>,
) -> Result<T, String> {
    with_node(text, |node| call(node.unwrap_or(&XNode::empty())))
}

/// A number argument; null is NaN, which JSON writes as null.
fn number(args: &Value, key: &str) -> Result<f64, String> {
    Ok(arg::<JsNum>(args, key)?.map_or(f64::NAN, |n| n.0))
}

/// `Option<Vec<JsNum>>` as `number[] | undefined`.
fn numbers(values: Option<Vec<f64>>) -> Returned {
    optional(values.map(|values| values.into_iter().map(JsNum).collect::<Vec<_>>()))
}

fn reconcile_grid_columns(_text: &str, args: &Value) -> Returned {
    let mut rows: Vec<Vec<TableCell>> = required(args, "rows")?;
    let row_tcws: Vec<Vec<Option<JsNum>>> = required(args, "rowTcws")?;
    let grid_cols: Option<Vec<JsNum>> = arg(args, "gridCols")?;
    let result = tables::reconcile_grid_columns(&mut rows, &row_tcws, grid_cols.as_deref())?;
    let mut out = Map::new();
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
    let look: tables::TblLookFlags = required(args, "look")?;
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
        value(tables::hf::has_deep_child_outside(
            node,
            &names,
            skip.as_deref(),
        ))
    })
}

fn bind_hf_image_anchors(_text: &str, args: &Value) -> Returned {
    let mut images: Vec<HfImage> = required(args, "images")?;
    let image_anchor_ids: Vec<Option<String>> = required(args, "imageAnchorIds")?;
    let row_anchor_ids: Vec<Option<Vec<String>>> = required(args, "rowAnchorIds")?;
    tables::hf::bind_hf_image_anchors(&mut images, &image_anchor_ids, &row_anchor_ids);
    value(images)
}

fn tcw_column_widths(text: &str, args: &Value) -> Returned {
    let pct: Option<JsNum> = arg(args, "pctTableTwips")?;
    with_element(text, |tbl| {
        numbers(extract::tcw_column_widths(
            tbl,
            pct.map_or(0.0, |pct| pct.0),
        ))
    })
}

/// `RowPropExceptions` as it crosses JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExceptionsArg {
    borders: Option<TableBorders>,
    cell_mar_twips: Option<docx_engine::model::CellMargins>,
    fill: Option<String>,
}

fn table_prop_exceptions_of(text: &str, _args: &Value) -> Returned {
    with_node(text, |node| {
        let Some(found) = extract::table_prop_exceptions_of(node)? else {
            return Ok(Some(Value::Null));
        };
        let mut out = Map::new();
        if let Some(borders) = found.borders {
            out.insert(
                "borders".to_owned(),
                serde_json::to_value(borders).map_err(|e| e.to_string())?,
            );
        }
        if let Some(mar) = found.cell_mar_twips {
            out.insert(
                "cellMarTwips".to_owned(),
                serde_json::to_value(mar).map_err(|e| e.to_string())?,
            );
        }
        if let Some(fill) = found.fill {
            out.insert("fill".to_owned(), Value::String(fill));
        }
        Ok(Some(Value::Object(out)))
    })
}

fn apply_row_prop_exceptions(_text: &str, args: &Value) -> Returned {
    let mut rows: Vec<Vec<TableCell>> = required(args, "rows")?;
    let exceptions: Vec<Option<ExceptionsArg>> = required(args, "exceptions")?;
    let exceptions: Vec<Option<RowPropExceptions>> = exceptions
        .into_iter()
        .map(|ex| {
            ex.map(|ex| RowPropExceptions {
                borders: ex.borders,
                cell_mar_twips: ex.cell_mar_twips,
                fill: ex.fill,
            })
        })
        .collect();
    extract::apply_row_prop_exceptions(&mut rows, &exceptions);
    value(rows)
}

/// The UTF-16 index `units` of `text` as a byte offset.
fn byte_of(text: &str, units: f64) -> usize {
    let target = if units.is_nan() {
        0.0
    } else {
        units.trunc().max(0.0)
    };
    let mut seen = 0.0;
    for (byte, c) in text.char_indices() {
        if seen >= target {
            return byte;
        }
        seen += c.len_utf16() as f64;
    }
    text.len()
}

/// `docOffset` of `args`, as a byte offset into document.xml.
fn doc_offset(args: &Value) -> Result<Option<usize>, String> {
    let Some(units) = arg::<JsNum>(args, "docOffset")? else {
        return Ok(None);
    };
    let package = package(args)?;
    let xml = part_text(&package, "word/document.xml")?.unwrap_or("");
    Ok(Some(byte_of(xml, units.0)))
}

/// Calls `call` with the `BuildContext` of `args`.
fn with_build_ctx(args: &Value, call: impl FnOnce(&BuildContext<'_>) -> Returned) -> Returned {
    let package = package(args)?;
    let hf: Option<bool> = arg(args, "hf")?;
    let section_at: Option<bool> = arg(args, "sectionAt")?;
    let compat_mode: Option<JsNum> = match args.get("compat") {
        Some(compat) => arg(compat, "compatibilityMode")?,
        None => None,
    };
    with_ctx(args, |resolver: &ResolveCtx| {
        let env = MediaEnv::new(&NoHost);
        let mut ctx = BuildContext::bare(&package, Rc::new(resolver.clone()), &env);
        if hf != Some(true) {
            ctx.has_numbering = true;
            ctx.num_formats = Some(parse_numbering(&package)?.formats);
            ctx.rels = parse_rels(&package, "word/_rels/document.xml.rels")?;
            ctx.source_path = Some("word/document.xml".to_owned());
            ctx.compatibility_mode = compat_mode;
            if section_at == Some(true) {
                let xml = part_text(&package, "word/document.xml")?.unwrap_or("");
                ctx.section_at = Some(SectionIndex::new(
                    xml,
                    Some(parse_settings_flag(&package, "w:gutterAtTop")?),
                ));
            }
        }
        call(&ctx)
    })
}

fn apply_table_style_display(text: &str, args: &Value) -> Returned {
    let mut rows: Vec<Vec<TableCell>> = required(args, "rows")?;
    with_build_ctx(args, |ctx| {
        with_node(text, |tbl_pr| {
            extract::apply_table_style_display(&mut rows, tbl_pr, ctx)?;
            value(&rows)
        })
    })
}

fn attach_raw_table_pr(text: &str, args: &Value) -> Returned {
    let mut model: TableModel = required(args, "model")?;
    let mut raw_tr_prs: Vec<Option<String>> = required(args, "rawTrPrs")?;
    extract::attach_raw_table_pr(text, &mut model, &mut raw_tr_prs)?;
    value(json!({ "model": model, "rawTrPrs": raw_tr_prs }))
}

fn extract_table(text: &str, args: &Value) -> Returned {
    let offset = doc_offset(args)?;
    with_build_ctx(args, |ctx| {
        optional(extract::extract_table(text, ctx, offset)?)
    })
}

fn extract_table_model(text: &str, args: &Value) -> Returned {
    let depth: Option<u32> = arg(args, "depth")?;
    let offset = doc_offset(args)?;
    with_build_ctx(args, |ctx| {
        with_element(text, |tbl| {
            optional(extract::extract_table_model(
                tbl,
                ctx,
                depth.unwrap_or(1),
                offset,
            )?)
        })
    })
}

fn extract_cell(text: &str, args: &Value) -> Returned {
    let depth: u32 = required(args, "depth")?;
    let table_style_id: Option<String> = arg(args, "tableStyleId")?;
    let conds: Option<Vec<TableCond>> = arg(args, "conds")?;
    let offset = doc_offset(args)?;
    with_build_ctx(args, |ctx| {
        with_element(text, |tc| {
            value(extract::extract_cell(
                tc,
                ctx,
                depth,
                offset,
                table_style_id.as_deref(),
                &conds.unwrap_or_default(),
            )?)
        })
    })
}

fn hf_empty_mark_font(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| {
        with_node(text, |p_pr| {
            optional(hf_paras::hf_empty_mark_font(p_pr, ctx)?)
        })
    })
}

fn hf_para_style_layers(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| {
        with_element(text, |p_node| {
            let (direct, display) = hf_paras::hf_para_style_layers(p_node, &ctx.resolver.styles)?;
            let mut out = Map::new();
            if let Some(direct) = direct {
                out.insert(
                    "direct".to_owned(),
                    serde_json::to_value(direct).map_err(|e| e.to_string())?,
                );
            }
            if let Some(display) = display {
                out.insert(
                    "d".to_owned(),
                    serde_json::to_value(display).map_err(|e| e.to_string())?,
                );
            }
            value(out)
        })
    })
}

fn hf_styled_para_format(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| {
        with_element(text, |p_node| {
            value(hf_paras::hf_styled_para_format(p_node, ctx)?)
        })
    })
}

/// `HfRawCell` without its node, as it crosses JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCellArg {
    grid_start: JsNum,
    span: JsNum,
    width_twips: JsNum,
    width_is_pct: bool,
    v_merge_continue: bool,
    borders: Option<docx_engine::model::CellBorders>,
}

fn raw_rows<'a>(rows: &[Vec<RawCellArg>], node: &'a XNode) -> Vec<Vec<HfRawCell<'a>>> {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|cell| HfRawCell {
                    tc: node,
                    tc_pr: None,
                    grid_start: cell.grid_start.0,
                    span: cell.span.0,
                    width_twips: cell.width_twips.0,
                    width_is_pct: cell.width_is_pct,
                    v_merge_continue: cell.v_merge_continue,
                    borders: cell.borders.clone(),
                })
                .collect()
        })
        .collect()
}

fn hf_cell_borders(_text: &str, args: &Value) -> Returned {
    let rows: Vec<Vec<RawCellArg>> = required(args, "rows")?;
    let tbl: Option<TableBorders> = arg(args, "tbl")?;
    let r: f64 = required(args, "r")?;
    let c: f64 = required(args, "c")?;
    let node = XNode::empty();
    let rows = raw_rows(&rows, &node);
    match rows.get(r as usize).and_then(|row| row.get(c as usize)) {
        Some(_) => optional(hf_paras::hf_cell_borders(
            &rows,
            r as usize,
            c as usize,
            tbl.as_ref(),
        )),
        None => Err("TypeError: Cannot read properties of undefined".to_owned()),
    }
}

fn hf_v_span_of(_text: &str, args: &Value) -> Returned {
    let rows: Vec<Vec<RawCellArg>> = required(args, "rows")?;
    let node = XNode::empty();
    let rows = raw_rows(&rows, &node);
    value(JsNum(hf_paras::hf_v_span_of(
        &rows,
        required::<f64>(args, "r")? as usize,
        number(args, "col")?,
    )))
}

fn map_entries(map: Option<JsMap<String>>) -> Returned {
    optional(map.map(|map| {
        map.iter()
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect::<Vec<_>>()
    }))
}

fn hf_table_media_call(text: &str, args: &Value) -> Returned {
    let part_path: String = required(args, "partPath")?;
    let package = package(args)?;
    let env = MediaEnv::new(&NoHost);
    map_entries(hf_table_media(&package, &part_path, text, &env)?)
}

/// `args.tableMedia`: `[rId, url]` pairs.
fn table_media_arg(args: &Value) -> Result<Option<JsMap<String>>, String> {
    let entries: Option<Vec<(String, String)>> = arg(args, "tableMedia")?;
    Ok(entries.map(|entries| entries.into_iter().collect()))
}

fn hf_cell_content(text: &str, args: &Value) -> Returned {
    let table_style_id: Option<String> = arg(args, "tableStyleId")?;
    with_build_ctx(args, |ctx| {
        with_element(text, |tc| {
            let content = hf_paras::hf_cell_content(tc, ctx, table_style_id.as_deref())?;
            let mut out = Map::new();
            out.insert(
                "paras".to_owned(),
                serde_json::to_value(&content.paras).map_err(|e| e.to_string())?,
            );
            if let Some(props) = &content.para_props {
                out.insert(
                    "paraProps".to_owned(),
                    serde_json::to_value(props).map_err(|e| e.to_string())?,
                );
            }
            if let Some(align) = &content.align {
                out.insert(
                    "align".to_owned(),
                    serde_json::to_value(align).map_err(|e| e.to_string())?,
                );
            }
            if let Some(fill) = &content.fill {
                out.insert("fill".to_owned(), Value::String(fill.clone()));
            }
            if content.locked {
                out.insert("locked".to_owned(), Value::Bool(true));
            }
            value(out)
        })
    })
}

fn hf_table_row_paragraphs(text: &str, args: &Value) -> Returned {
    let compat_mode: f64 = number(args, "compatibilityMode")?;
    let tbl_index: Option<JsNum> = arg(args, "tblIndex")?;
    with_build_ctx(args, |ctx| {
        with_element(text, |tbl| {
            let rows = hf_paras::hf_table_rows(tbl, ctx, compat_mode, tbl_index.map(|i| i.0))?;
            let ids: Vec<Option<&Vec<String>>> = rows.iter().map(|(_, ids)| ids.as_ref()).collect();
            let paras: Vec<&docx_engine::model::HfParagraph> =
                rows.iter().map(|(para, _)| para).collect();
            value(json!({ "paras": paras, "rowAnchorIds": ids }))
        })
    })
}

fn hf_paragraphs(text: &str, args: &Value) -> Returned {
    let package = package(args)?;
    let compat_mode: f64 = number(args, "compatibilityMode")?;
    let table_media = table_media_arg(args)?;
    with_build_ctx(args, |ctx| {
        let list = hf_paras::hf_paragraphs(
            text,
            &package,
            &ctx.resolver,
            table_media.as_ref(),
            compat_mode,
            ctx.media,
        )?;
        let mut run_image_ids: Vec<&String> = list.run_image_ids.iter().collect();
        run_image_ids.sort();
        value(json!({
            "paras": list.paras,
            "rowAnchorIds": list.row_anchor_ids,
            "runImageIds": run_image_ids,
        }))
    })
}

fn hf_kind(args: &Value) -> Result<HfKind, String> {
    let kind: String = required(args, "kind")?;
    Ok(if kind == "header" {
        HfKind::Header
    } else {
        HfKind::Footer
    })
}

fn hf_content(text: &str, args: &Value) -> Returned {
    let package = package(args)?;
    let kind = hf_kind(args)?;
    let compat_mode: f64 = number(args, "compatibilityMode")?;
    let table_media = table_media_arg(args)?;
    with_build_ctx(args, |ctx| {
        let content = hf_content_from_xml(
            text,
            kind,
            &package,
            &ctx.resolver,
            table_media.as_ref(),
            compat_mode,
            ctx.media,
        )?;
        value(json!({
            "text": content.text,
            "hasPageNumber": content.has_page_number,
            "watermark": content.watermark,
            "watermarkPicture": content.watermark_picture,
            "paras": content.paras,
        }))
    })
}

fn read_hf_part(text: &str, args: &Value) -> Returned {
    let package = package(args)?;
    let kind = hf_kind(args)?;
    let hf_type: String = required(args, "hfType")?;
    let compat_mode: f64 = number(args, "compatibilityMode")?;
    let source_path: String = required(args, "sourcePath")?;
    let rels = parse_rels(&package, "word/_rels/document.xml.rels")?;
    with_build_ctx(args, |ctx| {
        let part = read_header_footer_part(
            &package,
            text,
            &rels,
            kind,
            &hf_type,
            &ctx.resolver,
            compat_mode,
            &source_path,
            ctx.media,
        )?;
        optional(part.map(|part| {
            let mut out = Map::new();
            out.insert("text".to_owned(), json!(part.text));
            out.insert("hasPageNumber".to_owned(), json!(part.has_page_number));
            out.insert("watermark".to_owned(), json!(part.watermark));
            out.insert("watermarkPicture".to_owned(), json!(part.watermark_picture));
            out.insert("paras".to_owned(), json!(part.paras));
            if let Some(images) = part.images {
                out.insert("images".to_owned(), json!(images));
            }
            out
        }))
    })
}

fn parse_all_hf(_text: &str, args: &Value) -> Returned {
    let package = package(args)?;
    let compat_mode: f64 = number(args, "compatibilityMode")?;
    let source_path: String = required(args, "sourcePath")?;
    let rels = parse_rels(&package, "word/_rels/document.xml.rels")?;
    with_build_ctx(args, |ctx| {
        value(parse_all_hf_parts(
            &package,
            &rels,
            &ctx.resolver,
            compat_mode,
            &source_path,
            ctx.media,
        )?)
    })
}

fn hf_images_call(text: &str, args: &Value) -> Returned {
    let package = package(args)?;
    let part_path: String = required(args, "partPath")?;
    let run_ids: Option<Vec<String>> = arg(args, "runImageIds")?;
    let env = MediaEnv::new(&NoHost);
    let ids = run_ids.map(|ids| ids.into_iter().collect::<std::collections::HashSet<_>>());
    let found = hf_images(&package, &part_path, text, ids.as_ref(), &env)?;
    value(json!({ "images": found.images, "anchorIds": found.image_anchor_ids }))
}

fn hf_group_pictures_call(text: &str, args: &Value) -> Returned {
    let package = package(args)?;
    let source_path: String = required(args, "sourcePath")?;
    let rels = parse_rels(&package, "word/_rels/document.xml.rels")?;
    let env = MediaEnv::new(&NoHost);
    optional(hf_group_pictures(
        &package,
        &rels,
        text,
        &source_path,
        &env,
    )?)
}

fn parse_field_tree(text: &str, _args: &Value) -> Returned {
    let tree = hf_fields::parse_field_tree(text);
    fn frame(tree: &hf_fields::FieldTree, index: usize) -> Value {
        let f = &tree.frames[index];
        json!({
            "start": f.start,
            "end": f.end,
            "instr": f.instr,
            "separateStart": f.separate_start,
            "separateEnd": f.separate_end,
            "children": f.children.iter().map(|&child| frame(tree, child)).collect::<Vec<_>>(),
        })
    }
    value(
        tree.roots
            .iter()
            .map(|&root| frame(&tree, root))
            .collect::<Vec<_>>(),
    )
}

fn part_namespaces(text: &str, _args: &Value) -> Returned {
    let map = opaque::part_namespaces(text).map_err(|limit| limit.to_string())?;
    value(
        map.iter()
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect::<Vec<_>>(),
    )
}

fn namespaces_arg(args: &Value) -> Result<Option<JsMap<String>>, String> {
    let entries: Option<Vec<(String, String)>> = arg(args, "namespaces")?;
    Ok(entries.map(|entries| entries.into_iter().collect()))
}

fn inline_wrap_prefixes(_text: &str, args: &Value) -> Returned {
    let wrap: InlineWrap = required(args, "wrap")?;
    optional(opaque::inline_wrap_prefixes(&wrap).map(|prefixes| {
        let mut sorted: Vec<String> = prefixes.into_iter().collect();
        sorted.sort();
        sorted
    }))
}

fn valid_inline_wrap(_text: &str, args: &Value) -> Returned {
    let wrap: InlineWrap = required(args, "wrap")?;
    value(opaque::valid_inline_wrap(
        &wrap,
        namespaces_arg(args)?.as_ref(),
    ))
}

fn raw_elements(text: &str, args: &Value) -> Returned {
    let skip: Option<bool> = arg(args, "skipNonElements")?;
    let tree = opaque::raw_elements(text, skip == Some(true)).map_err(|limit| limit.to_string())?;
    fn element(tree: &opaque::RawTree, index: usize) -> Value {
        let el = tree.get(index);
        json!({
            "name": el.name,
            "start": el.start,
            "openEnd": el.open_end,
            "closeStart": el.close_start,
            "end": el.end,
            "selfClosing": el.self_closing,
            "children": el.children.iter().map(|&child| element(tree, child)).collect::<Vec<_>>(),
        })
    }
    value(
        tree.roots
            .iter()
            .map(|&root| element(&tree, root))
            .collect::<Vec<_>>(),
    )
}

fn inline_wrapper_shell(text: &str, args: &Value) -> Returned {
    let with_source: Option<bool> = arg(args, "withSource")?;
    let nodes =
        parse_ordered(text, DEEP_XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    let Some(node) = nodes.iter().find(|node| node.name().is_some()) else {
        return Err("TypeError: no node".to_owned());
    };
    let source = opaque::inline_raw_source(text, node);
    let shell = opaque::inline_wrapper_shell(node, (with_source == Some(true)).then_some(&source))
        .map_err(|limit| limit.to_string())?;
    value(shell.map(|shell| {
        json!({
            "open": shell.open,
            "close": shell.close,
            "content": shell.content.iter().map(|node| serialize(node)).collect::<Vec<_>>(),
        })
    }))
}

fn same_inline_wrap(_text: &str, args: &Value) -> Returned {
    let a: Option<InlineWrap> = arg(args, "a")?;
    let b: Option<InlineWrap> = arg(args, "b")?;
    value(opaque::same_inline_wrap(a.as_ref(), b.as_ref()))
}

fn same_inline_wrap_chain(_text: &str, args: &Value) -> Returned {
    let a: Option<Vec<InlineWrap>> = arg(args, "a")?;
    let b: Option<Vec<InlineWrap>> = arg(args, "b")?;
    value(opaque::same_inline_wrap_chain(a.as_deref(), b.as_deref()))
}

fn inline_wrap_text_of(_text: &str, args: &Value) -> Returned {
    let runs: Vec<Run> = required(args, "runs")?;
    let from: Option<usize> = arg(args, "from")?;
    let to: Option<usize> = arg(args, "to")?;
    let (from, to) = (from.unwrap_or(0), to.unwrap_or(runs.len()).min(runs.len()));
    value(opaque::inline_wrap_text_of(&runs, from.min(to), to))
}

/// The grouping key the spec passes for `revKeyOf`: the revision record of the run, as JSON.
fn place_inline_wraps(_text: &str, args: &Value) -> Returned {
    let runs: Vec<Run> = required(args, "runs")?;
    let key = |run: &Run| -> String {
        let revision = run
            .ins
            .as_ref()
            .map(|r| ("ins", r))
            .or(run.del.as_ref().map(|r| ("del", r)));
        match revision {
            Some((kind, info)) => format!("{kind}:{}", info.id.as_deref().unwrap_or("")),
            None => String::new(),
        }
    };
    value(opaque::place_inline_wraps(&runs, &key))
}

#[allow(dead_code)]
type Unused = ParaFormat;
