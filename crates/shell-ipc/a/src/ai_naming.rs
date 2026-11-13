//! `apps/shell/src/main/ai-naming-service.ts`: the channel behind the
//! renderer's "Name with AI..." button (`ai:suggest-file-name`). The decisions
//! are `main_core::shell::ai_naming_service::suggest_file_name`; this port
//! carries out the one thing that module waits for, the one-shot chat of
//! `chatForProvider`, without blocking the core thread.
//!
//! `suggest_file_name` is a plain function over a [`NamingHost`] whose `chat`
//! answers at once, so the call is made twice: a planning pass in which `chat`
//! only records what it was asked, and, once the chat ended, a finishing pass
//! (same settings file, same statuses, same language as the first) in which
//! `chat` answers what the chat gave. Everything before the chat is decided
//! by the planning pass alone; a refusal there is the answer.

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::ai_provider::task::JsError;
use main_core::shell::ai_naming_service::{
    ChatOutcome, NAMING_TIMEOUT_MS, NamingHost, suggest_file_name,
};
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::{AppPaths, PathName, Services};
use shell_contract::{Batch, IpcError, IpcValue};

use crate::ports::AiNaming;
use crate::runtime::Driver;
use crate::secrets::SecretCodecHost;
use crate::value::{arg, from_json};

/// What the naming handler reaches in the shell besides its own file: the
/// subscription statuses (the provider modules' shared state) and the
/// language the instruction asks the name in
pub trait NamingContext: Send + Sync {
    /// `sharedSubscriptionStatuses()`
    fn subscription_statuses(&self) -> JsonValue;
    /// `lang()` of `registerAiNamingIpc(lang)`
    fn ui_lang(&self) -> String;
}

pub type NamingContextHost = Arc<dyn NamingContext>;

/// The codec the AI settings' keys are sealed with
pub type Codec = Arc<dyn AiSecretCodec + Send + Sync>;

/// `chatForProvider(provider, config, '', instruction, signal)` as asked
#[derive(Debug, Clone, PartialEq)]
pub struct ChatJob {
    pub provider: String,
    pub config: JsonValue,
    pub instruction: String,
}

/// What a chat ended in, and whether the 30 second timer had fired
#[derive(Debug, Clone, PartialEq)]
pub struct ChatResult {
    pub outcome: ChatOutcome,
    pub timed_out: bool,
}

/// What `chatForProvider` is to this port: the provider transports. The shell
/// leaves it out and the port runs the chat on the ai-provider runtime; a host
/// that gives one (the probe) answers instead. `done` is called once, on any
/// thread, when the chat ended
pub trait NamingChat: Send + Sync {
    fn chat(&self, job: ChatJob, done: Box<dyn FnOnce(ChatResult) + Send>);
}

pub type NamingChatHost = Arc<dyn NamingChat>;

/// Runs a chat and calls the continuation when it ended
pub type RunChat = Rc<dyn Fn(ChatJob, Box<dyn FnOnce(ChatResult) + Send>)>;

/// What the first pass learned from the host, kept for the second
#[derive(Default, Clone)]
struct Snapshot {
    file: Option<Option<String>>,
    statuses: Option<JsonValue>,
    lang: Option<String>,
}

enum Mode {
    /// `chat` records the request
    Plan(Option<ChatJob>),
    /// `chat` answers what the chat gave
    Finish(Option<ChatResult>),
}

struct Pass<'a> {
    user_data: &'a PathBuf,
    ctx: &'a dyn NamingContext,
    codec: &'a dyn AiSecretCodec,
    snap: Snapshot,
    mode: Mode,
    timed_out: bool,
}

impl NamingHost for Pass<'_> {
    fn settings_file(&mut self) -> Option<String> {
        let user_data = self.user_data;
        self.snap
            .file
            .get_or_insert_with(|| std::fs::read_to_string(user_data.join("ai-settings.json")).ok())
            .clone()
    }

    fn subscription_statuses(&mut self) -> JsonValue {
        let ctx = self.ctx;
        self.snap
            .statuses
            .get_or_insert_with(|| ctx.subscription_statuses())
            .clone()
    }

    fn ui_lang(&mut self) -> String {
        let ctx = self.ctx;
        self.snap.lang.get_or_insert_with(|| ctx.ui_lang()).clone()
    }

    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        Some(self.codec)
    }

    fn chat(&mut self, provider: &str, config: &JsonValue, instruction: &str) -> ChatOutcome {
        match &mut self.mode {
            Mode::Plan(job) => {
                *job = Some(ChatJob {
                    provider: provider.to_owned(),
                    config: config.clone(),
                    instruction: instruction.to_owned(),
                });
                // what the second pass reads of the chat is not known yet
                ChatOutcome::Threw(JsonValue::Null)
            }
            Mode::Finish(result) => {
                let result = result.take().expect("the finishing pass is asked once");
                self.timed_out = result.timed_out;
                result.outcome
            }
        }
    }

    fn timed_out(&self) -> bool {
        self.timed_out
    }

    fn warn(&mut self, detail: &JsonValue) {
        // the planning pass only imagines a failed chat
        if matches!(self.mode, Mode::Finish(_)) {
            eprintln!(
                "[shell] file naming failed: {}",
                jscompat::json_stringify(detail)
            );
        }
    }
}

/// The port of `registerAiNamingIpc`
pub struct AiNamingPort {
    user_data: PathBuf,
    ctx: NamingContextHost,
    codec: Codec,
    run_chat: RunChat,
}

impl AiNamingPort {
    pub fn new(
        paths: &dyn AppPaths,
        ctx: NamingContextHost,
        codec: Codec,
        run_chat: RunChat,
    ) -> Self {
        AiNamingPort {
            user_data: paths.path(PathName::UserData),
            ctx,
            codec,
            run_chat,
        }
    }
}

/// A chat's end as the second pass reads it. `content` of the reply is the
/// provider's own value: only a string can be split into lines, anything else
/// is the `TypeError` the TypeScript's `out.split` throws
pub fn chat_outcome_of(
    answer: Result<main_core::packages::ai_provider::types::AiChatResponse, JsError>,
) -> Result<ChatOutcome, IpcError> {
    match answer {
        Ok(reply) if reply.ok => match reply.content {
            None => Ok(ChatOutcome::Reply { content: None }),
            Some(JsonValue::String(content)) => Ok(ChatOutcome::Reply {
                content: Some(content),
            }),
            Some(_) => Err(IpcError {
                name: Some("TypeError".into()),
                message: "out.split is not a function".into(),
            }),
        },
        Ok(reply) => Ok(ChatOutcome::Failed {
            error: reply.error.map_or(JsonValue::Null, JsonValue::String),
        }),
        Err(error) => Ok(ChatOutcome::Threw(JsonValue::String(format!(
            "{}: {}",
            error.name, error.message
        )))),
    }
}

impl AiNaming for AiNamingPort {
    fn ai_suggest_file_name(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let input = arg(&args, 0);
        let mut pass = Pass {
            user_data: &self.user_data,
            ctx: &*self.ctx,
            codec: &*self.codec,
            snap: Snapshot::default(),
            mode: Mode::Plan(None),
            timed_out: false,
        };
        let planned = suggest_file_name(&mut pass, input.as_ref());
        let Mode::Plan(Some(job)) = std::mem::replace(&mut pass.mode, Mode::Plan(None)) else {
            // refused before any model was asked
            return reply.reply(Ok(from_json(&planned)));
        };
        let snap = pass.snap.clone();
        let user_data = self.user_data.clone();
        let ctx = self.ctx.clone();
        let codec = self.codec.clone();
        (self.run_chat)(
            job,
            Box::new(move |result| {
                let mut pass = Pass {
                    user_data: &user_data,
                    ctx: &*ctx,
                    codec: &*codec,
                    snap,
                    mode: Mode::Finish(Some(result)),
                    timed_out: false,
                };
                let answer = suggest_file_name(&mut pass, input.as_ref());
                reply.reply(Ok(from_json(&answer)));
            }),
        );
    }
}

/// The chat run by the ai-provider runtime: one `chatForProvider` call with the
/// 30 second timer of `askModel`
fn driver_chat(driver: Driver) -> RunChat {
    Rc::new(move |job, then| {
        let rt = driver.rt();
        let providers = driver.providers();
        let signal = rt.controller();
        let timer = {
            let signal = signal.clone();
            rt.set_timeout(NAMING_TIMEOUT_MS, move || {
                signal.abort(Some(JsError::abort()));
            })
        };
        let future = {
            let rt = rt.clone();
            let signal = signal.clone();
            async move {
                let answer = main_core::packages::ai_provider::chat::chat_for_provider(
                    &rt,
                    &providers,
                    &job.provider,
                    &job.config,
                    "",
                    &job.instruction,
                    Some(&signal),
                )
                .await;
                rt.clear_timeout(Some(timer));
                ChatResult {
                    timed_out: signal.aborted(),
                    outcome: match chat_outcome_of(answer) {
                        Ok(outcome) => outcome,
                        // the TypeScript rejects the handler there: it has no outcome
                        Err(error) => ChatOutcome::Threw(JsonValue::String(error.message)),
                    },
                }
            }
        };
        driver.run(future, then);
    })
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn AiNaming> {
    crate::Factory::new(|services: &Services, provided| {
        let hosts = &services.hosts;
        let run_chat: RunChat = match hosts.get::<NamingChatHost>() {
            Some(host) => {
                let host = host.clone();
                Rc::new(move |job, done| host.chat(job, done))
            }
            None => driver_chat(
                provided
                    .all::<Driver>()
                    .first()
                    .expect("the shared driver is provided before the ports are built")
                    .as_ref()
                    .clone(),
            ),
        };
        let port: Rc<dyn AiNaming> = Rc::new(AiNamingPort::new(
            &*services.paths,
            hosts.need::<NamingContextHost>(Batch::A)?,
            hosts.need::<SecretCodecHost>(Batch::A)? as Codec,
            run_chat,
        ));
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jscompat::JsObject;
    use shell_contract::Surface;
    use shell_contract::ids::{ViewId, WindowId};
    use shell_contract::ipc::Sender;
    use shell_contract::runtime::CancelToken;
    use std::cell::{Cell, RefCell};
    use std::sync::Mutex;

    struct Ctx {
        statuses: JsonValue,
    }

    impl NamingContext for Ctx {
        fn subscription_statuses(&self) -> JsonValue {
            self.statuses.clone()
        }
        fn ui_lang(&self) -> String {
            "Korean".into()
        }
    }

    /// keys in the test settings are plain
    struct PlainCodec;
    impl AiSecretCodec for PlainCodec {
        fn seal(
            &self,
            _plain: &str,
        ) -> Result<Option<String>, main_core::packages::ai_provider::settings_secrets::CodecThrow>
        {
            Ok(None)
        }
        fn open(
            &self,
            _sealed: &str,
        ) -> Result<Option<String>, main_core::packages::ai_provider::settings_secrets::CodecThrow>
        {
            Ok(None)
        }
    }

    fn obj(pairs: Vec<(&str, JsonValue)>) -> JsonValue {
        let mut o = JsObject::new();
        for (k, v) in pairs {
            o.set(k, v);
        }
        JsonValue::Object(o)
    }

    fn string(s: &str) -> JsonValue {
        JsonValue::String(s.into())
    }

    struct TestPaths(PathBuf);
    impl AppPaths for TestPaths {
        fn path(&self, _name: PathName) -> PathBuf {
            self.0.clone()
        }
    }

    fn cx() -> CallContext {
        CallContext {
            sender: Sender {
                view: ViewId(1),
                window: WindowId(1),
                surface: Surface::Shell,
            },
            request: None,
            cancel: CancelToken::default(),
        }
    }

    fn user_data(name: &str, settings: Option<&str>) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("seuoffice-naming-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(settings) = settings {
            std::fs::write(dir.join("ai-settings.json"), settings).unwrap();
        }
        dir
    }

    /// settings that select the API-key provider `openai`
    const KEY_SETTINGS: &str =
        r#"{"provider":"openai","providers":{"openai":{"apiKey":"sk-test","model":"gpt-x"}}}"#;

    fn ask(
        dir: PathBuf,
        statuses: JsonValue,
        content: &str,
        chat: impl Fn(ChatJob) -> ChatResult + 'static,
    ) -> (Result<IpcValue, IpcError>, Vec<ChatJob>) {
        let jobs: Rc<RefCell<Vec<ChatJob>>> = Rc::default();
        let run_chat: RunChat = {
            let jobs = jobs.clone();
            Rc::new(move |job, then| {
                jobs.borrow_mut().push(job.clone());
                then(chat(job));
            })
        };
        let port = AiNamingPort::new(
            &TestPaths(dir),
            Arc::new(Ctx { statuses }),
            Arc::new(PlainCodec),
            run_chat,
        );
        let answer: Arc<Mutex<Option<Result<IpcValue, IpcError>>>> = Arc::default();
        let sink = answer.clone();
        port.ai_suggest_file_name(
            &cx(),
            vec![IpcValue::Object(vec![(
                "content".into(),
                IpcValue::String(content.into()),
            )])],
            Responder::new(move |r| *sink.lock().unwrap() = Some(r)),
        );
        let out = answer.lock().unwrap().take().expect("answered");
        let jobs = jobs.borrow().clone();
        (out, jobs)
    }

    fn reply(content: &str) -> ChatResult {
        ChatResult {
            outcome: ChatOutcome::Reply {
                content: Some(content.into()),
            },
            timed_out: false,
        }
    }

    fn object_of(answer: Result<IpcValue, IpcError>) -> Vec<(String, IpcValue)> {
        match answer {
            Ok(IpcValue::Object(entries)) => entries,
            other => panic!("not an object: {other:?}"),
        }
    }

    fn field(entries: &[(String, IpcValue)], key: &str) -> Option<IpcValue> {
        entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    #[test]
    fn blank_content_asks_no_model() {
        let calls = Rc::new(Cell::new(0));
        let seen = calls.clone();
        let (answer, jobs) = ask(
            user_data("blank", Some(KEY_SETTINGS)),
            JsonValue::Null,
            "  \n ",
            move |_| {
                seen.set(seen.get() + 1);
                reply("x")
            },
        );
        let entries = object_of(answer);
        assert_eq!(field(&entries, "ok"), Some(IpcValue::Bool(false)));
        assert_eq!(
            field(&entries, "reason"),
            Some(IpcValue::String("empty-content".into()))
        );
        assert!(jobs.is_empty());
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn no_connected_provider_refuses_without_a_chat() {
        let (answer, jobs) = ask(
            user_data("none", None),
            JsonValue::Null,
            "A quarterly report",
            |_| reply("x"),
        );
        let entries = object_of(answer);
        assert_eq!(field(&entries, "ok"), Some(IpcValue::Bool(false)));
        assert_eq!(
            field(&entries, "reason"),
            Some(IpcValue::String("not-connected".into()))
        );
        assert!(jobs.is_empty());
    }

    #[test]
    fn the_first_line_of_the_reply_is_the_name() {
        let statuses = obj(vec![]);
        let (answer, jobs) = ask(
            user_data("name", Some(KEY_SETTINGS)),
            statuses,
            "Quarterly revenue by region",
            |_| reply("\n\"Q3 Revenue Report.md\"\nA second line"),
        );
        let entries = object_of(answer);
        assert_eq!(field(&entries, "ok"), Some(IpcValue::Bool(true)));
        assert_eq!(
            field(&entries, "name"),
            Some(IpcValue::String("Q3 Revenue Report".into()))
        );
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].provider, "openai");
        assert!(jobs[0].instruction.contains("Write it in Korean."));
        assert!(jobs[0].instruction.ends_with("Quarterly revenue by region"));
    }

    #[test]
    fn a_reply_of_nothing_usable_is_empty_name() {
        let (answer, _) = ask(
            user_data("empty", Some(KEY_SETTINGS)),
            obj(vec![]),
            "text",
            |_| reply("..."),
        );
        let entries = object_of(answer);
        assert_eq!(
            field(&entries, "reason"),
            Some(IpcValue::String("empty-name".into()))
        );
    }

    #[test]
    fn a_failed_chat_is_failed_and_a_timer_makes_it_timeout() {
        let failed = |timed_out| ChatResult {
            outcome: ChatOutcome::Failed {
                error: string("boom"),
            },
            timed_out,
        };
        let (answer, _) = ask(
            user_data("failed", Some(KEY_SETTINGS)),
            obj(vec![]),
            "text",
            move |_| failed(false),
        );
        assert_eq!(
            field(&object_of(answer), "reason"),
            Some(IpcValue::String("failed".into()))
        );
        let (answer, _) = ask(
            user_data("timeout", Some(KEY_SETTINGS)),
            obj(vec![]),
            "text",
            move |_| failed(true),
        );
        assert_eq!(
            field(&object_of(answer), "reason"),
            Some(IpcValue::String("timeout".into()))
        );
    }

    #[test]
    fn a_provider_that_rejects_is_failed() {
        let (answer, _) = ask(
            user_data("threw", Some(KEY_SETTINGS)),
            obj(vec![]),
            "text",
            |_| ChatResult {
                outcome: ChatOutcome::Threw(string("network down")),
                timed_out: false,
            },
        );
        assert_eq!(
            field(&object_of(answer), "reason"),
            Some(IpcValue::String("failed".into()))
        );
    }

    #[test]
    fn chat_outcome_keeps_strings_and_rejects_other_content() {
        use main_core::packages::ai_provider::types::AiChatResponse;
        assert_eq!(
            chat_outcome_of(Ok(AiChatResponse::succeeded(string("a")))),
            Ok(ChatOutcome::Reply {
                content: Some("a".into())
            })
        );
        assert!(chat_outcome_of(Ok(AiChatResponse::succeeded(JsonValue::Number(1.0)))).is_err());
        assert_eq!(
            chat_outcome_of(Ok(AiChatResponse::failed("nope"))),
            Ok(ChatOutcome::Failed {
                error: string("nope")
            })
        );
    }
}
