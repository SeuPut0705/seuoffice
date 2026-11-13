//! `apps/shell/src/main/agent/agent-window.ts`: the agent window (decision
//! 0032), its sessions, skill cards and the templates they offer, over
//! `main_core::shell::agent::{agent_window, agent_api, agent_sessions,
//! agent_skills, project_skills, agent_session_folders, agent_mcp*}`.
//!
//! The manager and the window's handlers live on the core thread, in the
//! port. `main-core` ported what the TypeScript awaits (the session folder, the
//! app's MCP server, the relays, the skills copy, the program, the program
//! taking a message) as steps the caller carries out ([`machine`]): each runs
//! on a worker (or, for Codex, on the shared runtime driver) and its answer is
//! posted back to the core thread to resume the start. Nothing blocks the core
//! thread, and `stop` and `answer` are handled at once while a start waits.
//!
//! What W provides: [`AgentWindowFrame`] (the window itself: create, reveal,
//! its page). What M provides: the theme `agent-window:get-theme` answers is
//! [`AgentServices::theme`] (there is no shared theme host in the contract
//! yet). What other batches call: [`AgentWindowControl`], added to `Provided`.

mod codex;
mod hosts;
mod machine;

use std::rc::Rc;

use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcValue, ViewId};

pub use hosts::{
    AgentServices, AgentServicesHost, AgentWindowControl, AgentWindowFrame, AgentWindowFrameHost,
    AppMcpStarted, ClaudeSession, Fault, RelayAsker, RelaysStarted, RunnerFault, SessionRef,
    SkillHooks,
};

use machine::{Inner, Op, Wiring, forget, with_core};

use crate::ports::AgentWindow;
use crate::runtime::Driver;

/// The port of `registerIpc` in `agent-window.ts`
pub struct AgentWindowPort {
    inner: Rc<Inner>,
    port: u64,
}

impl AgentWindowPort {
    fn new(wiring: Wiring) -> AgentWindowPort {
        let (inner, port) = Inner::register(wiring);
        AgentWindowPort { inner, port }
    }

    fn call(&self, op: Op, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.inner.invoke(op, cx.sender.view, &args, reply);
    }
}

impl Drop for AgentWindowPort {
    fn drop(&mut self) {
        forget(self.port);
    }
}

impl AgentWindow for AgentWindowPort {
    fn agent_window_answer(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::Answer, cx, args, reply)
    }

    fn agent_window_get_init(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::GetInit, cx, args, reply)
    }

    fn agent_window_get_project_prefs(
        &self,
        cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        self.call(Op::GetProjectPrefs, cx, args, reply)
    }

    fn agent_window_get_project_skills(
        &self,
        cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        self.call(Op::GetProjectSkills, cx, args, reply)
    }

    fn agent_window_get_theme(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::GetTheme, cx, args, reply)
    }

    fn agent_window_open_file(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::OpenFile, cx, args, reply)
    }

    fn agent_window_pick_folder(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::PickFolder, cx, args, reply)
    }

    fn agent_window_send(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::Send, cx, args, reply)
    }

    fn agent_window_set_prefs(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::SetPrefs, cx, args, reply)
    }

    fn agent_window_set_project_prefs(
        &self,
        cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        self.call(Op::SetProjectPrefs, cx, args, reply)
    }

    fn agent_window_set_project_skills(
        &self,
        cx: &CallContext,
        args: Vec<IpcValue>,
        reply: Responder,
    ) {
        self.call(Op::SetProjectSkills, cx, args, reply)
    }

    fn agent_window_start(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::Start, cx, args, reply)
    }

    fn agent_window_stop(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::Stop, cx, args, reply)
    }

    fn agent_window_template_as_is(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::TemplateAsIs, cx, args, reply)
    }

    fn agent_window_template_blank(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::TemplateBlank, cx, args, reply)
    }

    fn agent_window_template_check(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.call(Op::TemplateCheck, cx, args, reply)
    }
}

/// What other batches call on the agent window; the port's state is on the core thread, where
/// these are called
struct Control {
    port: u64,
}

impl AgentWindowControl for Control {
    fn open_from_home(&self, sender: ViewId) {
        with_core(self.port, |inner| inner.open_from_home(sender));
    }

    fn open(&self) {
        with_core(self.port, |inner| inner.open_window());
    }

    fn is_window_contents(&self, view: ViewId) -> bool {
        let mut is = false;
        with_core(self.port, |inner| is = inner.is_window_contents(view));
        is
    }

    fn stop_sessions(&self) {
        with_core(self.port, |inner| inner.stop_all());
    }
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn AgentWindow> {
    crate::Factory::new(|services: &Services, provided| {
        let hosts = &services.hosts;
        let driver = provided
            .all::<Driver>()
            .first()
            .expect("the shared driver is provided before the ports are built")
            .as_ref()
            .clone();
        let port = AgentWindowPort::new(Wiring {
            services: services.clone(),
            svc: hosts.need::<AgentServicesHost>(Batch::A)?,
            frame: hosts.need::<AgentWindowFrameHost>(Batch::A)?,
            main_window: hosts.need(Batch::A)?,
            dialogs: hosts.need(Batch::A)?,
            contents: hosts.need(Batch::A)?,
            driver,
        });
        // `win.on('closed')`: the window's sessions end with it
        let (core, number) = (services.core.clone(), port.port);
        services.views.on_destroyed(Box::new(move |view| {
            core.post(Box::new(move || {
                with_core(number, |inner| inner.view_closed(view));
            }));
        }));
        provided.add::<dyn AgentWindowControl>(Rc::new(Control { port: port.port }));
        let port: Rc<dyn AgentWindow> = Rc::new(port);
        Ok(port)
    })
}

#[cfg(test)]
mod tests;
