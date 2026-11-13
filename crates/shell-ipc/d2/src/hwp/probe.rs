//! What the shell and the other areas call on the Hangul editor, run by
//! name for tools/ipc-diff's `trigger` steps (`d2/hwp:<what>`). Each name
//! is the kebab-case of the function hwp-main.ts or recovery.ts exported;
//! the reply is what that function returned. A call that waits for the
//! renderer (`request-save`, `request-close`, `read-text`,
//! `export-hwp-pdf-headless`) answers `undefined` at once, so the case can
//! send the renderer's answer next; the `outcome` trigger then answers `null`
//! while it waits, `{value}` or `{error}` once it settled.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use main_core::packages::electron_utils::recovery_contract::{
    RecoveryEditorContract, RecoveryOpenDecision, RecoveryOpenFileRequest,
};
use main_core::packages::electron_utils::recovery_store::RecoveryIdentity;
use serde_json::Value;
use shell_contract::editors::Then;
use shell_contract::ipc::Reply;
use shell_contract::runtime::Services;
use shell_contract::{DocumentEditors, IpcValue, Provided, SaveMode, ViewId, WindowId};

use super::{HEADLESS_TIMEOUT_MS, HwpEditors, UntitledOption};
use crate::kit::{IntoIpc, obj};

/// `{ kind, filePath }` or `{ kind, untitledId, ext }`, as recovery.ts builds them
fn identity(identity: Option<RecoveryIdentity>) -> IpcValue {
    match identity {
        None => IpcValue::Null,
        Some(RecoveryIdentity::File(f)) => obj([
            ("kind", f.kind.into_ipc()),
            ("filePath", f.file_path.into_ipc()),
        ]),
        Some(RecoveryIdentity::Untitled(u)) => obj([
            ("kind", u.kind.into_ipc()),
            ("untitledId", u.untitled_id.into_ipc()),
            ("ext", u.ext.into_ipc()),
        ]),
    }
}

thread_local! {
    /// The outcome of the last waiting trigger: `None` while it waits
    static OUTCOME: RefCell<Option<Reply>> = const { RefCell::new(None) };
}

/// Starts a waiting call: its outcome lands in `OUTCOME`
fn wait<T: 'static>(into: impl Fn(T) -> IpcValue + 'static) -> Then<T> {
    OUTCOME.with(|o| *o.borrow_mut() = None);
    Box::new(move |r| OUTCOME.with(|o| *o.borrow_mut() = Some(r.map(into))))
}

fn text(args: &Value, i: usize) -> Option<&str> {
    args.get(i).and_then(Value::as_str)
}

/// Runs `what` on the Hangul editors; false (and `then` dropped) for a name
/// it does not know
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: Then<IpcValue>,
) -> bool {
    let Some(editors) = provided.all::<HwpEditors>().into_iter().next() else {
        return false;
    };
    let done = |then: Then<IpcValue>| then(Ok(IpcValue::Undefined));
    match what {
        // createHwpView(openPath, options): the shell's tab on a file
        "open-view" => {
            let untitled = match args.get(1) {
                Some(Value::Bool(true)) => UntitledOption::Copy,
                Some(Value::Object(o)) => UntitledOption::Pdf {
                    base_name: o
                        .get("baseName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                },
                _ => UntitledOption::No,
            };
            editors.grant_and_track(view, text(args, 0), untitled);
            done(then)
        }
        "request-save" => {
            let mode = match text(args, 0) {
                Some("saveAs") => SaveMode::SaveAs,
                _ => SaveMode::Save,
            };
            editors.request_save(view, mode, wait(IntoIpc::into_ipc));
            done(then)
        }
        "request-close" => {
            let parent = args
                .get(0)
                .and_then(Value::as_u64)
                .map(|w| WindowId(w as u32));
            editors.request_close(view, parent, wait(IntoIpc::into_ipc));
            done(then)
        }
        "read-text" => {
            editors.read_text(view, wait(IntoIpc::into_ipc));
            done(then)
        }
        "file-renamed" => {
            let (old, new) = (text(args, 0).unwrap_or(""), text(args, 1).unwrap_or(""));
            editors.file_renamed(view, Path::new(old), Path::new(new));
            done(then)
        }
        // requestHwpPrint(contents, mode), what the File > Export menu asks
        "export-request" => {
            editors.export_request(view, text(args, 0).unwrap_or(""));
            done(then)
        }
        "request-preview" => {
            editors.request_preview(view, text(args, 0).unwrap_or(""));
            done(then)
        }
        "is-dirty" => then(Ok(editors.is_dirty(view).into_ipc())),
        "memo-modal-open" => then(Ok(editors.memo_modal_open(view).into_ipc())),
        "recovery-identity" => then(Ok(identity(editors.recovery_identity(view)))),
        "set-recovery-title" => {
            editors.set_recovery_title(view, text(args, 0).unwrap_or(""));
            done(then)
        }
        "discard-recovery-copy" => {
            editors.discard_recovery_copy(view);
            done(then)
        }
        // the contract's writeCopiesNow: the flushes go out; nothing waits here
        "write-copies-now" => {
            editors.write_copies_now();
            done(then)
        }
        "open-file-with-decision" => {
            let decision = match text(args, 1) {
                Some("restore") => RecoveryOpenDecision::Restore,
                _ => RecoveryOpenDecision::Original,
            };
            let request = RecoveryOpenFileRequest {
                file_path: text(args, 0).unwrap_or("").to_owned(),
                decision,
            };
            editors.open_file_with_decision(&view, &request);
            done(then)
        }
        "render-process-gone" => {
            editors.render_process_gone(view, text(args, 0).unwrap_or("crashed"));
            done(then)
        }
        "did-start-navigation" => {
            let flag = |i: usize| args.get(i).and_then(Value::as_bool).unwrap_or(false);
            editors.did_start_navigation(view, flag(0), flag(1));
            done(then)
        }
        "export-hwp-pdf-headless" => {
            let timeout = args
                .get(2)
                .and_then(Value::as_u64)
                .unwrap_or(HEADLESS_TIMEOUT_MS);
            editors.export_hwp_pdf_headless(
                text(args, 0).unwrap_or(""),
                text(args, 1).unwrap_or(""),
                timeout,
                wait(|()| IpcValue::Undefined),
            );
            done(then)
        }
        "outcome" => {
            let value = match OUTCOME.with(|o| o.borrow().clone()) {
                None => IpcValue::Null,
                Some(Ok(value)) => obj([("value", value)]),
                Some(Err(e)) => obj([("error", e.to_string().into_ipc())]),
            };
            then(Ok(value))
        }
        _ => return false,
    }
    true
}

#[cfg(all(test, feature = "probe"))]
mod tests {
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};

    use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
    use serde_json::json;
    use shell_contract::{IpcError, Surface};

    use super::*;
    use crate::testing::Rt;

    fn rt() -> Rt {
        let mut rt = Rt::new(|h| {
            crate::hwp::fakes(h, &Value::Null);
            h.insert::<Arc<Mutex<SharedRecoveryState>>>(Arc::new(Mutex::new(
                SharedRecoveryState::new("0000000000000000"),
            )));
        });
        rt.register(crate::hwp::entries).unwrap();
        rt
    }

    type Got = Rc<RefCell<Option<Result<IpcValue, IpcError>>>>;

    fn trigger(rt: &Rt, what: &str, view: u32, args: Value) -> (bool, Got) {
        let got: Got = Rc::default();
        let set = Rc::clone(&got);
        let known = probe_trigger(
            what,
            ViewId(view),
            &args,
            &rt.services,
            &rt.provided(),
            Box::new(move |r| *set.borrow_mut() = Some(r)),
        );
        (known, got)
    }

    #[test]
    fn a_trigger_opens_a_view_and_answers_what_the_function_returned() {
        let mut rt = rt();
        let from = rt.view(1, Surface::Hwp);
        let path = rt.dir.join("a.hwp");
        std::fs::write(&path, b"x").unwrap();
        let path = path.to_string_lossy().into_owned();
        let (known, got) = trigger(&rt, "open-view", 1, json!([path]));
        assert!(known);
        assert_eq!(*got.borrow(), Some(Ok(IpcValue::Undefined)));
        assert_eq!(
            rt.invoke_now("hwp:consume-pending", from, vec![]),
            Ok(path.as_str().into_ipc())
        );
        let (_, got) = trigger(&rt, "recovery-identity", 1, json!([]));
        assert_eq!(
            *got.borrow(),
            Some(Ok(obj([
                ("kind", "hwp".into_ipc()),
                ("filePath", path.as_str().into_ipc()),
            ])))
        );
        // a clean tab closes without asking
        trigger(&rt, "request-close", 1, json!([null]));
        let (_, got) = trigger(&rt, "outcome", 1, json!([]));
        assert_eq!(*got.borrow(), Some(Ok(obj([("value", true.into_ipc())]))));
        // a save waits for the renderer's commit: the outcome tells
        let (_, got) = trigger(&rt, "request-save", 1, json!(["saveAs"]));
        assert_eq!(*got.borrow(), Some(Ok(IpcValue::Undefined)));
        let (_, got) = trigger(&rt, "outcome", 1, json!([]));
        assert_eq!(*got.borrow(), Some(Ok(IpcValue::Null)));
        rt.send("hwp:abort-save", from, vec![]);
        let (_, got) = trigger(&rt, "outcome", 1, json!([]));
        assert_eq!(*got.borrow(), Some(Ok(obj([("value", false.into_ipc())]))));
        let (known, got) = trigger(&rt, "no-such-thing", 1, json!([]));
        assert!(!known);
        assert_eq!(*got.borrow(), None);
    }
}
