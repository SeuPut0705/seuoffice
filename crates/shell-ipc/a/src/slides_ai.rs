//! `apps/slides/src/main/ai-ipc.ts` (the slides-only handlers of
//! `registerSlidesOnlyAiIpc` and `ai:log-run-failure`),
//! `apps/slides/src/main/ai-proposal.ts` (`registerAiProposalIpc`) and the
//! `slides:ai-snapshot-restore` handler of `slides-main.ts`: the slides AI's
//! images, media, style templates, sidecars, capabilities and the held
//! proposal of an AI run.
//!
//! Two ports, [`SlidesAiPort`] ([`SlidesAi`], 12 channels) and
//! [`SlidesAiProposalPort`] ([`SlidesAiProposal`], 4), over the one
//! `main_core::slides::{ai_ipc, ai_proposal, ai_default_fonts}`.
//!
//! The deck session is D1's: its handlers reach it through
//! [`SlidesAiSessions`], which D1 provides (see [`sessions`]). What waits on
//! the network is not on the core thread: the image and media tools and the
//! picture download run on a worker ([`SlidesAiHost`]) and answer from the core
//! thread; a call that another handler can cancel (`ai:generate-image`,
//! `ai:analyze-media`) keeps its `MediaCalls` entry and a [`CancelToken`] for
//! the tool's signal until it ends. The wait of `slides:ai-run-begin` for the
//! writes in flight is polled on the core thread between short worker sleeps.

pub mod host;
pub mod sessions;
#[cfg(any(test, feature = "probe"))]
pub(crate) mod world;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jscompat::JsonValue;
use main_core::packages::ai_provider::ai_settings_guard::GuardHost;
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::ai_search::media_call_abort::{MediaCallId, MediaCalls};
use main_core::packages::electron_utils::abort_on_destroyed::DestroyableSender;
use main_core::slides::ai_ipc::{
    AiIpcHost, AiSender, IpcError as CoreError, MediaRequest, MediaStart, PictureSource,
    ai_analyze_media_begin, ai_analyze_media_finish, ai_generate_image_begin,
    ai_generate_image_finish, ai_list_style_templates, ai_load_style_template, ai_log_run_failure,
    ai_save_sidecar, ai_save_style_template, slides_ai_default_fonts, slides_ai_tool_capabilities,
};
use main_core::slides::ai_proposal::{RunBeginTicket, RunBeginWake, SettleStep, settle_deadline};
use shell_contract::hosts::OsShellHost;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::provided::Provided;
use shell_contract::runtime::{CancelToken, PathName, Services};
use shell_contract::{Batch, IpcError, IpcValue, ViewId};

use crate::ports::{SlidesAi, SlidesAiProposal};
use crate::shell_ai_prefs::ShellUiHost;
use crate::value::{arg, from_json};

pub use host::{SlidesAiHost, SlidesAiHostHandle};
pub use sessions::{MediaCallAbort, Overrides, SessionsBuilder, SlidesAiSessions};

/// How long a wait for the writes in flight sleeps before it looks again
const SETTLE_POLL_MS: u64 = 20;

/// `Date.now()`
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// The error a handler throws. `main-core` keeps no error name; the three
/// messages V8 words for a `TypeError` of a property read, a destructuring or
/// a call are named so, as the renderer's rejection text carries the name.
fn ipc_error(error: CoreError) -> IpcError {
    let type_error = error.message.starts_with("Cannot read properties of")
        || error.message.starts_with("Cannot destructure property")
        || error.message.ends_with(" is not a function");
    IpcError {
        name: Some(if type_error { "TypeError" } else { "Error" }.into()),
        message: error.message,
    }
}

// ---- the core-thread state ----

/// What a handler and the continuation of an awaited call both need. It lives
/// on the core thread (it holds `Rc`s): a continuation posted from a worker
/// finds it again by its index ([`with_core`]).
struct Core {
    services: Services,
    host: SlidesAiHostHandle,
    shell_ui: ShellUiHost,
    os: OsShellHost,
    provided: Rc<Provided>,
    /// the sessions a probe passes in place of D1's
    fixed: Option<Rc<dyn SlidesAiSessions>>,
    /// `Date.now()`
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    media: RefCell<MediaState>,
}

/// `inFlightMediaCalls`, and the signal of each call
#[derive(Default)]
struct MediaState {
    calls: MediaCalls,
    signals: Vec<(MediaCallId, CancelToken)>,
}

thread_local! {
    static CORES: RefCell<Vec<Rc<Core>>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` with the core registered at `index`, on the core thread
fn with_core<R>(index: usize, f: impl FnOnce(&Rc<Core>) -> R) -> Option<R> {
    let core = CORES.with(|cores| cores.borrow().get(index).cloned())?;
    Some(f(&core))
}

impl Core {
    fn build(
        services: &Services,
        provided: &Rc<Provided>,
        overrides: &Overrides,
    ) -> Result<(Rc<Core>, usize), shell_contract::ipc::RegisterError> {
        let hosts = &services.hosts;
        let core = Rc::new(Core {
            services: services.clone(),
            host: hosts.need::<SlidesAiHostHandle>(Batch::A)?,
            shell_ui: hosts.need::<ShellUiHost>(Batch::A)?,
            os: hosts.need::<OsShellHost>(Batch::A)?,
            provided: provided.clone(),
            fixed: overrides.sessions.as_ref().map(|build| build()),
            now: overrides.now_ms.clone().unwrap_or_else(|| Arc::new(now_ms)),
            media: RefCell::default(),
        });
        let index = CORES.with(|cores| {
            let mut cores = cores.borrow_mut();
            cores.push(core.clone());
            cores.len() - 1
        });
        // `sender.once('destroyed', ...)` of every media call: one listener for all
        services.views.on_destroyed(Box::new(move |view| {
            with_core(index, |core| core.abort_calls_of(view.0 as f64));
        }));
        Ok((core, index))
    }

    /// The sessions D1 provides, a probe's in their place
    fn sessions(&self) -> Option<Rc<dyn SlidesAiSessions>> {
        self.fixed
            .clone()
            .or_else(|| self.provided.all::<dyn SlidesAiSessions>().first().cloned())
    }

    /// `sessions.get(view)?.path`
    fn session_path(&self, view: ViewId) -> Option<String> {
        self.sessions()?.document(view).map(|doc| doc.path)
    }

    /// `abortMediaCalls(senderId)`: the calls' signals fire
    fn abort_calls_of(&self, sender_id: f64) {
        let mut media = self.media.borrow_mut();
        for call in media.calls.abort_media_calls(sender_id) {
            for (_, signal) in media.signals.iter().filter(|(id, _)| *id == call) {
                signal.cancel();
            }
        }
    }

    /// The signal of a call just begun (aborted at once for a destroyed sender)
    fn signal_of(&self, call: MediaCallId) -> CancelToken {
        let mut media = self.media.borrow_mut();
        let signal = CancelToken::default();
        if media.calls.aborted(call) {
            signal.cancel();
        }
        media.signals.push((call, signal.clone()));
        signal
    }

    /// The `finally` of `withMediaCallSignal` and the handler's answer
    fn finish_media(
        &self,
        analyze: bool,
        view: ViewId,
        start: MediaStart,
        outcome: Option<Result<JsonValue, JsonValue>>,
    ) -> Result<JsonValue, CoreError> {
        let call = start.call();
        let mut sender = ViewSender {
            view,
            services: &self.services,
        };
        let answer = {
            let mut media = self.media.borrow_mut();
            if analyze {
                ai_analyze_media_finish(&mut media.calls, &mut sender, start, outcome)
            } else {
                ai_generate_image_finish(&mut media.calls, &mut sender, start, outcome)
            }
        };
        self.media
            .borrow_mut()
            .signals
            .retain(|(id, _)| *id != call);
        answer
    }

    /// `slides:ai-run-begin` after the wait for the writes
    fn run_begin_after_wait(
        &self,
        view: ViewId,
        ticket: RunBeginTicket,
        session_id: Option<u64>,
        settled: bool,
    ) -> bool {
        let Some(sessions) = self.sessions() else {
            return false;
        };
        let wake = RunBeginWake {
            settled,
            // `sender.isDestroyed?.()`
            sender_destroyed: self.services.views.sender_of(view).is_none(),
            // `sessionOf(e) === session`
            same_session: sessions.document(view).map(|doc| doc.id) == session_id,
        };
        sessions.run_begin_finish(view, ticket, wake)
    }

    /// The picture handlers after the download
    fn picture_done(
        &self,
        view: ViewId,
        replace: bool,
        op: &JsonValue,
        ticket: main_core::slides::ai_ipc::PictureTicket,
        downloaded: Option<Vec<u8>>,
    ) -> IpcValue {
        let Some(sessions) = self.sessions() else {
            return IpcValue::Null;
        };
        sessions
            .picture_finish(
                view,
                replace,
                self.host.image_decoder(),
                op,
                ticket,
                downloaded,
            )
            .map_or(IpcValue::Null, |answer| from_json(&answer))
    }
}

/// One turn of `settleWrites`'s loop on the core thread; between turns a
/// worker sleeps, so the core thread serves the writes that settle
fn settle(index: usize, view: ViewId, deadline: f64, then: Box<dyn FnOnce(bool) + Send>) {
    let step = with_core(index, |core| {
        core.sessions()
            .map(|sessions| sessions.settle_step(view, (core.now)(), deadline))
    })
    .flatten();
    match step {
        // a session that is gone has no write in flight; the handler finds that out after
        None | Some(SettleStep::Quiet) => then(true),
        Some(SettleStep::TimedOut) => then(false),
        Some(SettleStep::Wait { left_ms }) => {
            let Some((workers, core_thread)) = with_core(index, |core| {
                (core.services.workers.clone(), core.services.core.clone())
            }) else {
                return;
            };
            let sleep = (left_ms.max(1.0) as u64).min(SETTLE_POLL_MS);
            workers.spawn(Box::new(move || {
                std::thread::sleep(Duration::from_millis(sleep));
                core_thread.post(Box::new(move || settle(index, view, deadline, then)));
            }));
        }
    }
}

// ---- the sender and the host of main-core's ai-ipc ----

/// `event.sender` of a handler: its id, whether it is destroyed. Its
/// `once('destroyed')` listener is the one [`Core::build`] registered for every view.
struct ViewSender<'a> {
    view: ViewId,
    services: &'a Services,
}

impl DestroyableSender for ViewSender<'_> {
    fn is_destroyed(&mut self) -> bool {
        self.services.views.sender_of(self.view).is_none()
    }

    fn once_destroyed(&mut self, _listener: u64) {
        // `Core::build` aborts every call of a view when it is destroyed
    }

    fn remove_destroyed_listener(&mut self, _listener: u64) {}

    fn on_navigation(&mut self, _listener: u64) -> bool {
        false
    }

    fn remove_navigation_listener(&mut self, _listener: u64) {}
}

impl AiSender for ViewSender<'_> {
    fn id(&self) -> f64 {
        self.view.0 as f64
    }

    fn send(&mut self, _channel: &str, _payload: &JsonValue) {
        unreachable!("only ai:stream sends to its sender, and this port does not run it")
    }
}

/// The directory and the files `sanitizeAiSettings` checks a path against
struct FsGuard {
    home: String,
}

impl GuardHost for FsGuard {
    fn home_dir(&self) -> String {
        self.home.clone()
    }

    fn is_file(&self, path: &str) -> bool {
        std::path::Path::new(path).is_file()
    }
}

/// `tm(key)` / `tm(key, { name })` of `apps/slides/src/main/i18n-main.ts`, the
/// three strings of the style template handlers
fn template_text(lang: main_core::packages::i18n::Lang, key: &str, name: Option<&str>) -> String {
    use main_core::packages::i18n::Lang;
    let (en, ko) = match key {
        "errTplNameInvalid" => ("Invalid template name", "템플릿 이름이 잘못되었습니다"),
        "errTplMissing" => (
            "Template \"{name}\" does not exist",
            "템플릿 \"{name}\"이(가) 존재하지 않습니다",
        ),
        "errTplNoSkill" => (
            "Template \"{name}\" has no valid Style Skill",
            "템플릿 \"{name}\"에 유효한 Style Skill이 없습니다",
        ),
        other => return other.to_owned(),
    };
    let text = if lang == Lang::Ko { ko } else { en };
    match name {
        Some(name) => text.replace("{name}", name),
        None => text.to_owned(),
    }
}

/// What the handlers of `main_core::slides::ai_ipc` ask of Electron
struct Ai<'a> {
    core: &'a Core,
    guard: FsGuard,
}

impl<'a> Ai<'a> {
    fn new(core: &'a Core) -> Self {
        Ai {
            core,
            guard: FsGuard {
                home: core
                    .services
                    .paths
                    .path(PathName::Home)
                    .to_string_lossy()
                    .into_owned(),
            },
        }
    }

    fn path(&self, name: PathName) -> String {
        self.core
            .services
            .paths
            .path(name)
            .to_string_lossy()
            .into_owned()
    }
}

/// What only `registerAiIpc`'s own handlers ask; this port does not run them
const NOT_RUN: &str = "only the shared AI handlers ask it, and this port does not run them";

impl AiIpcHost for Ai<'_> {
    fn user_data_path(&self) -> String {
        self.path(PathName::UserData)
    }

    fn temp_path(&self) -> String {
        self.path(PathName::Temp)
    }

    fn app_version(&self) -> String {
        unreachable!("app_version: {NOT_RUN}")
    }

    fn product_name(&self) -> String {
        unreachable!("product_name: {NOT_RUN}")
    }

    fn document_locale(&mut self) -> String {
        self.core.shell_ui.document_locale()
    }

    fn ui_lang(&mut self) -> String {
        self.core.host.ui_lang().as_str().to_owned()
    }

    fn tm(&self, key: &str, name: Option<&str>) -> String {
        template_text(self.core.host.ui_lang(), key, name)
    }

    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        self.core.host.secret_codec()
    }

    fn guard_host(&self) -> &dyn GuardHost {
        &self.guard
    }

    fn warn(&mut self, message: &str) {
        eprintln!("{message}");
    }

    fn web_contents_count(&self) -> usize {
        unreachable!("web_contents_count: {NOT_RUN}")
    }

    fn web_contents_destroyed(&mut self, _index: usize) -> bool {
        unreachable!("web_contents_destroyed: {NOT_RUN}")
    }

    fn web_contents_send(&mut self, _index: usize, _channel: &str, _payload: Option<&JsonValue>) {
        unreachable!("web_contents_send: {NOT_RUN}")
    }

    fn shutdown_codex_on_quit(&mut self) {
        unreachable!("shutdown_codex_on_quit: {NOT_RUN}")
    }

    fn set_rescue_fetch(&mut self) {
        unreachable!("set_rescue_fetch: {NOT_RUN}")
    }

    fn set_ai_user_agent(&mut self, _user_agent: &str) {
        unreachable!("set_ai_user_agent: {NOT_RUN}")
    }

    fn ensure_subscription_ipc(&mut self, _data_dir: &str) {
        unreachable!("ensure_subscription_ipc: {NOT_RUN}")
    }

    fn shared_subscription_statuses(&mut self) -> JsonValue {
        self.core.host.shared_subscription_statuses()
    }

    fn ai_subscription_login_window_text(&mut self, _lang: &str, _provider: &str) -> JsonValue {
        unreachable!("ai_subscription_login_window_text: {NOT_RUN}")
    }

    fn ai_chatgpt_sign_in_pages(&mut self, _lang: &str) -> JsonValue {
        unreachable!("ai_chatgpt_sign_in_pages: {NOT_RUN}")
    }

    fn open_external(&mut self, url: &str) -> bool {
        self.core.os.open_external(url).is_ok()
    }

    fn ai_tool_capabilities(&mut self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        self.core.host.ai_tool_capabilities(settings, context)
    }
}

// ---- ai.ts: the slides AI port ----

pub struct SlidesAiPort {
    core: Rc<Core>,
    index: usize,
}

impl SlidesAiPort {
    /// `generateImageTool` / `analyzeMediaTool` behind `withMediaCallSignal`
    fn media(&self, cx: &CallContext, args: &[IpcValue], reply: Responder, analyze: bool) {
        let core = &self.core;
        let view = cx.sender.view;
        let op = arg(args, 0);
        let session_path = core.session_path(view);
        let mut sender = ViewSender {
            view,
            services: &core.services,
        };
        let (start, request) = {
            let mut host = Ai::new(core);
            let mut media = core.media.borrow_mut();
            if analyze {
                ai_analyze_media_begin(
                    &mut host,
                    &mut media.calls,
                    &mut sender,
                    session_path.as_deref(),
                    op.as_ref(),
                )
            } else {
                ai_generate_image_begin(
                    &mut host,
                    &mut media.calls,
                    &mut sender,
                    session_path.as_deref(),
                    op.as_ref(),
                )
            }
        };
        let signal = core.signal_of(start.call());
        let Some(request) = request else {
            let answer = core.finish_media(analyze, view, start, None);
            return reply.reply(answer.map(|json| from_json(&json)).map_err(ipc_error));
        };
        let host = core.host.clone();
        let core_thread = core.services.core.clone();
        let index = self.index;
        core.services.workers.spawn(Box::new(move || {
            let outcome = match &request {
                MediaRequest::GenerateImage {
                    settings_path,
                    request,
                    options,
                } => host.generate_image(settings_path, request, options, &signal),
                MediaRequest::AnalyzeMedia {
                    settings_path,
                    request,
                    options,
                } => host.analyze_media(settings_path, request, options, &signal),
                MediaRequest::ReadUrl { .. } => {
                    unreachable!("the slides handlers never read a URL")
                }
            };
            core_thread.post(Box::new(move || {
                with_core(index, |core| {
                    let answer = core.finish_media(analyze, view, start, Some(outcome));
                    reply.reply(answer.map(|json| from_json(&json)).map_err(ipc_error));
                });
            }));
        }));
    }

    /// `ai:insert-image-url` and `ai:replace-picture-url`
    fn picture(&self, cx: &CallContext, args: &[IpcValue], reply: Responder, replace: bool) {
        let core = &self.core;
        let view = cx.sender.view;
        let Some(sessions) = core.sessions() else {
            return reply.reply(Ok(IpcValue::Null));
        };
        let op = arg(args, 0);
        let ticket =
            match sessions.picture_begin(view, replace, core.host.image_decoder(), op.as_ref()) {
                Err(error) => return reply.reply(Err(ipc_error(error))),
                Ok(None) => return reply.reply(Ok(IpcValue::Null)),
                Ok(Some(ticket)) => ticket,
            };
        // `ticket` is `Some` only for an op that is there
        let op = op.unwrap_or(JsonValue::Null);
        let url = match ticket.source() {
            // a user attachment: nothing to download
            PictureSource::Bytes { .. } => {
                return reply.reply(Ok(core.picture_done(view, replace, &op, ticket, None)));
            }
            PictureSource::Download { url } => url.clone(),
        };
        let host = core.host.clone();
        let core_thread = core.services.core.clone();
        let index = self.index;
        core.services.workers.spawn(Box::new(move || {
            let downloaded = host.fetch_remote_image(&url);
            core_thread.post(Box::new(move || {
                with_core(index, |core| {
                    reply.reply(Ok(core.picture_done(view, replace, &op, ticket, downloaded)));
                });
            }));
        }));
    }
}

impl SlidesAi for SlidesAiPort {
    fn ai_analyze_media(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.media(cx, &args, reply, true)
    }

    fn ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.media(cx, &args, reply, false)
    }

    fn ai_insert_image_url(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.picture(cx, &args, reply, false)
    }

    fn ai_replace_picture_url(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.picture(cx, &args, reply, true)
    }

    fn ai_list_style_templates(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let host = Ai::new(&self.core);
        reply.reply(Ok(from_json(&ai_list_style_templates(&host))))
    }

    fn ai_load_style_template(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let host = Ai::new(&self.core);
        let name = arg(&args, 0);
        reply.reply(Ok(from_json(&ai_load_style_template(&host, name.as_ref()))))
    }

    fn ai_save_style_template(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let host = Ai::new(&self.core);
        let (name, data) = (arg(&args, 0), arg(&args, 1));
        reply.reply(Ok(from_json(&ai_save_style_template(
            &host,
            name.as_ref(),
            data.as_ref(),
        ))))
    }

    fn ai_log_run_failure(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let host = Ai::new(&self.core);
        ai_log_run_failure(&host, arg(&args, 0).as_ref(), (self.core.now)());
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn ai_save_sidecar(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let path = self.core.session_path(cx.sender.view);
        reply.reply(Ok(from_json(&ai_save_sidecar(
            path.as_deref(),
            arg(&args, 0).as_ref(),
        ))))
    }

    fn slides_ai_default_fonts(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let mut host = Ai::new(&self.core);
        reply.reply(Ok(from_json(&slides_ai_default_fonts(&mut host))))
    }

    fn slides_ai_snapshot_restore(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = match args.first() {
            Some(IpcValue::Number(id)) => *id,
            _ => f64::NAN,
        };
        let restored = self
            .core
            .sessions()
            .and_then(|sessions| sessions.snapshot_restore(cx.sender.view, id));
        reply.reply(Ok(restored.unwrap_or(IpcValue::Null)))
    }

    fn slides_ai_tool_capabilities(
        &self,
        _cx: &CallContext,
        _args: Vec<IpcValue>,
        reply: Responder,
    ) {
        let mut host = Ai::new(&self.core);
        reply.reply(Ok(from_json(&slides_ai_tool_capabilities(&mut host))))
    }
}

impl MediaCallAbort for SlidesAiPort {
    fn abort_media_calls(&self, sender_id: f64) {
        self.core.abort_calls_of(sender_id)
    }
}

/// The port the shell inserts: it also provides [`MediaCallAbort`] for the
/// shared AI port's `ai:stream-cancel`
pub fn factory() -> crate::Factory<dyn SlidesAi> {
    factory_with(Overrides::default())
}

/// [`factory`] with the probe's overrides
pub fn factory_with(overrides: Overrides) -> crate::Factory<dyn SlidesAi> {
    crate::Factory::new(move |services, provided| {
        let (core, index) = Core::build(services, provided, &overrides)?;
        let port = Rc::new(SlidesAiPort { core, index });
        provided.add::<dyn MediaCallAbort>(port.clone());
        let port: Rc<dyn SlidesAi> = port;
        Ok(port)
    })
}

// ---- ai-proposal.ts: the held proposal ----

pub struct SlidesAiProposalPort {
    core: Rc<Core>,
    index: usize,
}

impl SlidesAiProposal for SlidesAiProposalPort {
    fn slides_ai_proposal_accept(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let accepted = self
            .core
            .sessions()
            .and_then(|sessions| sessions.proposal_accept(cx.sender.view));
        reply.reply(Ok(match accepted {
            Some((slides, snapshot_id)) => IpcValue::Object(vec![
                ("slides".into(), slides),
                ("snapshotId".into(), IpcValue::Number(snapshot_id as f64)),
            ]),
            None => IpcValue::Null,
        }))
    }

    fn slides_ai_proposal_reject(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let rejected = self
            .core
            .sessions()
            .is_some_and(|sessions| sessions.proposal_reject(cx.sender.view));
        reply.reply(Ok(IpcValue::Bool(rejected)))
    }

    /// The window may go away during the wait for the writes; a run begun for it
    /// then would lock the deck for every other window with nobody left to settle it
    fn slides_ai_run_begin(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let view = cx.sender.view;
        let Some(sessions) = self.core.sessions() else {
            return reply.reply(Ok(IpcValue::Bool(false)));
        };
        let Some(ticket) = sessions.run_begin_start(view) else {
            return reply.reply(Ok(IpcValue::Bool(false)));
        };
        let session_id = sessions.document(view).map(|doc| doc.id);
        let index = self.index;
        settle(
            index,
            view,
            settle_deadline((self.core.now)()),
            Box::new(move |settled| {
                with_core(index, |core| {
                    let begun = core.run_begin_after_wait(view, ticket, session_id, settled);
                    reply.reply(Ok(IpcValue::Bool(begun)));
                });
            }),
        );
    }

    fn slides_ai_run_hold(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let held = self
            .core
            .sessions()
            .and_then(|sessions| sessions.run_hold(cx.sender.view));
        reply.reply(Ok(held.unwrap_or(IpcValue::Null)))
    }
}

/// The port the shell inserts for the held proposal
pub fn proposal_factory() -> crate::Factory<dyn SlidesAiProposal> {
    proposal_factory_with(Overrides::default())
}

/// [`proposal_factory`] with the probe's overrides
pub fn proposal_factory_with(overrides: Overrides) -> crate::Factory<dyn SlidesAiProposal> {
    crate::Factory::new(move |services, provided| {
        let (core, index) = Core::build(services, provided, &overrides)?;
        let port: Rc<dyn SlidesAiProposal> = Rc::new(SlidesAiProposalPort { core, index });
        Ok(port)
    })
}
