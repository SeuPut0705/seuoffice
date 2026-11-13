//! `apps/shell/src/main/mcp/docs-bridge.ts` and `sheets-bridge.ts`: the shell
//! half of the MCP to editor bridges.
//!
//! The renderer of a docs or sheets tab announces itself (`docs:mcp-ready`),
//! the shell pushes one command at a time (`docs:mcp-command`) and the tab
//! answers it (`docs:mcp-result`). The two calls the MCP tool layer makes
//! (`createDocsControl(deps)`: `openBlankTab`, `runCommand`) wait for those
//! messages, so here they are resumable: [`McpBridgeControl`] takes a
//! continuation that the bridge runs on the core thread when the renderer
//! answered (or a timer ended the wait). Nothing waits on the core thread.
//!
//! The control is what the port adds to [`Provided`]; the MCP server's tools
//! find it there.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::shell::mcp::docs_bridge::{DocsBridge, DocsBridgeHost, Settled, Submitted};
use main_core::shell::mcp::sheets_bridge::{SheetsBridge, SheetsBridgeHost};
use main_core::shell::mcp::tools::document_tools::McpEditorCommandName;
use main_core::shell::mcp::tools::sheets_tools::SheetsCommandName;
use shell_contract::editors::Then;
use shell_contract::ipc::{CallContext, Responder, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::actor::Clock;
use crate::ports::McpDocumentBridges;
use crate::value::{arg, from_json};

/// The tabs the MCP tools open and close for the bridges (`openBlankDocsTabForMcp`
/// and its twins of the shell entry). Called on the core thread.
pub trait McpTabs: Send + Sync {
    /// `openBlankDocsTabForMcp()`: a fresh blank docs tab; its view
    fn open_blank_docs_tab(&self) -> ViewId;
    /// `authorizeMcpDocWrite(wcId, filePath)`
    fn authorize_docs_save(&self, view: ViewId, path: &str);
    /// `abandonBlankTabForMcp(docsTabs, wcId)`
    fn abandon_blank_docs_tab(&self, view: ViewId);
    /// `openBlankSheetsTabForMcp()`: a fresh blank sheets tab with its
    /// backing workbook file; its view, or the message it rejects with
    fn open_blank_sheets_tab(&self) -> Result<ViewId, String>;
    /// `authorizeMcpSheetWrite(wcId, filePath)`
    fn authorize_sheets_save(&self, view: ViewId, path: &str);
    /// `abandonBlankSheetsTabForMcp(wcId)`: close the tab and delete its empty workbook
    fn abandon_blank_sheets_tab(&self, view: ViewId);
}

pub type McpTabsHost = Arc<dyn McpTabs>;

/// What the MCP tool layer calls: `DocsControl` and `SheetsControl`. Each
/// takes the continuation its promise's reaction becomes.
pub trait McpBridgeControl {
    /// `DocsControl.openBlankTab()`: resolves with the tab's webContents id
    fn docs_open_blank_tab(&self, then: Then<Option<JsonValue>>);
    /// `DocsControl.runCommand(wcId, command, payload)`
    fn docs_run_command(
        &self,
        wc_id: i64,
        command: McpEditorCommandName,
        payload: Option<JsonValue>,
        then: Then<Option<JsonValue>>,
    );
    /// `SheetsControl.openBlankTab()`
    fn sheets_open_blank_tab(&self, then: Then<Option<JsonValue>>);
    /// `SheetsControl.runCommand(wcId, command, payload)`
    fn sheets_run_command(
        &self,
        wc_id: i64,
        command: SheetsCommandName,
        payload: Option<JsonValue>,
        then: Then<Option<JsonValue>>,
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Docs,
    Sheets,
}

impl Kind {
    fn command_channel(self) -> &'static str {
        match self {
            Kind::Docs => "docs:mcp-command",
            Kind::Sheets => "sheets:mcp-command",
        }
    }
}

/// What both bridges' hosts share
struct Common {
    services: Services,
    tabs: McpTabsHost,
    clock: Clock,
    /// promises settled inside a bridge call, handed out once it returned
    settled: RefCell<Vec<(Kind, u64, Settled)>>,
    id: u64,
}

struct FamilyHost {
    common: Rc<Common>,
    kind: Kind,
}

fn view_of(wc_id: i64) -> Option<ViewId> {
    u32::try_from(wc_id).ok().map(ViewId)
}

impl FamilyHost {
    fn alive(&self, wc_id: i64) -> bool {
        view_of(wc_id).is_some_and(|view| self.common.services.views.sender_of(view).is_some())
    }

    fn send(&self, wc_id: i64, request_id: &str, command: &str, payload: Option<&JsonValue>) {
        let Some(view) = view_of(wc_id) else { return };
        // `wc.send(channel, { requestId, command, payload })` keeps the
        // `payload` key when it is `undefined`, so the wire message does too.
        let message = IpcValue::Object(vec![
            (
                "requestId".to_owned(),
                IpcValue::String(request_id.to_owned()),
            ),
            ("command".to_owned(), IpcValue::String(command.to_owned())),
            (
                "payload".to_owned(),
                payload.map_or(IpcValue::Undefined, from_json),
            ),
        ]);
        self.common.services.events.emit(
            Target::View(view),
            self.kind.command_channel(),
            vec![message],
        );
    }

    fn set_timeout(&self, ms: f64) -> u64 {
        let core = self.common.services.core.clone();
        let hub = self.common.id;
        let kind = self.kind;
        self.common.clock.set(ms, move |timer| {
            core.post(Box::new(move || {
                with_bridges(hub, |bridges| bridges.on_timeout(kind, timer));
            }));
        })
    }
}

impl DocsBridgeHost for FamilyHost {
    fn web_contents_alive(&mut self, wc_id: i64) -> bool {
        self.alive(wc_id)
    }

    /// `wc.once('destroyed', ..)`: the views' destruction is listened to once, for every tab
    fn watch_destroyed(&mut self, _wc_id: i64) {}

    fn send_command(
        &mut self,
        wc_id: i64,
        request_id: &str,
        command: McpEditorCommandName,
        payload: Option<&JsonValue>,
    ) {
        self.send(wc_id, request_id, command.as_str(), payload);
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        FamilyHost::set_timeout(self, ms)
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.common.clock.clear(timer);
    }

    fn settle(&mut self, op: u64, outcome: Settled) {
        self.common
            .settled
            .borrow_mut()
            .push((self.kind, op, outcome));
    }

    fn exists_sync(&mut self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn open_blank_tab(&mut self) -> i64 {
        i64::from(self.common.tabs.open_blank_docs_tab().0)
    }

    fn authorize_save(&mut self, wc_id: i64, file_path: &str) {
        if let Some(view) = view_of(wc_id) {
            self.common.tabs.authorize_docs_save(view, file_path);
        }
    }

    fn abandon_blank_tab(&mut self, wc_id: i64) {
        if let Some(view) = view_of(wc_id) {
            self.common.tabs.abandon_blank_docs_tab(view);
        }
    }
}

impl SheetsBridgeHost for FamilyHost {
    fn web_contents_alive(&mut self, wc_id: i64) -> bool {
        self.alive(wc_id)
    }

    fn watch_destroyed(&mut self, _wc_id: i64) {}

    fn send_command(
        &mut self,
        wc_id: i64,
        request_id: &str,
        command: SheetsCommandName,
        payload: Option<&JsonValue>,
    ) {
        self.send(wc_id, request_id, command.as_str(), payload);
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        FamilyHost::set_timeout(self, ms)
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.common.clock.clear(timer);
    }

    fn settle(&mut self, op: u64, outcome: Settled) {
        self.common
            .settled
            .borrow_mut()
            .push((self.kind, op, outcome));
    }

    fn exists_sync(&mut self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn open_blank_tab(&mut self) -> Result<i64, String> {
        self.common
            .tabs
            .open_blank_sheets_tab()
            .map(|view| i64::from(view.0))
    }

    fn authorize_save(&mut self, wc_id: i64, file_path: &str) {
        if let Some(view) = view_of(wc_id) {
            self.common.tabs.authorize_sheets_save(view, file_path);
        }
    }

    fn abandon_blank_tab(&mut self, wc_id: i64) {
        if let Some(view) = view_of(wc_id) {
            self.common.tabs.abandon_blank_sheets_tab(view);
        }
    }
}

fn rejection(message: String) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message,
    }
}

fn settled(outcome: Settled) -> Result<Option<JsonValue>, IpcError> {
    outcome.map_err(rejection)
}

/// The state of both bridges and the promises waiting on them
pub struct Bridges {
    common: Rc<Common>,
    docs: RefCell<DocsBridge<FamilyHost>>,
    sheets: RefCell<SheetsBridge<FamilyHost>>,
    waiting: RefCell<Waiting>,
}

/// the commands sent to an editor and waiting for its result, by (docs or not, op)
type Waiting = HashMap<(bool, u64), Then<Option<JsonValue>>>;

thread_local! {
    static BRIDGES: RefCell<HashMap<u64, Weak<Bridges>>> = RefCell::new(HashMap::new());
}

/// Runs `job` with the bridges registered under `id`, on the core thread
fn with_bridges<R>(id: u64, job: impl FnOnce(&Bridges) -> R) -> Option<R> {
    let found = BRIDGES.with(|all| all.borrow().get(&id).and_then(Weak::upgrade));
    found.map(|bridges| job(&bridges))
}

impl Bridges {
    fn new(services: &Services, tabs: McpTabsHost) -> Rc<Bridges> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let common = Rc::new(Common {
            services: services.clone(),
            tabs,
            clock: Clock::new(),
            settled: RefCell::new(Vec::new()),
            id,
        });
        let host = |kind| FamilyHost {
            common: common.clone(),
            kind,
        };
        let mut docs = DocsBridge::new(host(Kind::Docs));
        let mut sheets = SheetsBridge::new(host(Kind::Sheets));
        // `installDocsBridge()` and `installSheetsBridge()`: the listeners are the port's channels
        let _ = docs.install();
        let _ = sheets.install();
        let bridges = Rc::new(Bridges {
            common,
            docs: RefCell::new(docs),
            sheets: RefCell::new(sheets),
            waiting: RefCell::new(HashMap::new()),
        });
        BRIDGES.with(|all| all.borrow_mut().insert(id, Rc::downgrade(&bridges)));
        services.views.on_destroyed(Box::new(move |view| {
            with_bridges(id, |bridges| bridges.on_destroyed(i64::from(view.0)));
        }));
        bridges
    }

    /// `wc.once('destroyed', ..)` of a watched tab
    fn on_destroyed(&self, wc_id: i64) {
        self.docs.borrow_mut().on_destroyed(wc_id);
        self.sheets.borrow_mut().on_destroyed(wc_id);
        self.resume();
    }

    fn on_timeout(&self, kind: Kind, timer: u64) {
        match kind {
            Kind::Docs => self.docs.borrow_mut().on_timeout(timer),
            Kind::Sheets => self.sheets.borrow_mut().on_timeout(timer),
        }
        self.resume();
    }

    /// Runs the continuations of the promises that settled, outside any bridge call
    fn resume(&self) {
        loop {
            let items = std::mem::take(&mut *self.common.settled.borrow_mut());
            if items.is_empty() {
                return;
            }
            for (kind, op, outcome) in items {
                let then = self.waiting.borrow_mut().remove(&(kind == Kind::Docs, op));
                if let Some(then) = then {
                    then(settled(outcome));
                }
            }
        }
    }

    /// What a call of the control gave: settle it now or wait for `settle`
    fn submit(&self, kind: Kind, submitted: Submitted, then: Then<Option<JsonValue>>) {
        match submitted {
            Submitted::Resolved(value) => then(Ok(value)),
            Submitted::Rejected(message) => then(Err(rejection(message))),
            Submitted::Pending(op) => {
                self.waiting
                    .borrow_mut()
                    .insert((kind == Kind::Docs, op), then);
            }
        }
        self.resume();
    }
}

/// The port of the two bridges, and the control the MCP tools call
pub struct BridgesPort {
    bridges: Rc<Bridges>,
}

impl BridgesPort {
    pub fn new(services: &Services, tabs: McpTabsHost) -> Rc<BridgesPort> {
        Rc::new(BridgesPort {
            bridges: Bridges::new(services, tabs),
        })
    }

    fn ready(&self, kind: Kind, cx: &CallContext, reply: Responder) {
        let sender = i64::from(cx.sender.view.0);
        match kind {
            Kind::Docs => self.bridges.docs.borrow_mut().on_ready(sender),
            Kind::Sheets => self.bridges.sheets.borrow_mut().on_ready(sender),
        }
        self.bridges.resume();
        reply.reply(Ok(IpcValue::Undefined));
    }

    fn result(&self, kind: Kind, cx: &CallContext, args: &[IpcValue], reply: Responder) {
        let sender = i64::from(cx.sender.view.0);
        let result = arg(args, 0);
        match kind {
            Kind::Docs => self
                .bridges
                .docs
                .borrow_mut()
                .on_result(sender, result.as_ref()),
            Kind::Sheets => self
                .bridges
                .sheets
                .borrow_mut()
                .on_result(sender, result.as_ref()),
        }
        self.bridges.resume();
        reply.reply(Ok(IpcValue::Undefined));
    }
}

impl McpDocumentBridges for BridgesPort {
    fn docs_mcp_ready(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.ready(Kind::Docs, cx, reply)
    }

    fn docs_mcp_result(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.result(Kind::Docs, cx, &args, reply)
    }

    fn sheets_mcp_ready(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.ready(Kind::Sheets, cx, reply)
    }

    fn sheets_mcp_result(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.result(Kind::Sheets, cx, &args, reply)
    }
}

impl McpBridgeControl for BridgesPort {
    fn docs_open_blank_tab(&self, then: Then<Option<JsonValue>>) {
        let submitted = self.bridges.docs.borrow_mut().open_blank_tab();
        self.bridges.submit(Kind::Docs, submitted, then);
    }

    fn docs_run_command(
        &self,
        wc_id: i64,
        command: McpEditorCommandName,
        payload: Option<JsonValue>,
        then: Then<Option<JsonValue>>,
    ) {
        let submitted =
            self.bridges
                .docs
                .borrow_mut()
                .run_command(wc_id, command, payload.as_ref());
        self.bridges.submit(Kind::Docs, submitted, then);
    }

    fn sheets_open_blank_tab(&self, then: Then<Option<JsonValue>>) {
        let submitted = self.bridges.sheets.borrow_mut().open_blank_tab();
        self.bridges.submit(Kind::Sheets, submitted, then);
    }

    fn sheets_run_command(
        &self,
        wc_id: i64,
        command: SheetsCommandName,
        payload: Option<JsonValue>,
        then: Then<Option<JsonValue>>,
    ) {
        let submitted =
            self.bridges
                .sheets
                .borrow_mut()
                .run_command(wc_id, command, payload.as_ref());
        self.bridges.submit(Kind::Sheets, submitted, then);
    }
}

/// The host the shell inserts for the bridges port; the control is added to
/// what the batches provide each other
pub fn factory() -> crate::Factory<dyn McpDocumentBridges> {
    crate::Factory::new(|services, provided: &Rc<Provided>| {
        let tabs = services
            .hosts
            .need::<McpTabsHost>(shell_contract::Batch::A)?;
        let port = BridgesPort::new(services, tabs);
        provided.add::<dyn McpBridgeControl>(port.clone());
        let port: Rc<dyn McpDocumentBridges> = port;
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use jscompat::JsObject;
    use shell_contract::ipc::Sender;
    use shell_contract::{Surface, WindowId};

    use super::*;
    use crate::mcp::testing::{Rig, call_cx, obj};

    struct Tabs {
        log: Mutex<Vec<String>>,
        open: Mutex<Vec<ViewId>>,
    }

    impl McpTabs for Tabs {
        fn open_blank_docs_tab(&self) -> ViewId {
            self.log.lock().unwrap().push("open docs".into());
            self.open.lock().unwrap().remove(0)
        }
        fn authorize_docs_save(&self, view: ViewId, path: &str) {
            self.log
                .lock()
                .unwrap()
                .push(format!("authorize docs {} {path}", view.0));
        }
        fn abandon_blank_docs_tab(&self, view: ViewId) {
            self.log
                .lock()
                .unwrap()
                .push(format!("abandon docs {}", view.0));
        }
        fn open_blank_sheets_tab(&self) -> Result<ViewId, String> {
            self.log.lock().unwrap().push("open sheets".into());
            self.open
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| "no more tabs".to_owned())
        }
        fn authorize_sheets_save(&self, view: ViewId, path: &str) {
            self.log
                .lock()
                .unwrap()
                .push(format!("authorize sheets {} {path}", view.0));
        }
        fn abandon_blank_sheets_tab(&self, view: ViewId) {
            self.log
                .lock()
                .unwrap()
                .push(format!("abandon sheets {}", view.0));
        }
    }

    fn cx(view: u32) -> CallContext {
        call_cx(Sender {
            view: ViewId(view),
            window: WindowId(1),
            surface: Surface::Docs,
        })
    }

    /// The outcomes a call has settled with, in order
    type Outcomes = Vec<Result<Option<JsonValue>, IpcError>>;

    fn collect() -> (Rc<RefCell<Outcomes>>, impl Fn() -> Then<Option<JsonValue>>) {
        let results: Rc<RefCell<Outcomes>> = Rc::default();
        let sink = results.clone();
        (results, move || {
            let sink = sink.clone();
            Box::new(move |outcome| sink.borrow_mut().push(outcome))
        })
    }

    #[test]
    fn a_command_goes_out_when_the_tab_is_ready_and_resolves_with_its_result() {
        let rig = Rig::new(&[7]);
        let tabs = Arc::new(Tabs {
            log: Mutex::default(),
            open: Mutex::default(),
        });
        let port = BridgesPort::new(&rig.services, tabs.clone());
        let (results, then) = collect();
        port.docs_run_command(
            7,
            McpEditorCommandName::ReadDocument,
            Some(JsonValue::Number(1.0)),
            then(),
        );
        // not ready yet: nothing was sent and nothing settled
        assert!(rig.events().is_empty());
        assert!(results.borrow().is_empty());
        let (reply, _) = rig.responder();
        port.docs_mcp_ready(&cx(7), vec![], reply);
        let events = rig.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "docs:mcp-command");
        let IpcValue::Object(sent) = &events[0].2[0] else {
            panic!("an object")
        };
        let field = |name: &str| sent.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        assert_eq!(
            field("command"),
            Some(IpcValue::String("read_document".into()))
        );
        assert_eq!(field("payload"), Some(IpcValue::Number(1.0)));
        let Some(IpcValue::String(request)) = field("requestId") else {
            panic!("a request id")
        };
        let answer = obj(&[
            ("requestId", IpcValue::String(request)),
            ("ok", IpcValue::Bool(true)),
            ("result", IpcValue::String("text".into())),
        ]);
        let (reply, _) = rig.responder();
        port.docs_mcp_result(&cx(7), vec![answer], reply);
        assert_eq!(
            *results.borrow(),
            vec![Ok(Some(JsonValue::String("text".into())))]
        );
    }

    #[test]
    fn a_result_from_another_tab_or_for_no_command_changes_nothing() {
        let rig = Rig::new(&[7, 8]);
        let tabs = Arc::new(Tabs {
            log: Mutex::default(),
            open: Mutex::default(),
        });
        let port = BridgesPort::new(&rig.services, tabs);
        let (results, then) = collect();
        let (reply, _) = rig.responder();
        port.docs_mcp_ready(&cx(7), vec![], reply);
        port.docs_run_command(7, McpEditorCommandName::ReadDocument, None, then());
        let events = rig.events();
        let IpcValue::Object(sent) = &events[0].2[0] else {
            panic!("an object")
        };
        let Some((_, IpcValue::String(request))) = sent.iter().find(|(k, _)| k == "requestId")
        else {
            panic!("a request id")
        };
        let forged = obj(&[
            ("requestId", IpcValue::String(request.clone())),
            ("ok", IpcValue::Bool(true)),
        ]);
        let (reply, _) = rig.responder();
        port.docs_mcp_result(&cx(8), vec![forged], reply);
        let (reply, _) = rig.responder();
        port.docs_mcp_result(
            &cx(7),
            vec![obj(&[("requestId", IpcValue::String("mcp-99".into()))])],
            reply,
        );
        assert!(results.borrow().is_empty());
        // the tab's own failure rejects with its message
        let failed = obj(&[
            ("requestId", IpcValue::String(request.clone())),
            ("ok", IpcValue::Bool(false)),
            ("error", IpcValue::String("no such block".into())),
        ]);
        let (reply, _) = rig.responder();
        port.docs_mcp_result(&cx(7), vec![failed], reply);
        assert_eq!(results.borrow().len(), 1);
        assert_eq!(
            results.borrow()[0].as_ref().unwrap_err().message,
            "no such block"
        );
    }

    #[test]
    fn a_save_goes_through_the_save_checks_and_a_closed_tab_fails_its_waiters() {
        let rig = Rig::new(&[7]);
        let tabs = Arc::new(Tabs {
            log: Mutex::default(),
            open: Mutex::default(),
        });
        let port = BridgesPort::new(&rig.services, tabs.clone());
        let (results, then) = collect();
        let (reply, _) = rig.responder();
        port.docs_mcp_ready(&cx(7), vec![], reply);
        let dir = std::env::temp_dir().join(format!("shell-a-mcp-bridge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let existing = dir.join("exists.docx");
        std::fs::write(&existing, b"x").unwrap();
        let path = existing.to_string_lossy().into_owned();
        let payload = |overwrite: Option<bool>| {
            let mut o = JsObject::new();
            o.set("path", JsonValue::String(path.clone()));
            if let Some(overwrite) = overwrite {
                o.set("overwrite", JsonValue::Bool(overwrite));
            }
            Some(JsonValue::Object(o))
        };
        port.docs_run_command(7, McpEditorCommandName::SaveDocument, payload(None), then());
        assert!(
            results.borrow()[0]
                .as_ref()
                .unwrap_err()
                .message
                .starts_with("file already exists")
        );
        assert!(rig.events().is_empty());
        port.docs_run_command(
            7,
            McpEditorCommandName::SaveDocument,
            payload(Some(true)),
            then(),
        );
        assert_eq!(rig.events().len(), 1);
        assert_eq!(
            tabs.log.lock().unwrap().as_slice(),
            [format!("authorize docs 7 {path}")]
        );
        // the tab goes away with the command in flight
        rig.destroy_view(7);
        assert_eq!(results.borrow().len(), 2);
        assert_eq!(
            results.borrow()[1].as_ref().unwrap_err().message,
            "the document tab was closed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheets_and_docs_keep_their_own_commands_and_blank_tabs() {
        let rig = Rig::new(&[4, 5]);
        let tabs = Arc::new(Tabs {
            log: Mutex::default(),
            open: Mutex::new(vec![ViewId(4), ViewId(5)]),
        });
        let port = BridgesPort::new(&rig.services, tabs.clone());
        let (results, then) = collect();
        port.sheets_open_blank_tab(then());
        // the blank sheets tab (the last of the list) is opened and waits for its renderer
        assert!(results.borrow().is_empty());
        let (reply, _) = rig.responder();
        port.sheets_mcp_ready(&cx(5), vec![], reply);
        assert_eq!(*results.borrow(), vec![Ok(Some(JsonValue::Number(5.0)))]);
        port.sheets_run_command(5, SheetsCommandName::ReadSheet, None, then());
        let events = rig.events();
        assert_eq!(events[0].1, "sheets:mcp-command");
        // a docs tab that closes before it is ready is abandoned
        let (results2, then2) = collect();
        port.docs_open_blank_tab(then2());
        rig.destroy_view(4);
        assert_eq!(results2.borrow().len(), 1);
        assert_eq!(
            tabs.log.lock().unwrap().as_slice(),
            ["open sheets", "open docs", "abandon docs 4"]
        );
    }
}
