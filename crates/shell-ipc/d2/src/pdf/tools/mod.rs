//! The shell's PDF tools: structure jobs and the result store
//! (`pdf-structure-ipc.ts`, `pdf-structure/handlers.ts`, [`structure`]), the
//! tools window (`pdf-tools/`, [`window`]), the password dialog
//! (`pdf-password-dialog.ts`, [`password`]), the conversion screen
//! (`pdf-convert-ui.ts`) and `pdf:convert-office` of `shell/index.ts`
//! ([`convert`]).
//!
//! What other areas call (`requestPdfConvertDialog`, `promptPdfPassword`,
//! `grantPdfStructureTarget`, `openPdfToolsWithFile`, ...) are methods of
//! [`PdfTools`], which `entries` adds to the provided table.

mod convert;
mod hosts;
mod options;
mod password;
mod runner;
mod structure;
mod window;

use std::rc::Rc;
use std::sync::{Arc, Mutex};

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, FallbackDir, show_open_dialog_with_memory, show_save_dialog_with_memory,
};
use shell_contract::app_actions::{DocumentConversions, PdfExport};
use shell_contract::hosts::{
    ContentsHost, Dialogs, DialogsHost, FileDialog, FileFilter, MainWindowHost, OsShellHost,
};
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcValue, Provided, ViewId, WindowId};

pub use hosts::*;

use super::Grants;
use crate::kit::{Entry, IntoIpc};

/// What every part of the tools reaches: the services, the hosts, the
/// grants of the editor, one dialog memory and the job runner
pub(crate) struct Ctx {
    pub services: Services,
    pub engine: PdfToolsEngineHost,
    pub shell: PdfToolsShellHost,
    pub dialogs: DialogsHost,
    pub contents: ContentsHost,
    pub os: OsShellHost,
    pub main_window: MainWindowHost,
    pub grants: Grants,
    /// `showOpenDialogWithMemory` keys its memory by Electron's one `dialog`
    memory: Arc<Mutex<DialogMemory>>,
    pub runner: runner::Runner,
}

impl Ctx {
    /// `showOpenDialogWithMemory(dialog, parent, options, fallbackDir)`:
    /// the picked paths, `None` when cancelled
    pub fn show_open(
        &self,
        parent: Option<WindowId>,
        options: JsObject<JsonValue>,
        fallback: Option<&str>,
    ) -> Option<Vec<String>> {
        let result = show_open_dialog_with_memory(
            &mut self.memory.lock().unwrap_or_else(|e| e.into_inner()),
            &mut HostDialog(&*self.dialogs),
            parent.as_ref(),
            &options,
            fallback,
        );
        if result.get("canceled").is_some_and(|c| c.truthy()) {
            return None;
        }
        Some(match result.get("filePaths").as_deref() {
            Some(JsonValue::Array(paths)) => paths
                .iter()
                .filter_map(|p| match p {
                    JsonValue::String(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
    }

    /// `showSaveDialogWithMemory(dialog, parent, options)`: the picked path,
    /// `None` when cancelled or empty
    pub fn show_save(
        &self,
        parent: Option<WindowId>,
        options: JsObject<JsonValue>,
    ) -> Option<String> {
        let result = show_save_dialog_with_memory(
            &mut self.memory.lock().unwrap_or_else(|e| e.into_inner()),
            &mut HostDialog(&*self.dialogs),
            parent.as_ref(),
            &options,
            None::<&FallbackDir<'_>>,
        );
        if result.get("canceled").is_some_and(|c| c.truthy()) {
            return None;
        }
        match result.get("filePath").as_deref() {
            Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
            _ => None,
        }
    }

    /// `!contents.isDestroyed()`
    pub fn alive(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_some()
    }

    /// `BrowserWindow.fromWebContents(contents)`
    pub fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.contents.window_of(view)
    }
}

/// The shared dialog host as `dialog-memory`'s `Dialog`
struct HostDialog<'a>(&'a dyn Dialogs);

fn file_dialog(options: &JsObject<JsonValue>) -> FileDialog {
    let text = |key: &str| match options.get(key) {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    let strings = |v: Option<&JsonValue>| match v {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|i| match i {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let filters = match options.get("filters") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|f| FileFilter {
                name: match f.get("name").as_deref() {
                    Some(JsonValue::String(s)) => s.clone(),
                    _ => String::new(),
                },
                extensions: strings(f.get("extensions").as_deref()),
            })
            .collect(),
        _ => Vec::new(),
    };
    FileDialog {
        title: text("title"),
        default_path: text("defaultPath").map(Into::into),
        button_label: text("buttonLabel"),
        filters,
        properties: strings(options.get("properties")),
    }
}

impl Dialog for HostDialog<'_> {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.open(parent.copied(), &file_dialog(options));
        let mut out = JsObject::new();
        out.set("canceled", JsonValue::Bool(picked.is_none()));
        out.set(
            "filePaths",
            JsonValue::Array(
                picked
                    .unwrap_or_default()
                    .iter()
                    .map(|p| JsonValue::String(p.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        JsonValue::Object(out)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.save(parent.copied(), &file_dialog(options));
        let mut out = JsObject::new();
        out.set("canceled", JsonValue::Bool(picked.is_none()));
        if let Some(path) = picked {
            out.set(
                "filePath",
                JsonValue::String(path.to_string_lossy().into_owned()),
            );
        }
        JsonValue::Object(out)
    }
}

/// Dialog options as an object literal
pub(crate) fn options<const N: usize>(
    entries: [(&str, Option<JsonValue>); N],
) -> JsObject<JsonValue> {
    let mut out = JsObject::new();
    for (k, v) in entries {
        if let Some(v) = v {
            out.set(k, v);
        }
    }
    out
}

pub(crate) fn js_str(s: &str) -> JsonValue {
    JsonValue::String(s.to_owned())
}

pub(crate) fn js_strs(items: &[&str]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| js_str(s)).collect())
}

/// `[{ name, extensions }]`
pub(crate) fn js_filter(name: &str, extensions: &[&str]) -> JsonValue {
    let mut f = JsObject::new();
    f.set("name", js_str(name));
    f.set("extensions", js_strs(extensions));
    JsonValue::Array(vec![JsonValue::Object(f)])
}

// ── values as the TypeScript reads and builds them ──

/// `typeof v === 'object' && v !== null && !Array.isArray(v)`
pub(crate) fn is_record(v: &IpcValue) -> bool {
    matches!(
        v,
        IpcValue::Object(_) | IpcValue::Bytes(..) | IpcValue::Date(_)
    )
}

/// `Number.isSafeInteger(v)`
pub(crate) fn safe_int(v: &IpcValue) -> Option<f64> {
    match v {
        IpcValue::Number(n) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 => Some(*n),
        _ => None,
    }
}

/// `text.length` (UTF-16 code units)
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `{ ...value, key: v }`: the key keeps its place when `value` has it
pub(crate) fn with(mut value: IpcValue, key: &str, v: IpcValue) -> IpcValue {
    if let IpcValue::Object(entries) = &mut value {
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = v,
            None => entries.push((key.to_owned(), v)),
        }
        value
    } else {
        IpcValue::Object(vec![(key.to_owned(), v)])
    }
}

/// `{ ok: true, ...value }`
pub(crate) fn ok_with(value: IpcValue) -> IpcValue {
    let mut out = vec![("ok".to_owned(), true.into_ipc())];
    if let IpcValue::Object(entries) = value {
        for (k, v) in entries {
            match out.iter_mut().find(|(o, _)| *o == k) {
                Some(slot) => slot.1 = v,
                None => out.push((k, v)),
            }
        }
    }
    IpcValue::Object(out)
}

/// An integer as JavaScript prints it
pub(crate) fn int_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The calls other areas make into the PDF tools
pub struct PdfTools {
    ctx: Rc<Ctx>,
    structure: structure::Structure,
    window: window::Window,
    password: password::Password,
    convert: convert::Convert,
}

// called by other areas (menus, Save As, the editor's ribbon) through the provided table
impl PdfTools {
    /// `requestPdfConvertDialog(contents, format, outPath)`
    pub fn request_convert_dialog(
        &self,
        view: Option<ViewId>,
        format: &str,
        out_path: Option<&str>,
    ) {
        convert::request_convert_dialog(&self.ctx, view, format, out_path)
    }

    /// `promptPdfPassword(parent, state)`: `then` gets the entered password,
    /// `None` when the user cancelled or closed the window
    pub fn prompt_password(
        &self,
        parent: Option<WindowId>,
        state: IpcValue,
        then: Box<dyn FnOnce(Option<String>)>,
    ) {
        self.password.prompt(parent, state, then)
    }

    /// `closePdfPasswordDialog()`
    pub fn close_password_dialog(&self) {
        self.password.close()
    }

    /// `grantPdfStructureTarget(contents, sourcePath, outPath, kind)`
    pub fn grant_structure_target(
        &self,
        view: ViewId,
        source: &str,
        out_path: &str,
        kind: &str,
    ) -> bool {
        self.ctx.alive(view) && self.structure.grant_target(view, source, out_path, kind)
    }

    /// `openPdfToolsWithFile(path, tool)`
    pub fn open_with_file(&self, path: &str, tool: &str) -> bool {
        self.window.open_with_file(path, tool)
    }

    /// `openPdfToolsWindow()`
    pub fn open_window(&self) {
        self.window.open_window()
    }

    /// `exportPdfAs{Docx,Pptx,Xlsx}Local(preset)`: Save As › Word,
    /// PowerPoint, Excel with the tab and target its dialog picked; without
    /// a preset, the active pdf tab and a save dialog
    pub fn export_office(
        &self,
        format: PdfExport,
        preset: Option<(PdfTab, String)>,
        then: Box<dyn FnOnce()>,
    ) {
        self.convert.export_office(format, preset, then)
    }

    /// `app.on('will-quit', () => runner.cancelAll())`
    pub fn cancel_all(&self) -> usize {
        self.ctx.runner.cancel_all()
    }
}

/// The File menus' conversions (batch M calls them)
impl DocumentConversions for PdfTools {
    /// `exportPdfAs{Docx,Pptx,Xlsx}Local()`: the active pdf tab converts, as
    /// in the TypeScript, whichever view the menu was used in
    fn export_pdf_as(&self, _view: ViewId, format: PdfExport) {
        self.export_office(format, None, Box::new(|| {}))
    }

    /// `importPdfAsHwp()`: the tab the menu was used in keeps its document
    fn import_pdf_into_hwp(&self, _view: ViewId) {
        self.convert.import_pdf_into_hwp()
    }
}

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
    grants: &Grants,
) -> Result<Vec<Entry>, RegisterError> {
    let hosts = &services.hosts;
    let ctx = Rc::new(Ctx {
        services: services.clone(),
        engine: hosts.need::<PdfToolsEngineHost>(Batch::D2)?,
        shell: hosts.need::<PdfToolsShellHost>(Batch::D2)?,
        dialogs: hosts.need::<DialogsHost>(Batch::D2)?,
        contents: hosts.need::<ContentsHost>(Batch::D2)?,
        os: hosts.need::<OsShellHost>(Batch::D2)?,
        main_window: hosts.need::<MainWindowHost>(Batch::D2)?,
        grants: grants.clone(),
        memory: hosts.need::<Arc<Mutex<DialogMemory>>>(Batch::D2)?,
        runner: runner::Runner::new(services),
    });
    let password = password::Password::new(&ctx);
    let structure = structure::Structure::new(&ctx);
    let window = window::Window::new(&ctx);
    let convert = convert::Convert::new(&ctx, &password);
    let mut all = Vec::new();
    all.extend(password.entries());
    all.extend(structure.entries());
    all.extend(window.entries());
    all.extend(convert.entries());
    let tools = Rc::new(PdfTools {
        ctx,
        structure,
        window,
        password,
        convert,
    });
    provided.add::<dyn DocumentConversions>(tools.clone());
    provided.add::<PdfTools>(tools);
    Ok(all)
}

/// The calls the shell makes into the PDF tools outside a channel, as
/// ipc-probe's `trigger` steps name them (`d2/pdf-tools:<what>`). `args` are
/// the step's arguments; `then` gets the outcome. False for an unknown `what`.
#[cfg(feature = "probe")]
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &serde_json::Value,
    services: &Services,
    provided: &Rc<Provided>,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    let Some(tools) = provided.all::<PdfTools>().pop() else {
        return false;
    };
    let s = |i: usize| args.get(i).and_then(serde_json::Value::as_str);
    let answer = match what {
        // `createPdfView(openPath)`'s `grantAndTrack`: the view's only grant is its file
        "open-view" => {
            let mut allowed = std::collections::HashSet::new();
            if let Some(path) = s(0).filter(|p| std::path::Path::new(p).exists()) {
                allowed.insert(path.to_owned());
            }
            tools.ctx.grants.0.insert(view, allowed);
            IpcValue::Undefined
        }
        "request-convert-dialog" => {
            tools.request_convert_dialog(Some(view), s(0).unwrap_or(""), s(1));
            IpcValue::Undefined
        }
        // the attempt's password goes to the log when the prompt settles, after
        // the call that settled it, as the TypeScript promise's `then` runs
        "prompt-password" => {
            let log = services.hosts.get::<hosts::fake::ProbeLog>().cloned();
            let core = services.core.clone();
            let state = crate::kit::from_json(args.get(0).unwrap_or(&serde_json::Value::Null));
            tools.prompt_password(
                tools.ctx.window_of(view),
                state,
                Box::new(move |password| {
                    if let Some(log) = log {
                        core.post(Box::new(move || {
                            log.lock()
                                .unwrap()
                                .push(serde_json::json!(["promptPdfPassword.settled", password]))
                        }));
                    }
                }),
            );
            IpcValue::Undefined
        }
        "close-password-dialog" => {
            tools.close_password_dialog();
            IpcValue::Undefined
        }
        "grant-structure-target" => IpcValue::Bool(tools.grant_structure_target(
            view,
            s(0).unwrap_or(""),
            s(1).unwrap_or(""),
            s(2).unwrap_or(""),
        )),
        "open-with-file" => {
            IpcValue::Bool(tools.open_with_file(s(0).unwrap_or(""), s(1).unwrap_or("")))
        }
        "open-window" => {
            tools.open_window();
            IpcValue::Undefined
        }
        "cancel-all" => IpcValue::Number(tools.cancel_all() as f64),
        // the File menu's Export as Word / PowerPoint / Excel: the answer
        // waits for the flow, as the TypeScript's `await` does
        "export-pdf-as" => {
            let format = match s(0) {
                Some("docx") => PdfExport::Docx,
                Some("pptx") => PdfExport::Pptx,
                Some("xlsx") => PdfExport::Xlsx,
                // the menu offers no other
                _ => {
                    then(Ok(IpcValue::Undefined));
                    return true;
                }
            };
            tools.export_office(
                format,
                None,
                Box::new(move || then(Ok(IpcValue::Undefined))),
            );
            return true;
        }
        "import-pdf-into-hwp" => {
            let conversions = shell_contract::app_actions::document_conversions(provided);
            conversions
                .expect("the tools provide it")
                .import_pdf_into_hwp(view);
            IpcValue::Undefined
        }
        _ => return false,
    };
    then(Ok(answer));
    true
}

/// The fakes of this part's hosts: one [`hosts::fake::Fake`] for both
/// traits, answering from `case.tools` (`hosts.d2.pdf.tools`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let log = hosts.get::<hosts::fake::ProbeLog>().cloned();
    let fake = std::sync::Arc::new(hosts::fake::Fake::new(
        case.get("tools").unwrap_or(&serde_json::Value::Null),
        log,
    ));
    hosts.insert::<PdfToolsEngineHost>(fake.clone());
    hosts.insert::<PdfToolsShellHost>(fake);
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A shell with the tools registered and a handle on their fake
    use std::cell::RefCell;
    use std::sync::Arc;

    use serde_json::Value;
    use shell_contract::{IpcValue, Surface, ViewId};

    use super::hosts::fake::Fake;
    use super::*;
    use crate::testing::Rt;

    pub struct T {
        pub rt: Rt,
        pub fake: Arc<Fake>,
    }

    fn register(services: &Services, provided: &Rc<Provided>) -> Result<Vec<Entry>, RegisterError> {
        // the editor's grants: tests grant through the map this creates
        let grants = GRANTS
            .with(|g| g.borrow().clone())
            .unwrap_or_else(|| Grants(crate::kit::ViewMap::new(services)));
        GRANTS.with(|g| *g.borrow_mut() = Some(grants.clone()));
        entries(services, provided, &grants)
    }

    thread_local! {
        static GRANTS: RefCell<Option<Grants>> = const { RefCell::new(None) };
    }

    pub fn tools(case: Value) -> T {
        GRANTS.with(|g| *g.borrow_mut() = None);
        let fake = Arc::new(Fake::new(&case, None));
        let f = fake.clone();
        let mut rt = Rt::new(move |h| {
            h.insert::<PdfToolsEngineHost>(f.clone());
            h.insert::<PdfToolsShellHost>(f);
        });
        rt.register(register).unwrap();
        T { rt, fake }
    }

    impl T {
        /// `allowedByWc`: give `view` the file
        pub fn grant(&self, view: u32, path: &str) {
            GRANTS.with(|g| {
                let g = g.borrow();
                let grants = g.as_ref().unwrap();
                if !grants.0.contains(ViewId(view)) {
                    grants.0.insert(ViewId(view), Default::default());
                }
                grants.0.with(ViewId(view), |set| {
                    set.unwrap().insert(path.to_owned());
                });
            })
        }

        pub fn tools(&self) -> Rc<PdfTools> {
            self.rt.provided().all::<PdfTools>().pop().unwrap()
        }

        pub fn pdf_view(&self, id: u32) -> shell_contract::ipc::Sender {
            self.rt.view(id, Surface::Pdf)
        }

        pub fn call(
            &mut self,
            channel: &str,
            from: shell_contract::ipc::Sender,
            args: Vec<IpcValue>,
        ) -> IpcValue {
            self.rt.invoke_now(channel, from, args).unwrap()
        }

        /// a temp file with these bytes; its path
        pub fn file(&self, name: &str, bytes: &[u8]) -> String {
            let path = self.rt.dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    /// an IpcValue from JSON, `{"$u8": [..]}` as bytes
    pub fn v(json: Value) -> IpcValue {
        super::hosts::fake::ipc(&json)
    }

    /// what a test compares a reply with
    pub fn j(v: &IpcValue) -> Value {
        crate::kit::to_json(v).unwrap_or(Value::Null)
    }
}

#[cfg(all(test, feature = "probe"))]
mod trigger_tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use serde_json::json;
    use shell_contract::{IpcValue, ViewId};

    use super::test_support::*;

    fn trigger(t: &T, what: &str, view: u32, args: serde_json::Value) -> Option<IpcValue> {
        let got = Rc::new(RefCell::new(None));
        let g = got.clone();
        let known = super::probe_trigger(
            what,
            ViewId(view),
            &args,
            &t.rt.services,
            &t.rt.provided(),
            Box::new(move |r| *g.borrow_mut() = Some(r.unwrap())),
        );
        assert!(known || got.borrow().is_none());
        got.take()
    }

    #[test]
    fn triggers_reach_the_tools_and_unknown_names_are_refused() {
        let mut t = tools(json!({}));
        assert_eq!(trigger(&t, "no-such-thing", 5, json!([])), None);
        let pdf = t.pdf_view(5);
        let src = t.file("a.pdf", b"x");
        // the view set-up grants the view its existing file only
        trigger(&t, "open-view", 5, json!([t.rt.dir.join("gone.pdf")]));
        assert_eq!(
            j(&t.call("pdf:store-doc-hash", pdf, vec![v(json!(src))]))["error"],
            json!("not-granted")
        );
        assert_eq!(
            trigger(&t, "open-view", 5, json!([src])),
            Some(IpcValue::Undefined)
        );
        assert_eq!(
            j(&t.call("pdf:store-doc-hash", pdf, vec![v(json!(src))]))["ok"],
            json!(true)
        );
        let out = t.rt.dir.join("a.md").to_string_lossy().into_owned();
        assert_eq!(
            trigger(&t, "grant-structure-target", 5, json!([src, out, "md"])),
            Some(IpcValue::Bool(true))
        );
        assert_eq!(
            trigger(&t, "grant-structure-target", 5, json!([src, src, "md"])),
            Some(IpcValue::Bool(false))
        );
        trigger(&t, "request-convert-dialog", 5, json!(["md"]));
        assert_eq!(j(&t.rt.events()[0].args[0]), json!({ "format": "md" }));
        assert_eq!(
            trigger(&t, "cancel-all", 5, json!([])),
            Some(IpcValue::Number(0.0))
        );
    }
}
