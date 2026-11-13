//! What tools/ipc-diff's trigger steps (`d2/docs:<what>`) call: the
//! functions `docs-main.ts` exported to the shell and other areas, through
//! [`DocsEditors`] as the shell finds it in `Provided`. `args` is the
//! JavaScript call's arguments after the web contents, as a JSON array.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryFileIdentity, RecoveryIdentity, RecoveryUntitledIdentity,
};
use serde_json::Value;
use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::runtime::Services;
use shell_contract::{IpcValue, Provided, ViewId, WindowId};

use super::editors::DocsEditors;
use crate::kit::{self, IntoIpc};

fn text(args: &Value, i: usize) -> String {
    args[i].as_str().unwrap_or_default().to_owned()
}

/// A recovery identity as the TypeScript writes it: `{kind, filePath}` or
/// `{kind, untitledId, ext}`
fn identity(v: &Value) -> RecoveryIdentity {
    let kind = v["kind"].as_str().unwrap_or("docs").to_owned();
    match v["filePath"].as_str() {
        Some(path) => RecoveryIdentity::File(RecoveryFileIdentity {
            kind,
            file_path: path.to_owned(),
        }),
        None => RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: v["untitledId"].as_str().unwrap_or_default().to_owned(),
            ext: v["ext"].as_str().unwrap_or(".docx").to_owned(),
        }),
    }
}

fn untitled_json(u: RecoveryUntitledIdentity) -> IpcValue {
    super::Obj::new()
        .set("kind", u.kind)
        .set("untitledId", u.untitled_id)
        .set("ext", u.ext)
        .done()
}

/// Runs the shell call `what` for `view`; false when `what` is not one
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: Then<IpcValue>,
) -> bool {
    let Some(editor) = provided.all::<DocsEditors>().into_iter().next() else {
        return false;
    };
    match what {
        // the tab menu's save: `contents.send('menu:command', 'save' | 'save-as')`
        "request-save" => {
            let mode = if args[0] == "saveAs" {
                SaveMode::SaveAs
            } else {
                SaveMode::Save
            };
            editor.request_save(
                view,
                mode,
                Box::new(move |r| then(r.map(IntoIpc::into_ipc))),
            );
        }
        // requestDocsClose(contents, parent)
        "request-close" => {
            let parent = args[0].as_u64().map(|w| WindowId(w as u32));
            editor.request_close(
                view,
                parent,
                Box::new(move |r| then(r.map(IntoIpc::into_ipc))),
            );
        }
        "read-text" => editor.read_text(view, Box::new(move |r| then(r.map(IntoIpc::into_ipc)))),
        "save-to-path" => editor.save_to_path(
            view,
            PathBuf::from(text(args, 0)),
            Box::new(move |r| then(r.map(|()| IpcValue::Undefined))),
        ),
        // docsFileRenamed(wc, oldPath, newPath)
        "file-renamed" => {
            editor.file_renamed(view, Path::new(&text(args, 0)), Path::new(&text(args, 1)));
            then(Ok(IpcValue::Undefined))
        }
        // the File > Export menu's sendCommand('export-<format>')
        "export-request" => {
            editor.export_request(view, &text(args, 0));
            then(Ok(IpcValue::Undefined))
        }
        "document-path" => then(Ok(editor.document_path(view).as_deref().into_ipc())),
        "torn-down" => then(Ok(editor.torn_down(view).into_ipc())),
        // markDocsNewBlank(wcId)
        "mark-new-blank" => {
            editor.mark_new_blank(view);
            then(Ok(IpcValue::Undefined))
        }
        // queueDocsCopy(wcId, { path, name })
        "queue-copy" => {
            let (path, name) = (args[0]["path"].as_str(), args[0]["name"].as_str());
            editor.queue_copy(
                view,
                path.unwrap_or_default().into(),
                name.unwrap_or_default().into(),
            );
            then(Ok(IpcValue::Undefined))
        }
        // createDocsView(openPath): the tab's first document
        "open-view" => {
            editor.queue_open(view, text(args, 0));
            then(Ok(IpcValue::Undefined))
        }
        // authorizeMcpDocWrite(wcId, filePath)
        "authorize-mcp-doc-write" => {
            editor.authorize_mcp_doc_write(view, &text(args, 0));
            then(Ok(IpcValue::Undefined))
        }
        // teardownDocsRenderer(contents); args[0]: contents.isCrashed()
        "teardown" => {
            editor.teardown(view, args[0] == true);
            then(Ok(IpcValue::Undefined))
        }
        // discardDocsRecovery(contents)
        "discard-recovery" => {
            editor.discard_recovery(view);
            then(Ok(IpcValue::Undefined))
        }
        // docsRecoveryIdentity(webContentsId)
        "recovery-identity" => then(Ok(editor
            .recovery_identity(view)
            .map_or(IpcValue::Null, untitled_json))),
        // docsRecoveryEditor.writeCopiesNow()
        "write-copies-now" => {
            editor.write_copies_now(Box::new(move || then(Ok(IpcValue::Undefined))))
        }
        // docsRecoveryEditor.openFileWithDecision(contents, { filePath, decision })
        "open-file-with-decision" => {
            let decision = if args[0]["decision"] == "restore" {
                RecoveryOpenDecision::Restore
            } else {
                RecoveryOpenDecision::Original
            };
            editor.open_file_with_decision(
                view,
                args[0]["filePath"].as_str().unwrap_or_default().into(),
                decision,
            );
            then(Ok(IpcValue::Undefined))
        }
        // docsRecoveryEditor.openUntitledCopy(contents, { copy, title, saveAsDefaultPath })
        "open-untitled-copy" => {
            let r = &args[0];
            editor.open_untitled_copy(
                view,
                identity(&r["copy"]),
                r["title"].as_str().unwrap_or_default().into(),
                r["saveAsDefaultPath"].as_str().map(str::to_owned),
            );
            then(Ok(IpcValue::Undefined))
        }
        // createAiDocument(request, ownerWebContentsId)
        "create-ai-document" => {
            editor.create_ai_document(
                &kit::from_json(&args[0]),
                view,
                Box::new(move |v| then(Ok(v))),
            );
        }
        // exportDocsHeadless(input, outPath, format, timeoutMs) past its window
        "export-headless" => editor.begin_headless_export(
            view,
            text(args, 0),
            text(args, 1),
            args[2].as_str().unwrap_or("pdf"),
            Duration::from_millis(args[3].as_u64().unwrap_or(300_000)),
            Box::new(move |r| then(r.map(|()| IpcValue::Undefined).map_err(kit::error))),
        ),
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
    use shell_contract::Surface;
    use shell_contract::ipc::Sender;

    use super::*;
    use crate::testing::Rt;

    type Answer = Rc<RefCell<Option<Result<IpcValue, shell_contract::IpcError>>>>;

    fn rt() -> (Rt, Sender) {
        let mut rt = Rt::new(|h| {
            super::super::fakes(h, &Value::Null);
            h.insert::<Arc<Mutex<SharedRecoveryState>>>(Arc::new(Mutex::new(
                SharedRecoveryState::new("r"),
            )));
        });
        rt.register(super::super::entries).unwrap();
        let a = rt.view(1, Surface::Docs);
        (rt, a)
    }

    fn run(rt: &mut Rt, what: &str, args: Value) -> Answer {
        let got: Answer = Rc::default();
        let g = got.clone();
        let provided = rt.provided();
        let known = probe_trigger(
            what,
            ViewId(1),
            &args,
            &rt.services,
            &provided,
            Box::new(move |r| *g.borrow_mut() = Some(r)),
        );
        assert!(known, "{what}");
        rt.drain();
        got
    }

    #[test]
    fn shell_calls_reach_the_editor_and_answer() {
        let (mut rt, a) = rt();
        let provided = rt.provided();
        let unknown = probe_trigger(
            "nope",
            ViewId(1),
            &json!([]),
            &rt.services,
            &provided,
            Box::new(|_| {}),
        );
        assert!(!unknown);
        assert_eq!(
            *run(&mut rt, "document-path", json!([])).borrow(),
            Some(Ok(IpcValue::Null))
        );
        run(&mut rt, "mark-new-blank", json!([]));
        assert_eq!(
            rt.invoke_now("docs:consume-new-blank", a, vec![]),
            Ok(true.into_ipc())
        );
        run(&mut rt, "teardown", json!([false]));
        assert_eq!(
            *run(&mut rt, "torn-down", json!([])).borrow(),
            Some(Ok(true.into_ipc()))
        );
        let events: Vec<_> = rt.events().into_iter().map(|e| e.channel).collect();
        assert_eq!(events, vec!["docs:teardown"]);
    }

    #[test]
    fn a_waiting_shell_call_answers_when_the_renderer_does() {
        let (mut rt, a) = rt();
        let closed = run(&mut rt, "request-close", json!([1]));
        assert_eq!(*closed.borrow(), None);
        rt.send("docs:close-check-result", a, vec![false.into_ipc()]);
        assert_eq!(*closed.borrow(), Some(Ok(true.into_ipc())));
        let events: Vec<_> = rt.events().into_iter().map(|e| e.channel).collect();
        assert_eq!(events, vec!["docs:close-check"]);
    }
}
