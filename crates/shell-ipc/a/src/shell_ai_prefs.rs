//! The AI channels the shell entry (`apps/shell/src/main/index.ts`) answers
//! itself: the AI panel preferences every window shares, the slides AI
//! fonts, and opening Settings at the AI model page. The entry is shared and
//! nobody ports it whole, so these bodies live here. `normalizeAiPanelPrefs`
//! and `sameAiPanelPrefs` of `packages/ui/src/ai-panel-prefs.ts` come with
//! them: nothing in `main-core` reads the preferences.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsObject, JsonValue};
use main_core::packages::ui::normalize_slides_ai_fonts;
use main_core::shell::app_settings::{read_app_settings, write_app_setting, write_app_settings};
use shell_contract::hosts::MainWindowHost;
use shell_contract::ipc::{CallContext, EventSink, Responder, Target};
use shell_contract::runtime::{AppPaths, PathName};
use shell_contract::{IpcError, IpcValue};

use crate::ports::ShellAiPrefs;
use crate::value::{arg, from_json, to_json};

/// `SLIDES_AI_FONTS_KEY`
const SLIDES_AI_FONTS_KEY: &str = "slidesAiFonts";
/// `AI_FONT_SIZES`
const AI_FONT_SIZES: [&str; 4] = ["default", "large", "xlarge", "custom"];
const AI_FONT_BASE_PX: f64 = 14.0;
const AI_CUSTOM_FONT_MIN_PX: f64 = 10.0;
const AI_CUSTOM_FONT_MAX_PX: f64 = 32.0;
/// `HOME_CHANNELS.openSettings`
const HOME_OPEN_SETTINGS: &str = "home:open-settings";
const PREFS_CHANGED: &str = "app:ai-panel-prefs-changed";

/// What the shell entry reaches beyond the shared hosts: the language
/// documents are written in (M's app settings) and the shell window brought
/// forward on its home tab (W's tabs)
pub trait ShellUi {
    /// `currentDocumentLocale()`
    fn document_locale(&self) -> String;
    /// restore, show and focus the shell window and open its home tab
    /// (`win.restore()`, `show()`, `focus()`, `tabManager.openHomeTab()`)
    fn show_home_tab(&self);
}

pub type ShellUiHost = Arc<dyn ShellUi + Send + Sync>;

/// `AiPanelPrefs`
#[derive(Clone, Debug, PartialEq)]
pub struct AiPanelPrefs {
    pub side: &'static str,
    pub font_size: &'static str,
    pub custom_font_size: f64,
    pub spellcheck: bool,
    pub open_in_new_docs: bool,
    pub show_ai_sidebar: bool,
}

impl AiPanelPrefs {
    fn to_json(&self) -> JsonValue {
        let mut o = JsObject::new();
        o.set("side", JsonValue::String(self.side.into()));
        o.set("fontSize", JsonValue::String(self.font_size.into()));
        o.set("customFontSize", JsonValue::Number(self.custom_font_size));
        o.set("spellcheck", JsonValue::Bool(self.spellcheck));
        o.set("openInNewDocs", JsonValue::Bool(self.open_in_new_docs));
        o.set("showAiSidebar", JsonValue::Bool(self.show_ai_sidebar));
        JsonValue::Object(o)
    }
}

/// `clampAiCustomFontSize(value)`
fn clamp_custom_font_size(value: Option<&JsonValue>) -> Option<f64> {
    let n = match value? {
        JsonValue::Number(n) => *n,
        JsonValue::String(s) => jscompat::to_number(s),
        _ => return None,
    };
    n.is_finite()
        .then(|| jscompat::math_round(n).clamp(AI_CUSTOM_FONT_MIN_PX, AI_CUSTOM_FONT_MAX_PX))
}

fn bool_or(value: Option<&JsonValue>, fallback: bool) -> bool {
    match value {
        Some(JsonValue::Bool(b)) => *b,
        _ => fallback,
    }
}

/// `normalizeAiPanelPrefs(raw)`: an object's fields, each falling back to
/// the default when missing or malformed
pub fn normalize_ai_panel_prefs(raw: &JsObject<JsonValue>) -> AiPanelPrefs {
    let font_size = match raw.get("fontSize") {
        Some(JsonValue::String(s)) => AI_FONT_SIZES.iter().copied().find(|f| f == s),
        _ => None,
    };
    AiPanelPrefs {
        side: match raw.get("side") {
            Some(JsonValue::String(s)) if s == "right" => "right",
            _ => "left",
        },
        font_size: font_size.unwrap_or("default"),
        custom_font_size: clamp_custom_font_size(raw.get("customFontSize"))
            .unwrap_or(AI_FONT_BASE_PX),
        spellcheck: bool_or(raw.get("spellcheck"), true),
        open_in_new_docs: bool_or(raw.get("openInNewDocs"), true),
        show_ai_sidebar: bool_or(raw.get("showAiSidebar"), true),
    }
}

/// The JSON of a prefs field: a string stays a string, as the TypeScript
/// handed the stored and patched values straight to `normalizeAiPanelPrefs`
fn field(o: &mut JsObject<JsonValue>, key: &str, value: Option<JsonValue>) {
    if let Some(value) = value {
        o.set(key, value);
    }
}

pub struct ShellAiPrefsPort {
    pub paths: Arc<dyn AppPaths>,
    pub events: Arc<dyn EventSink>,
    pub ui: ShellUiHost,
    pub main_window: MainWindowHost,
    /// `cachedAiPanelPrefs`
    cache: RefCell<Option<AiPanelPrefs>>,
}

impl ShellAiPrefsPort {
    pub fn new(
        paths: Arc<dyn AppPaths>,
        events: Arc<dyn EventSink>,
        ui: ShellUiHost,
        main_window: MainWindowHost,
    ) -> Self {
        ShellAiPrefsPort {
            paths,
            events,
            ui,
            main_window,
            cache: RefCell::new(None),
        }
    }

    /// `APP_SETTINGS_PATH()`
    fn settings_path(&self) -> String {
        let path: PathBuf = self
            .paths
            .path(PathName::UserData)
            .join("app-settings.json");
        path.to_string_lossy().into_owned()
    }

    /// `currentAiPanelPrefs()`
    fn current(&self) -> AiPanelPrefs {
        if let Some(prefs) = self.cache.borrow().clone() {
            return prefs;
        }
        let saved = read_app_settings(&self.settings_path());
        let mut raw = JsObject::new();
        for (key, stored) in [
            ("side", "aiPanelSide"),
            ("fontSize", "aiPanelFontSize"),
            ("customFontSize", "aiPanelCustomFontSize"),
            ("spellcheck", "aiPanelSpellcheck"),
            ("openInNewDocs", "aiPanelOpenInNewDocs"),
            ("showAiSidebar", "aiPanelShowSidebar"),
        ] {
            field(&mut raw, key, saved.get(stored).cloned());
        }
        let prefs = normalize_ai_panel_prefs(&raw);
        *self.cache.borrow_mut() = Some(prefs.clone());
        prefs
    }

    /// `setAiPanelPrefs(patch)`: `patch` as the renderer sent it, since
    /// `'key' in raw` also sees a key whose value is `undefined`
    fn set(&self, patch: Option<&IpcValue>) -> Result<AiPanelPrefs, IpcError> {
        let prev = self.current();
        let prev_json = prev.to_json();
        let entries: &[(String, IpcValue)] = match patch {
            Some(IpcValue::Object(entries)) => entries,
            _ => &[],
        };
        let own = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v);
        let mut merged = JsObject::new();
        let side = match own("side") {
            Some(IpcValue::String(s)) if s == "left" || s == "right" => s.clone(),
            _ => prev.side.to_owned(),
        };
        merged.set("side", JsonValue::String(side));
        for key in [
            "fontSize",
            "customFontSize",
            "spellcheck",
            "openInNewDocs",
            "showAiSidebar",
        ] {
            let value = match own(key) {
                Some(value) => to_json(value),
                None => prev_json.get(key).map(|v| v.into_owned()),
            };
            field(&mut merged, key, value);
        }
        let next = normalize_ai_panel_prefs(&merged);
        if next == prev {
            return Ok(prev);
        }
        *self.cache.borrow_mut() = Some(next.clone());
        write_app_settings(
            &self.settings_path(),
            &[
                ("aiPanelSide", Some(JsonValue::String(next.side.into()))),
                (
                    "aiPanelFontSize",
                    Some(JsonValue::String(next.font_size.into())),
                ),
                (
                    "aiPanelCustomFontSize",
                    Some(JsonValue::Number(next.custom_font_size)),
                ),
                ("aiPanelSpellcheck", Some(JsonValue::Bool(next.spellcheck))),
                (
                    "aiPanelOpenInNewDocs",
                    Some(JsonValue::Bool(next.open_in_new_docs)),
                ),
                (
                    "aiPanelShowSidebar",
                    Some(JsonValue::Bool(next.show_ai_sidebar)),
                ),
            ],
        )
        .map_err(node_error)?;
        self.events
            .emit(Target::All, PREFS_CHANGED, vec![from_json(&next.to_json())]);
        Ok(next)
    }

    fn get_prefs(&self, reply: Responder) {
        reply.reply(Ok(from_json(&self.current().to_json())))
    }

    fn set_prefs(&self, args: Vec<IpcValue>, reply: Responder) {
        reply.reply(self.set(args.first()).map(|p| from_json(&p.to_json())))
    }
}

fn node_error(error: main_core::node_fs::NodeError) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: error.message,
    }
}

impl ShellAiPrefs for ShellAiPrefsPort {
    fn ai_open_model_settings(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        if let Some(view) = self.main_window.view() {
            self.ui.show_home_tab();
            let mut section = JsObject::new();
            section.set("section", JsonValue::String("aiModel".into()));
            self.events.emit(
                Target::View(view),
                HOME_OPEN_SETTINGS,
                vec![from_json(&JsonValue::Object(section))],
            );
        }
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn app_get_ai_panel_prefs(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.get_prefs(reply)
    }

    fn home_get_ai_panel_prefs(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.get_prefs(reply)
    }

    fn app_set_ai_panel_prefs(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.set_prefs(args, reply)
    }

    fn home_set_ai_panel_prefs(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.set_prefs(args, reply)
    }

    fn home_get_slides_ai_fonts(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let settings = read_app_settings(&self.settings_path());
        let fonts = normalize_slides_ai_fonts(
            settings.get(SLIDES_AI_FONTS_KEY),
            &self.ui.document_locale(),
        );
        reply.reply(Ok(from_json(&fonts.to_json())))
    }

    fn home_set_slides_ai_fonts(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let next =
            normalize_slides_ai_fonts(arg(&args, 0).as_ref(), &self.ui.document_locale()).to_json();
        let written = write_app_setting(
            &self.settings_path(),
            SLIDES_AI_FONTS_KEY,
            Some(next.clone()),
        );
        reply.reply(written.map(|_| from_json(&next)).map_err(node_error))
    }
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn ShellAiPrefs> {
    crate::Factory::new(|services, _| {
        let hosts = &services.hosts;
        let port: std::rc::Rc<dyn ShellAiPrefs> = std::rc::Rc::new(ShellAiPrefsPort::new(
            services.paths.clone(),
            services.events.clone(),
            hosts.need::<ShellUiHost>(shell_contract::Batch::A)?,
            hosts.need::<MainWindowHost>(shell_contract::Batch::A)?,
        ));
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use shell_contract::ipc::Sender;
    use shell_contract::runtime::CancelToken;
    use shell_contract::{Surface, ViewId, WindowId};

    use super::*;

    struct Dir(PathBuf);
    impl AppPaths for Dir {
        fn path(&self, _: PathName) -> PathBuf {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct Log(Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);
    impl EventSink for Log {
        fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
            self.0.lock().unwrap().push((target, channel, args));
        }
    }

    struct Ui(Mutex<u32>);
    impl ShellUi for Ui {
        fn document_locale(&self) -> String {
            "ja".into()
        }
        fn show_home_tab(&self) {
            *self.0.lock().unwrap() += 1;
        }
    }

    struct Main(Option<ViewId>);
    impl shell_contract::hosts::MainWindow for Main {
        fn view(&self) -> Option<ViewId> {
            self.0
        }
        fn window(&self) -> Option<WindowId> {
            self.0.map(|_| WindowId(1))
        }
    }

    struct Rig {
        dir: PathBuf,
        log: Arc<Log>,
        ui: Arc<Ui>,
        port: ShellAiPrefsPort,
    }

    fn rig(name: &str, main: Option<ViewId>) -> Rig {
        let dir = std::env::temp_dir().join(format!("shell-a-prefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = Arc::new(Log::default());
        let ui = Arc::new(Ui(Mutex::new(0)));
        let port = ShellAiPrefsPort::new(
            Arc::new(Dir(dir.clone())),
            log.clone(),
            ui.clone(),
            Arc::new(Main(main)),
        );
        Rig { dir, log, ui, port }
    }

    fn call(f: impl FnOnce(&CallContext, Responder)) -> Result<IpcValue, IpcError> {
        let cx = CallContext {
            sender: Sender {
                view: ViewId(5),
                window: WindowId(2),
                surface: Surface::Docs,
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

    fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
        IpcValue::Object(
            entries
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    fn prefs(side: &str, size: &str, custom: f64, spell: bool) -> IpcValue {
        obj(&[
            ("side", IpcValue::String(side.into())),
            ("fontSize", IpcValue::String(size.into())),
            ("customFontSize", IpcValue::Number(custom)),
            ("spellcheck", IpcValue::Bool(spell)),
            ("openInNewDocs", IpcValue::Bool(true)),
            ("showAiSidebar", IpcValue::Bool(true)),
        ])
    }

    fn settings(dir: &std::path::Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join("app-settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_patch_is_merged_clamped_written_and_broadcast() {
        let r = rig("merge", None);
        assert_eq!(
            call(|cx, re| r.port.app_get_ai_panel_prefs(cx, vec![], re)),
            Ok(prefs("left", "default", 14.0, true))
        );
        let patch = obj(&[
            ("side", IpcValue::String("right".into())),
            ("fontSize", IpcValue::String("custom".into())),
            ("customFontSize", IpcValue::String("99.4".into())),
            ("spellcheck", IpcValue::Bool(false)),
        ]);
        let want = prefs("right", "custom", 32.0, false);
        assert_eq!(
            call(|cx, re| r.port.home_set_ai_panel_prefs(cx, vec![patch], re)),
            Ok(want.clone())
        );
        let file = settings(&r.dir);
        assert_eq!(file["aiPanelSide"], "right");
        assert_eq!(file["aiPanelCustomFontSize"], 32.0);
        assert_eq!(file["aiPanelSpellcheck"], false);
        assert_eq!(
            r.log.0.lock().unwrap().as_slice(),
            &[(Target::All, PREFS_CHANGED, vec![want])]
        );
    }

    #[test]
    fn an_unchanged_patch_writes_and_sends_nothing() {
        let r = rig("same", None);
        let side = obj(&[("side", IpcValue::String("left".into()))]);
        let got = call(|cx, re| r.port.app_set_ai_panel_prefs(cx, vec![side], re));
        assert_eq!(got, Ok(prefs("left", "default", 14.0, true)));
        assert!(!r.dir.join("app-settings.json").exists());
        assert!(r.log.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_key_sent_as_undefined_falls_back_to_the_default_and_a_bad_side_keeps_the_old() {
        let r = rig("undefined", None);
        let first = obj(&[
            ("side", IpcValue::String("right".into())),
            ("spellcheck", IpcValue::Bool(false)),
        ]);
        call(|cx, re| r.port.app_set_ai_panel_prefs(cx, vec![first], re)).unwrap();
        let second = obj(&[
            ("side", IpcValue::String("up".into())),
            ("spellcheck", IpcValue::Undefined),
        ]);
        assert_eq!(
            call(|cx, re| r.port.app_set_ai_panel_prefs(cx, vec![second], re)),
            Ok(prefs("right", "default", 14.0, true))
        );
    }

    #[test]
    fn stored_prefs_are_read_once_and_normalized() {
        let r = rig("stored", None);
        std::fs::write(
            r.dir.join("app-settings.json"),
            r#"{"aiPanelSide":"right","aiPanelFontSize":"huge","aiPanelCustomFontSize":3,"aiPanelSpellcheck":"no"}"#,
        )
        .unwrap();
        let want = prefs("right", "default", 10.0, true);
        assert_eq!(
            call(|cx, re| r.port.home_get_ai_panel_prefs(cx, vec![], re)),
            Ok(want.clone())
        );
        std::fs::remove_file(r.dir.join("app-settings.json")).unwrap();
        assert_eq!(
            call(|cx, re| r.port.home_get_ai_panel_prefs(cx, vec![], re)),
            Ok(want)
        );
    }

    #[test]
    fn slides_fonts_normalize_with_the_document_language_and_persist() {
        let r = rig("fonts", None);
        let auto = obj(&[
            ("mode", IpcValue::String("auto".into())),
            ("sans", IpcValue::String("Pretendard".into())),
            ("serif", IpcValue::String("Noto Serif KR".into())),
        ]);
        assert_eq!(
            call(|cx, re| r.port.home_get_slides_ai_fonts(cx, vec![], re)),
            Ok(auto)
        );
        let input = obj(&[
            ("mode", IpcValue::String("serif".into())),
            ("sans", IpcValue::String("  Arial\"  ".into())),
        ]);
        let want = obj(&[
            ("mode", IpcValue::String("serif".into())),
            ("sans", IpcValue::String("Arial".into())),
            ("serif", IpcValue::String("Noto Serif KR".into())),
        ]);
        assert_eq!(
            call(|cx, re| r.port.home_set_slides_ai_fonts(cx, vec![input], re)),
            Ok(want.clone())
        );
        assert_eq!(settings(&r.dir)["slidesAiFonts"]["sans"], "Arial");
        assert_eq!(
            call(|cx, re| r.port.home_get_slides_ai_fonts(cx, vec![], re)),
            Ok(want)
        );
    }

    #[test]
    fn model_settings_open_on_the_shell_window_only_when_it_exists() {
        let none = rig("open-none", None);
        assert_eq!(
            call(|cx, re| none.port.ai_open_model_settings(cx, vec![], re)),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(*none.ui.0.lock().unwrap(), 0);
        let r = rig("open", Some(ViewId(9)));
        call(|cx, re| r.port.ai_open_model_settings(cx, vec![], re)).unwrap();
        assert_eq!(*r.ui.0.lock().unwrap(), 1);
        assert_eq!(
            r.log.0.lock().unwrap().as_slice(),
            &[(
                Target::View(ViewId(9)),
                HOME_OPEN_SETTINGS,
                vec![obj(&[("section", IpcValue::String("aiModel".into()))])]
            )]
        );
    }
}
