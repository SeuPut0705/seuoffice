//! Dialog and file driven inserts (pictures, backgrounds, video, audio, 3D
//! models, ink), picture replacement, narration and the slide moves. Dialog
//! calls may block the core thread; reads of media files go to workers.

use std::time::{SystemTime, UNIX_EPOCH};

use jscompat::{JsObject, JsonValue, buffer_from_base64};
use main_core::slides::mp4_audio_sniff::unplayable_audio_codec;
use main_core::slides::picture_frame::{
    DEFAULT_PICTURE_DPI, ImageDpi, PictureFrameOptions, picture_frame,
};
use main_core::slides::session_state::OpSource;
use main_core::slides::video_size::{Frame, Point, Size, audio_frame, video_frame, video_size};
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::{IpcError, IpcValue, ViewId};

use super::dialog::{filter_of, jstr, jstrs, options};
use super::engine::TxnRequest;
use super::lifecycle::read_file;
use super::session::{EMU_PER_PX_96, Obj, js_round, null, number, op, prop, slide_index, target};
use super::state::{App, SlideSession};
use super::{Route, later, now};
use crate::value::{
    Args, as_bytes, as_num, as_str, buffer, field, is_nullish, num, obj, or_null, string, truthy,
};

type Reply = Result<IpcValue, IpcError>;

/// The largest model, recording or media read whole (`ATTACHABLE_MAX_BYTES`)
const MAX_BYTES: usize = 50 * 1024 * 1024;
/// The largest picture (`ATTACHABLE_IMAGE_MAX_BYTES`)
const IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"];
const VIDEO_EXTS: [&str; 5] = ["mp4", "m4v", "mov", "webm", "avi"];
const AUDIO_EXTS: [&str; 5] = ["mp3", "wav", "m4a", "aac", "ogg"];

pub fn routes(app: &App) -> Vec<Route> {
    vec![
        now(app, "slides:edit-background", edit_background),
        now(app, "slides:edit-image-fill", edit_image_fill),
        now(app, "slides:pick-picture-file", pick_picture_file),
        now(app, "slides:insert-image", insert_image),
        later(app, "slides:insert-media", insert_media),
        later(app, "slides:add-media-bytes", add_media_bytes),
        later(app, "slides:pick-model3d", pick_model3d),
        now(app, "slides:add-model3d", add_model3d),
        now(app, "slides:set-model3d-view", set_model3d_view),
        now(app, "slides:add-ink", add_ink),
        now(app, "slides:add-image-bytes", add_image_bytes),
        now(app, "slides:replace-picture-bytes", replace_picture_bytes),
        now(app, "slides:save-recording", save_recording),
        now(app, "slides:clear-narration", clear_narration),
        now(app, "slides:move-slides", move_slides),
        now(app, "slides:remove-section-slides", remove_section_slides),
    ]
}

// ---- helpers ----

/// `path.split('.').pop()!.toLowerCase()`
fn file_ext(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_lowercase()
}

/// `baseName(filePath)`
fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or("").to_owned()
}

/// `boundedBase64Size(value, limit)`: the decoded size, `None` past the
/// limit (checked on the encoded text first)
fn bounded_base64_size(value: &str, limit: usize) -> Option<usize> {
    let length = value.encode_utf16().count();
    if length > 4 * limit.div_ceil(3) {
        return None;
    }
    // Buffer.byteLength(value, 'base64')
    let padding = if value.ends_with("==") {
        2
    } else {
        usize::from(value.ends_with('='))
    };
    let size = ((length * 3) >> 2).saturating_sub(padding);
    (size <= limit).then_some(size)
}

fn decode(value: &IpcValue) -> Vec<u8> {
    buffer_from_base64(as_str(value).unwrap_or(""))
}

fn image_options(app: &App, title_key: &str) -> JsObject<JsonValue> {
    options([
        ("title", jstr(app.tm(title_key, &[]))),
        ("properties", jstrs(&["openFile"])),
        (
            "filters",
            JsonValue::Array(vec![filter_of(
                app.tm("filterImages", &[]),
                IMAGE_EXTS.iter().map(|e| (*e).to_owned()).collect(),
            )]),
        ),
    ])
}

fn frame_value(frame: Frame) -> IpcValue {
    obj([
        ("x", num(frame.x)),
        ("y", num(frame.y)),
        ("cx", num(frame.cx)),
        ("cy", num(frame.cy)),
    ])
}

/// `{ slide, sourceId: txn.records[0].created[0] }` of an insert
fn inserted(
    app: &App,
    s: &SlideSession,
    slide: &IpcValue,
    r: &super::engine::TxnResult,
) -> IpcValue {
    let created = r
        .records
        .as_ref()
        .and_then(|r| r.first())
        .and_then(|r| r.created.as_ref())
        .and_then(|c| c.first());
    match app.rebuild_slide(s, slide) {
        Some(rebuilt) => obj([
            ("slide", rebuilt),
            (
                "sourceId",
                created.map_or(IpcValue::Undefined, |id| string(id.as_str())),
            ),
        ]),
        None => IpcValue::Null,
    }
}

fn unsupported(ext: &IpcValue) -> IpcValue {
    obj([("error", string("unsupported")), ("ext", ext.clone())])
}

fn scale_of(app: &App, s: &SlideSession, fit: &IpcValue) -> f64 {
    number(fit) / (app.engine.size(s.deck()).cx / EMU_PER_PX_96)
}

// ---- backgrounds and fills ----

pub fn edit_background(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = app.engine.slide_paths(s.deck());
        let slide = prop(op_value, "slideIndex")?;
        let targets: Vec<usize> = if as_num(slide) == Some(-1.0) {
            (0..before.len()).collect()
        } else {
            slide_index(slide, before.len()).into_iter().collect()
        };
        if targets.is_empty() {
            return null();
        }
        let tile = as_str(field(op_value, "mode")) == Some("tile");
        if as_str(field(op_value, "kind")) == Some("image") {
            let source = if !matches!(field(op_value, "pick"), IpcValue::Bool(false)) {
                let Some(path) = app.pick_open_first(&image_options(app, "dlgInsertImage")) else {
                    return null();
                };
                let bytes = read_file(&path)?;
                obj([("bytes", buffer(bytes)), ("ext", string(file_ext(&path)))])
            } else {
                // reuse an already-landed background image (mode change / apply-to-all)
                let source_slide = match field(op_value, "sourceSlideIndex") {
                    v if is_nullish(v) => slide,
                    v => v,
                };
                let Some(media) = slide_index(source_slide, before.len())
                    .and_then(|i| app.engine.background_image(s.deck(), i))
                else {
                    return null();
                };
                obj([("mediaPath", string(media))])
            };
            s.core.push_history();
            // the picked bytes land as one media part; further slides only add a
            // rel to it (each op reports the landed media path)
            let mut landed: Option<IpcValue> = None;
            for i in &targets {
                let o = op("setBackground")
                    .set("target", target(&num(*i as f64), None))
                    .set("kind", string("image"))
                    .set(
                        "source",
                        match &landed {
                            Some(path) => obj([("mediaPath", path.clone())]),
                            None => source.clone(),
                        },
                    )
                    .set("tile", IpcValue::Bool(tile))
                    .build();
                let r = app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(vec![o]));
                if r.applied {
                    let used = r
                        .records
                        .as_ref()
                        .and_then(|r| r.first())
                        .map(|rec| field(&rec.after, "mediaPath").clone());
                    if let Some(used) = used.filter(truthy) {
                        landed = Some(used);
                    }
                }
            }
            if landed.is_none() {
                s.core.undo_stack.pop();
                return null();
            }
        } else {
            let kind = as_str(field(op_value, "kind")).unwrap_or("");
            let common = |o: Obj| -> Obj {
                match kind {
                    "solid" => o
                        .set("kind", string("solid"))
                        .set("color", field(op_value, "color").clone()),
                    "gradient" => o
                        .set("kind", string("gradient"))
                        .set("from", field(op_value, "from").clone())
                        .set("to", field(op_value, "to").clone())
                        .set_if(
                            !matches!(field(op_value, "angleDeg"), IpcValue::Undefined),
                            "angleDeg",
                            || field(op_value, "angleDeg").clone(),
                        )
                        .set_if(truthy(field(op_value, "radial")), "radial", || {
                            IpcValue::Bool(true)
                        }),
                    "reset" => o.set("kind", string("reset")),
                    _ => o
                        .set("kind", string("graphics"))
                        .set("hidden", field(op_value, "hidden").clone()),
                }
            };
            let ops = targets
                .iter()
                .map(|i| {
                    common(op("setBackground").set("target", target(&num(*i as f64), None))).build()
                })
                .collect();
            s.core.push_history();
            let r = app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(ops));
            if !r.applied {
                s.core.undo_stack.pop();
                return null();
            }
        }
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        let changed: Vec<f64> = targets.iter().map(|i| *i as f64).collect();
        Ok(app.build_slide_update(s, &before, &changed))
    })
}

pub fn edit_image_fill(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        let targets = match prop(op_value, "targets")? {
            IpcValue::Array(items) => items.clone(),
            _ => return Err(prop(&IpcValue::Undefined, "length").unwrap_err()),
        };
        if slide_index(slide, len).is_none() || targets.is_empty() {
            return null();
        }
        let source = field(op_value, "source");
        let (bytes, ext) = if truthy(source) {
            // bundled texture preset: bytes shipped inline, no picker
            (
                decode(field(source, "base64")),
                as_str(field(source, "ext")).unwrap_or("").to_lowercase(),
            )
        } else {
            let Some(path) = app.pick_open_first(&image_options(app, "dlgInsertImage")) else {
                return null();
            };
            (read_file(&path)?, file_ext(&path))
        };
        s.core.push_history();
        let tile = as_str(field(op_value, "mode")) == Some("tile");
        let mut landed: Option<IpcValue> = None;
        let mut applied = 0;
        for t in &targets {
            let source = match &landed {
                Some(path) => obj([("mediaPath", path.clone())]),
                None => obj([
                    ("bytes", buffer(bytes.clone())),
                    ("ext", string(ext.as_str())),
                ]),
            };
            let o = op("setImageFill")
                .set("target", target(slide, Some(field(t, "sourceId"))))
                .set("source", source)
                .set("tile", IpcValue::Bool(tile))
                .set_if(truthy(field(t, "groupId")), "group", || {
                    field(t, "groupId").clone()
                })
                .build();
            let r = app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(vec![o]));
            if r.applied {
                applied += 1;
                let used = r
                    .records
                    .as_ref()
                    .and_then(|r| r.first())
                    .map(|rec| field(&rec.after, "mediaPath").clone());
                if let Some(used) = used.filter(truthy) {
                    landed = Some(used);
                }
            }
        }
        if applied == 0 {
            s.core.undo_stack.pop();
            return null();
        }
        Ok(or_null(app.rebuild_slide(s, slide)))
    })
}

pub fn pick_picture_file(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    let Some(path) = app.pick_open_first(&image_options(app, "dlgReplacePicture")) else {
        return null();
    };
    let bytes = read_file(&path)?;
    Ok(obj([
        ("base64", string(jscompat::base64(&bytes))),
        ("ext", string(file_ext(&path))),
    ]))
}

// ---- pictures ----

pub fn insert_image(app: &App, cx: &CallContext, args: Args) -> Reply {
    let slide = args.get(0);
    let fit = args.get(1);
    app.with_session(cx.sender.view, |app, s| {
        let len = app.engine.slide_paths(s.deck()).len();
        if slide_index(slide, len).is_none() {
            return null();
        }
        let Some(path) = app.pick_open_first(&image_options(app, "dlgInsertImage")) else {
            return null();
        };
        let bytes = read_file(&path)?;
        let ext = file_ext(&path);
        let size = app.engine.size(s.deck());
        let info = app.engine.image_info(&bytes, &ext, Some(&path));
        let offset = picture_frame(
            Size {
                width: size.cx,
                height: size.cy,
            },
            info.natural.map(|(width, height)| Size { width, height }),
            info.dpi.map(|(x, y)| ImageDpi { x, y }),
            DEFAULT_PICTURE_DPI,
            PictureFrameOptions::default(),
        );
        let o = op("addPicture")
            .set("target", target(slide, None))
            .set("bytes", buffer(bytes))
            .set("ext", string(ext.as_str()))
            .set("offset", frame_value(offset))
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return Ok(unsupported(&string(ext)));
        };
        s.fit_width_px = number(fit);
        Ok(inserted(app, s, slide, &r))
    })
}

pub fn add_image_bytes(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        if slide_index(slide, len).is_none() {
            return null();
        }
        let size = app.engine.size(s.deck());
        let scale = scale_of(app, s, field(op_value, "fitWidthPx"));
        let to_emu = |v: &IpcValue| js_round((number(v) / scale) * EMU_PER_PX_96);
        let bytes = decode(field(op_value, "base64"));
        let has = |key: &str| match op_value {
            IpcValue::Object(entries) => entries.iter().any(|(k, _)| k == key),
            _ => false,
        };
        let offset = if has("naturalPx") {
            let natural = field(op_value, "naturalPx");
            let center = field(op_value, "centerPx");
            let ext = as_str(field(op_value, "ext")).unwrap_or("");
            let info = app.engine.image_info(&bytes, ext, None);
            picture_frame(
                Size {
                    width: size.cx,
                    height: size.cy,
                },
                Some(Size {
                    width: number(field(natural, "width")),
                    height: number(field(natural, "height")),
                }),
                info.dpi.map(|(x, y)| ImageDpi { x, y }),
                DEFAULT_PICTURE_DPI,
                PictureFrameOptions {
                    center: truthy(center).then(|| Point {
                        x: to_emu(field(center, "x")),
                        y: to_emu(field(center, "y")),
                    }),
                    min_emu: Some(to_emu(&num(24.0))),
                },
            )
        } else {
            Frame {
                x: to_emu(field(op_value, "xPx")),
                y: to_emu(field(op_value, "yPx")),
                cx: to_emu(field(op_value, "wPx")).max(1.0),
                cy: to_emu(field(op_value, "hPx")).max(1.0),
            }
        };
        let o = op("addPicture")
            .set("target", target(slide, None))
            .set("bytes", buffer(bytes))
            .set("ext", field(op_value, "ext").clone())
            .set("offset", frame_value(offset))
            .set_if(truthy(field(op_value, "name")), "name", || {
                field(op_value, "name").clone()
            })
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return Ok(unsupported(field(op_value, "ext")));
        };
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        Ok(inserted(app, s, slide, &r))
    })
}

pub fn replace_picture_bytes(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        if slide_index(slide, len).is_none() {
            return null();
        }
        let o = op("replacePicture")
            .set("target", target(slide, Some(field(op_value, "sourceId"))))
            .set("bytes", buffer(decode(field(op_value, "base64"))))
            .set("ext", field(op_value, "ext").clone())
            .set_if(
                truthy(field(op_value, "keepSrcRect")),
                "keepSrcRect",
                || IpcValue::Bool(true),
            )
            .build();
        if app
            .session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)
            .is_none()
        {
            return Ok(unsupported(field(op_value, "ext")));
        }
        Ok(or_null(app.rebuild_slide(s, slide)))
    })
}

pub fn add_ink(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        if slide_index(slide, len).is_none() {
            return null();
        }
        let scale = scale_of(app, s, field(op_value, "fitWidthPx"));
        let to_emu = |v: &IpcValue| js_round((number(v) / scale) * EMU_PER_PX_96);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let o = op("addPicture")
            .set("target", target(slide, None))
            .set("bytes", buffer(decode(field(op_value, "base64"))))
            .set("ext", string("png"))
            .set(
                "offset",
                obj([
                    ("x", num(to_emu(field(op_value, "xPx")))),
                    ("y", num(to_emu(field(op_value, "yPx")))),
                    ("cx", num(to_emu(field(op_value, "wPx")).max(1.0))),
                    ("cy", num(to_emu(field(op_value, "hPx")).max(1.0))),
                ]),
            )
            .set("name", string(format!("aislides-ink {}", base36(stamp))))
            .set("descr", field(op_value, "payload").clone())
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return null();
        };
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        Ok(inserted(app, s, slide, &r))
    })
}

/// `n.toString(36)`
fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ---- audio and video ----

/// `mediaPlaybackWarning(kind, ext, bytes)`: in-app playback caveats
fn media_playback_warning(app: &App, kind: &str, ext: &str, bytes: &[u8]) -> Option<String> {
    if kind != "video" {
        return None;
    }
    if ext == "avi" {
        return Some(app.tm("mediaAviBody", &[]));
    }
    if matches!(ext, "mp4" | "m4v" | "mov")
        && let Some(codec) = unplayable_audio_codec(bytes)
    {
        return Some(app.tm("mediaNoAudioBody", &[("codec", JsonValue::String(codec))]));
    }
    None
}

struct Embed<'a> {
    kind: &'a str,
    bytes: Vec<u8>,
    ext: &'a str,
    name: Option<String>,
    poster: Option<Vec<u8>>,
    natural: Option<Size>,
    center: Option<Point>,
    fit: IpcValue,
}

/// `embedMedia(session, slideIndex, kind, bytes, ext, name, opts)`: the
/// rebuilt slide, the new element and the playback warning
fn embed_media(
    app: &App,
    s: &mut SlideSession,
    slide: &IpcValue,
    e: Embed<'_>,
) -> Option<(IpcValue, IpcValue, Option<String>)> {
    let size = app.engine.size(s.deck());
    let slide_size = Size {
        width: size.cx,
        height: size.cy,
    };
    let offset = if e.kind == "video" {
        video_frame(
            slide_size,
            e.natural.or_else(|| video_size(&e.bytes, e.ext)),
            e.center,
        )
    } else {
        audio_frame(slide_size, e.center)
    };
    let warning = media_playback_warning(app, e.kind, e.ext, &e.bytes);
    let o = op("addMedia")
        .set("target", target(slide, None))
        .set("kind", string(e.kind))
        .set("bytes", buffer(e.bytes))
        .set("ext", string(e.ext))
        .set_if(e.poster.is_some(), "poster", || {
            obj([
                ("bytes", buffer(e.poster.clone().unwrap_or_default())),
                ("ext", string("png")),
            ])
        })
        .set("offset", frame_value(offset))
        .set_if(
            e.name.as_deref().is_some_and(|n| !n.is_empty()),
            "name",
            || string(e.name.clone().unwrap_or_default()),
        )
        .build();
    let txn = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit)?;
    s.fit_width_px = number(&e.fit);
    let rebuilt = app.rebuild_slide(s, slide)?;
    let id = txn
        .records
        .as_ref()
        .and_then(|r| r.first())
        .and_then(|r| r.created.as_ref())
        .and_then(|c| c.first())
        .map_or(IpcValue::Undefined, |id| string(id.as_str()));
    Some((rebuilt, id, warning))
}

pub fn insert_media(app: &App, cx: &CallContext, args: Args, responder: Responder) {
    let view = cx.sender.view;
    let slide = args.get(0).clone();
    let kind = as_str(args.get(1)).unwrap_or("").to_owned();
    let fit = args.get(2).clone();
    {
        let state = app.state.borrow();
        let Some(s) = state.session(view) else {
            return responder.reply(null());
        };
        if slide_index(&slide, app.engine.slide_paths(s.deck()).len()).is_none() {
            return responder.reply(null());
        }
    }
    let exts: Vec<String> = if kind == "video" {
        VIDEO_EXTS.iter().map(|e| (*e).to_owned()).collect()
    } else {
        AUDIO_EXTS.iter().map(|e| (*e).to_owned()).collect()
    };
    let (filter_name, title) = if kind == "video" {
        (app.tm("filterVideo", &[]), app.tm("dlgInsertVideo", &[]))
    } else {
        (app.tm("filterAudio", &[]), app.tm("dlgInsertAudio", &[]))
    };
    let picked = app.pick_open_first(&options([
        ("title", jstr(title)),
        ("properties", jstrs(&["openFile"])),
        (
            "filters",
            JsonValue::Array(vec![filter_of(filter_name, exts)]),
        ),
    ]));
    let Some(path) = picked else {
        return responder.reply(null());
    };
    let engine = app.engine.clone();
    let index = app.registry_index;
    let services = app.services.clone();
    app.services.workers.spawn(Box::new(move || {
        let bytes = match read_file(&path) {
            Ok(bytes) => bytes,
            Err(error) => return responder.reply(Err(error)),
        };
        let poster = (kind == "video")
            .then(|| engine.video_poster(&path))
            .flatten();
        super::post_to(&services, index, move |app| {
            let ext = file_ext(&path);
            // warn up front, before the file lands on the slide
            if let Some(detail) = media_playback_warning(app, &kind, &ext, &bytes) {
                let warn = MessageBox {
                    kind: Some("warning".into()),
                    title: None,
                    message: app.tm("mediaUnsupportedTitle", &[]),
                    detail: Some(detail),
                    buttons: vec![app.tm("legacyPptOk", &[])],
                    default_id: None,
                    cancel_id: None,
                    checkbox_label: None,
                };
                app.message_box(app.shell.dialog_parent(), &warn);
            }
            let reply = app.with_session(view, |app, s| {
                let embedded = embed_media(
                    app,
                    s,
                    &slide,
                    Embed {
                        kind: &kind,
                        bytes,
                        ext: &ext,
                        name: Some(base_name(&path)),
                        poster,
                        natural: None,
                        center: None,
                        fit,
                    },
                );
                Ok(match embedded {
                    Some((slide, id, _)) => obj([("slide", slide), ("sourceId", id)]),
                    None => IpcValue::Null,
                })
            });
            responder.reply(reply);
        });
    }));
}

pub fn add_media_bytes(app: &App, cx: &CallContext, args: Args, responder: Responder) {
    let view = cx.sender.view;
    let op_value = args.get(0).clone();
    let (slot, ai_run) = {
        let state = app.state.borrow();
        let Some(s) = state.session(view) else {
            return responder.reply(null());
        };
        let slide = field(&op_value, "slideIndex");
        if slide_index(slide, app.engine.slide_paths(s.deck()).len()).is_none() {
            return responder.reply(null());
        }
        (state.slot_of(view), s.core.ai_run)
    };
    let path = match &op_value {
        IpcValue::Object(entries) if entries.iter().any(|(k, _)| k == "path") => {
            Some(as_str(field(&op_value, "path")).unwrap_or("").to_owned())
        }
        _ => None,
    };
    let engine = app.engine.clone();
    let index = app.registry_index;
    let services = app.services.clone();
    app.services.workers.spawn(Box::new(move || {
        let (bytes, poster) = match &path {
            Some(path) => match read_file(path) {
                Ok(bytes) => {
                    let video = as_str(field(&op_value, "kind")) == Some("video");
                    (bytes, video.then(|| engine.video_poster(path)).flatten())
                }
                Err(_) => return responder.reply(null()),
            },
            None => (decode(field(&op_value, "base64")), None),
        };
        super::post_to(&services, index, move |app| {
            // a replaced session invalidates this insert (checked before the state is borrowed)
            if app.state_slot_changed(view, slot) {
                return responder.reply(null());
            }
            let reply = app.with_session(view, |app, s| {
                // an AI run started meanwhile invalidates it too
                if s.core.ai_run != ai_run {
                    return null();
                }
                let slide = field(&op_value, "slideIndex");
                let scale = scale_of(app, s, field(&op_value, "fitWidthPx"));
                let to_emu = |v: &IpcValue| js_round((number(v) / scale) * EMU_PER_PX_96);
                let center = field(&op_value, "centerPx");
                let natural = field(&op_value, "natural");
                let kind = as_str(field(&op_value, "kind")).unwrap_or("");
                let embedded = embed_media(
                    app,
                    s,
                    slide,
                    Embed {
                        kind,
                        bytes,
                        ext: as_str(field(&op_value, "ext")).unwrap_or(""),
                        name: as_str(field(&op_value, "name")).map(str::to_owned),
                        poster,
                        natural: truthy(natural).then(|| Size {
                            width: number(field(natural, "width")),
                            height: number(field(natural, "height")),
                        }),
                        center: truthy(center).then(|| Point {
                            x: to_emu(field(center, "x")),
                            y: to_emu(field(center, "y")),
                        }),
                        fit: field(&op_value, "fitWidthPx").clone(),
                    },
                );
                Ok(match embedded {
                    Some((slide, id, warning)) => {
                        let mut o = Obj::new().set("slide", slide).set("sourceId", id);
                        if let Some(warning) = warning {
                            o = o.set("warning", string(warning));
                        }
                        o.build()
                    }
                    None => IpcValue::Null,
                })
            });
            responder.reply(reply);
        });
    }));
}

impl App {
    /// the view is no longer attached to `slot` (its session was replaced)
    fn state_slot_changed(&self, view: ViewId, slot: Option<usize>) -> bool {
        self.state.borrow().slot_of(view) != slot
    }
}

// ---- 3D models ----

pub fn pick_model3d(app: &App, _cx: &CallContext, _args: Args, responder: Responder) {
    let picked = app.pick_open_first(&options([
        ("title", jstr(app.tm("dlgInsert3d", &[]))),
        ("properties", jstrs(&["openFile"])),
        (
            "filters",
            JsonValue::Array(vec![filter_of(app.tm("filter3d", &[]), vec!["glb".into()])]),
        ),
    ]));
    let Some(path) = picked else {
        return responder.reply(null());
    };
    // `stat` first: a file that is not there is the stat's error, not the read's
    let size = match std::fs::metadata(&path) {
        Ok(meta) => meta.len() as usize,
        Err(e) => {
            return responder.reply(Err(crate::value::thrown(
                main_core::node_fs::node_error(&e, "stat", &path).message,
            )));
        }
    };
    if size > MAX_BYTES {
        app.refuse_oversized_media(MAX_BYTES);
        return responder.reply(null());
    }
    let index = app.registry_index;
    let services = app.services.clone();
    app.services.workers.spawn(Box::new(move || {
        let bytes = match read_file(&path) {
            Ok(bytes) => bytes,
            Err(error) => return responder.reply(Err(error)),
        };
        super::post_to(&services, index, move |app| {
            if bytes.len() > MAX_BYTES {
                app.refuse_oversized_media(MAX_BYTES);
                return responder.reply(null());
            }
            responder.reply(Ok(obj([
                ("name", string(base_name(&path))),
                ("bytes", buffer(bytes)),
            ])));
        });
    }));
}

pub fn add_model3d(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    let mut refused: Option<usize> = None;
    let reply = app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        if slide_index(slide, app.engine.slide_paths(s.deck()).len()).is_none() {
            return null();
        }
        let bytes = prop(op_value, "bytes")?;
        let Some(model) = as_bytes(bytes) else {
            return Err(prop(&IpcValue::Undefined, "byteLength").unwrap_err());
        };
        if model.len() > MAX_BYTES {
            refused = Some(MAX_BYTES);
            return null();
        }
        let poster = field(op_value, "posterBase64");
        if truthy(poster)
            && bounded_base64_size(as_str(poster).unwrap_or(""), IMAGE_MAX_BYTES).is_none()
        {
            refused = Some(IMAGE_MAX_BYTES);
            return null();
        }
        let size = app.engine.size(s.deck());
        let cy = js_round(size.cy * 0.5);
        let cx = js_round(cy * number(field(op_value, "aspect")));
        let o = op("addModel3d")
            .set("target", target(slide, None))
            .set("bytes", bytes.clone())
            .set("ext", string("glb"))
            .set_if(truthy(poster), "poster", || {
                obj([("bytes", buffer(decode(poster))), ("ext", string("png"))])
            })
            .set(
                "offset",
                obj([
                    ("x", num(js_round((size.cx - cx) / 2.0))),
                    ("y", num(js_round((size.cy - cy) / 2.0))),
                    ("cx", num(cx)),
                    ("cy", num(cy)),
                ]),
            )
            .set("name", field(op_value, "name").clone())
            .build();
        let Some(r) = app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) else {
            return null();
        };
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        Ok(inserted(app, s, slide, &r))
    });
    if let Some(limit) = refused {
        app.refuse_oversized_media(limit);
    }
    reply
}

pub fn set_model3d_view(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    let mut refused = false;
    let reply = app.with_session(cx.sender.view, |app, s| {
        let slide = prop(op_value, "slideIndex")?;
        if slide_index(slide, app.engine.slide_paths(s.deck()).len()).is_none() {
            return null();
        }
        let poster = field(op_value, "posterBase64");
        if truthy(poster)
            && bounded_base64_size(as_str(poster).unwrap_or(""), IMAGE_MAX_BYTES).is_none()
        {
            refused = true;
            return null();
        }
        let mut o =
            op("setModel3dView").set("target", target(slide, Some(field(op_value, "sourceId"))));
        // ...op.rot
        if let IpcValue::Object(entries) = field(op_value, "rot") {
            for (key, value) in entries {
                o = o.set(key, value.clone());
            }
        }
        let o = o
            .set_if(truthy(poster), "poster", || poster.clone())
            .set_if(truthy(poster), "posterExt", || string("png"))
            .build();
        Ok(
            match app.session_txn(s, TxnRequest::atomic(vec![o]), OpSource::Edit) {
                Some(_) => or_null(app.rebuild_slide(s, slide)),
                None => IpcValue::Null,
            },
        )
    });
    if refused {
        app.refuse_oversized_media(IMAGE_MAX_BYTES);
    }
    reply
}

// ---- narration ----

pub fn save_recording(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.close_narration_microphone(cx.sender.view);
    let mut refused = false;
    let reply = app.with_session(cx.sender.view, |app, s| {
        let recorded_slides = match prop(op_value, "slides")? {
            IpcValue::Array(items) => items.clone(),
            _ => Vec::new(),
        };
        let mut total = 0usize;
        for slide in &recorded_slides {
            let wav = as_str(field(slide, "wavBase64")).unwrap_or("");
            match bounded_base64_size(wav, MAX_BYTES.saturating_sub(total)) {
                Some(size) => total += size,
                None => {
                    refused = true;
                    return null();
                }
            }
        }
        let len = app.engine.slide_paths(s.deck()).len();
        let recorded: Vec<&IpcValue> = recorded_slides
            .iter()
            .filter(|r| slide_index(field(r, "slideIndex"), len).is_some())
            .collect();
        if recorded.is_empty() {
            return null();
        }
        let mut ops = Vec::new();
        for r in recorded {
            let slide = field(r, "slideIndex");
            ops.push(
                op("addNarration")
                    .set("target", target(slide, None))
                    .set("bytes", field(r, "wavBase64").clone())
                    .set("ext", string("wav"))
                    .set("durationMs", field(r, "durationMs").clone())
                    .build(),
            );
            ops.push(
                op("setAdvanceTime")
                    .set("target", target(slide, None))
                    .set("ms", field(r, "advanceMs").clone())
                    .build(),
            );
        }
        Ok(
            match app.session_txn(s, TxnRequest::atomic(ops), OpSource::Edit) {
                Some(_) => app.rebuild_every_slide(s),
                None => IpcValue::Null,
            },
        )
    });
    if refused {
        app.refuse_oversized_media(MAX_BYTES);
    }
    reply
}

pub fn clear_narration(app: &App, cx: &CallContext, args: Args) -> Reply {
    app.with_session(cx.sender.view, |app, s| {
        let len = app.engine.slide_paths(s.deck()).len();
        let indexes = match args.get(0) {
            IpcValue::Array(items) => items.clone(),
            _ => Vec::new(),
        };
        let targets: Vec<&IpcValue> = indexes
            .iter()
            .filter(|i| {
                slide_index(i, len).is_some_and(|idx| app.engine.has_narration(s.deck(), idx))
            })
            .collect();
        if targets.is_empty() {
            return null();
        }
        let ops = targets
            .iter()
            .map(|i| op("clearNarration").set("target", target(i, None)).build())
            .collect();
        Ok(
            match app.session_txn(s, TxnRequest::atomic(ops), OpSource::Edit) {
                Some(_) => app.rebuild_every_slide(s),
                None => IpcValue::Null,
            },
        )
    })
}

// ---- moves ----

/// `planSlideMoves(count, selected, insertAt)`: steps that land `selected`
/// as a block at gap `insertAt`; empty when the order would not change
fn plan_slide_moves(count: usize, selected: &[f64], insert_at: f64) -> Vec<(i64, usize)> {
    let mut block: Vec<f64> = Vec::new();
    for x in selected {
        if !block.contains(x) {
            block.push(*x);
        }
    }
    block.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let is_picked = |i: usize| block.contains(&(i as f64));
    let rest: Vec<usize> = (0..count).filter(|i| !is_picked(*i)).collect();
    let before = block.iter().filter(|i| **i < insert_at).count() as f64;
    let at = insert_at - before;
    // `slice(0, at)` and `slice(at)`: the index is truncated and counts from the end when negative
    let at = if at.is_nan() {
        0
    } else if at.trunc() < 0.0 {
        (rest.len() as f64 + at.trunc()).max(0.0) as usize
    } else {
        at.trunc().min(rest.len() as f64) as usize
    };
    let mut fin: Vec<f64> = rest[..at].iter().map(|i| *i as f64).collect();
    fin.extend(block.iter().copied());
    fin.extend(rest[at..].iter().map(|i| *i as f64));
    let mut cur: Vec<f64> = (0..count).map(|i| i as f64).collect();
    let mut steps = Vec::new();
    for (t, id) in fin.iter().enumerate() {
        // `cur.indexOf(id)` is -1 for a slide that is not there
        let from: i64 = cur.iter().position(|c| c == id).map_or(-1, |p| p as i64);
        if from == t as i64 {
            continue;
        }
        steps.push((from, t));
        // `splice(-1, 1)` drops the last item, `splice(t, 0, id)` appends past the end
        if from >= 0 {
            cur.remove(from as usize);
        } else {
            cur.pop();
        }
        cur.insert(t.min(cur.len()), *id);
    }
    steps
}

pub fn move_slides(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = app.engine.slide_paths(s.deck());
        let indexes: Vec<f64> = match prop(op_value, "slideIndexes")? {
            IpcValue::Array(items) => items.iter().map(number).collect(),
            _ => Vec::new(),
        };
        let steps = plan_slide_moves(before.len(), &indexes, number(field(op_value, "insertAt")));
        if steps.is_empty() {
            return null();
        }
        let ops = steps
            .iter()
            .map(|(from, to)| {
                op("moveSlide")
                    .set("target", target(&num(*from as f64), None))
                    .set("to", num(*to as f64))
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
        let update = app.build_slide_update(s, &before, &[]);
        Ok(Obj::from_value(update)
            .set("sections", app.engine.sections(s.deck()))
            .build())
    })
}

pub fn remove_section_slides(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let before = app.engine.slide_paths(s.deck());
        let total = before.len();
        let id = prop(op_value, "id")?;
        let Some(indices) = app.engine.section_slide_indices(s.deck(), id) else {
            return null();
        };
        if indices.len() >= total {
            return null();
        }
        // highest index first so the numeric targets stay valid as the deck shrinks
        let mut ops: Vec<IpcValue> = indices
            .iter()
            .rev()
            .map(|i| {
                op("deleteSlide")
                    .set("target", target(&num(*i as f64), None))
                    .build()
            })
            .collect();
        if !is_nullish(id) {
            ops.push(op("removeSection").set("id", id.clone()).build());
        }
        if ops.is_empty() {
            return null();
        }
        if app
            .session_txn(s, TxnRequest::atomic(ops), OpSource::Edit)
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
