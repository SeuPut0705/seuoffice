//! The probe's `trigger` steps (tools/ipc-diff): the calls the shell makes
//! into the PDF editor, by the kebab-case name of the pdf-main.ts function
//! they stand for. `args` are that function's arguments after `contents`.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use serde_json::Value;
use shell_contract::editors::{DocumentEditors, Then};
use shell_contract::runtime::Services;
use shell_contract::{IpcValue, Provided, ViewId, WindowId};

use super::editors::{PdfEditors, SaveAsOutcome};
use crate::kit::{IntoIpc, error};

fn text(args: &Value, i: usize) -> Option<&str> {
    args.get(i).and_then(Value::as_str)
}

fn outcome(o: SaveAsOutcome) -> IpcValue {
    match o {
        SaveAsOutcome::Saved => "saved",
        SaveAsOutcome::Cancelled => "cancelled",
        SaveAsOutcome::Failed => "failed",
    }
    .into_ipc()
}

/// Runs the shell call `what` for `view`; `then` gets its outcome. False
/// (and `then` dropped) for a name this editor does not have.
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: Then<IpcValue>,
) -> bool {
    let Some(ed) = provided.all::<PdfEditors>().pop() else {
        return false;
    };
    match what {
        // createPdfView(openPath): grantAndTrack of the new view
        "open-view" => {
            ed.open_view(view, text(args, 0));
            then(Ok(IpcValue::Undefined))
        }
        "flush-pdf-save" => {
            let all = args.get(0).and_then(Value::as_bool).unwrap_or(false);
            ed.flush_save(view, all, Box::new(move |ok| then(Ok(ok.into_ipc()))))
        }
        "request-pdf-close" => {
            let parent = args
                .get(0)
                .and_then(Value::as_u64)
                .map(|w| WindowId(w as u32));
            ed.request_close(
                view,
                parent,
                Box::new(move |r| then(r.map(IntoIpc::into_ipc))),
            )
        }
        "request-pdf-save-as-outcome" => {
            let Some(target) = text(args, 0) else {
                then(Err(error("a target path")));
                return true;
            };
            ed.request_save_as_outcome(view, target, Box::new(move |o| then(Ok(outcome(o)))))
        }
        "request-pdf-save-as" => {
            let target = text(args, 0).unwrap_or_default().to_owned();
            ed.save_to_path(
                view,
                PathBuf::from(target),
                Box::new(move |r| then(Ok(r.is_ok().into_ipc()))),
            )
        }
        "request-pdf-page-images" => {
            let sent = ed.request_page_images(view, text(args, 0).unwrap_or_default());
            then(Ok(sent.into_ipc()))
        }
        "set-pdf-save-as-in-flight" => {
            ed.set_save_as_in_flight(view, args.get(0).and_then(Value::as_bool) == Some(true));
            then(Ok(IpcValue::Undefined))
        }
        "pdf-file-renamed" => {
            let (old, new) = (
                text(args, 0).unwrap_or_default(),
                text(args, 1).unwrap_or_default(),
            );
            ed.file_renamed(view, Path::new(old), Path::new(new));
            then(Ok(IpcValue::Undefined))
        }
        "write-pdf-copies-now" => {
            ed.write_copies_now(Box::new(move || then(Ok(IpcValue::Undefined))))
        }
        "discard-pdf-recovery" => {
            ed.discard_recovery(view);
            then(Ok(IpcValue::Undefined))
        }
        "pdf-close-cancelled" => {
            ed.close_cancelled(view);
            then(Ok(IpcValue::Undefined))
        }
        "pdf-is-dirty" => then(Ok(ed.is_dirty(view).into_ipc())),
        "clear-pdf-dirty" => {
            ed.clear_dirty(view);
            then(Ok(IpcValue::Undefined))
        }
        "mark-pdf-untitled-path" => {
            ed.mark_untitled_path(text(args, 0).unwrap_or_default());
            then(Ok(IpcValue::Undefined))
        }
        "mark-pdf-untitled-copy" => {
            ed.mark_untitled_copy(text(args, 0).unwrap_or_default());
            then(Ok(IpcValue::Undefined))
        }
        // pdfRecoveryEditor.openFileWithDecision(contents, { filePath, decision })
        "open-file-with-decision" => {
            let request = args.get(0).cloned().unwrap_or(Value::Null);
            let path = request
                .get("filePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let restore = request.get("decision").and_then(Value::as_str) == Some("restore");
            ed.open_file_with_decision(view, path, restore);
            then(Ok(IpcValue::Undefined))
        }
        // the view's `setWindowOpenHandler`, answering `deny`
        "window-open" => {
            ed.window_open(text(args, 0).unwrap_or_default());
            then(Ok(crate::kit::obj([("action", "deny".into_ipc())])))
        }
        // `render-process-gone`, `did-start-loading`
        "render-process-gone" => {
            ed.render_gone(view);
            then(Ok(IpcValue::Undefined))
        }
        "did-start-loading" => {
            ed.start_loading(view);
            then(Ok(IpcValue::Undefined))
        }
        _ => return false,
    }
    true
}

#[cfg(all(test, feature = "probe"))]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use serde_json::json;
    use shell_contract::{IpcValue, Surface, ViewId};

    use super::probe_trigger;
    use crate::kit::IntoIpc;
    use crate::pdf::editor::tests::rt_with;

    #[test]
    fn triggers_reach_the_editor_and_answer_its_outcome() {
        let (mut rt, _) = rt_with(serde_json::Value::Null);
        let file = rt.dir.join("doc.pdf").to_string_lossy().into_owned();
        std::fs::write(&file, b"%PDF").unwrap();
        let view = rt.view(1, Surface::Pdf);
        let got = Rc::new(RefCell::new(Vec::new()));
        let run = |rt: &crate::testing::Rt, what: &str, args: serde_json::Value| {
            let g = got.clone();
            probe_trigger(
                what,
                ViewId(1),
                &args,
                &rt.services,
                &rt.provided(),
                Box::new(move |r| g.borrow_mut().push(r.unwrap())),
            )
        };
        assert!(run(&rt, "open-view", json!([file])));
        let read = rt.invoke_now("pdf:read-file", view, vec![file.as_str().into_ipc()]);
        assert!(read.is_ok());
        assert!(run(&rt, "pdf-is-dirty", json!([])));
        assert!(run(&rt, "request-pdf-save-as-outcome", json!(["/x.pdf"])));
        rt.send(
            "pdf:save-as-result",
            view,
            vec![IpcValue::String("cancelled".into())],
        );
        assert!(!run(&rt, "no-such-call", json!([])));
        assert_eq!(
            *got.borrow(),
            vec![
                IpcValue::Undefined,
                false.into_ipc(),
                "cancelled".into_ipc()
            ]
        );
    }
}
