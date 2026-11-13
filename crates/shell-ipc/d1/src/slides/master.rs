//! The master edit view: parts open in the editor are edited through
//! part-addressed op transactions seeded with the live master slide the
//! engine keeps (`masterTxn`); every edit marks the deck dirty and answers
//! the master's render slide (`masterEditDone`).

use main_core::slides::session_state::OpSource;
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue};

use super::edits::fill_value;
use super::engine::TxnRequest;
use super::session::{EMU_PER_PT, EMU_PER_PX_96, Obj, js_round, null, number, op, prop};
use super::state::{App, MasterEdit, SlideSession};
use super::{Route, now};
use crate::value::{Args, as_str, field, num, obj, or_null, string, truthy};

type Reply = Result<IpcValue, IpcError>;

pub fn routes(app: &App) -> Vec<Route> {
    vec![
        now(app, "slides:master-enter", master_enter),
        now(app, "slides:master-open", master_open),
        now(app, "slides:master-close", master_close),
        now(app, "slides:master-edit-text", master_edit_text),
        now(app, "slides:master-edit-transform", master_edit_transform),
        now(app, "slides:master-edit-fill", master_edit_fill),
        now(app, "slides:master-edit-stroke", master_edit_stroke),
        now(app, "slides:master-delete-element", master_delete_element),
        now(app, "slides:master-add-element", master_add_element),
    ]
}

/// `{ part, el }`
fn part_target(part: &str, el: Option<&IpcValue>) -> IpcValue {
    match el {
        Some(el) => obj([("part", string(part)), ("el", el.clone())]),
        None => obj([("part", string(part))]),
    }
}

/// `buildMasterRenderSlide(session)`
fn master_render(app: &App, s: &SlideSession) -> Option<IpcValue> {
    let me = s.master_edit.as_ref()?;
    app.engine
        .master_render(s.deck(), &me.part_path, s.fit_width_px)
}

/// `masterEditDone(session)`
fn master_edit_done(app: &App, s: &mut SlideSession) -> IpcValue {
    s.core.mark_meta_dirty();
    or_null(master_render(app, s))
}

/// `masterTxn(session, me, op)`: seeded with the live master slide
fn master_txn(
    app: &App,
    s: &mut SlideSession,
    part: &str,
    o: IpcValue,
) -> Option<super::engine::TxnResult> {
    app.session_txn(
        s,
        TxnRequest::atomic(vec![o]).with_parts(vec![part.to_owned()]),
        OpSource::Edit,
    )
}

/// The session with its open master part, answering null without either
fn with_master(
    app: &App,
    cx: &CallContext,
    f: impl FnOnce(&App, &mut SlideSession, String) -> Reply,
) -> Reply {
    app.with_session(cx.sender.view, |app, s| match s.master_edit.clone() {
        Some(MasterEdit { part_path }) => f(app, s, part_path),
        None => null(),
    })
}

pub fn master_enter(app: &App, cx: &CallContext, args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        s.fit_width_px = number(args.get(0));
        let mut items = Vec::new();
        for part in app.engine.master_parts(s.deck()) {
            let Some(slide) = app
                .engine
                .master_parse(s.deck(), &part.part_path, s.fit_width_px)
            else {
                continue;
            };
            items.push(obj([
                ("partPath", string(part.part_path.as_str())),
                ("kind", part.kind.clone()),
                ("name", part.name.clone()),
                ("slide", slide),
            ]));
            if s.master_edit.is_none() {
                s.master_edit = Some(MasterEdit {
                    part_path: part.part_path.clone(),
                });
            }
        }
        if items.is_empty() {
            return null();
        }
        Ok(obj([("items", IpcValue::Array(items))]))
    })
}

pub fn master_open(app: &App, cx: &CallContext, args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        let part = as_str(args.get(0)).unwrap_or("");
        if app
            .engine
            .master_parse(s.deck(), part, s.fit_width_px)
            .is_none()
        {
            return null();
        }
        s.master_edit = Some(MasterEdit {
            part_path: part.to_owned(),
        });
        Ok(or_null(master_render(app, s)))
    })
}

pub fn master_close(app: &App, cx: &CallContext, _args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        s.master_edit = None;
        // edits were materialized one by one; here we only fetch the full render tree
        Ok(app.render_all(s))
    })
}

pub fn master_edit_text(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    with_master(app, cx, |app, s, part| {
        let o = op("setText")
            .set(
                "target",
                part_target(&part, Some(prop(op_value, "sourceId")?)),
            )
            .set("paragraphs", field(op_value, "paragraphs").clone())
            .build();
        if master_txn(app, s, &part, o).is_none() {
            return null();
        }
        Ok(master_edit_done(app, s))
    })
}

pub fn master_edit_transform(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    with_master(app, cx, |app, s, part| {
        let source_id = prop(op_value, "sourceId")?;
        let id = as_str(source_id).unwrap_or("");
        if !app.engine.master_has_element(s.deck(), &part, id) {
            return null();
        }
        let scale =
            number(field(op_value, "fitWidthPx")) / (app.engine.size(s.deck()).cx / EMU_PER_PX_96);
        let to_emu = |px: &IpcValue| js_round((number(px) / scale) * EMU_PER_PX_96);
        let offset = [
            to_emu(field(op_value, "xPx")),
            to_emu(field(op_value, "yPx")),
            to_emu(field(op_value, "wPx")),
            to_emu(field(op_value, "hPx")),
        ];
        if truthy(field(op_value, "preview")) {
            // previews are not persisted: mutate the live master slide only
            if !s.transform_preview {
                s.core.push_history();
                s.transform_preview = true;
            }
            let rot = js_round(number(field(op_value, "rotationDeg")) * 60000.0);
            app.engine
                .master_preview_transform(s.deck(), &part, id, offset, rot);
            return Ok(or_null(master_render(app, s)));
        }
        let payload = op("setTransform")
            .set("target", part_target(&part, Some(source_id)))
            .set(
                "box",
                obj([
                    ("x", num(offset[0])),
                    ("y", num(offset[1])),
                    ("cx", num(offset[2])),
                    ("cy", num(offset[3])),
                ]),
            )
            .set("rotDeg", field(op_value, "rotationDeg").clone())
            .build();
        let applied = if s.transform_preview {
            // the gesture's first preview frame already pushed the undo step
            s.transform_preview = false;
            let request = TxnRequest::atomic(vec![payload]).with_parts(vec![part.clone()]);
            app.journaled_txn(s, OpSource::Edit, &request).applied
        } else {
            master_txn(app, s, &part, payload).is_some()
        };
        if !applied {
            return null();
        }
        Ok(master_edit_done(app, s))
    })
}

pub fn master_edit_fill(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    with_master(app, cx, |app, s, part| {
        let fill = fill_value(prop(op_value, "fill")?);
        let o = op("setFill")
            .set(
                "target",
                part_target(&part, Some(field(op_value, "sourceId"))),
            )
            .set("fill", fill)
            .build();
        if master_txn(app, s, &part, o).is_none() {
            return null();
        }
        Ok(master_edit_done(app, s))
    })
}

pub fn master_edit_stroke(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    with_master(app, cx, |app, s, part| {
        let stroke = field(op_value, "stroke");
        let patch = if truthy(stroke) {
            obj([
                ("color", field(stroke, "color").clone()),
                (
                    "widthEmu",
                    num(js_round(number(field(stroke, "widthPt")) * EMU_PER_PT)),
                ),
            ])
        } else {
            IpcValue::Null
        };
        let o = op("setStroke")
            .set(
                "target",
                part_target(&part, Some(field(op_value, "sourceId"))),
            )
            .set("stroke", patch)
            .build();
        if master_txn(app, s, &part, o).is_none() {
            return null();
        }
        Ok(master_edit_done(app, s))
    })
}

pub fn master_delete_element(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    with_master(app, cx, |app, s, part| {
        let o = op("deleteElement")
            .set(
                "target",
                part_target(&part, Some(prop(op_value, "sourceId")?)),
            )
            .build();
        if master_txn(app, s, &part, o).is_none() {
            return null();
        }
        Ok(master_edit_done(app, s))
    })
}

pub fn master_add_element(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    with_master(app, cx, |app, s, part| {
        let scale =
            number(prop(op_value, "fitWidthPx")?) / (app.engine.size(s.deck()).cx / EMU_PER_PX_96);
        let to_emu = |px: &IpcValue| num(js_round((number(px) / scale) * EMU_PER_PX_96));
        let paragraphs = match field(op_value, "paragraphs") {
            IpcValue::Array(items) if !items.is_empty() => Some(IpcValue::Array(items.clone())),
            _ => None,
        };
        let stroke = field(op_value, "stroke");
        let o = Obj::new()
            .set("op", string("addElement"))
            .set("target", part_target(&part, None))
            .set("kind", field(op_value, "kind").clone())
            .set(
                "offset",
                obj([
                    ("x", to_emu(field(op_value, "xPx"))),
                    ("y", to_emu(field(op_value, "yPx"))),
                    ("cx", to_emu(field(op_value, "wPx"))),
                    ("cy", to_emu(field(op_value, "hPx"))),
                ]),
            )
            .set_if(paragraphs.is_some(), "paragraphs", || {
                paragraphs.clone().unwrap_or(IpcValue::Undefined)
            })
            .set_if(truthy(field(op_value, "fillColor")), "fill", || {
                field(op_value, "fillColor").clone()
            })
            .set_if(truthy(stroke), "stroke", || {
                obj([
                    ("color", field(stroke, "color").clone()),
                    (
                        "widthEmu",
                        num(js_round(number(field(stroke, "widthPt")) * EMU_PER_PT)),
                    ),
                ])
            })
            .set_if(truthy(field(op_value, "bodyPr")), "bodyPr", || {
                field(op_value, "bodyPr").clone()
            })
            .build();
        let created = master_txn(app, s, &part, o)
            .and_then(|r| r.records)
            .and_then(|r| r.into_iter().next())
            .and_then(|rec| rec.created)
            .and_then(|c| c.into_iter().next());
        let Some(source_id) = created else {
            return null();
        };
        Ok(obj([
            ("slide", master_edit_done(app, s)),
            ("sourceId", string(source_id)),
        ]))
    })
}
