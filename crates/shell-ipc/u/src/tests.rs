use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use main_core::shell::launch_recovery::RecoveryListItem;
use main_core::shell::updater::{
    UpdateAction, UpdatePhase, UpdateStatePatch, UpdateUiState, UpdateUiStrings,
};
use shell_contract::hosts::MainWindow;
use shell_contract::ipc::{
    CallContext, ChannelKind, EventSink, Handler, RegisterError, Registry, Reply, Responder,
    Sender, Target,
};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{
    Batch, CHANNELS, Hosts, IpcError, IpcValue, MainWindowHost, Surface, ViewId, WindowId,
};

use crate::launch_list::{self, ApplyDone};
use crate::update_window::{self, UpdateWindowSpec, UpdateWindows, UpdateWindowsHost};

/// The start-up check of the contract: known channel, once, own batch, the
/// kind renderers use
#[derive(Default)]
struct Table(
    HashMap<&'static str, Rc<dyn Handler>>,
    Rc<shell_contract::Provided>,
);

impl Registry for Table {
    fn register(
        &mut self,
        by: Batch,
        channel: &'static str,
        kind: ChannelKind,
        handler: Rc<dyn Handler>,
    ) -> Result<(), RegisterError> {
        let spec = CHANNELS
            .iter()
            .find(|s| s.name == channel)
            .ok_or(RegisterError::Unknown(channel))?;
        if spec.batch != by {
            return Err(RegisterError::WrongBatch {
                channel,
                owner: spec.batch,
                by,
            });
        }
        if !spec.kinds.contains(&kind) {
            return Err(RegisterError::WrongKind { channel, kind });
        }
        if self.0.insert(channel, handler).is_some() {
            return Err(RegisterError::Twice(channel));
        }
        Ok(())
    }

    fn provided(&self) -> Rc<shell_contract::Provided> {
        self.1.clone()
    }
}

struct Inline;
impl Thread for Inline {
    fn post(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
    fn is_current(&self) -> bool {
        false
    }
}
impl Workers for Inline {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);
impl EventSink for Events {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push((target, channel, args));
    }
}

struct NoViews;
impl Views for NoViews {
    fn sender_of(&self, _: ViewId) -> Option<Sender> {
        None
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}
impl AppPaths for NoViews {
    fn path(&self, _: PathName) -> PathBuf {
        PathBuf::new()
    }
}

const SHELL_VIEW: ViewId = ViewId(1);
const SHELL_WINDOW: WindowId = WindowId(1);
const UPDATE_WINDOW: WindowId = WindowId(7);

struct Shell;
impl MainWindow for Shell {
    fn view(&self) -> Option<ViewId> {
        Some(SHELL_VIEW)
    }
    fn window(&self) -> Option<WindowId> {
        Some(SHELL_WINDOW)
    }
}

#[derive(Default)]
struct Windows(Mutex<Vec<String>>);
impl UpdateWindows for Windows {
    fn create(&self, spec: &UpdateWindowSpec, inactive: bool) -> WindowId {
        self.0.lock().unwrap().push(format!(
            "create {}x{} parent {:?} inactive {inactive}",
            spec.width, spec.height, spec.parent
        ));
        UPDATE_WINDOW
    }
    fn show(&self, window: WindowId, inactive: bool) {
        self.0
            .lock()
            .unwrap()
            .push(format!("show {} inactive {inactive}", window.0));
    }
    fn close(&self, window: WindowId) {
        self.0.lock().unwrap().push(format!("close {}", window.0));
    }
}

#[derive(Default)]
struct Updater(Mutex<u32>);
impl crate::UpdaterControl for Updater {
    fn started(&self) {}
    fn available(&self) -> bool {
        true
    }
    fn check_now(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

struct Fixture {
    table: Table,
    updater: Arc<Updater>,
    events: Arc<Events>,
    windows: Arc<Windows>,
}

fn services(hosts: Hosts, events: Arc<Events>) -> Services {
    Services {
        ui: Arc::new(Inline),
        core: Arc::new(Inline),
        workers: Arc::new(Inline),
        events,
        views: Arc::new(NoViews),
        paths: Arc::new(NoViews),
        hosts: Arc::new(hosts),
    }
}

fn fixture() -> Fixture {
    let events = Arc::new(Events::default());
    let windows = Arc::new(Windows::default());
    let mut hosts = Hosts::default();
    let main: MainWindowHost = Arc::new(Shell);
    let update: UpdateWindowsHost = windows.clone();
    let updater = Arc::new(Updater::default());
    let control: crate::UpdaterControlHost = updater.clone();
    hosts.insert(main);
    hosts.insert(update);
    hosts.insert(control);
    let mut table = Table::default();
    crate::register(&mut table, &services(hosts, events.clone())).unwrap();
    Fixture {
        table,
        updater,
        events,
        windows,
    }
}

type Replies = Arc<Mutex<Vec<Reply>>>;

impl Fixture {
    fn call_from(&self, view: ViewId, channel: &str, args: Vec<IpcValue>) -> Replies {
        let replies = Replies::default();
        let sink = replies.clone();
        let cx = CallContext {
            sender: Sender {
                view,
                window: WindowId(view.0),
                surface: Surface::Shell,
            },
            request: None,
            cancel: CancelToken::default(),
        };
        self.table.0[channel].call(
            &cx,
            args,
            Responder::new(move |reply| sink.lock().unwrap().push(reply)),
        );
        replies
    }

    fn call(&self, channel: &str, args: Vec<IpcValue>) -> Reply {
        let replies = self.call_from(SHELL_VIEW, channel, args);
        let mut replies = replies.lock().unwrap();
        assert_eq!(replies.len(), 1, "{channel} answered once");
        replies.pop().unwrap()
    }

    fn events(&self) -> Vec<(Target, &'static str)> {
        let mut events = self.events.0.lock().unwrap();
        events.drain(..).map(|(t, c, _)| (t, c)).collect()
    }
}

fn state(phase: UpdatePhase) -> UpdateUiState {
    let s = String::new;
    UpdateUiState {
        phase,
        version: "2.0.0".into(),
        current_version: "1.0.0".into(),
        percent: 0.0,
        lang: "ko".into(),
        strings: UpdateUiStrings {
            title: "update".into(),
            headline: s(),
            desc: s(),
            download: s(),
            later: s(),
            install: s(),
            downloading: s(),
            failed: s(),
            retry: s(),
            manual_desc: s(),
            install_failed_desc: s(),
            visible_install_desc: s(),
            restart_desc: s(),
            open_download: s(),
            notes_label: s(),
            notes_on_git_hub: s(),
            notes_truncated: s(),
        },
        release_notes: None,
        visible_install: false,
    }
}

fn field<'a>(value: &'a IpcValue, key: &str) -> &'a IpcValue {
    let IpcValue::Object(entries) = value else {
        panic!("not an object: {value:?}")
    };
    &entries.iter().find(|(k, _)| k == key).unwrap().1
}

fn recorder() -> (Rc<RefCell<Vec<UpdateAction>>>, update_window::Actions) {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    (seen, Rc::new(move |a| sink.borrow_mut().push(a)))
}

#[test]
fn every_handled_channel_of_u_is_registered() {
    let f = fixture();
    for spec in CHANNELS.iter().filter(|s| s.batch == Batch::U) {
        let handled = spec.kinds.iter().any(|k| {
            matches!(
                k,
                ChannelKind::Invoke | ChannelKind::Send | ChannelKind::SendSync
            )
        });
        assert_eq!(f.table.0.contains_key(spec.name), handled, "{}", spec.name);
    }
}

#[test]
fn a_shell_without_the_update_host_does_not_start() {
    let mut hosts = Hosts::default();
    let main: MainWindowHost = Arc::new(Shell);
    hosts.insert(main);
    let err = crate::register(
        &mut Table::default(),
        &services(hosts, Arc::new(Events::default())),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        RegisterError::MissingHost {
            batch: Batch::U,
            ..
        }
    ));
}

#[test]
fn settings_ask_before_any_update_is_known() {
    let f = fixture();
    assert_eq!(f.call("update:get-state", vec![]), Ok(IpcValue::Null));
    assert_eq!(
        f.call("update:open-for-update", vec![]),
        Ok(IpcValue::Bool(false))
    );
    // the dialog's channels have no handler before the window was shown
    assert_eq!(
        f.call("update:download", vec![]),
        Err(IpcError::no_handler("update:download"))
    );
}

#[test]
fn the_window_shows_the_state_and_relays_its_buttons() {
    let f = fixture();
    let window = update_window::current().unwrap();
    let (seen, actions) = recorder();
    window.show(state(UpdatePhase::Available), actions, true);
    assert_eq!(
        f.windows.0.lock().unwrap().as_slice(),
        ["create 400x430 parent Some(WindowId(1)) inactive true"]
    );
    assert_eq!(
        f.events(),
        [(Target::View(SHELL_VIEW), update_window::STATE_CHANGED)]
    );
    let got = f.call("update:get-state", vec![]).unwrap();
    assert_eq!(field(&got, "phase"), &IpcValue::String("available".into()));
    assert_eq!(
        field(&got, "currentVersion"),
        &IpcValue::String("1.0.0".into())
    );

    for channel in [
        "update:download",
        "update:install",
        "update:later",
        "update:open-download",
    ] {
        assert_eq!(f.call(channel, vec![]), Ok(IpcValue::Undefined));
    }
    assert_eq!(
        *seen.borrow(),
        [
            UpdateAction::Download,
            UpdateAction::Install,
            UpdateAction::Later,
            UpdateAction::OpenDownload
        ]
    );

    window.push(&UpdateStatePatch {
        phase: UpdatePhase::Downloading,
        percent: Some(42.0),
        visible_install: None,
    });
    assert_eq!(
        f.events(),
        [
            (Target::Window(UPDATE_WINDOW), update_window::CHANGED),
            (Target::View(SHELL_VIEW), update_window::STATE_CHANGED)
        ]
    );
    let got = f.call("update:get-state", vec![]).unwrap();
    assert_eq!(field(&got, "percent"), &IpcValue::Number(42.0));
}

#[test]
fn open_for_update_downloads_only_when_nothing_started() {
    let f = fixture();
    let window = update_window::current().unwrap();
    let (seen, actions) = recorder();
    window.show(state(UpdatePhase::Downloading), actions.clone(), false);
    assert_eq!(
        f.call("update:open-for-update", vec![]),
        Ok(IpcValue::Bool(true))
    );
    assert!(seen.borrow().is_empty());
    window.show(state(UpdatePhase::Error), actions, false);
    assert_eq!(
        f.call("update:open-for-update", vec![]),
        Ok(IpcValue::Bool(true))
    );
    assert_eq!(*seen.borrow(), [UpdateAction::Download]);
}

#[test]
fn a_close_the_user_made_counts_as_later() {
    let f = fixture();
    let window = update_window::current().unwrap();
    let (seen, actions) = recorder();
    window.show(state(UpdatePhase::Available), actions.clone(), false);
    window.closed(UPDATE_WINDOW);
    assert_eq!(*seen.borrow(), [UpdateAction::Later]);
    assert!(!window.is_open());

    window.show(state(UpdatePhase::Downloaded), actions, false);
    window.close();
    window.closed(UPDATE_WINDOW);
    assert_eq!(*seen.borrow(), [UpdateAction::Later], "install closes it");
    assert_eq!(f.windows.0.lock().unwrap().last().unwrap(), "close 7");
}

fn row(id: &str) -> RecoveryListItem {
    RecoveryListItem {
        id: id.into(),
        editor_kind: "docs".into(),
        name: format!("{id}.docx"),
        folder: None,
        last_copy_time: 5.0,
        untitled: true,
        file_changed_after_copy: false,
        original_missing: false,
    }
}

fn decisions(id: &str, choice: &str) -> IpcValue {
    IpcValue::Object(vec![(
        "decisions".into(),
        IpcValue::Object(vec![(id.into(), IpcValue::String(choice.into()))]),
    )])
}

#[test]
fn the_launch_list_waits_for_the_launch_flow() {
    let f = fixture();
    let list = launch_list::current().unwrap();
    let pending = f.call_from(SHELL_VIEW, launch_list::GET, vec![]);
    assert!(pending.lock().unwrap().is_empty(), "waits");
    // another view (the manual shares the preload) gets nothing
    assert_eq!(
        f.call_from(ViewId(9), launch_list::GET, vec![])
            .lock()
            .unwrap()
            .as_slice(),
        [Ok(IpcValue::Null)]
    );
    assert!(list.blocking());

    let applied = Rc::new(RefCell::new(Vec::new()));
    let sink = applied.clone();
    let held: Rc<RefCell<Option<ApplyDone>>> = Rc::default();
    let hold = held.clone();
    list.publish(
        vec![row("a")],
        Rc::new(move |result, done| {
            sink.borrow_mut().push(format!("{result:?}"));
            *hold.borrow_mut() = Some(done);
        }),
    );
    let rows = pending.lock().unwrap().pop().unwrap().unwrap();
    let IpcValue::Array(rows) = rows else {
        panic!()
    };
    assert_eq!(field(&rows[0], "id"), &IpcValue::String("a".into()));
    assert_eq!(field(&rows[0], "folder"), &IpcValue::Null);

    assert_eq!(
        f.call(launch_list::SUBMIT, vec![decisions("a", "later")]),
        Err(IpcError {
            name: Some("Error".into()),
            message: "invalid launch recovery choice".into()
        })
    );
    assert_eq!(
        f.call_from(
            ViewId(9),
            launch_list::SUBMIT,
            vec![decisions("a", "restore")]
        )
        .lock()
        .unwrap()
        .as_slice(),
        [Err(IpcError {
            name: Some("Error".into()),
            message: "the launch recovery list belongs to the main window".into()
        })]
    );

    let first = f.call_from(
        SHELL_VIEW,
        launch_list::SUBMIT,
        vec![decisions("a", "restore")],
    );
    let joined = f.call_from(
        SHELL_VIEW,
        launch_list::SUBMIT,
        vec![decisions("a", "discard")],
    );
    assert_eq!(applied.borrow().len(), 1, "one apply at a time");
    assert!(!list.blocking(), "applying loads the front tabs");
    assert!(first.lock().unwrap().is_empty() && joined.lock().unwrap().is_empty());

    held.borrow_mut().take().unwrap().settle(Ok(()));
    assert_eq!(first.lock().unwrap().as_slice(), [Ok(IpcValue::Undefined)]);
    assert_eq!(joined.lock().unwrap().as_slice(), [Ok(IpcValue::Undefined)]);
    assert_eq!(f.call(launch_list::GET, vec![]), Ok(IpcValue::Null));
}

#[test]
fn a_failed_apply_leaves_the_list_up() {
    let f = fixture();
    let list = launch_list::current().unwrap();
    let ok = Rc::new(RefCell::new(false));
    let flag = ok.clone();
    list.publish(
        vec![row("a")],
        Rc::new(move |_, done| {
            done.settle(if *flag.borrow() {
                Ok(())
            } else {
                Err(IpcError {
                    name: Some("Error".into()),
                    message: "disk".into(),
                })
            })
        }),
    );
    assert_eq!(
        f.call(launch_list::SUBMIT, vec![decisions("a", "restore")]),
        Err(IpcError {
            name: Some("Error".into()),
            message: "disk".into()
        })
    );
    assert!(list.blocking());
    assert!(matches!(
        f.call(launch_list::GET, vec![]),
        Ok(IpcValue::Array(_))
    ));
    *ok.borrow_mut() = true;
    assert_eq!(
        f.call(launch_list::SUBMIT, vec![decisions("a", "restore")]),
        Ok(IpcValue::Undefined)
    );
    assert_eq!(f.call(launch_list::GET, vec![]), Ok(IpcValue::Null));
}

#[test]
fn nothing_to_ask_answers_null() {
    let f = fixture();
    let pending = f.call_from(SHELL_VIEW, launch_list::GET, vec![]);
    launch_list::current().unwrap().publish_none();
    assert_eq!(pending.lock().unwrap().as_slice(), [Ok(IpcValue::Null)]);
    assert_eq!(
        f.call(launch_list::SUBMIT, vec![IpcValue::Undefined]),
        Ok(IpcValue::Undefined)
    );
}

#[test]
fn the_menus_reach_the_update_check() {
    let f = fixture();
    let check = shell_contract::app_actions::update_check(&f.table.1).expect("provided");
    assert!(check.available());
    check.check_now();
    assert_eq!(*f.updater.0.lock().unwrap(), 1);
}

#[test]
fn what_waits_for_the_launch_runs_once_it_has_its_answer() {
    let f = fixture();
    let list = launch_list::current().unwrap();
    let ran = Rc::new(RefCell::new(Vec::new()));
    let r = ran.clone();
    list.when_unblocked(Box::new(move || r.borrow_mut().push("early")));
    assert!(ran.borrow().is_empty(), "the launch has no answer yet");
    list.publish(vec![row("a")], Rc::new(|_, done| done.settle(Ok(()))));
    assert!(ran.borrow().is_empty(), "the list is up");
    list.publish_none();
    assert!(ran.borrow().is_empty(), "a second publish changes nothing");
    f.call(launch_list::SUBMIT, vec![decisions("a", "restore")])
        .unwrap();
    assert_eq!(*ran.borrow(), ["early"]);
    let r = ran.clone();
    list.when_unblocked(Box::new(move || r.borrow_mut().push("late")));
    assert_eq!(*ran.borrow(), ["early", "late"]);
}
