//! Slide and element clipboards: copy-slides, paste-slide, repaste-slide,
//! the clipboard probes, copy/paste/duplicate of elements, native clipboard.

use jscompat::JsonValue;
use main_core::slides::element_clipboard::{
    ClipboardHost, ELEMENT_CLIPBOARD_FORMAT, ElementClipboardIdentity, HostThrew,
    can_write_element_clipboard_image, element_clipboard_marker_matches,
    is_element_clipboard_token, write_element_clipboard_image,
};
use main_core::slides::paste_cascade::{new_paste_cascade, page_key, paste_shift_px, record_paste};
use main_core::slides::session_state::OpSource;
use shell_contract::ipc::CallContext;
use shell_contract::{IpcError, IpcValue};

use super::engine::TxnRequest;
use super::session::{
    EMU_PER_PX_96, Obj, array_of_strings, js_round, null, number, op, prop, target,
};
use super::state::{App, ElementClipboard, LastSlidePaste, SlideClipboard, SlideSession};
use crate::value::{Args, as_num, as_str, field, num, obj, string, truthy};

type Reply = Result<IpcValue, IpcError>;

const SLIDE_MARKER: &str = "io.seuoffice.slides.slide";

/// `main-core`'s clipboard host over the shell's clipboard and the marker
/// formats of the slides host
struct Marker<'a>(&'a App);

impl ClipboardHost for Marker<'_> {
    type Image = Vec<u8>;

    fn read_buffer(&self, format: &str) -> Result<Vec<u8>, HostThrew> {
        Ok(self.0.shell.read_clipboard_buffer(format))
    }

    fn read_html(&self) -> Result<String, HostThrew> {
        Ok(self.0.clipboard.read_html())
    }

    fn create_image_from_buffer(&self, bytes: &[u8]) -> Result<Vec<u8>, HostThrew> {
        Ok(self.0.shell.normalize_png(bytes).unwrap_or_default())
    }

    fn image_is_empty(&self, image: &Vec<u8>) -> Result<bool, HostThrew> {
        Ok(image.is_empty())
    }

    fn image_to_png(&self, image: &Vec<u8>) -> Result<Vec<u8>, HostThrew> {
        Ok(image.clone())
    }

    fn write_image_and_html(&mut self, image: &Vec<u8>, html: &str) -> Result<(), HostThrew> {
        self.0.shell.write_image_and_html(image, html);
        Ok(())
    }
}

fn json_string(value: &IpcValue) -> Option<JsonValue> {
    as_str(value).map(|s| JsonValue::String(s.to_owned()))
}

impl App {
    /// `clipboardMarker(format)`
    fn clipboard_marker(&self, format: &str) -> bool {
        !self.shell.read_clipboard_buffer(format).is_empty()
    }

    fn slide_marker_present(&self) -> bool {
        self.state.borrow().slide_clipboard.is_some() && self.clipboard_marker(SLIDE_MARKER)
    }

    fn element_marker_present(&self) -> bool {
        let token = self
            .state
            .borrow()
            .element_clipboard
            .as_ref()
            .map(|c| c.token.clone());
        token.is_some_and(|t| element_clipboard_marker_matches(&Marker(self), &t))
    }

    fn slide_paths_of(&self, s: &SlideSession) -> Vec<String> {
        self.engine.slide_paths(s.deck())
    }
}

pub fn has_slide_clipboard(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    Ok(IpcValue::Bool(app.state.borrow().slide_clipboard.is_some()))
}

pub fn copy_slides(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op = args.get(0);
    let mut state = app.state.borrow_mut();
    let Some(session) = state.session(cx.sender.view) else {
        return Ok(IpcValue::Bool(false));
    };
    let indexes = match prop(op, "slideIndexes")? {
        IpcValue::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    if indexes.is_empty() {
        return Ok(IpcValue::Bool(false));
    }
    let len = app.engine.slide_paths(session.deck()).len();
    let mut bundles = Vec::new();
    for index in &indexes {
        let bundle = super::session::slide_index(index, len)
            .and_then(|i| app.engine.copy_slide(session.deck(), i));
        match bundle {
            Some(bundle) => bundles.push(bundle),
            None => return Ok(IpcValue::Bool(false)),
        }
    }
    let pngs = match field(op, "pngs") {
        IpcValue::Array(items) if items.len() == bundles.len() => Some(items.clone()),
        _ => None,
    };
    state.slide_clipboard = Some(SlideClipboard { bundles, pngs });
    drop(state);
    // Marker so plain paste knows the latest copy was a slide
    app.shell.write_clipboard_buffer(SLIDE_MARKER, b"1");
    Ok(IpcValue::Bool(true))
}

/// What `performSlidePaste` answers: the update, and where the paste landed
struct Pasted {
    value: IpcValue,
    index: f64,
}

fn perform_slide_paste(
    app: &App,
    s: &mut SlideSession,
    clipboard: &SlideClipboard,
    paste: &IpcValue,
    before: Option<Vec<String>>,
    restored: Vec<f64>,
) -> Option<Pasted> {
    let before = before.unwrap_or_else(|| app.slide_paths_of(s));
    let picture = as_str(field(paste, "mode")) == Some("picture");
    if picture && clipboard.pngs.is_none() {
        return None;
    }
    let after_index = number(field(paste, "afterIndex"));
    let ops = clipboard
        .bundles
        .iter()
        .enumerate()
        .map(|(j, bundle)| {
            let mut o = op("pasteSlide")
                .set(
                    "afterIndex",
                    num(if picture {
                        after_index
                    } else {
                        after_index + j as f64
                    }),
                )
                .set("mode", field(paste, "mode").clone());
            o = if picture {
                o.set(
                    "png",
                    clipboard
                        .pngs
                        .as_ref()
                        .and_then(|p| p.get(j))
                        .cloned()
                        .unwrap_or(IpcValue::Undefined),
                )
            } else {
                o.set("bundle", bundle.clone())
            };
            o.build()
        })
        .collect();
    let r = app.journaled_txn(s, OpSource::Edit, &TxnRequest::atomic(ops));
    if !r.applied {
        return None;
    }
    let records = r.records.unwrap_or_default();
    s.fit_width_px = number(field(paste, "fitWidthPx"));
    // Pasted slides are parsed fresh, so no element dirty flag is set
    s.core.mark_meta_dirty();
    let created: Vec<String> = records
        .iter()
        .flat_map(|x| x.created.clone().unwrap_or_default())
        .collect();
    let index = records
        .first()
        .and_then(|rec| as_num(field(&rec.after, "index")))
        .unwrap_or(f64::NAN);
    let count = if picture { 1 } else { clipboard.bundles.len() };
    let mut changed = restored;
    changed.extend((0..count).map(|j| index + j as f64));
    let update = app.build_slide_update(s, &before, &changed);
    let value = Obj::from_value(update)
        .set("index", num(index))
        .set(
            "count",
            num(if picture {
                0.0
            } else {
                clipboard.bundles.len() as f64
            }),
        )
        .set_if(!created.is_empty(), "sourceIds", || {
            array_of_strings(&created)
        })
        .build();
    Some(Pasted { value, index })
}

pub fn paste_slide(app: &App, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let paste = args.get(0);
    let mut state = app.state.borrow_mut();
    let Some(clipboard) = state.slide_clipboard.clone() else {
        return null();
    };
    let Some((s, rest)) = state.session_split(view) else {
        return null();
    };
    s.core.push_history();
    let Some(done) = perform_slide_paste(app, s, &clipboard, paste, None, Vec::new()) else {
        s.core.undo_stack.pop();
        return null();
    };
    let picture = as_str(field(paste, "mode")) == Some("picture");
    rest.last_slide_paste.insert(
        view,
        LastSlidePaste {
            after_index: number(field(paste, "afterIndex")),
            undo_len: s.core.undo_stack.len(),
            changed: if picture {
                vec![done.index]
            } else {
                Vec::new()
            },
        },
    );
    Ok(done.value)
}

pub fn repaste_slide(app: &App, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let paste = args.get(0);
    let mut state = app.state.borrow_mut();
    let clipboard = state.slide_clipboard.clone();
    let Some((s, rest)) = state.session_split(view) else {
        return null();
    };
    let (Some(clipboard), Some(rec)) = (clipboard, rest.last_slide_paste.get_mut(&view)) else {
        return null();
    };
    if s.core.undo_stack.len() != rec.undo_len {
        return null();
    }
    let Some(snapshot) = s.core.undo_stack.pop() else {
        return null();
    };
    let before = app.slide_paths_of(s);
    s.core.restore_snapshot(&snapshot);
    s.core.push_history();
    let again = obj([
        ("afterIndex", num(rec.after_index)),
        ("fitWidthPx", field(paste, "fitWidthPx").clone()),
        ("mode", field(paste, "mode").clone()),
    ]);
    let Some(done) = perform_slide_paste(
        app,
        s,
        &clipboard,
        &again,
        Some(before),
        rec.changed.clone(),
    ) else {
        s.core.undo_stack.pop();
        return null();
    };
    rec.undo_len = s.core.undo_stack.len();
    rec.changed = if as_str(field(paste, "mode")) == Some("picture") {
        vec![done.index]
    } else {
        Vec::new()
    };
    Ok(done.value)
}

pub fn clipboard_external(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    if app.slide_marker_present() {
        return Ok(obj([("kind", string("slide"))]));
    }
    if app.element_marker_present() {
        return Ok(obj([("kind", string("internal"))]));
    }
    let png = app.clipboard.read_image_png();
    if !png.is_empty() {
        return Ok(obj([
            ("kind", string("image")),
            ("base64", string(jscompat::base64(&png))),
            ("ext", string("png")),
        ]));
    }
    let text = app.clipboard.read_text();
    if !jscompat::trim(&text).is_empty() {
        return Ok(obj([("kind", string("text")), ("text", string(text))]));
    }
    Ok(obj([("kind", string("none"))]))
}

pub fn clipboard_probe(app: &App, _cx: &CallContext, _args: Args) -> Reply {
    if app.slide_marker_present() || app.element_marker_present() {
        return Ok(IpcValue::Bool(true));
    }
    if app
        .clipboard
        .available_formats()
        .iter()
        .any(|f| f.starts_with("image/"))
    {
        return Ok(IpcValue::Bool(true));
    }
    Ok(IpcValue::Bool(
        !jscompat::trim(&app.clipboard.read_text()).is_empty(),
    ))
}

fn source_ids(op: &IpcValue) -> Vec<String> {
    match field(op, "sourceIds") {
        IpcValue::Array(items) => items
            .iter()
            .filter_map(|i| as_str(i).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

pub fn copy_elements(app: &App, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let op = args.get(0);
    let mut state = app.state.borrow_mut();
    let Some((s, rest)) = state.session_split(view) else {
        return Ok(num(0.0));
    };
    let slide_index = prop(op, "slideIndex")?;
    let len = app.engine.slide_paths(s.deck()).len();
    let Some(slide) = super::session::slide_index(slide_index, len) else {
        return Ok(num(0.0));
    };
    let items = app
        .engine
        .copy_elements(s.deck(), slide, &source_ids(op))
        .unwrap_or_default();
    let count = items.len();
    if count > 0 {
        let token = field(op, "clipboardToken");
        let token = if is_element_clipboard_token(json_string(token).as_ref()) {
            as_str(token).unwrap_or_default().to_owned()
        } else {
            jscompat::random_uuid()
        };
        let source =
            (!truthy(field(op, "cut"))).then(|| page_key(f64::from(view.0), number(slide_index)));
        *rest.element_clipboard = Some(ElementClipboard {
            items,
            cascade: new_paste_cascade(source),
            token: token.clone(),
            sender_id: f64::from(view.0),
        });
        drop(state);
        // Write our marker to the OS clipboard: an external copy overwrites
        // it, so at paste time it tells whether internal or external is newer
        app.shell
            .write_clipboard_buffer(ELEMENT_CLIPBOARD_FORMAT, token.as_bytes());
    }
    Ok(num(count as f64))
}

pub fn copy_elements_image(app: &App, cx: &CallContext, args: Args) -> Reply {
    let identity =
        app.state
            .borrow()
            .element_clipboard
            .as_ref()
            .map(|c| ElementClipboardIdentity {
                token: c.token.clone(),
                sender_id: c.sender_id,
            });
    let token = json_string(args.get(0));
    let mut marker = Marker(app);
    if !can_write_element_clipboard_image(
        &marker,
        identity.as_ref(),
        f64::from(cx.sender.view.0),
        token.as_ref(),
    ) {
        return Ok(IpcValue::Bool(false));
    }
    let png = json_string(args.get(1));
    let token = as_str(args.get(0)).unwrap_or_default();
    Ok(IpcValue::Bool(write_element_clipboard_image(
        &mut marker,
        token,
        png.as_ref(),
    )))
}

pub fn paste_elements(app: &App, cx: &CallContext, args: Args) -> Reply {
    let view = cx.sender.view;
    let op_value = args.get(0);
    let mut state = app.state.borrow_mut();
    let Some((s, rest)) = state.session_split(view) else {
        return null();
    };
    let Some(clip) = rest
        .element_clipboard
        .as_mut()
        .filter(|c| !c.items.is_empty())
    else {
        return null();
    };
    let slide_index = prop(op_value, "slideIndex")?;
    if super::session::slide_index(slide_index, app.engine.slide_paths(s.deck()).len()).is_none() {
        return null();
    }
    let size = app.engine.size(s.deck());
    let scale = number(field(op_value, "fitWidthPx")) / (size.cx / EMU_PER_PX_96);
    // Cascade only past occupied spots
    let target_key = page_key(f64::from(view.0), number(slide_index));
    let shift_px = paste_shift_px(&clip.cascade, &target_key);
    let shift = js_round((shift_px / scale) * EMU_PER_PX_96);
    let request = TxnRequest::atomic(vec![
        op("pasteElements")
            .set("target", target(slide_index, None))
            .set("items", IpcValue::Array(clip.items.clone()))
            .set("dx", num(shift))
            .set("dy", num(shift))
            .build(),
    ]);
    let Some(r) = app.session_txn(s, request, OpSource::Edit) else {
        return null();
    };
    record_paste(&mut clip.cascade, &target_key);
    s.fit_width_px = number(field(op_value, "fitWidthPx"));
    let created = r
        .records
        .as_ref()
        .and_then(|r| r.first())
        .and_then(|rec| rec.created.clone())
        .unwrap_or_default();
    Ok(match app.rebuild_slide(s, slide_index) {
        Some(slide) => obj([("slide", slide), ("sourceIds", array_of_strings(&created))]),
        None => IpcValue::Null,
    })
}

pub fn duplicate_elements(app: &App, cx: &CallContext, args: Args) -> Reply {
    let op_value = args.get(0);
    app.with_session(cx.sender.view, |app, s| {
        let slide_index = prop(op_value, "slideIndex")?;
        let len = app.engine.slide_paths(s.deck()).len();
        let Some(slide) = super::session::slide_index(slide_index, len) else {
            return null();
        };
        let items = app
            .engine
            .copy_elements(s.deck(), slide, &source_ids(op_value))
            .unwrap_or_default();
        if items.is_empty() {
            return null();
        }
        let size = app.engine.size(s.deck());
        let scale = number(field(op_value, "fitWidthPx")) / (size.cx / EMU_PER_PX_96);
        let to_emu = |px: f64| js_round((px / scale) * EMU_PER_PX_96);
        let request = TxnRequest::atomic(vec![
            op("pasteElements")
                .set("target", target(slide_index, None))
                .set("items", IpcValue::Array(items))
                .set("dx", num(to_emu(number(field(op_value, "dxPx")))))
                .set("dy", num(to_emu(number(field(op_value, "dyPx")))))
                .build(),
        ]);
        let Some(r) = app.session_txn(s, request, OpSource::Edit) else {
            return null();
        };
        s.fit_width_px = number(field(op_value, "fitWidthPx"));
        let created = r
            .records
            .as_ref()
            .and_then(|r| r.first())
            .and_then(|rec| rec.created.clone())
            .unwrap_or_default();
        Ok(match app.rebuild_slide(s, slide_index) {
            Some(slide) => obj([("slide", slide), ("sourceIds", array_of_strings(&created))]),
            None => IpcValue::Null,
        })
    })
}

pub fn native_clipboard(app: &App, cx: &CallContext, args: Args) -> Reply {
    let command = match args.str(0) {
        Some("cut") => "cut",
        Some("copy") => "copy",
        _ => "paste",
    };
    app.shell.native_clipboard(cx.sender.view, command);
    Ok(IpcValue::Undefined)
}
