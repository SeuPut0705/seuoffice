//! The edit channels of `slides-main.ts` that are shims over one pptx-ops
//! transaction: the handler turns the renderer's operation into ops,
//! `session_txn` wraps them in one undo step, and the answer is the rebuilt
//! slide or a slide update. See [`super::session`] for the pattern.
//!
//! Channels not yet here (the next phase): edit-text, set-element-font,
//! set-element-paragraph-format, edit-transform (+ cancel preview, multi),
//! set-shape-adjust/geometry, set-text-body-props (autofit write-back),
//! apply-txn, apply-edit-script, master-*, edit-background, edit-image-fill,
//! pick-picture-file, insert-image/media, add-ink, add-image-bytes,
//! replace-picture-bytes, add-media-bytes, add-model3d, pick-model3d,
//! media-data, model3d-data, set-model3d-view, add-slide-with-layout,
//! set-slide-layout, get-layouts, edit-table-style, edit-chart,
//! chart-color-schemes, get-chart-data, set-link and the link/animation/
//! notes/comment readers, save-recording, clear-narration, move-slides,
//! remove-section-slides.

use main_core::slides::session_state::OpSource;
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue};

use super::engine::TxnRequest;
use super::session::{
    EMU_PER_PT, EMU_PER_PX_96, Obj, emu_box, js_round, null, number, op, prop, slide_index, target,
};
use super::state::{App, SlideSession};
use super::{Route, now};
use crate::value::or_null;
use crate::value::{Args, as_num, as_str, field, is_nullish, num, obj, string, truthy};

type Reply = Result<IpcValue, IpcError>;

fn p(value: &IpcValue, key: &str) -> IpcValue {
    field(value, key).clone()
}

/// `op.fitWidthPx / (deck.size.cx / EMU_PER_PX_96)`
fn scale_of(app: &App, s: &SlideSession, fit: &IpcValue) -> f64 {
    number(fit) / (app.engine.size(s.deck()).cx / EMU_PER_PX_96)
}

/// `...(op.groupId ? { group: op.groupId } : {})`
fn with_group(o: Obj, op_value: &IpcValue) -> Obj {
    o.set_if(truthy(field(op_value, "groupId")), "group", || {
        p(op_value, "groupId")
    })
}

/// A shim of one atomic transaction answering the rebuilt slide of
/// `op.slideIndex`: `session && sessionTxn(...) ? rebuildSlide : null`
fn rebuild_shim(
    app: &App,
    cx: &CallContext,
    args: &Args,
    build: impl FnOnce(&App, &SlideSession, &IpcValue) -> Result<Vec<IpcValue>, IpcError>,
) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let ops = build(app, s, op_value)?;
        let slide = prop(op_value, "slideIndex")?;
        Ok(
            match app.session_txn(s, TxnRequest::atomic(ops), OpSource::Edit) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

/// `{ slide, sourceId: r.records[0].created[0] }` of an insert
fn inserted(
    app: &App,
    s: &SlideSession,
    slide: &IpcValue,
    created: Option<&Vec<String>>,
) -> IpcValue {
    match app.rebuild_slide(s, slide) {
        Some(rebuilt) => obj([
            ("slide", rebuilt),
            (
                "sourceId",
                created
                    .and_then(|c| c.first())
                    .map_or(IpcValue::Undefined, |id| string(id.as_str())),
            ),
        ]),
        None => IpcValue::Null,
    }
}

fn stroke_value(stroke: &IpcValue) -> IpcValue {
    obj([
        ("color", p(stroke, "color")),
        (
            "widthEmu",
            num(js_round(number(field(stroke, "widthPt")) * EMU_PER_PT)),
        ),
    ])
}

pub fn routes(app: &App) -> Vec<Route> {
    vec![
        now(app, "slides:add-element", add_element),
        now(app, "slides:delete-element", delete_element),
        now(app, "slides:delete-elements", delete_elements),
        now(app, "slides:edit-stroke", edit_stroke),
        now(app, "slides:flip-elements", flip_elements),
        now(app, "slides:edit-picture-src-rect", edit_picture_src_rect),
        now(app, "slides:group-elements", group_elements),
        now(app, "slides:ungroup-element", ungroup_element),
        now(app, "slides:edit-fill", edit_fill),
        now(app, "slides:edit-picture-opacity", edit_picture_opacity),
        now(app, "slides:batch-edit-transform", batch_edit_transform),
        now(
            app,
            "slides:edit-connector-endpoints",
            edit_connector_endpoints,
        ),
        now(app, "slides:reorder-element", reorder_element),
        now(app, "slides:change-shape", change_shape),
        now(app, "slides:set-text-anchor", set_text_anchor),
        now(app, "slides:set-effects", set_effects),
        now(app, "slides:set-element-hidden", set_element_hidden),
        now(app, "slides:set-element-name", set_element_name),
        now(app, "slides:edit-table-cell", edit_table_cell),
        now(app, "slides:table-merge", table_merge),
        now(app, "slides:table-structure", table_structure),
        now(app, "slides:set-table-row-height", set_table_row_height),
        now(app, "slides:set-table-cell-anchor", set_table_cell_anchor),
        now(app, "slides:set-table-col-width", set_table_col_width),
        now(app, "slides:add-table", add_table),
        now(app, "slides:add-chart", add_chart),
        now(app, "slides:add-smartart", add_smartart),
        now(app, "slides:add-slide", add_slide),
        now(app, "slides:add-blank-slide", add_blank_slide),
        now(app, "slides:delete-slide", delete_slide),
        now(app, "slides:delete-slides", delete_slides),
        now(app, "slides:duplicate-slides", duplicate_slides),
        now(app, "slides:set-slides-hidden", set_slides_hidden),
        now(app, "slides:set-hidden", set_hidden),
        now(app, "slides:set-slide-size", set_slide_size),
        now(app, "slides:get-slide-size", get_slide_size),
        now(app, "slides:find-replace", find_replace),
        now(app, "slides:apply-header-footer", apply_header_footer),
        now(app, "slides:set-transition", set_transition),
        now(app, "slides:set-advance-times", set_advance_times),
        now(app, "slides:set-animations", set_animations),
        now(app, "slides:set-notes", set_notes),
        now(app, "slides:get-sections", get_sections),
        now(app, "slides:set-sections", set_sections),
        now(app, "slides:add-section", add_section),
        now(app, "slides:rename-section", rename_section),
        now(app, "slides:remove-section", remove_section),
        now(app, "slides:move-section", move_section),
        now(app, "slides:move-slide", move_slide),
    ]
}

pub fn add_element(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let scale = scale_of(app, s, prop(op_value, "fitWidthPx")?);
        let slide = prop(op_value, "slideIndex")?;
        let paragraphs = match field(op_value, "paragraphs") {
            IpcValue::Array(items) if !items.is_empty() => Some(IpcValue::Array(items.clone())),
            _ => as_str(field(op_value, "text"))
                .filter(|t| !t.is_empty())
                .map(|text| {
                    IpcValue::Array(
                        text.split('\n')
                            .map(|line| {
                                obj([(
                                    "runs",
                                    IpcValue::Array(vec![obj([("text", string(line))])]),
                                )])
                            })
                            .collect(),
                    )
                }),
        };
        let o = op("addElement")
            .set("target", target(slide, None))
            .set("kind", p(op_value, "kind"))
            .set(
                "offset",
                emu_box(
                    scale,
                    number(field(op_value, "xPx")),
                    number(field(op_value, "yPx")),
                    number(field(op_value, "wPx")),
                    number(field(op_value, "hPx")),
                ),
            )
            .set_if(paragraphs.is_some(), "paragraphs", || {
                paragraphs.clone().unwrap_or(IpcValue::Undefined)
            })
            .set_if(truthy(field(op_value, "fillColor")), "fill", || {
                p(op_value, "fillColor")
            })
            .set_if(truthy(field(op_value, "stroke")), "stroke", || {
                stroke_value(field(op_value, "stroke"))
            })
            .set_if(truthy(field(op_value, "bodyPr")), "bodyPr", || {
                p(op_value, "bodyPr")
            })
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return null();
        };
        let created = r
            .records
            .as_ref()
            .and_then(|r| r.first())
            .and_then(|r| r.created.as_ref());
        Ok(inserted(app, s, slide, created))
    })
}

pub fn delete_element(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = op("deleteElement")
            .set("target", target(slide, Some(field(op_value, "sourceId"))))
            .build();
        Ok(
            match app.push_and_journal(s, OpSource::Edit, &TxnRequest::atomic(vec![o])) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

pub fn delete_elements(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let ids = match prop(op_value, "sourceIds")? {
            IpcValue::Array(ids) => ids.clone(),
            _ => return Err(super::session::prop(&IpcValue::Undefined, "length").unwrap_err()),
        };
        if ids.is_empty() {
            return null();
        }
        let slide = field(op_value, "slideIndex");
        let ops = ids
            .iter()
            .map(|id| {
                op("deleteElement")
                    .set("target", target(slide, Some(id)))
                    .build()
            })
            .collect();
        Ok(
            match app.session_txn(s, TxnRequest::per_op(ops), OpSource::Edit) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

pub fn edit_stroke(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let stroke = field(op_value, "stroke");
        let patch = if truthy(stroke) {
            let mut o = Obj::new().set("color", p(stroke, "color")).set(
                "widthEmu",
                num(js_round(number(field(stroke, "widthPt")) * EMU_PER_PT)),
            );
            for key in ["dash", "cap", "join", "compound"] {
                o = o.set_if(truthy(field(stroke, key)), key, || p(stroke, key));
            }
            let gradient = field(stroke, "gradient");
            o = o.set_if(truthy(gradient), "gradient", || {
                obj([
                    ("stops", p(gradient, "stops")),
                    (
                        "angle",
                        num(js_round(number(field(gradient, "angleDeg")) * 60000.0)),
                    ),
                ])
            });
            o.build()
        } else {
            IpcValue::Null
        };
        let slide = prop(op_value, "slideIndex")?;
        let o = with_group(
            op("setStroke")
                .set("target", target(slide, Some(field(op_value, "sourceId"))))
                .set("stroke", patch),
            op_value,
        )
        .build();
        Ok(
            match app.push_and_journal(s, OpSource::Edit, &TxnRequest::atomic(vec![o])) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

pub fn flip_elements(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            with_group(
                op("flipElements")
                    .set("target", target(slide, None))
                    .set("els", p(o, "sourceIds"))
                    .set("axis", p(o, "axis")),
                o,
            )
            .build(),
        ])
    })
}

pub fn edit_picture_src_rect(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |app, s, o| {
        let slide = prop(o, "slideIndex")?;
        let box_px = field(o, "boxPx");
        let boxed = (truthy(box_px) && truthy(field(o, "fitWidthPx"))).then(|| {
            emu_box(
                scale_of(app, s, field(o, "fitWidthPx")),
                number(field(box_px, "x")),
                number(field(box_px, "y")),
                number(field(box_px, "w")),
                number(field(box_px, "h")),
            )
        });
        Ok(vec![
            op("setPictureSrcRect")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("srcRect", p(o, "srcRect"))
                .set_if(boxed.is_some(), "box", || {
                    boxed.clone().unwrap_or(IpcValue::Undefined)
                })
                .build(),
        ])
    })
}

pub fn group_elements(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = op("groupElements")
            .set("target", target(slide, None))
            .set("els", p(op_value, "sourceIds"))
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return null();
        };
        Ok(match app.rebuild_slide(s, slide) {
            Some(rendered) => obj([
                ("slide", rendered),
                (
                    "groupId",
                    r.records
                        .as_ref()
                        .and_then(|r| r.first())
                        .and_then(|r| r.created.as_ref())
                        .and_then(|c| c.first())
                        .map_or(IpcValue::Undefined, |id| string(id.as_str())),
                ),
            ]),
            None => IpcValue::Null,
        })
    })
}

pub fn ungroup_element(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("ungroupElement")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .build(),
        ])
    })
}

/// IPC gradient to the engine's fill (`gradientStops`, `gradientPathKind`,
/// `gradientFillTo`)
pub fn fill_value(fill: &IpcValue) -> IpcValue {
    if let IpcValue::String(_) = fill {
        return fill.clone();
    }
    let g = field(fill, "gradient");
    let stops = match field(g, "stops") {
        IpcValue::Array(items) if !items.is_empty() => IpcValue::Array(items.clone()),
        _ => IpcValue::Array(vec![
            obj([("pos", num(0.0)), ("color", p(g, "from"))]),
            obj([("pos", num(1.0)), ("color", p(g, "to"))]),
        ]),
    };
    let path = if truthy(field(g, "path")) {
        Some(p(g, "path"))
    } else if truthy(field(g, "radial")) {
        Some(string("circle"))
    } else {
        None
    };
    let o = Obj::new().set("stops", stops);
    match path {
        Some(path) => {
            let center = field(g, "center");
            o.set("path", path)
                .set_if(truthy(center), "fillTo", || {
                    let x = number(field(center, "x"));
                    let y = number(field(center, "y"));
                    obj([
                        ("l", num(x)),
                        ("t", num(y)),
                        ("r", num(1.0 - x)),
                        ("b", num(1.0 - y)),
                    ])
                })
                .build()
        }
        None => o
            .set(
                "angle",
                num(js_round(
                    as_num(field(g, "angleDeg")).unwrap_or(0.0) * 60000.0,
                )),
            )
            .build(),
    }
}

pub fn edit_fill(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let fill = fill_value(prop(op_value, "fill")?);
        let slide = prop(op_value, "slideIndex")?;
        let o = with_group(
            op("setFill")
                .set("target", target(slide, Some(field(op_value, "sourceId"))))
                .set("fill", fill),
            op_value,
        )
        .build();
        Ok(
            match app.push_and_journal(s, OpSource::Edit, &TxnRequest::atomic(vec![o])) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

pub fn edit_picture_opacity(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setPictureOpacity")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("opacity", p(o, "opacity"))
                .build(),
        ])
    })
}

/// the box of one item of a transform batch (`toEmu` of the px box)
fn item_box(scale: f64, item: &IpcValue) -> IpcValue {
    emu_box(
        scale,
        number(field(item, "xPx")),
        number(field(item, "yPx")),
        number(field(item, "wPx")),
        number(field(item, "hPx")),
    )
}

pub fn batch_edit_transform(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |app, s, o| {
        let scale = scale_of(app, s, prop(o, "fitWidthPx")?);
        let slide = prop(o, "slideIndex")?;
        let items = match prop(o, "items")? {
            IpcValue::Array(items) => items.clone(),
            _ => Vec::new(),
        };
        // legacy parity: the batch path never redistributed table grids
        Ok(items
            .iter()
            .map(|item| {
                op("setTransform")
                    .set("target", target(slide, Some(field(item, "sourceId"))))
                    .set("box", item_box(scale, item))
                    .set("rotDeg", p(item, "rotationDeg"))
                    .build()
            })
            .collect())
    })
}

pub fn edit_connector_endpoints(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |app, s, o| {
        let scale = scale_of(app, s, prop(o, "fitWidthPx")?);
        let slide = prop(o, "slideIndex")?;
        let to_emu = |px: &IpcValue| num(js_round((number(px) / scale) * EMU_PER_PX_96));
        Ok(vec![
            op("setConnectorEndpoints")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set(
                    "p1",
                    obj([
                        ("x", to_emu(field(o, "x1Px"))),
                        ("y", to_emu(field(o, "y1Px"))),
                    ]),
                )
                .set(
                    "p2",
                    obj([
                        ("x", to_emu(field(o, "x2Px"))),
                        ("y", to_emu(field(o, "y2Px"))),
                    ]),
                )
                .set("start", p(o, "start"))
                .set("end", p(o, "end"))
                .build(),
        ])
    })
}

pub fn reorder_element(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("reorderElement")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("dir", p(o, "dir"))
                .build(),
        ])
    })
}

pub fn change_shape(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            with_group(
                op("setShapeGeometry")
                    .set("target", target(slide, Some(field(o, "sourceId"))))
                    .set("prst", p(o, "prst")),
                o,
            )
            .build(),
        ])
    })
}

pub fn set_text_anchor(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setTextAnchor")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("anchor", p(o, "anchor"))
                .build(),
        ])
    })
}

pub fn set_effects(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setEffects")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("effects", p(o, "effects"))
                .build(),
        ])
    })
}

pub fn set_element_hidden(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setElementHidden")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("hidden", p(o, "hidden"))
                .build(),
        ])
    })
}

pub fn set_element_name(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("renameElement")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("name", p(o, "name"))
                .build(),
        ])
    })
}

pub fn edit_table_cell(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setTableCell")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("row", p(o, "row"))
                .set("col", p(o, "col"))
                .set("paragraphs", p(o, "paragraphs"))
                .build(),
        ])
    })
}

/// A table op answering `{ slide, sourceId: records[0].after.elementId }`
fn table_shim(
    app: &App,
    cx: &CallContext,
    args: &Args,
    build: impl FnOnce(&IpcValue, &IpcValue) -> IpcValue,
) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = build(op_value, slide);
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return null();
        };
        Ok(match app.rebuild_slide(s, slide) {
            Some(rebuilt) => obj([
                ("slide", rebuilt),
                (
                    "sourceId",
                    r.records
                        .as_ref()
                        .and_then(|r| r.first())
                        .map_or(IpcValue::Undefined, |rec| p(&rec.after, "elementId")),
                ),
            ]),
            None => IpcValue::Null,
        })
    })
}

pub fn table_merge(app: &App, cx: &CallContext, args: Args) -> Reply {
    table_shim(app, cx, &args, |o, slide| {
        op("tableMerge")
            .set("target", target(slide, Some(field(o, "sourceId"))))
            .set("kind", p(o, "kind"))
            .set("row", p(o, "row"))
            .set("col", p(o, "col"))
            .build()
    })
}

pub fn table_structure(app: &App, cx: &CallContext, args: Args) -> Reply {
    table_shim(app, cx, &args, |o, slide| {
        op("tableStructure")
            .set("target", target(slide, Some(field(o, "sourceId"))))
            .set("kind", p(o, "kind"))
            .set("index", p(o, "index"))
            .set_if(truthy(field(o, "before")), "before", || {
                IpcValue::Bool(true)
            })
            .build()
    })
}

pub fn set_table_row_height(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |app, s, o| {
        let scale = scale_of(app, s, prop(o, "fitWidthPx")?);
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setTableRowHeight")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("row", p(o, "row"))
                .set(
                    "hEmu",
                    num((number(field(o, "hPx")) / scale) * EMU_PER_PX_96),
                )
                .build(),
        ])
    })
}

pub fn set_table_cell_anchor(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setTableCellAnchor")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("row", p(o, "row"))
                .set("col", p(o, "col"))
                .set("anchor", p(o, "anchor"))
                .build(),
        ])
    })
}

pub fn set_table_col_width(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |app, s, o| {
        let scale = scale_of(app, s, prop(o, "fitWidthPx")?);
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setTableColWidth")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("col", p(o, "col"))
                .set(
                    "wEmu",
                    num((number(field(o, "wPx")) / scale) * EMU_PER_PX_96),
                )
                .build(),
        ])
    })
}

/// An insert answering `{ slide, sourceId }` of the created element
fn insert_shim(
    app: &App,
    cx: &CallContext,
    args: &Args,
    require_slide: bool,
    build: impl FnOnce(f64, &IpcValue, &IpcValue) -> IpcValue,
) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        if require_slide && slide_index(slide, len).is_none() {
            return null();
        }
        let scale = scale_of(app, s, field(op_value, "fitWidthPx"));
        let o = build(scale, op_value, slide);
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return null();
        };
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        let created = r
            .records
            .as_ref()
            .and_then(|r| r.first())
            .and_then(|r| r.created.as_ref());
        Ok(inserted(app, s, slide, created))
    })
}

pub fn add_table(app: &App, cx: &CallContext, args: Args) -> Reply {
    insert_shim(app, cx, &args, true, |scale, o, slide| {
        let to_emu = |px: &IpcValue| js_round((number(px) / scale) * EMU_PER_PX_96);
        let row_h = as_num(field(o, "rowHeightEmu"))
            .filter(|h| *h > 0.0)
            .map(js_round);
        let rows = number(field(o, "rows"));
        op("addTable")
            .set("target", target(slide, None))
            .set("rows", p(o, "rows"))
            .set("cols", p(o, "cols"))
            .set(
                "offset",
                obj([
                    ("x", num(to_emu(field(o, "xPx")))),
                    ("y", num(to_emu(field(o, "yPx")))),
                    ("cx", num(to_emu(field(o, "wPx")))),
                    (
                        "cy",
                        num(row_h.map_or_else(|| to_emu(field(o, "hPx")), |h| h * rows)),
                    ),
                ]),
            )
            .set_if(row_h.is_some(), "rowHeightsEmu", || {
                IpcValue::Array(
                    (0..rows.max(0.0) as usize)
                        .map(|_| num(row_h.unwrap_or(0.0)))
                        .collect(),
                )
            })
            .build()
    })
}

pub fn add_chart(app: &App, cx: &CallContext, args: Args) -> Reply {
    insert_shim(app, cx, &args, true, |scale, o, slide| {
        let bar_h = as_str(field(o, "kind")) == Some("barH");
        op("addChart")
            .set("target", target(slide, None))
            .set("kind", if bar_h { string("bar") } else { p(o, "kind") })
            .set_if(bar_h, "barDir", || string("bar"))
            .set_if(truthy(field(o, "title")), "title", || p(o, "title"))
            .set("categories", p(o, "categories"))
            .set("series", p(o, "series"))
            .set("offset", item_box(scale, o))
            .build()
    })
}

pub fn add_smartart(app: &App, cx: &CallContext, args: Args) -> Reply {
    insert_shim(app, cx, &args, true, |scale, o, slide| {
        op("addSmartArt")
            .set("target", target(slide, None))
            .set("layout", p(o, "layout"))
            .set("items", p(o, "items"))
            .set("offset", item_box(scale, o))
            .build()
    })
}

// ---- slides ----

fn before_paths(app: &App, s: &SlideSession) -> Vec<String> {
    app.engine.slide_paths(s.deck())
}

pub fn add_slide(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let source = prop(op_value, "sourceIndex")?;
        let o = op("duplicateSlide")
            .set("target", target(source, None))
            .set_if(truthy(field(op_value, "clearText")), "clearText", || {
                IpcValue::Bool(true)
            })
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        s.core.mark_meta_dirty();
        let update = app.build_slide_update(s, &before, &[]);
        Ok(Obj::from_value(update)
            .set("index", num(number(source) + 1.0))
            .build())
    })
}

pub fn add_blank_slide(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let source = prop(op_value, "sourceIndex")?;
        let mut ops = vec![
            op("addBlankSlide")
                .set("target", target(source, None))
                .build(),
        ];
        // ops are validated against the pre-transaction deck, so move the existing
        // source slide down past the new one rather than targeting the new index
        let before_flag = truthy(field(op_value, "before"));
        if before_flag {
            ops.push(
                op("moveSlide")
                    .set("target", target(source, None))
                    .set("to", num(number(source) + 1.0))
                    .build(),
            );
        }
        if app
            .session_txn(s, TxnRequest::atomic(ops), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        // the blank slide is parsed fresh, so neither structureDirty nor an
        // element dirty flag is set and the insert would otherwise be unsaveable
        s.core.mark_meta_dirty();
        let update = app.build_slide_update(s, &before, &[]);
        let index = if before_flag {
            number(source)
        } else {
            number(source) + 1.0
        };
        Ok(Obj::from_value(update).set("index", num(index)).build())
    })
}

pub fn delete_slide(app: &App, cx: &CallContext, args: Args) -> Reply {
    let index = args.get(0).clone();
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let o = op("deleteSlide")
            .set("target", target(&index, None))
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.core.mark_meta_dirty();
        Ok(app.build_slide_update(s, &before, &[]))
    })
}

fn numbers(value: &IpcValue) -> Vec<f64> {
    match value {
        IpcValue::Array(items) => items.iter().map(number).collect(),
        _ => Vec::new(),
    }
}

/// `[...new Set(xs)].sort((a, b) => b - a)`
fn unique_desc(xs: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for x in xs {
        if !out.iter().any(|y| y == x || (x.is_nan() && y.is_nan())) {
            out.push(*x);
        }
    }
    out.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    out
}

pub fn delete_slides(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let indexes = unique_desc(&numbers(prop(op_value, "slideIndexes")?));
        if indexes.is_empty() || indexes.len() >= before.len() {
            return null();
        }
        let ops = indexes
            .iter()
            .map(|i| {
                op("deleteSlide")
                    .set("target", target(&num(*i), None))
                    .build()
            })
            .collect();
        if app
            .session_txn(s, TxnRequest::atomic(ops), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.core.mark_meta_dirty();
        Ok(app.build_slide_update(s, &before, &[]))
    })
}

/// `planSlideDuplicates(selected)`: the last slide is duplicated first so no
/// step targets an index that does not exist in the pre-transaction deck
fn plan_slide_duplicates(selected: &[f64]) -> Vec<IpcValue> {
    let mut block = unique_desc(selected);
    block.reverse();
    let Some(last) = block.last().copied() else {
        return Vec::new();
    };
    let dup = |i: f64| {
        op("duplicateSlide")
            .set("target", target(&num(i), None))
            .build()
    };
    let mut steps = vec![dup(last)];
    for (j, i) in block[..block.len() - 1].iter().enumerate() {
        steps.push(dup(*i));
        steps.push(
            op("moveSlide")
                .set("target", target(&num(*i + 1.0), None))
                .set("to", num(last + 1.0 + j as f64))
                .build(),
        );
    }
    steps
}

pub fn duplicate_slides(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let indexes = numbers(prop(op_value, "slideIndexes")?);
        let steps = plan_slide_duplicates(&indexes);
        if steps.is_empty() {
            return null();
        }
        let before = before_paths(app, s);
        if app
            .session_txn(s, TxnRequest::atomic(steps), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        // a single duplicate is parsed fresh too and would otherwise leave the
        // deck changed but reported clean
        s.core.mark_meta_dirty();
        let update = app.build_slide_update(s, &before, &[]);
        let max = indexes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        Ok(Obj::from_value(update).set("index", num(max + 1.0)).build())
    })
}

pub fn set_slides_hidden(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let indexes = match prop(op_value, "slideIndexes")? {
            IpcValue::Array(items) => items.clone(),
            _ => Vec::new(),
        };
        if indexes.is_empty() {
            return null();
        }
        let before = before_paths(app, s);
        let ops = indexes
            .iter()
            .map(|i| {
                op("setHidden")
                    .set("target", target(i, None))
                    .set("hidden", p(op_value, "hidden"))
                    .build()
            })
            .collect();
        if app
            .session_txn(s, TxnRequest::atomic(ops), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        Ok(app.build_slide_update(s, &before, &numbers(&IpcValue::Array(indexes))))
    })
}

pub fn set_hidden(app: &App, cx: &CallContext, args: Args) -> Reply {
    rebuild_shim(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(vec![
            op("setHidden")
                .set("target", target(slide, None))
                .set("hidden", p(o, "hidden"))
                .build(),
        ])
    })
}

pub fn set_slide_size(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let o = op("setSlideSize")
            .set("cx", prop(op_value, "cx")?.clone())
            .set("cy", p(op_value, "cy"))
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.core.mark_meta_dirty();
        Ok(app.render_all(s))
    })
}

pub fn get_slide_size(app: &App, cx: &CallContext, _args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        Ok(app.size_value(app.engine.size(s.deck())))
    })
}

pub fn find_replace(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let o = op("findReplace")
            .set("find", prop(op_value, "find")?.clone())
            .set("replace", p(op_value, "replace"))
            .set("matchCase", p(op_value, "matchCase"))
            .set("firstOnly", p(op_value, "firstOnly"))
            .set("slideIndex", p(op_value, "slideIndex"))
            .set("elementId", p(op_value, "elementId"))
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return Ok(obj([("count", num(0.0)), ("update", IpcValue::Null)]));
        };
        let after = r
            .records
            .as_ref()
            .and_then(|r| r.first())
            .map_or(IpcValue::Undefined, |r| r.after.clone());
        let changed = numbers(field(&after, "changedSlides"));
        let update = app.build_slide_update(s, &before, &changed);
        Ok(obj([("count", p(&after, "count")), ("update", update)]))
    })
}

pub fn apply_header_footer(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let nullish_to_null = |v: &IpcValue| {
            if is_nullish(v) {
                IpcValue::Null
            } else {
                v.clone()
            }
        };
        let settings = Obj::new()
            .set("footer", nullish_to_null(prop(op_value, "footer")?))
            .set(
                "slideNum",
                IpcValue::Bool(truthy(field(op_value, "slideNum"))),
            )
            .set("date", nullish_to_null(field(op_value, "date")))
            .set_if(truthy(field(op_value, "dateAuto")), "dateAuto", || {
                IpcValue::Bool(true)
            })
            .build();
        let o = op("applyHeaderFooter").set("settings", settings).build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        Ok(app.render_all(s))
    })
}

pub fn set_transition(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session_or(cx.sender.view, IpcValue::Bool(false), |app, s| {
        let len = app.engine.slide_paths(s.deck()).len();
        let slide = prop(op_value, "slideIndex")?;
        let indexes: Vec<f64> = if as_num(slide) == Some(-1.0) {
            (0..len).map(|i| i as f64).collect()
        } else if slide_index(slide, len).is_some() {
            vec![number(slide)]
        } else {
            Vec::new()
        };
        if indexes.is_empty() {
            return Ok(IpcValue::Bool(false));
        }
        let ops = indexes
            .iter()
            .map(|i| {
                op("setTransition")
                    .set("target", target(&num(*i), None))
                    .set("kind", p(op_value, "kind"))
                    .build()
            })
            .collect();
        Ok(IpcValue::Bool(
            app.session_txn(s, TxnRequest::atomic(ops), OpSource::Edit)
                .is_some(),
        ))
    })
}

pub fn set_advance_times(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session_or(cx.sender.view, IpcValue::Bool(false), |app, s| {
        let len = app.engine.slide_paths(s.deck()).len();
        let times = match prop(op_value, "times")? {
            IpcValue::Array(items) => items.clone(),
            _ => Vec::new(),
        };
        let targets: Vec<&IpcValue> = times
            .iter()
            .filter(|t| slide_index(field(t, "slideIndex"), len).is_some())
            .collect();
        if targets.is_empty() {
            return Ok(IpcValue::Bool(false));
        }
        let ops = targets
            .iter()
            .map(|t| {
                op("setAdvanceTime")
                    .set("target", target(field(t, "slideIndex"), None))
                    .set("ms", p(t, "ms"))
                    .build()
            })
            .collect();
        Ok(IpcValue::Bool(
            app.session_txn(s, TxnRequest::atomic(ops), OpSource::Edit)
                .is_some(),
        ))
    })
}

pub fn set_animations(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session_or(cx.sender.view, IpcValue::Bool(false), |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = op("setAnimations")
            .set("target", target(slide, None))
            .set("items", p(op_value, "items"))
            .build();
        Ok(IpcValue::Bool(
            app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
                .is_some(),
        ))
    })
}

pub fn set_notes(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session_or(cx.sender.view, IpcValue::Bool(false), |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = op("setNotes")
            .set("target", target(slide, None))
            .set("text", p(op_value, "text"))
            .build();
        let r = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit);
        if r.is_some() {
            s.core.mark_meta_dirty();
        }
        Ok(IpcValue::Bool(r.is_some()))
    })
}

// ---- sections ----

pub fn get_sections(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let state = app.state.borrow();
    Ok(match state.session(cx.sender.view) {
        Some(s) => app.engine.sections(s.deck()),
        None => IpcValue::Array(Vec::new()),
    })
}

/// `sectionShim(e, op)`: single op, metaDirty, the op's `after` echoed back
fn section_shim(app: &App, s: &mut SlideSession, o: IpcValue) -> Option<IpcValue> {
    let r = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)?;
    s.core.mark_meta_dirty();
    Some(
        r.records
            .and_then(|r| r.into_iter().next())
            .map_or(IpcValue::Undefined, |rec| rec.after),
    )
}

pub fn set_sections(app: &App, cx: &CallContext, args: Args) -> Reply {
    let sections = args.get(0).clone();
    app.with_session(cx.sender.view, |app, s| {
        let o = op("setSections").set("sections", sections).build();
        // a falsy `after` (the op answers nothing) is a failure to the TypeScript
        match section_shim(app, s, o).filter(truthy) {
            Some(_) => Ok(app.engine.sections(s.deck())),
            None => null(),
        }
    })
}

fn section_echo(app: &App, cx: &CallContext, o: IpcValue) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        Ok(section_shim(app, s, o)
            .filter(|v| !matches!(v, IpcValue::Undefined))
            .unwrap_or(IpcValue::Null))
    })
}

pub fn add_section(app: &App, cx: &CallContext, args: Args) -> Reply {
    let o = args.get(0);
    // the TypeScript reads the op's fields before the session lookup
    let atom = prop(o, "atSlideIndex")?.clone();
    section_echo(
        app,
        cx,
        op("addSection")
            .set("atSlideIndex", atom)
            .set("name", p(o, "name"))
            .build(),
    )
}

pub fn rename_section(app: &App, cx: &CallContext, args: Args) -> Reply {
    let o = args.get(0);
    let id = prop(o, "id")?.clone();
    section_echo(
        app,
        cx,
        op("renameSection")
            .set("id", id)
            .set("name", p(o, "name"))
            .build(),
    )
}

pub fn remove_section(app: &App, cx: &CallContext, args: Args) -> Reply {
    let o = args.get(0);
    let id = prop(o, "id")?.clone();
    section_echo(app, cx, op("removeSection").set("id", id).build())
}

pub fn move_slide(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let o = op("moveSlide")
            .set("target", target(prop(op_value, "fromIndex")?, None))
            .set("to", p(op_value, "toIndex"))
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        s.core.mark_meta_dirty();
        let update = app.build_slide_update(s, &before, &[]);
        Ok(Obj::from_value(update)
            .set("sections", app.engine.sections(s.deck()))
            .build())
    })
}

pub fn move_section(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = before_paths(app, s);
        let o = op("moveSection")
            .set("id", prop(op_value, "id")?.clone())
            .set("dir", p(op_value, "dir"))
            .build();
        let Some(sections) = section_shim(app, s, o).filter(truthy) else {
            return null();
        };
        let update = app.build_slide_update(s, &before, &[]);
        Ok(Obj::from_value(update).set("sections", sections).build())
    })
}
