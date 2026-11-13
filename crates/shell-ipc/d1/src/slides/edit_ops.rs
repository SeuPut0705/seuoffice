//! Edit channels that go beyond a plain shim: text edits with autofit
//! write-back, gesture-undo transforms, the AI batch surface (`apply-txn`,
//! `apply-edit-script`), themes, layouts, charts, media reads.

use jscompat::JsonValue;
use main_core::packages::i18n::product_name;
use main_core::slides::session_state::OpSource;
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue};

use super::engine::{Isolation, TxnRequest, TxnResult};
use super::session::{
    EMU_PER_PX_96, Obj, js_round, js_string, null, number, op, prop, slide_index, target,
};
use super::state::{App, SlideSession};
use super::{Route, now};
use crate::value::{Args, as_num, as_str, field, num, obj, or_null, string, truthy};

type Reply = Result<IpcValue, IpcError>;

fn p(value: &IpcValue, key: &str) -> IpcValue {
    field(value, key).clone()
}

fn with_group(o: Obj, op_value: &IpcValue) -> Obj {
    o.set_if(truthy(field(op_value, "groupId")), "group", || {
        p(op_value, "groupId")
    })
}

pub fn routes(app: &App) -> Vec<Route> {
    vec![
        now(app, "slides:edit-text", edit_text),
        now(app, "slides:set-element-font", set_element_font),
        now(
            app,
            "slides:set-element-paragraph-format",
            set_element_paragraph_format,
        ),
        now(app, "slides:set-text-body-props", set_text_body_props),
        now(app, "slides:edit-transform", edit_transform),
        now(
            app,
            "slides:cancel-transform-preview",
            cancel_transform_preview,
        ),
        now(app, "slides:edit-transform-multi", edit_transform_multi),
        now(app, "slides:set-shape-adjust", set_shape_adjust),
        now(app, "slides:set-shape-geometry", set_shape_geometry),
        now(app, "slides:apply-txn", apply_txn),
        now(app, "slides:apply-edit-script", apply_edit_script),
        now(app, "slides:apply-theme", apply_theme),
        now(app, "slides:media-data", media_data),
        now(app, "slides:model3d-data", model3d_data),
        now(app, "slides:get-layouts", get_layouts),
        now(app, "slides:add-slide-with-layout", add_slide_with_layout),
        now(app, "slides:set-slide-layout", set_slide_layout),
        now(app, "slides:edit-table-style", edit_table_style),
        now(app, "slides:edit-chart", edit_chart),
        now(app, "slides:chart-color-schemes", chart_color_schemes),
        now(app, "slides:get-chart-data", get_chart_data),
    ]
}

/// `applyAutofitResize` then `syncAutofitScale` of one element
fn autofit_both(
    app: &App,
    s: &SlideSession,
    slide: &IpcValue,
    id: &IpcValue,
    rendered: Option<IpcValue>,
) -> Option<IpcValue> {
    let len = app.engine.slide_paths(s.deck()).len();
    let (Some(index), Some(id)) = (slide_index(slide, len), as_str(id)) else {
        return rendered;
    };
    let resized = app
        .engine
        .autofit_resize(s.deck(), index, id, rendered, s.fit_width_px);
    app.engine
        .sync_autofit_scale(s.deck(), index, id, resized, s.fit_width_px)
}

fn level_dirty(result: &TxnResult) -> bool {
    result
        .records
        .as_ref()
        .and_then(|r| r.first())
        .is_some_and(|rec| truthy(field(&rec.after, "levelDirty")))
}

fn ids_of(value: &IpcValue) -> Vec<IpcValue> {
    match value {
        IpcValue::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

pub fn edit_text(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = with_group(
            op("setText")
                .set("target", target(slide, Some(field(op_value, "sourceId"))))
                .set("paragraphs", p(op_value, "paragraphs")),
            op_value,
        )
        .build();
        let Some(r) = app.push_and_journal(s, OpSource::Edit, &TxnRequest::atomic(vec![o])) else {
            return null();
        };
        let rebuilt = app.rebuild_slide(s, slide);
        if truthy(field(op_value, "groupId")) || level_dirty(&r) {
            return Ok(or_null(rebuilt));
        }
        Ok(or_null(autofit_both(
            app,
            s,
            slide,
            field(op_value, "sourceId"),
            rebuilt,
        )))
    })
}

pub fn set_element_font(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let mut font = Obj::new();
        for key in [
            "fontFamily",
            "fontSizePt",
            "fontSizeStep",
            "strike",
            "bold",
            "italic",
            "underline",
            "color",
            "highlight",
            "letterSpacingPt",
        ] {
            font = font.set(key, p(op_value, key));
        }
        let font = font.build();
        let slide = prop(op_value, "slideIndex")?;
        let ids = ids_of(prop(op_value, "sourceIds")?);
        let ops = ids
            .iter()
            .map(|id| {
                with_group(
                    op("setFont")
                        .set("target", target(slide, Some(id)))
                        .set("font", font.clone()),
                    op_value,
                )
                .build()
            })
            .collect();
        // all non-text elements: nothing happened, the pushed history is popped
        if app
            .push_and_journal(s, OpSource::Edit, &TxnRequest::per_op(ops))
            .is_none()
        {
            return null();
        }
        let mut rendered = app.rebuild_slide(s, slide);
        for id in &ids {
            rendered = autofit_both(app, s, slide, id, rendered);
        }
        Ok(or_null(rendered))
    })
}

pub fn set_element_paragraph_format(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let mut format = Obj::new();
        for key in [
            "bullet",
            "bulletChar",
            "bulletFont",
            "numType",
            "startAt",
            "bulletImage",
            "bulletHangEmu",
            "bulletSizePct",
            "bulletColor",
            "lineSpacingPct",
            "spaceBeforePt",
            "spaceAfterPt",
            "align",
            "rtl",
            "indentDelta",
        ] {
            format = format.set(key, p(op_value, key));
        }
        let format = format.build();
        let slide = prop(op_value, "slideIndex")?;
        let ids = ids_of(prop(op_value, "sourceIds")?);
        let ops = ids
            .iter()
            .map(|id| {
                with_group(
                    op("setParagraphFormat")
                        .set("target", target(slide, Some(id)))
                        .set("format", format.clone()),
                    op_value,
                )
                .build()
            })
            .collect();
        if app
            .push_and_journal(s, OpSource::Edit, &TxnRequest::per_op(ops))
            .is_none()
        {
            return null();
        }
        if truthy(field(op_value, "indentDelta")) {
            // level changes affect inherited defaults; bake into bytes then reparse
            let len = app.engine.slide_paths(s.deck()).len();
            if let Some(index) = slide_index(slide, len) {
                app.engine.materialize_slide(s.deck(), index);
            }
            return Ok(or_null(app.rebuild_slide(s, slide)));
        }
        let mut rendered = app.rebuild_slide(s, slide);
        for id in &ids {
            rendered = autofit_both(app, s, slide, id, rendered);
        }
        Ok(or_null(rendered))
    })
}

pub fn set_text_body_props(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let o = op("setTextBodyProps")
            .set("target", target(slide, Some(field(op_value, "sourceId"))))
            .set("props", p(op_value, "props"))
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        // autofit must take effect immediately on toggle
        let rebuilt = app.rebuild_slide(s, slide);
        Ok(or_null(autofit_both(
            app,
            s,
            slide,
            field(op_value, "sourceId"),
            rebuilt,
        )))
    })
}

// ---- transforms ----

/// `transformPayload(session, slideIndex, fitWidthPx, item)`: px to EMU
/// (inverting the viewport scale) for one setTransform
fn transform_payload(
    app: &App,
    s: &SlideSession,
    slide: &IpcValue,
    fit: &IpcValue,
    item: &IpcValue,
) -> Option<IpcValue> {
    let len = app.engine.slide_paths(s.deck()).len();
    let index = slide_index(slide, len)?;
    let group_id = field(item, "groupId");
    let frame = if truthy(group_id) {
        Some(app.engine.group_child_frame(
            s.deck(),
            index,
            as_str(group_id).unwrap_or(""),
            as_str(field(item, "sourceId")).unwrap_or(""),
        )?)
    } else {
        None
    };
    let size = app.engine.size(s.deck());
    let scale = number(fit) / (size.cx / EMU_PER_PX_96);
    let to_emu = |px: f64| js_round((px / scale) * EMU_PER_PX_96);
    let (x, y, w, h) = (
        number(field(item, "xPx")),
        number(field(item, "yPx")),
        number(field(item, "wPx")),
        number(field(item, "hPx")),
    );
    let boxed = match &frame {
        Some(frame) => {
            let ch = frame.child_offset;
            let ch_x = ch.map_or(frame.group_offset[0], |c| c[0]);
            let ch_y = ch.map_or(frame.group_offset[1], |c| c[1]);
            let g = frame.group_offset;
            let gsx = match ch {
                Some(c) if c[2] != 0.0 => g[2] / c[2],
                _ => 1.0,
            };
            let gsy = match ch {
                Some(c) if c[3] != 0.0 => g[3] / c[3],
                _ => 1.0,
            };
            obj([
                ("x", num(to_emu(x / gsx) + ch_x)),
                ("y", num(to_emu(y / gsy) + ch_y)),
                ("cx", num(to_emu(w / gsx))),
                ("cy", num(to_emu(h / gsy))),
            ])
        }
        None => obj([
            ("x", num(to_emu(x))),
            ("y", num(to_emu(y))),
            ("cx", num(to_emu(w))),
            ("cy", num(to_emu(h))),
        ]),
    };
    let o = op("setTransform")
        .set("target", target(slide, Some(field(item, "sourceId"))))
        .set("box", boxed)
        .set("rotDeg", p(item, "rotationDeg"));
    // tables redistribute gridCol widths / tr heights so the file matches the frame
    Some(
        if truthy(group_id) {
            o.set("group", group_id.clone())
        } else {
            o.set("resizeTableGrid", IpcValue::Bool(true))
        }
        .build(),
    )
}

fn dry_fails(app: &App, s: &SlideSession, payload: &IpcValue) -> bool {
    app.engine
        .run_txn(s.deck(), &TxnRequest::atomic(vec![payload.clone()]).dry())
        .failure_count()
        > 0
}

pub fn edit_transform(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let Some(payload) =
            transform_payload(app, s, slide, field(op_value, "fitWidthPx"), op_value)
        else {
            return null();
        };
        // validate BEFORE the preview bookkeeping
        if dry_fails(app, s, &payload) {
            return null();
        }
        let preview = truthy(field(op_value, "preview"));
        // one whole drag = one undo step
        let mut pushed = false;
        if preview {
            if !s.transform_preview {
                s.preview_redo = Some(s.core.redo_stack.clone());
                s.core.push_history();
                pushed = true;
                s.transform_preview = true;
            }
        } else if s.transform_preview {
            s.transform_preview = false;
            s.preview_redo = None;
        } else {
            s.core.push_history();
            pushed = true;
        }
        let request = TxnRequest::atomic(vec![payload]);
        // journal only the settled commit
        let applied = if preview {
            app.engine.run_txn(s.deck(), &request).applied
        } else {
            app.journaled_txn(s, OpSource::Edit, &request).applied
        };
        if !applied {
            if pushed {
                s.core.undo_stack.pop();
                if preview {
                    s.transform_preview = false;
                    if let Some(redo) = s.preview_redo.take() {
                        s.core.redo_stack = redo;
                    }
                }
            }
            return null();
        }
        Ok(or_null(app.rebuild_slide(s, slide)))
    })
}

pub fn cancel_transform_preview(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        if !s.transform_preview {
            return null();
        }
        s.transform_preview = false;
        if let Some(snapshot) = s.core.undo_stack.pop() {
            s.core.restore_snapshot(&snapshot);
        }
        if let Some(redo) = s.preview_redo.take() {
            s.core.redo_stack = redo;
        }
        s.core.schedule_history_notify();
        s.core.schedule_deck_broadcast();
        Ok(or_null(app.rebuild_slide(s, prop(op_value, "slideIndex")?)))
    })
}

pub fn edit_transform_multi(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let mut ops = Vec::new();
        for item in ids_of(prop(op_value, "items")?) {
            match transform_payload(app, s, slide, field(op_value, "fitWidthPx"), &item) {
                Some(payload) => ops.push(payload),
                None => return null(),
            }
        }
        if ops.is_empty() {
            return null();
        }
        Ok(
            match app.session_txn(s, TxnRequest::atomic(ops), OpSource::Edit) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    })
}

/// The gesture-undo contract shared by set-shape-adjust and set-shape-geometry
fn gesture_edit(
    app: &App,
    cx: &CallContext,
    args: &Args,
    build: impl FnOnce(&App, &SlideSession, &IpcValue) -> Result<IpcValue, IpcError>,
) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let payload = build(app, s, op_value)?;
        let slide = prop(op_value, "slideIndex")?;
        if dry_fails(app, s, &payload) {
            return null();
        }
        let preview = truthy(field(op_value, "preview"));
        let mut pushed = false;
        if preview {
            if !s.transform_preview {
                s.core.push_history();
                s.transform_preview = true;
                pushed = true;
            }
        } else if s.transform_preview {
            s.transform_preview = false;
        } else {
            s.core.push_history();
            pushed = true;
        }
        let r = app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(vec![payload]));
        if !r.applied {
            if pushed {
                s.core.undo_stack.pop();
                if preview {
                    s.transform_preview = false;
                }
            }
            return null();
        }
        Ok(or_null(app.rebuild_slide(s, slide)))
    })
}

pub fn set_shape_adjust(app: &App, cx: &CallContext, args: Args) -> Reply {
    gesture_edit(app, cx, &args, |_, _, o| {
        let slide = prop(o, "slideIndex")?;
        Ok(with_group(
            op("setShapeAdjust")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set("adjust", p(o, "adjust")),
            o,
        )
        .build())
    })
}

pub fn set_shape_geometry(app: &App, cx: &CallContext, args: Args) -> Reply {
    gesture_edit(app, cx, &args, |app, s, o| {
        let size = app.engine.size(s.deck());
        let scale = number(prop(o, "fitWidthPx")?) / (size.cx / EMU_PER_PX_96);
        let to_emu = |v: &IpcValue| num(js_round((number(v) / scale) * EMU_PER_PX_96));
        let slide = prop(o, "slideIndex")?;
        let path_px = prop(o, "pathPx")?;
        let cmds = ids_of(field(path_px, "cmds"))
            .iter()
            .map(|c| {
                obj([
                    ("op", p(c, "op")),
                    (
                        "pts",
                        IpcValue::Array(ids_of(field(c, "pts")).iter().map(to_emu).collect()),
                    ),
                ])
            })
            .collect();
        Ok(with_group(
            op("setShapeCustomGeometry")
                .set("target", target(slide, Some(field(o, "sourceId"))))
                .set(
                    "path",
                    obj([
                        ("w", to_emu(field(path_px, "w"))),
                        ("h", to_emu(field(path_px, "h"))),
                        ("cmds", IpcValue::Array(cmds)),
                    ]),
                ),
            o,
        )
        .build())
    })
}

// ---- the AI batch surface ----

fn compact(failures: &Option<Vec<super::engine::TxnFailure>>) -> IpcValue {
    match failures {
        Some(items) => IpcValue::Array(
            items
                .iter()
                .map(|f| {
                    obj([
                        ("index", num(f.index as f64)),
                        ("error", string(f.error.as_str())),
                    ])
                })
                .collect(),
        ),
        None => IpcValue::Undefined,
    }
}

pub fn apply_txn(app: &App, cx: &CallContext, args: Args) -> Reply {
    let req = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let ops = match field(req, "ops") {
            IpcValue::Array(ops) => ops.clone(),
            _ => Vec::new(),
        };
        if ops.is_empty() || ops.len() > 50 {
            return Ok(obj([
                ("applied", IpcValue::Bool(false)),
                (
                    "failures",
                    IpcValue::Array(vec![obj([
                        ("index", num(0.0)),
                        (
                            "error",
                            string("ops must be a non-empty array (at most 50 per transaction)."),
                        ),
                    ])]),
                ),
            ]));
        }
        let isolation = if as_str(field(req, "isolation")) == Some("per_op") {
            Isolation::PerOp
        } else {
            Isolation::Atomic
        };
        let request = TxnRequest {
            ops: ops.clone(),
            isolation,
            dry_run: false,
            parts: Vec::new(),
        };
        if truthy(field(req, "dryRun")) {
            let r = app.engine.run_txn(s.deck(), &request.dry());
            let mut o = Obj::new()
                .set("applied", IpcValue::Bool(false))
                .set("dryRun", IpcValue::Bool(true))
                .set(
                    "plan",
                    r.plan.clone().unwrap_or(IpcValue::Array(Vec::new())),
                );
            if r.failure_count() > 0 {
                o = o.set("failures", compact(&r.failures));
            }
            return Ok(o.build());
        }
        // plan before pushing history (a no-op request must not clear the redo stack)
        let plan = app.engine.run_txn(s.deck(), &request.dry());
        let invalid = plan.failure_count();
        let refused = match isolation {
            Isolation::Atomic => invalid > 0,
            Isolation::PerOp => invalid >= ops.len(),
        };
        if refused {
            return Ok(obj([
                ("applied", IpcValue::Bool(false)),
                ("failures", compact(&plan.failures)),
            ]));
        }
        s.core.push_history();
        let r = app.journaled_txn(s, OpSource::Batch, &request);
        if !r.applied {
            s.core.undo_stack.pop();
            return Ok(obj([
                ("applied", IpcValue::Bool(false)),
                ("failures", compact(&r.failures)),
            ]));
        }
        // some ops change only package state: without this the session would still look clean
        s.core.mark_meta_dirty();
        // post-pass mirroring the dedicated shims: slides are re-found by the
        // executor-stamped durable id
        let mut rendered: Vec<(usize, Option<IpcValue>)> = Vec::new();
        for rec in r.records.iter().flatten() {
            let Some(index) = rec
                .slide_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .and_then(|id| app.engine.slide_index_of_id(s.deck(), id))
            else {
                continue;
            };
            let name = as_str(field(&rec.op, "op")).unwrap_or("");
            if name == "setTableStyle" || name == "setChart" {
                app.rebuild_slide_with_reparse(s, &num(index as f64));
                rendered.retain(|(i, _)| *i != index);
                continue;
            }
            let el = field(field(&rec.op, "target"), "el");
            if !truthy(el) || truthy(field(&rec.op, "group")) {
                continue;
            }
            if !matches!(name, "setText" | "setFont" | "setParagraphFormat") {
                continue;
            }
            if name == "setText" && truthy(field(&rec.after, "levelDirty")) {
                continue;
            }
            if name == "setParagraphFormat"
                && truthy(field(field(&rec.op, "format"), "indentDelta"))
            {
                app.engine.materialize_slide(s.deck(), index);
                rendered.retain(|(i, _)| *i != index);
                continue;
            }
            let cached = rendered.iter().position(|(i, _)| *i == index);
            let slide_value = num(index as f64);
            let current = match cached {
                Some(at) => rendered[at].1.clone(),
                None => app.rebuild_slide(s, &slide_value),
            };
            let next = autofit_both(app, s, &slide_value, el, current);
            match cached {
                Some(at) => rendered[at].1 = next,
                None => rendered.push((index, next)),
            }
        }
        let mut o = Obj::new().set("applied", IpcValue::Bool(true)).set(
            "records",
            IpcValue::Array(
                r.records
                    .iter()
                    .flatten()
                    .map(|rec| {
                        let t = field(&rec.op, "target");
                        let mut record = Obj::new().set("op", p(&rec.op, "op"));
                        if truthy(t) {
                            let el = field(t, "el");
                            let text = format!(
                                "{}{}",
                                js_string(field(t, "slide")),
                                if truthy(el) {
                                    format!("/{}", js_string(el))
                                } else {
                                    String::new()
                                }
                            );
                            record = record.set("target", string(text));
                        }
                        if let Some(created) = &rec.created {
                            record =
                                record.set("created", super::session::array_of_strings(created));
                        }
                        record.build()
                    })
                    .collect(),
            ),
        );
        if r.failure_count() > 0 {
            o = o.set("failures", compact(&r.failures));
        }
        Ok(o.set("slides", app.render_all(s)).build())
    })
}

pub fn apply_edit_script(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let ops = app.engine.map_script_ops(s.deck(), op_value);
        if ops.is_empty() {
            return null();
        }
        let first_error = |r: &TxnResult| {
            r.failures
                .as_ref()
                .and_then(|f| f.first())
                .map(|f| f.error.clone())
        };
        let plan = app
            .engine
            .run_txn(s.deck(), &TxnRequest::atomic(ops.clone()).dry());
        if plan.failure_count() > 0 {
            return Ok(obj([(
                "error",
                string(first_error(&plan).unwrap_or_default()),
            )]));
        }
        s.core.push_history();
        let r = app.journaled_txn(s, OpSource::Script, &TxnRequest::atomic(ops));
        if !r.applied {
            s.core.undo_stack.pop();
            return Ok(obj([(
                "error",
                string(
                    first_error(&r)
                        .unwrap_or_else(|| "the transaction could not be applied".into()),
                ),
            )]));
        }
        let slide = field(op_value, "slideIndex");
        let mut rendered = app.rebuild_slide(s, slide);
        for rec in r.records.iter().flatten() {
            let o = &rec.op;
            let el = field(field(o, "target"), "el");
            if !truthy(el) || truthy(field(o, "group")) || rendered.is_none() {
                continue;
            }
            match as_str(field(o, "op")) {
                Some("setText") => {
                    // level changes rematerialized inside the op; autofit would fight the reparse
                    if truthy(field(&rec.after, "levelDirty")) {
                        continue;
                    }
                    rendered = autofit_both(app, s, slide, el, rendered);
                }
                Some("setFont" | "setParagraphFormat") => {
                    rendered = autofit_both(app, s, slide, el, rendered);
                }
                _ => {}
            }
        }
        Ok(match rendered {
            Some(slide) => obj([("slide", slide)]),
            None => IpcValue::Null,
        })
    })
}

pub fn apply_theme(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let payload = op("applyTheme")
            .set("name", prop(op_value, "name")?.clone())
            .set("colors", p(op_value, "colors"))
            .set_if(truthy(field(op_value, "majorFont")), "majorFont", || {
                p(op_value, "majorFont")
            })
            .set_if(truthy(field(op_value, "minorFont")), "minorFont", || {
                p(op_value, "minorFont")
            })
            .build();
        let first_error = |r: &TxnResult| {
            r.failures
                .as_ref()
                .and_then(|f| f.first())
                .map(|f| f.error.clone())
        };
        // plan first so an invalid request doesn't clear the redo stack
        let plan = app
            .engine
            .run_txn(s.deck(), &TxnRequest::atomic(vec![payload.clone()]).dry());
        if plan.failure_count() > 0 {
            return Ok(obj([(
                "error",
                string(first_error(&plan).unwrap_or_default()),
            )]));
        }
        s.core.push_history();
        let r = app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(vec![payload]));
        if !r.applied {
            s.core.undo_stack.pop();
            return Ok(obj([(
                "error",
                string(first_error(&r).unwrap_or_else(|| "applyTheme failed".into())),
            )]));
        }
        let after = r
            .records
            .as_ref()
            .and_then(|r| r.first())
            .map_or(IpcValue::Undefined, |rec| rec.after.clone());
        if as_num(field(&after, "patched")) == Some(0.0)
            && as_num(field(&after, "remapped")) == Some(0.0)
        {
            // nothing matched the spec; the op only baked pending edits: not an undo step
            s.core.undo_stack.pop();
            return null();
        }
        // reparse so every element's resolved colors/fonts refresh
        app.engine.reparse_deck(s.deck());
        // the session-level flag preserves the "unsaved" state (reset on save)
        s.core.mark_meta_dirty();
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        Ok(app.render_all(s))
    })
}

// ---- media reads ----

fn av_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        _ => return None,
    })
}

/// The largest model or recording read whole (`ATTACHABLE_MAX_BYTES`)
const MEDIA_MAX_BYTES: usize = 50 * 1024 * 1024;

impl App {
    /// `refuseOversizedMedia(limit)`: tells the user, answers null
    pub fn refuse_oversized_media(&self, limit_bytes: usize) {
        let detail = self.tm(
            "errTooLarge",
            &[(
                "mb",
                JsonValue::Number(limit_bytes as f64 / 1024.0 / 1024.0),
            )],
        );
        self.show_presentation_error(detail);
    }

    /// `showPresentationError(detail)`: a message box not awaited
    pub fn show_presentation_error(&self, detail: String) {
        let parent = self.shell.dialog_parent();
        let dialogs = self.dialogs.clone();
        let message = MessageBox {
            kind: Some("error".into()),
            title: None,
            message: product_name(Some(self.lang().as_str())).to_owned(),
            detail: Some(detail),
            buttons: Vec::new(),
            default_id: None,
            cancel_id: None,
            checkbox_label: None,
        };
        self.services.workers.spawn(Box::new(move || {
            dialogs.message(parent, &message);
        }));
    }
}

pub fn media_data(app: &App, cx: &CallContext, args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        let len = app.engine.slide_paths(s.deck()).len();
        let Some(index) = slide_index(args.get(0), len) else {
            return null();
        };
        let Some(media) =
            app.engine
                .picture_media(s.deck(), index, as_str(args.get(1)).unwrap_or(""))
        else {
            return null();
        };
        if media.external {
            return Ok(obj([
                ("kind", string(media.kind)),
                ("dataUrl", string(media.target)),
            ]));
        }
        let Some(bytes) = app.engine.read_part(s.deck(), &media.target) else {
            return null();
        };
        let ext = media.target.rsplit('.').next().unwrap_or("").to_lowercase();
        let mime = av_mime(&ext).unwrap_or(if media.kind == "video" {
            "video/mp4"
        } else {
            "audio/mpeg"
        });
        Ok(obj([
            ("kind", string(media.kind)),
            (
                "dataUrl",
                string(format!("data:{mime};base64,{}", jscompat::base64(&bytes))),
            ),
        ]))
    })
}

pub fn model3d_data(app: &App, cx: &CallContext, args: Args) -> Reply {
    let (bytes, oversized) = {
        let state = app.state.borrow();
        let Some(s) = state.session(cx.sender.view) else {
            return null();
        };
        let len = app.engine.slide_paths(s.deck()).len();
        let bytes = slide_index(args.get(0), len)
            .and_then(|i| {
                app.engine
                    .model3d_target(s.deck(), i, as_str(args.get(1)).unwrap_or(""))
            })
            .and_then(|target| app.engine.read_part(s.deck(), &target));
        let oversized = bytes.as_ref().is_some_and(|b| b.len() > MEDIA_MAX_BYTES);
        (bytes, oversized)
    };
    if oversized {
        app.refuse_oversized_media(MEDIA_MAX_BYTES);
        return null();
    }
    Ok(bytes.map_or(IpcValue::Null, crate::value::buffer))
}

// ---- layouts ----

/// `resolveLayoutPath(session, layoutPath)`: 'builtin:<key>' virtual paths
/// get injected into the package on first use
fn resolve_layout_path(app: &App, s: &SlideSession, layout: &IpcValue) -> Option<IpcValue> {
    match as_str(layout).and_then(|l| l.strip_prefix("builtin:")) {
        Some(key) => app.engine.ensure_builtin_layout(s.deck(), key).map(string),
        None => match layout {
            IpcValue::Undefined | IpcValue::Null => None,
            other => Some(other.clone()),
        },
    }
}

pub fn get_layouts(app: &App, cx: &CallContext, _args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        Ok(obj([
            ("layouts", app.engine.layouts(s.deck())),
            ("size", app.size_value(app.engine.size(s.deck()))),
        ]))
    })
}

pub fn add_slide_with_layout(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = app.engine.slide_paths(s.deck());
        // 'builtin:' resolution may inject a layout part: do it before the undo snapshot
        s.core.push_history();
        let layout = resolve_layout_path(app, s, prop(op_value, "layoutPath")?);
        let source = field(op_value, "sourceIndex");
        let applied = layout.is_some_and(|layout| {
            let o = op("addSlideWithLayout")
                .set("target", target(source, None))
                .set("layoutPath", layout)
                .build();
            app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(vec![o]))
                .applied
        });
        if !applied {
            s.core.undo_stack.pop();
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

pub fn set_slide_layout(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        s.core.push_history();
        let layout_value = prop(op_value, "layoutPath")?;
        let layout = resolve_layout_path(app, s, layout_value);
        let slide = field(op_value, "slideIndex");
        // a named layout that fails to resolve is an error; an absent layoutPath means reset
        let applied = if truthy(layout_value) && layout.is_none() {
            false
        } else {
            let mut o = op("setSlideLayout").set("target", target(slide, None));
            if let Some(layout) = layout.filter(truthy) {
                o = o.set("layoutPath", layout);
            }
            app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(vec![o.build()]))
                .applied
        };
        if !applied {
            s.core.undo_stack.pop();
            return null();
        }
        Ok(or_null(app.rebuild_slide(s, slide)))
    })
}

// ---- tables and charts ----

pub fn edit_table_style(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        let Some(index) = slide_index(slide, len) else {
            return null();
        };
        // a reparse regenerates element ids: look up the new id by element index
        let el_index = app.engine.element_index(
            s.deck(),
            index,
            as_str(field(op_value, "sourceId")).unwrap_or(""),
        );
        let mut o =
            op("setTableStyle").set("target", target(slide, Some(field(op_value, "sourceId"))));
        if let IpcValue::Object(entries) = op_value {
            for (key, value) in entries {
                if key != "slideIndex" && key != "sourceId" {
                    o = o.set(key, value.clone());
                }
            }
        }
        if app
            .push_and_journal(s, OpSource::Edit, &TxnRequest::atomic(vec![o.build()]))
            .is_none()
        {
            return null();
        }
        // the patch is written on the anchor; a reparse is needed before it shows in the model
        let Some(rebuilt) = app.rebuild_slide_with_reparse(s, slide) else {
            return null();
        };
        let new_id = el_index.and_then(|i| app.engine.element_id_at(s.deck(), index, i));
        Ok(obj([
            ("slide", rebuilt),
            ("sourceId", new_id.map_or(IpcValue::Null, string)),
        ]))
    })
}

/// `mixHex(hex, target, ratio)`
fn mix_hex(hex: &str, target: f64, ratio: f64) -> String {
    let digits = hex.strip_prefix('#').unwrap_or(hex);
    let Some(v) = (digits.len() == 6)
        .then(|| u32::from_str_radix(digits, 16).ok())
        .flatten()
    else {
        return hex.to_owned();
    };
    let ch = |x: u32| js_round(f64::from(x) + (target - f64::from(x)) * ratio) as u32;
    let (r, g, b) = (ch((v >> 16) & 255), ch((v >> 8) & 255), ch(v & 255));
    format!("#{:06X}", (r << 16) | (g << 8) | b)
}

const FALLBACK_ACCENTS: [&str; 6] = [
    "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47",
];

/// `chartColorSchemes(opened)`: `[{ key, label, colors }]`
fn color_schemes(app: &App, s: &SlideSession) -> Vec<(String, String, Vec<String>)> {
    let acc: Vec<String> = app
        .engine
        .theme_accents(s.deck())
        .unwrap_or_else(|| FALLBACK_ACCENTS.iter().map(|c| (*c).to_owned()).collect());
    let mut rot: Vec<String> = acc.iter().skip(3).cloned().collect();
    rot.extend(acc.iter().take(3).cloned());
    let mono = |c: &str| {
        vec![
            mix_hex(c, 0.0, 0.25),
            c.to_owned(),
            mix_hex(c, 255.0, 0.25),
            mix_hex(c, 255.0, 0.45),
            mix_hex(c, 255.0, 0.65),
        ]
    };
    let mut out = vec![
        (
            "default".to_owned(),
            app.tm("schemeThemeDefault", &[]),
            Vec::new(),
        ),
        (
            "colorful".to_owned(),
            app.tm("schemeColorful", &[]),
            acc.clone(),
        ),
        ("colorful2".to_owned(), app.tm("schemeColorful2", &[]), rot),
    ];
    for (i, c) in acc.iter().enumerate() {
        out.push((
            format!("mono-accent{}", i + 1),
            app.tm("schemeMono", &[("n", JsonValue::Number((i + 1) as f64))]),
            mono(c),
        ));
    }
    out
}

/// the legacy fixed schemes, kept as fallback
fn legacy_scheme(key: &str) -> Option<Vec<&'static str>> {
    Some(match key {
        "default" => vec![],
        "blue" => vec!["#2E75B6", "#4472C4", "#5B9BD5", "#70AD47", "#ED7D31"],
        "warm" => vec!["#ED7D31", "#FFC000", "#FF0000", "#C55A11", "#833C00"],
        "cool" => vec!["#0070C0", "#00B0F0", "#00B0A0", "#7030A0", "#2E75B6"],
        "mono" => vec!["#404040", "#666666", "#888888", "#AAAAAA", "#CCCCCC"],
        _ => return None,
    })
}

pub fn chart_color_schemes(app: &App, cx: &CallContext, _args: Args) -> Reply {
    let state = app.state.borrow();
    let Some(s) = state.session(cx.sender.view) else {
        return null();
    };
    Ok(IpcValue::Array(
        color_schemes(app, s)
            .into_iter()
            .map(|(key, label, colors)| {
                obj([
                    ("key", string(key)),
                    ("label", string(label)),
                    (
                        "colors",
                        IpcValue::Array(colors.into_iter().map(string).collect()),
                    ),
                ])
            })
            .collect(),
    ))
}

pub fn get_chart_data(app: &App, cx: &CallContext, args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        let len = app.engine.slide_paths(s.deck()).len();
        let Some(index) = slide_index(args.get(0), len) else {
            return null();
        };
        Ok(app
            .engine
            .chart_data(s.deck(), index, as_str(args.get(1)).unwrap_or("")))
    })
}

pub fn edit_chart(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    let view = cx.sender.view;
    // the confirmation needs no state: ask first when the chart comes from another app
    let (el_index, imported, ai_run) = {
        let state = app.state.borrow();
        let Some(s) = state.session(view) else {
            return null();
        };
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        let Some(index) = slide_index(slide, len) else {
            return null();
        };
        let id = as_str(field(op_value, "sourceId")).unwrap_or("");
        (
            app.engine.element_index(s.deck(), index, id),
            app.engine.is_imported_chart(s.deck(), index, id),
            s.core.ai_run,
        )
    };
    if imported {
        // confirm before the first edit of a chart from an imported file
        let options = MessageBox {
            kind: Some("warning".into()),
            title: None,
            message: app.tm("chartSimplifyTitle", &[]),
            detail: Some(app.tm("chartSimplifyBody", &[])),
            buttons: vec![app.tm("chartSimplifyOk", &[]), app.tm("btnCancel", &[])],
            default_id: Some(0),
            cancel_id: Some(1),
            checkbox_label: None,
        };
        if app.message_box(app.shell.dialog_parent(), &options) != 0 {
            return null();
        }
    }
    app.with_session(view, |app, s| {
        if s.core.ai_run != ai_run {
            return null();
        }
        let slide = field(op_value, "slideIndex");
        let kind = field(op_value, "kind");
        let bar_h = as_str(kind) == Some("barH");
        let mut patch = Obj::new();
        if truthy(kind) {
            patch = patch.set("kind", if bar_h { string("bar") } else { kind.clone() });
        }
        patch = patch.set_if(bar_h, "barDir", || string("bar"));
        for key in ["categories", "series"] {
            patch = patch.set_if(truthy(field(op_value, key)), key, || p(op_value, key));
        }
        patch = patch.set_if(
            !matches!(field(op_value, "title"), IpcValue::Undefined),
            "title",
            || p(op_value, "title"),
        );
        if let Some(scheme) = as_str(field(op_value, "colorScheme")).filter(|k| !k.is_empty()) {
            let colors = color_schemes(app, s)
                .into_iter()
                .find(|(key, _, _)| key == scheme)
                .map(|(_, _, colors)| colors)
                .or_else(|| {
                    legacy_scheme(scheme).map(|c| c.into_iter().map(str::to_owned).collect())
                });
            patch = patch.set(
                "colorScheme",
                colors.map_or(IpcValue::Undefined, |c| {
                    IpcValue::Array(c.into_iter().map(string).collect())
                }),
            );
        }
        patch = patch.set_if(truthy(field(op_value, "legendPos")), "legendPos", || {
            p(op_value, "legendPos")
        });
        for key in [
            "dataLabels",
            "gridlines",
            "catAxisTitle",
            "valAxisTitle",
            "gapWidthPct",
        ] {
            patch = patch.set_if(
                !matches!(field(op_value, key), IpcValue::Undefined),
                key,
                || p(op_value, key),
            );
        }
        patch = patch.set_if(
            truthy(field(op_value, "switchRowCol")),
            "switchRowCol",
            || IpcValue::Bool(true),
        );
        patch = patch.set_if(
            truthy(field(op_value, "pointColors")),
            "pointColors",
            || p(op_value, "pointColors"),
        );
        let o = op("setChart")
            .set("target", target(slide, Some(field(op_value, "sourceId"))))
            .set("patch", patch.build())
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return null();
        }
        // the chart part XML is updated; reparse the whole page to refresh the model
        let Some(rebuilt) = app.rebuild_slide_with_reparse(s, slide) else {
            return null();
        };
        let len = app.engine.slide_paths(s.deck()).len();
        let new_id = slide_index(slide, len)
            .zip(el_index)
            .and_then(|(i, e)| app.engine.element_id_at(s.deck(), i, e));
        Ok(obj([
            ("slide", rebuilt),
            ("sourceId", new_id.map_or(IpcValue::Null, string)),
        ]))
    })
}
