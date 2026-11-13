//! `apps/slides/src/main/template-selection-ipc.ts`: the two channels with
//! which a slides renderer reads and sets the design template remembered for
//! its deck. The renderer never names a file: which document is meant is the
//! calling view's slides session, which batch D1 provides
//! ([`SlidesDocuments`], looked up when a call comes). The store itself is
//! `main-core`'s [`TemplateSelectionMemory`].
//!
//! The hooks the TypeScript module also exports (`followTemplateSelection`,
//! `inheritTemplateSelection`, `moveSlidesTemplateSelection`) are called by
//! D1's save paths and W's rename path: the port provides them
//! ([`SlidesTemplateSelectionHooks`]) over the same memory.

use std::cell::{OnceCell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use jscompat::{JsObject, JsonValue};
use main_core::slides::template_selection::TemplateSelection;
use main_core::slides::template_selection_store::{
    TemplateSelectionDocument, TemplateSelectionMemory, TemplateSelectionStoreOptions,
};
use shell_contract::IpcValue;
use shell_contract::ViewId;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, PathName};
use shell_contract::slides::{SlidesDocument, SlidesDocuments, SlidesTemplateSelectionHooks};

use crate::ports::SlidesTemplateSelection;
use crate::value::{arg, from_json};

/// The store's document from the contract's
fn store_doc(doc: &SlidesDocument) -> TemplateSelectionDocument {
    TemplateSelectionDocument {
        id: doc.id,
        path: doc.path.clone(),
    }
}

/// `TemplateSelection` as the renderer receives it
fn selection_json(selection: &TemplateSelection) -> JsonValue {
    let mut object = JsObject::new();
    object.set(
        "kind",
        JsonValue::String(selection.kind.as_str().to_owned()),
    );
    object.set("key", JsonValue::String(selection.key.clone()));
    object.set(
        "adjustments",
        JsonValue::Array(
            selection
                .adjustments
                .iter()
                .cloned()
                .map(JsonValue::String)
                .collect(),
        ),
    );
    object.set("updatedAt", JsonValue::Number(selection.updated_at));
    JsonValue::Object(object)
}

fn answer(selection: Option<TemplateSelection>) -> IpcValue {
    match selection {
        Some(selection) => from_json(&selection_json(&selection)),
        None => IpcValue::Null,
    }
}

pub struct SlidesTemplateSelectionPort {
    paths: Arc<dyn AppPaths>,
    provided: Rc<Provided>,
    /// `memory`: created on first use, once the shell has settled the
    /// user-data folder
    memory: OnceCell<Rc<RefCell<TemplateSelectionMemory>>>,
}

impl SlidesTemplateSelectionPort {
    pub fn new(paths: Arc<dyn AppPaths>, provided: Rc<Provided>) -> Self {
        SlidesTemplateSelectionPort {
            paths,
            provided,
            memory: OnceCell::new(),
        }
    }

    /// `sessions.get(event.sender.id)`: from whichever batch provides it
    fn document(&self, view: ViewId) -> Option<TemplateSelectionDocument> {
        self.provided
            .all::<dyn SlidesDocuments>()
            .iter()
            .find_map(|documents| documents.document(view))
            .map(|doc| store_doc(&doc))
    }

    /// `templateSelectionMemory()`
    fn memory(&self) -> Rc<RefCell<TemplateSelectionMemory>> {
        self.memory
            .get_or_init(|| {
                let user_data = self.paths.path(PathName::UserData);
                Rc::new(RefCell::new(TemplateSelectionMemory::new(
                    &user_data.to_string_lossy(),
                    TemplateSelectionStoreOptions::default(),
                )))
            })
            .clone()
    }
}

impl SlidesTemplateSelection for SlidesTemplateSelectionPort {
    fn slides_ai_template_selection_get(
        &self,
        cx: &CallContext,
        _args: Vec<IpcValue>,
        reply: Responder,
    ) {
        let selection = self
            .document(cx.sender.view)
            .and_then(|document| self.memory().borrow().get(&document));
        reply.reply(Ok(answer(selection)))
    }

    fn slides_ai_template_selection_set(
        &self,
        cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        let selection = self.document(cx.sender.view).and_then(|document| {
            self.memory()
                .borrow_mut()
                .set(&document, arg(&args, 0).as_ref())
        });
        reply.reply(Ok(answer(selection)))
    }
}

/// The hooks never fail the save or rename they are called from: the
/// memory swallows its own errors (`guarded` in the TypeScript)
impl SlidesTemplateSelectionHooks for SlidesTemplateSelectionPort {
    fn follow(&self, doc: &SlidesDocument, from_path: &str, to_path: &str) {
        self.memory()
            .borrow_mut()
            .follow(&store_doc(doc), from_path, to_path)
    }

    fn inherit(&self, previous: Option<&SlidesDocument>, replacement: &SlidesDocument) {
        self.memory()
            .borrow_mut()
            .inherit(previous.map(store_doc).as_ref(), &store_doc(replacement))
    }

    fn moved(&self, old_path: &str, new_path: &str) {
        self.memory().borrow_mut().moved(old_path, new_path)
    }
}

/// The host the shell inserts for this port; it also provides the hooks
pub fn factory() -> crate::Factory<dyn SlidesTemplateSelection> {
    crate::Factory::new(|services, provided| {
        let port = Rc::new(SlidesTemplateSelectionPort::new(
            services.paths.clone(),
            provided.clone(),
        ));
        provided.add::<dyn SlidesTemplateSelectionHooks>(port.clone());
        let port: Rc<dyn SlidesTemplateSelection> = port;
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use shell_contract::ipc::Sender;
    use shell_contract::runtime::CancelToken;
    use shell_contract::{IpcError, Surface, WindowId};

    use super::*;

    struct Dir(PathBuf);
    impl AppPaths for Dir {
        fn path(&self, _: PathName) -> PathBuf {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct Sessions(Mutex<HashMap<u32, SlidesDocument>>);
    impl SlidesDocuments for Sessions {
        fn document(&self, view: ViewId) -> Option<SlidesDocument> {
            self.0.lock().unwrap().get(&view.0).cloned()
        }
    }

    fn user_data(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shell-a-template-selection-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn port(dir: &Path, sessions: &Rc<Sessions>) -> SlidesTemplateSelectionPort {
        let provided = Rc::new(Provided::default());
        provided.add::<dyn SlidesDocuments>(sessions.clone());
        SlidesTemplateSelectionPort::new(Arc::new(Dir(dir.to_path_buf())), provided)
    }

    fn call(view: u32, f: impl FnOnce(&CallContext, Responder)) -> Result<IpcValue, IpcError> {
        let cx = CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(1),
                surface: Surface::Slides,
            },
            request: None,
            cancel: CancelToken::default(),
        };
        let out = Arc::new(Mutex::new(None));
        let slot = out.clone();
        f(
            &cx,
            Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
        );
        out.lock().unwrap().take().expect("answered")
    }

    fn get(p: &SlidesTemplateSelectionPort, view: u32) -> IpcValue {
        call(view, |cx, reply| {
            p.slides_ai_template_selection_get(cx, vec![], reply)
        })
        .unwrap()
    }

    fn set(p: &SlidesTemplateSelectionPort, view: u32, selection: IpcValue) -> IpcValue {
        call(view, |cx, reply| {
            p.slides_ai_template_selection_set(cx, vec![selection], reply)
        })
        .unwrap()
    }

    fn selection(kind: &str, key: &str, adjustments: &[&str]) -> IpcValue {
        IpcValue::Object(vec![
            ("kind".into(), IpcValue::String(kind.into())),
            ("key".into(), IpcValue::String(key.into())),
            (
                "adjustments".into(),
                IpcValue::Array(
                    adjustments
                        .iter()
                        .map(|a| IpcValue::String((*a).into()))
                        .collect(),
                ),
            ),
        ])
    }

    fn field<'a>(value: &'a IpcValue, name: &str) -> &'a IpcValue {
        match value {
            IpcValue::Object(entries) => &entries.iter().find(|(k, _)| k == name).unwrap().1,
            other => panic!("not an object: {other:?}"),
        }
    }

    fn open(sessions: &Rc<Sessions>, view: u32, id: u64, path: &str) {
        sessions.0.lock().unwrap().insert(
            view,
            SlidesDocument {
                id,
                path: path.into(),
            },
        );
    }

    #[test]
    fn a_window_with_no_document_answers_null_both_ways() {
        let dir = user_data("nodoc");
        let sessions = Rc::new(Sessions::default());
        let p = port(&dir, &sessions);
        assert_eq!(get(&p, 7), IpcValue::Null);
        assert_eq!(
            set(&p, 7, selection("builtin", "aurora", &[])),
            IpcValue::Null
        );
    }

    #[test]
    fn an_unsaved_deck_remembers_its_selection_in_memory_only() {
        let dir = user_data("unsaved");
        let sessions = Rc::new(Sessions::default());
        open(&sessions, 1, 11, "");
        let p = port(&dir, &sessions);
        assert_eq!(get(&p, 1), IpcValue::Null);
        let stored = set(
            &p,
            1,
            selection("builtin", "aurora", &["  mostly blue ", ""]),
        );
        assert_eq!(field(&stored, "kind"), &IpcValue::String("builtin".into()));
        assert_eq!(field(&stored, "key"), &IpcValue::String("aurora".into()));
        assert_eq!(
            field(&stored, "adjustments"),
            &IpcValue::Array(vec![IpcValue::String("mostly blue".into())])
        );
        assert_eq!(get(&p, 1), stored);
        // nothing reached the disk, and another deck sees nothing
        open(&sessions, 2, 22, "");
        assert_eq!(get(&p, 2), IpcValue::Null);
        let fresh = port(&dir, &sessions);
        assert_eq!(get(&fresh, 1), IpcValue::Null);
    }

    #[test]
    fn a_saved_deck_keeps_its_selection_across_ports() {
        let dir = user_data("saved");
        let file = dir.join("deck.pptx");
        std::fs::write(&file, b"x").unwrap();
        let sessions = Rc::new(Sessions::default());
        open(&sessions, 1, 11, &file.to_string_lossy());
        let first = port(&dir, &sessions);
        let stored = set(&first, 1, selection("saved", "My style", &[]));
        let reopened = port(&dir, &sessions);
        assert_eq!(get(&reopened, 1), stored);
    }

    #[test]
    fn something_that_is_not_a_selection_changes_nothing_and_null_forgets() {
        let dir = user_data("invalid");
        let sessions = Rc::new(Sessions::default());
        open(&sessions, 1, 11, "");
        let p = port(&dir, &sessions);
        let kept = set(&p, 1, selection("builtin", "aurora", &[]));
        // an unknown kind is ignored: the remembered one comes back
        assert_eq!(set(&p, 1, selection("mystery", "x", &[])), kept);
        assert_eq!(set(&p, 1, IpcValue::String("nope".into())), kept);
        assert_eq!(set(&p, 1, IpcValue::Null), IpcValue::Null);
        assert_eq!(get(&p, 1), IpcValue::Null);
    }

    #[test]
    fn the_hooks_carry_the_selection_to_a_saved_file_a_new_session_and_a_rename() {
        let dir = user_data("hooks");
        let sessions = Rc::new(Sessions::default());
        open(&sessions, 1, 11, "");
        let p = port(&dir, &sessions);
        let stored = set(&p, 1, selection("builtin", "aurora", &[]));
        // a replacement session in the same window starts with what the old one had
        let old = SlidesDocument {
            id: 11,
            path: String::new(),
        };
        let new = SlidesDocument {
            id: 12,
            path: String::new(),
        };
        p.inherit(Some(&old), &new);
        open(&sessions, 1, 12, "");
        assert_eq!(get(&p, 1), stored);
        // the first save writes it under the file; a fresh port reads it from disk
        let first = dir.join("a.pptx").to_string_lossy().into_owned();
        p.follow(&new, "", &first);
        open(&sessions, 1, 12, &first);
        assert_eq!(get(&port(&dir, &sessions), 1), stored);
        // a rename moves the record: nothing stays under the old path
        let second = dir.join("b.pptx").to_string_lossy().into_owned();
        p.moved(&first, &second);
        assert_eq!(get(&port(&dir, &sessions), 1), IpcValue::Null);
        open(&sessions, 1, 12, &second);
        assert_eq!(get(&port(&dir, &sessions), 1), stored);
    }

    #[test]
    fn the_factory_provides_the_hooks() {
        let provided = Rc::new(Provided::default());
        let paths: Arc<dyn AppPaths> = Arc::new(Dir(user_data("factory")));
        let port = Rc::new(SlidesTemplateSelectionPort::new(paths, provided.clone()));
        provided.add::<dyn SlidesTemplateSelectionHooks>(port);
        assert_eq!(provided.all::<dyn SlidesTemplateSelectionHooks>().len(), 1);
    }
}
