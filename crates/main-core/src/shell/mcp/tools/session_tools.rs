//! `apps/shell/src/main/mcp/tools/session-tools.ts`: the shared session
//! lifecycle for the visible-editing tools.
//!
//! The three families (docs / slides / sheets) each open a real tab and drive
//! it through their own bridge, but the *lifecycle* is identical: open a blank
//! tab, edit it, save it to a path, end the session. One pair of
//! `create_session` / `save_session` tools replaces six near-identical ones,
//! while each family module keeps owning its own tab and editor protocol
//! behind a [`FamilyDriver`]. One session is active at a time: creating a new
//! session replaces the previous one.
//!
//! Every `await` of the TypeScript that a renderer answers is a step here, not
//! a call: a handler returns [`ToolStep::Await`] with the [`HostCall`] it
//! waits for and the continuation that goes on with the answer ([`await_host`]).
//! The drivers name the host call each of their methods awaits; the target
//! resolver is the call [`resolve_target_call`]. The session host is the one
//! piece of state the tool set shares: [`SharedSessionHost`], an
//! `Rc<RefCell<..>>` made by [`create_session_host`].
//!
//! The bottom of the file holds the argument helpers the tool modules share
//! (`String(args.x ?? '')`, `args.x === true`, an object spread); the other
//! tool modules and the tool slices of the later waves import them from here.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::node_path::host::is_absolute;
use jscompat::{JsObject, JsonValue, to_primitive};

use super::formats::{SessionFamily, family_label, with_save_extension};
use crate::packages::i18n::PRODUCT_NAME;
use crate::packages::zod::z;
use crate::shell::mcp::mcp_server::{HostCall, McpToolDefinition, Settled, ToolHandler, ToolStep};

/// `options` of a [`resolve_target_call`]: `{ focus?: boolean }`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResolveOptions {
    pub focus: Option<bool>,
}

/// `TargetResolver`: resolve a document reference (tab id, or path) to the
/// webContents id of that open tab. The content tools call this when the
/// caller passed `document`, which redirects the edit from the session's own
/// blank tab to one the user has open; the bridges are addressed by
/// webContents id, so no session is involved.
///
/// With `focus`, the tab is also brought into view (activated, and the window
/// revealed) so the user watches the change land. Mutating tools ask for it;
/// reads do not, because an agent sweeping several tabs for context should
/// not make the UI jump along.
///
/// The resolution waits for the tab manager and the window, so on the one core
/// thread it is a step, not a method: this is the call the handler suspends on
/// (`TargetResolver.resolve(target, family, options?)`). The host answers the
/// webContents id as a number, or the message the resolver threw.
pub fn resolve_target_call(
    target: &str,
    family: SessionFamily,
    options: Option<ResolveOptions>,
) -> HostCall {
    let mut args = vec![
        JsonValue::String(target.to_owned()),
        JsonValue::String(family.as_str().to_owned()),
    ];
    if let Some(options) = options {
        let mut entries = JsObject::new();
        if let Some(focus) = options.focus {
            entries.set("focus", JsonValue::Bool(focus));
        }
        args.push(JsonValue::Object(entries));
    }
    HostCall {
        control: "TargetResolver",
        method: "resolve",
        args,
    }
}

/// `FamilyDriver`: one family's visible-session lifecycle, implemented by the
/// family's tool module. `open_blank_tab` opens the tab; `save` writes that
/// tab to disk through the family's own bridge. Both wait for a renderer, so a
/// driver does not run them: it names the host call each one awaits (the
/// family's control: `DocsControl.openBlankTab`, `DocsControl.runCommand`,
/// ...), and the session tools suspend on it. `open_blank_tab` is answered
/// with the new tab's webContents id; `save` with what the bridge answered
/// (`None` is `undefined`), where a driver that reports failure as data
/// answers `{ ok: false, .. }` instead of failing.
pub trait FamilyDriver {
    fn family(&self) -> SessionFamily;
    fn open_blank_tab(&self) -> HostCall;
    fn save(&self, wc_id: i64, path: &str, overwrite: bool) -> HostCall;
}

/// `ActiveSession`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActiveSession {
    pub family: SessionFamily,
    pub wc_id: i64,
}

/// `SessionHost`: the one active session, shared between the generic
/// lifecycle tools and the per-family content tools. Created per server so
/// tests and restarts start clean.
#[derive(Debug, Default)]
pub struct SessionHost {
    active: Option<ActiveSession>,
}

/// The session host as the tool factories take it.
pub type SharedSessionHost = Rc<RefCell<SessionHost>>;

impl SessionHost {
    pub fn begin(&mut self, family: SessionFamily, wc_id: i64) {
        self.active = Some(ActiveSession { family, wc_id });
    }

    /// the active session itself, or `None`
    pub fn current(&self) -> Option<ActiveSession> {
        self.active
    }

    /// the active session's tab id; fails with a guided error when there is
    /// none or it is another family
    pub fn require(&self, family: SessionFamily) -> Result<i64, String> {
        let Some(active) = self.active else {
            return Err("no session is open — call create_session first".to_owned());
        };
        if active.family != family {
            return Err(format!(
                "the active session is a {} — call create_session with family \"{}\" first",
                family_label(active.family.editor()),
                family.as_str()
            ));
        }
        Ok(active.wc_id)
    }

    pub fn end(&mut self) {
        self.active = None;
    }
}

/// `createSessionHost()`
pub fn create_session_host() -> SharedSessionHost {
    Rc::new(RefCell::new(SessionHost::default()))
}

/// `saveFailure(result)`: a driver's save result that reports failure as data
/// instead of throwing (sheets' `SaveOutcome`). Returns the message to raise,
/// or `None` on success.
fn save_failure(result: Option<&JsonValue>) -> Option<String> {
    let result = result?;
    // `typeof result !== 'object'`: an array has no `ok`, so it is a success
    let JsonValue::Object(object) = result else {
        return None;
    };
    // `ok !== false`
    if object.get("ok") != Some(&JsonValue::Bool(false)) {
        return None;
    }
    let detail = match (object.get("reason"), object.get("error")) {
        (Some(JsonValue::String(reason)), _) => Some(reason),
        (_, Some(JsonValue::String(error))) => Some(error),
        _ => None,
    };
    Some(match detail {
        Some(detail) if !detail.is_empty() => format!("the file could not be saved: {detail}"),
        _ => "the file could not be saved".to_owned(),
    })
}

/// The continuation a [`ContentTarget`] runs with the tab it found, or the
/// message of what the lookup threw.
pub type TargetThen<'h> = Box<dyn FnOnce(Result<i64, String>) -> ToolStep<'h> + 'h>;

/// The function [`content_target`] returns: where a content tool should send
/// its command. Called with `args.document` (`None` is `undefined`) and, for
/// a mutating tool, `{ focus: true }`, then the continuation of the handler
/// (`const wc = await target(..)` is `target(.., then)`). [`with_target`]
/// is the usual way to call it.
pub type ContentTarget<'h> =
    Rc<dyn Fn(Option<&JsonValue>, Option<ResolveOptions>, TargetThen<'h>) -> ToolStep<'h> + 'h>;

/// `contentTarget(host, resolveTarget, family)`: where a content tool should
/// send its command: the open document the caller named, or the session's own
/// tab when they named none.
///
/// Naming a document is the escape hatch from the single-session model: an
/// agent can edit the workbook the user is looking at without a
/// `create_session`, and without that session's blank tab being replaced. The
/// tab keeps its own dirty/save lifecycle: MCP edits land in the live document
/// and the user decides when to save (or the caller uses `open_documents
/// {action:"save"}`).
///
/// `resolve_target` is whether the shell wired a `TargetResolver` (absent in
/// headless/unit runs, where a `document` argument is refused). The resolver
/// itself awaits the tab manager and the window, so naming a document is a
/// host call ([`resolve_target_call`]) the continuation resumes from.
pub fn content_target<'h>(
    host: SharedSessionHost,
    resolve_target: bool,
    family: SessionFamily,
) -> ContentTarget<'h> {
    Rc::new(
        move |document: Option<&JsonValue>,
              options: Option<ResolveOptions>,
              then: TargetThen<'h>| {
            let named = match document {
                Some(JsonValue::String(text)) if !text.is_empty() => text,
                _ => {
                    let wc = host.borrow().require(family);
                    return then(wc);
                }
            };
            if !resolve_target {
                return then(Err(
                    "this build cannot target an open document; use create_session and its own tab instead"
                        .to_owned(),
                ));
            }
            await_host(
                resolve_target_call(named, family, options),
                move |settled| then(tab_id_of(settled)),
            )
        },
    )
}

/// `await target(args.document, options)` then `next(wc, args)`: the handler
/// of a content tool. A lookup that threw ends the tool with its message.
pub fn with_target<'h, F>(
    target: &ContentTarget<'h>,
    args: JsonValue,
    options: Option<ResolveOptions>,
    next: F,
) -> ToolStep<'h>
where
    F: FnOnce(i64, JsonValue) -> ToolStep<'h> + 'h,
{
    let document = args.get("document").map(|document| document.into_owned());
    target(
        document.as_ref(),
        options,
        Box::new(move |found| match found {
            Ok(wc) => next(wc, args),
            Err(message) => ToolStep::Done(Err(message)),
        }),
    )
}

/// `await` of a host call: the handler goes on in `then` once the host has
/// answered it ([`Settled`]: the value, `None` being `undefined`, or the
/// message it threw).
pub fn await_host<'h, F>(call: HostCall, then: F) -> ToolStep<'h>
where
    F: FnOnce(Settled) -> ToolStep<'h> + 'h,
{
    ToolStep::Await {
        call,
        then: Box::new(then),
    }
}

/// the webContents id a host answered to a call whose TypeScript gives a
/// `number` (`openBlankTab`, the target resolver)
pub fn tab_id_of(settled: Settled) -> Result<i64, String> {
    match settled {
        Ok(Some(JsonValue::Number(id))) => Ok(id as i64),
        Ok(_) => Err("the host answered no tab id".to_owned()),
        Err(message) => Err(message),
    }
}

/// A tool whose handler awaits no host call: what it computes is the tool's
/// answer at once (`ToolStep::Done`).
pub fn sync_handler<'h, F>(mut handler: F) -> ToolHandler<'h>
where
    F: FnMut(JsonValue) -> Result<Option<JsonValue>, String> + 'h,
{
    Box::new(move |args| ToolStep::Done(handler(args)))
}

/// `createSessionTools(drivers, host)`: `create_session` and `save_session`
/// over the families that have a driver; no tool at all without one.
pub fn create_session_tools<'h>(
    drivers: &[Rc<dyn FamilyDriver + 'h>],
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    if drivers.is_empty() {
        return Vec::new();
    }
    // `new Map(drivers.map((d) => [d.family, d]))`: the last driver of a family wins
    let drivers: Rc<Vec<Rc<dyn FamilyDriver + 'h>>> = Rc::new(drivers.to_vec());
    let families: Vec<&str> = drivers.iter().map(|d| d.family().as_str()).collect();
    let listing = drivers
        .iter()
        .map(|d| {
            format!(
                "{} ({})",
                d.family().as_str(),
                family_label(d.family().editor())
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let create_drivers = Rc::clone(&drivers);
    let create_host = Rc::clone(&host);
    let create_session = McpToolDefinition {
        name: "create_session".to_owned(),
        description: format!(
            "Open a new empty file in a visible SeuOffice tab and start an editing session; family picks the editor: {listing}. \
             Then add content with that family's tools (docs: insert_content / replace_blocks / apply_ops; slides: apply_slide_ops; sheets: apply_sheet_ops) and finish with save_session. \
             One session is active at a time — a new create_session replaces it. The user watches each step in the app."
        ),
        input_schema: Some(z::shape(vec![(
            "family",
            z::enum_(&families).describe("which editor to open"),
        )])),
        handler: Box::new(move |args: JsonValue| {
            let family_arg = args.get("family");
            let driver = match family_arg.as_deref() {
                Some(JsonValue::String(name)) => driver_of(&create_drivers, name),
                _ => None,
            };
            let Some(driver) = driver else {
                return ToolStep::Done(
                    string_of(family_arg.as_deref())
                        .and_then(|name| Err(format!("unknown family \"{name}\""))),
                );
            };
            let family = driver.family();
            let host = Rc::clone(&create_host);
            // `const wcId = await driver.openBlankTab()`
            await_host(driver.open_blank_tab(), move |settled| {
                let wc_id = match tab_id_of(settled) {
                    Ok(wc_id) => wc_id,
                    Err(message) => return ToolStep::Done(Err(message)),
                };
                host.borrow_mut().begin(family, wc_id);
                ToolStep::Done(Ok(Some(js_object(vec![
                    ("ok", JsonValue::Bool(true)),
                    ("family", JsonValue::String(family.as_str().to_owned())),
                    ("sessionId", JsonValue::Number(wc_id as f64)),
                    (
                        "message",
                        JsonValue::String(format!(
                            "A new empty {} is open in {PRODUCT_NAME}. Add content, then call save_session.",
                            family_label(family.editor())
                        )),
                    ),
                ]))))
            })
        }),
    };

    let save_drivers = Rc::clone(&drivers);
    let save_host = host;
    let save_session = McpToolDefinition {
        name: "save_session".to_owned(),
        description: concat!(
            "Save the active session to an absolute path and end it. A path with no extension gets the ",
            "active family's file format appended (docx: .docx; xlsx: .xlsx; pptx: .pptx); a different ",
            "extension is refused. Refuses to replace an existing file unless overwrite is true. This is ",
            "the output step."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("path", z::string().describe("absolute output path for the file")),
            (
                "overwrite",
                z::boolean()
                    .optional()
                    .describe("allow replacing an existing file at `path`; default false"),
            ),
        ])),
        handler: Box::new(move |args: JsonValue| {
            // everything before `await driver.save(..)` runs without the host
            let prepared = (|| {
                let Some(session) = save_host.borrow().current() else {
                    return Err("no session is open — call create_session first".to_owned());
                };
                let Some(driver) = driver_of(&save_drivers, session.family.as_str()) else {
                    return Err(format!(
                        "no driver for the active \"{}\" session",
                        session.family.as_str()
                    ));
                };
                let requested = string_or_empty(&args, "path")?;
                if !is_absolute(&requested) {
                    return Err("path must be absolute".to_owned());
                }
                let file_path = with_save_extension(session.family, &requested)?;
                Ok(driver.save(session.wc_id, &file_path, is_true(&args, "overwrite")))
            })();
            let call = match prepared {
                Ok(call) => call,
                Err(message) => return ToolStep::Done(Err(message)),
            };
            let host = Rc::clone(&save_host);
            await_host(call, move |settled| {
                let result = match settled {
                    Ok(result) => result,
                    Err(message) => return ToolStep::Done(Err(message)),
                };
                // Some drivers report a failed write as data rather than by throwing
                // (sheets returns the renderer's SaveOutcome `{ok:false}`), so returning
                // it verbatim would tell the agent the file was written when it was not.
                // Raise a tool error and keep the session open: the edits are still in
                // the tab, so the caller can correct the path and retry instead of
                // rebuilding the document from scratch.
                if let Some(failure) = save_failure(result.as_ref()) {
                    return ToolStep::Done(Err(failure));
                }
                host.borrow_mut().end();
                // Normalize the success shape: drivers differ (docs returns `{ok,path}`,
                // slides just `{path}`), and an agent that checks `ok` on every family
                // would read the slides save as a failure. A driver that returned a
                // non-object is reported as-is under `result` rather than being spread
                // into the response as indexed characters.
                let mut out = JsObject::new();
                out.set("ok", JsonValue::Bool(true));
                match &result {
                    Some(detail @ (JsonValue::Object(_) | JsonValue::Array(_))) => {
                        spread(&mut out, detail);
                    }
                    Some(other) => out.set("result", other.clone()),
                    None => {}
                }
                ToolStep::Done(Ok(Some(JsonValue::Object(out))))
            })
        }),
    };

    vec![create_session, save_session]
}

/// `byFamily.get(name)`
fn driver_of<'a, 'h>(
    drivers: &'a [Rc<dyn FamilyDriver + 'h>],
    name: &str,
) -> Option<&'a Rc<dyn FamilyDriver + 'h>> {
    drivers.iter().rev().find(|d| d.family().as_str() == name)
}

// ---- argument helpers shared by the tool modules ----

/// `{ a, b, .. }` with the keys in the order given
pub fn js_object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

/// `String(value)` (what a template literal writes too), `None` being
/// `undefined`. `Err` is the `TypeError` of a value that converts to nothing.
pub fn string_of(value: Option<&JsonValue>) -> Result<String, String> {
    to_primitive(value)
        .map(|primitive| primitive.to_js_string())
        .map_err(|error| error.0)
}

/// `String(args[key] ?? '')`
pub fn string_or_empty(args: &JsonValue, key: &str) -> Result<String, String> {
    match args.get(key).as_deref() {
        None | Some(JsonValue::Null) => Ok(String::new()),
        value => string_of(value),
    }
}

/// `typeof args[key] === 'string' ? args[key] : undefined`
pub fn string_arg(args: &JsonValue, key: &str) -> Option<String> {
    match args.get(key).as_deref() {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `args[key] === true`
pub fn is_true(args: &JsonValue, key: &str) -> bool {
    matches!(args.get(key).as_deref(), Some(JsonValue::Bool(true)))
}

/// the entries `{ ...source }` copies: an object's own entries, an array's
/// items under their indexes, a string's code units under theirs; anything
/// else spreads nothing
fn spread_entries(source: &JsonValue) -> Vec<(String, JsonValue)> {
    match source {
        JsonValue::Object(object) => object
            .entries()
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.clone()))
            .collect(),
        JsonValue::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        JsonValue::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                (
                    index.to_string(),
                    JsonValue::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => Vec::new(),
    }
}

/// `{ ...target, ...source }` for one source (see [`ObjectDraft`] for a result
/// whose own values can be `undefined`)
pub fn spread(target: &mut JsObject<JsonValue>, source: &JsonValue) {
    for (key, value) in spread_entries(source) {
        target.set(key, value);
    }
}

/// An object literal under construction, `{ a: x, b: y, ...detail }`, whose
/// own values may be `undefined` (`None`): such a key holds its place in the
/// key order (a later spread of the same key fills it where it is) and is left
/// out of the JSON [`ObjectDraft::finish`] writes, as `JSON.stringify` leaves
/// it out.
#[derive(Default)]
pub struct ObjectDraft {
    entries: JsObject<Option<JsonValue>>,
}

impl ObjectDraft {
    pub fn new() -> Self {
        ObjectDraft::default()
    }

    /// `object[key] = value`
    pub fn set(&mut self, key: &str, value: Option<JsonValue>) {
        self.entries.set(key, value);
    }

    /// `...source`
    pub fn spread(&mut self, source: &JsonValue) {
        for (key, value) in spread_entries(source) {
            self.entries.set(key, Some(value));
        }
    }

    /// the object as `JSON.parse(JSON.stringify(object))` reads it
    pub fn finish(self) -> JsonValue {
        JsonValue::Object(
            self.entries
                .entries()
                .into_iter()
                .filter_map(|(key, value)| value.clone().map(|value| (key.to_owned(), value)))
                .collect(),
        )
    }
}
