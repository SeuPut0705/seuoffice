//! `apps/shell/src/main/outbound-confirm.ts`: the main-process side of the
//! editors' outbound guard (decision 0062). It answers whether "Let AI use
//! internet tools" is on, and puts the question to the person before the AI
//! fetches an address that has not appeared in the conversation. Only the
//! person's click allows; a closed dialog or a bad request answers no.
//!
//! `confirmRequestOf` is `main-core`'s. The switch is read from
//! `ai-settings.json` with `main-core`'s `normalizeAiSettings`, as
//! `readStoredAiSettings` of the shell entry does.

use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsonValue, json_parse, slice_utf16};
use main_core::packages::ai_provider::legacy_settings::normalize_ai_settings;
use main_core::packages::electron_utils::outbound_channels::confirm_request_of;
use main_core::packages::i18n::Lang;
use shell_contract::IpcValue;
use shell_contract::hosts::{DialogsHost, MessageBox};
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::{AppPaths, PathName};

use crate::ports::Outbound;
use crate::value::arg;

/// `SHOWN_ADDRESS_CHARS`: characters of one address the dialog shows
const SHOWN_ADDRESS_CHARS: usize = 300;

/// What the module reads from the shell entry
pub trait OutboundShell {
    /// `currentLang()`: the UI language the question is worded in
    fn lang(&self) -> Lang;
}

pub type OutboundShellHost = Arc<dyn OutboundShell + Send + Sync>;

/// `OUTBOUND_CONFIRM_STRINGS`
fn text(lang: Lang, key: &str) -> &'static str {
    match (lang, key) {
        (Lang::En, "title") => "AI wants to open a web address",
        (Lang::En, "body") => {
            "The AI wants to fetch the address below. It has not appeared in this conversation before."
        }
        (Lang::En, "warn") => {
            "Hidden text in a document or web page may have told the AI to do this. Block it if the address carries document content or you do not know the site."
        }
        (Lang::En, "allow") => "Allow",
        (Lang::En, "block") => "Block",
        (Lang::Ko, "title") => "AI가 웹 주소에 접속하려고 합니다",
        (Lang::Ko, "body") => {
            "AI가 아래 주소를 가져오려고 합니다. 지금까지 대화에 나온 적 없는 주소입니다."
        }
        (Lang::Ko, "warn") => {
            "문서나 웹 페이지에 숨은 글이 AI에게 이 일을 시켰을 수 있습니다. 주소에 문서 내용이 담겨 있거나 모르는 사이트라면 막으세요."
        }
        (Lang::Ko, "allow") => "허용",
        (Lang::Ko, "block") => "막기",
        _ => unreachable!("no outbound confirm string {key}"),
    }
}

/// `confirmDialogOptions(lang, tool, addresses)`: "Block" is the default and
/// what closing the dialog means
fn confirm_dialog_options(lang: Lang, tool: &str, addresses: &[String]) -> MessageBox {
    let shown = addresses
        .iter()
        .map(|a| {
            if a.encode_utf16().count() > SHOWN_ADDRESS_CHARS {
                format!("{}…", slice_utf16(a, 0.0, Some(SHOWN_ADDRESS_CHARS as f64)))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    MessageBox {
        kind: Some("warning".into()),
        title: Some(text(lang, "title").into()),
        message: text(lang, "body").into(),
        detail: Some(format!("{shown}\n\n({tool})\n\n{}", text(lang, "warn"))),
        buttons: vec![text(lang, "block").into(), text(lang, "allow").into()],
        default_id: Some(0),
        cancel_id: Some(0),
        checkbox_label: None,
    }
}

pub struct OutboundPort {
    paths: Arc<dyn AppPaths>,
    dialogs: DialogsHost,
    shell: OutboundShellHost,
}

impl OutboundPort {
    pub fn new(paths: Arc<dyn AppPaths>, dialogs: DialogsHost, shell: OutboundShellHost) -> Self {
        OutboundPort {
            paths,
            dialogs,
            shell,
        }
    }

    /// `readStoredAiSettings().internetTools !== false`: only an explicit
    /// false turns the tools off
    fn internet_tools_on(&self) -> bool {
        let path: PathBuf = self.paths.path(PathName::UserData).join("ai-settings.json");
        let stored = std::fs::read(path)
            .ok()
            .and_then(|bytes| json_parse(&String::from_utf8_lossy(&bytes)).ok());
        let settings = normalize_ai_settings(None, stored.as_ref(), None);
        !matches!(
            settings.get("internetTools").as_deref(),
            Some(JsonValue::Bool(false))
        )
    }
}

impl Outbound for OutboundPort {
    fn ai_confirm_addresses(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = arg(&args, 0);
        let Some(request) = confirm_request_of(raw.as_ref()) else {
            return reply.reply(Ok(IpcValue::Bool(false)));
        };
        if !self.internet_tools_on() {
            return reply.reply(Ok(IpcValue::Bool(false)));
        }
        let options = confirm_dialog_options(self.shell.lang(), &request.tool, &request.addresses);
        // the question goes over the window of the caller
        let answer = self.dialogs.message(Some(cx.sender.window), &options);
        reply.reply(Ok(IpcValue::Bool(answer.response == 1)))
    }

    fn ai_internet_tools(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        reply.reply(Ok(IpcValue::Bool(self.internet_tools_on())))
    }
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn Outbound> {
    crate::Factory::new(|services, _| {
        let hosts = &services.hosts;
        let port: std::rc::Rc<dyn Outbound> = std::rc::Rc::new(OutboundPort::new(
            services.paths.clone(),
            hosts.need::<DialogsHost>(shell_contract::Batch::A)?,
            hosts.need::<OutboundShellHost>(shell_contract::Batch::A)?,
        ));
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Mutex;

    use shell_contract::hosts::{Dialogs, FileDialog, MessageBoxAnswer};
    use shell_contract::ipc::Sender;
    use shell_contract::runtime::CancelToken;
    use shell_contract::{IpcError, Surface, ViewId, WindowId};

    use super::*;

    struct Dir(PathBuf);
    impl AppPaths for Dir {
        fn path(&self, _: PathName) -> PathBuf {
            self.0.clone()
        }
    }

    struct Language(Lang);
    impl OutboundShell for Language {
        fn lang(&self) -> Lang {
            self.0
        }
    }

    /// answers every message box with `response` and remembers what it was asked
    struct Person {
        response: usize,
        asked: Mutex<Vec<(Option<WindowId>, MessageBox)>>,
    }
    impl Dialogs for Person {
        fn open(&self, _: Option<WindowId>, _: &FileDialog) -> Option<Vec<PathBuf>> {
            None
        }
        fn save(&self, _: Option<WindowId>, _: &FileDialog) -> Option<PathBuf> {
            None
        }
        fn message(&self, parent: Option<WindowId>, options: &MessageBox) -> MessageBoxAnswer {
            self.asked.lock().unwrap().push((parent, options.clone()));
            MessageBoxAnswer {
                response: self.response,
                checkbox_checked: false,
            }
        }
        fn error(&self, _: &str, _: &str) {}
    }

    struct Rig {
        dir: PathBuf,
        person: Arc<Person>,
        port: OutboundPort,
    }

    fn rig(name: &str, response: usize, lang: Lang) -> Rig {
        let dir =
            std::env::temp_dir().join(format!("shell-a-outbound-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let person = Arc::new(Person {
            response,
            asked: Mutex::new(Vec::new()),
        });
        let port = OutboundPort::new(
            Arc::new(Dir(dir.clone())),
            person.clone(),
            Arc::new(Language(lang)),
        );
        Rig { dir, person, port }
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

    fn request(tool: &str, addresses: &[&str]) -> IpcValue {
        IpcValue::Object(vec![
            ("tool".into(), IpcValue::String(tool.into())),
            (
                "addresses".into(),
                IpcValue::Array(
                    addresses
                        .iter()
                        .map(|a| IpcValue::String((*a).into()))
                        .collect(),
                ),
            ),
        ])
    }

    fn write_settings(dir: &Path, json: &str) {
        std::fs::write(dir.join("ai-settings.json"), json).unwrap();
    }

    fn confirm(r: &Rig, raw: IpcValue) -> Result<IpcValue, IpcError> {
        call(|cx, re| r.port.ai_confirm_addresses(cx, vec![raw], re))
    }

    fn asked(r: &Rig) -> usize {
        r.person.asked.lock().unwrap().len()
    }

    #[test]
    fn the_switch_is_on_unless_the_file_says_false() {
        let r = rig("switch", 1, Lang::En);
        let on = |r: &Rig| call(|cx, re| r.port.ai_internet_tools(cx, vec![], re));
        assert_eq!(on(&r), Ok(IpcValue::Bool(true)));
        write_settings(&r.dir, r#"{"providers":{},"internetTools":false}"#);
        assert_eq!(on(&r), Ok(IpcValue::Bool(false)));
        write_settings(&r.dir, r#"{"providers":{},"internetTools":true}"#);
        assert_eq!(on(&r), Ok(IpcValue::Bool(true)));
        write_settings(&r.dir, "{not json");
        assert_eq!(on(&r), Ok(IpcValue::Bool(true)));
    }

    #[test]
    fn only_the_allow_button_allows() {
        let allow = rig("allow", 1, Lang::En);
        assert_eq!(
            confirm(&allow, request("web_fetch", &["https://example.com/a"])),
            Ok(IpcValue::Bool(true))
        );
        let block = rig("block", 0, Lang::En);
        assert_eq!(
            confirm(&block, request("web_fetch", &["https://example.com/a"])),
            Ok(IpcValue::Bool(false))
        );
    }

    #[test]
    fn the_question_names_the_tool_and_cuts_long_addresses_over_the_callers_window() {
        let r = rig("question", 1, Lang::En);
        let long = format!("https://example.com/{}", "x".repeat(400));
        confirm(&r, request("web_fetch", &["  https://a.test/ ", &long])).unwrap();
        let asked = r.person.asked.lock().unwrap();
        let (parent, options) = &asked[0];
        assert_eq!(*parent, Some(WindowId(2)));
        let detail = options.detail.as_deref().unwrap();
        let cut = format!("{}…", &long[..300]);
        assert!(detail.starts_with(&format!("https://a.test/\n{cut}\n\n(web_fetch)\n\n")));
        assert_eq!(options.default_id, Some(0));
        assert_eq!(options.cancel_id, Some(0));
    }

    #[test]
    fn the_question_follows_the_ui_language() {
        let en = rig("en", 0, Lang::En);
        confirm(&en, request("web_fetch", &["https://a.test"])).unwrap();
        assert_eq!(
            en.person.asked.lock().unwrap()[0].1.buttons,
            vec!["Block".to_owned(), "Allow".to_owned()]
        );
        let ko = rig("ko", 0, Lang::Ko);
        confirm(&ko, request("web_fetch", &["https://a.test"])).unwrap();
        assert_eq!(
            ko.person.asked.lock().unwrap()[0].1.buttons,
            vec!["막기".to_owned(), "허용".to_owned()]
        );
    }

    #[test]
    fn a_bad_request_or_a_switched_off_tool_answers_no_without_asking() {
        let r = rig("refuse", 1, Lang::En);
        let nine = vec!["https://a.test"; 9];
        for bad in [
            IpcValue::Undefined,
            IpcValue::String("https://a.test".into()),
            request("Web Fetch", &["https://a.test"]),
            request("web_fetch", &[]),
            request("web_fetch", &["ftp://a.test"]),
            request("web_fetch", &nine),
        ] {
            assert_eq!(confirm(&r, bad), Ok(IpcValue::Bool(false)));
        }
        assert_eq!(asked(&r), 0);
        write_settings(&r.dir, r#"{"providers":{},"internetTools":false}"#);
        assert_eq!(
            confirm(&r, request("web_fetch", &["https://a.test"])),
            Ok(IpcValue::Bool(false))
        );
        assert_eq!(asked(&r), 0);
        write_settings(&r.dir, r#"{"providers":{},"internetTools":true}"#);
        assert_eq!(
            confirm(&r, request("web_fetch", &["https://a.test"])),
            Ok(IpcValue::Bool(true))
        );
        assert_eq!(asked(&r), 1);
    }
}
