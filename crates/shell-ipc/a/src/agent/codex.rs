//! The Codex runner of an agent session, on the core thread.
//!
//! `startCodexAgentSession` is an `async` function over the ai-provider
//! runtime ([`crate::runtime::Driver`]), which the core thread drives, and the
//! port lives on the core thread too, so the runner is started right there:
//! the start's awaited [`AgentStartCall::RunCodex`] is `driver.run(..)`, and
//! what it came to resumes the start through [`super::machine::later`], never
//! while a handler holds the port's state.

use std::rc::Rc;

use jscompat::JsonValue;
use main_core::packages::ai_provider::agent_session_codex::{
    CodexAgentDeps, CodexAgentSession, CodexAgentSessionOptions, start_codex_agent_session,
};
use main_core::packages::ai_provider::agent_session_program_problem::{
    AgentProgramError, AgentProgramProblem,
};
use main_core::packages::ai_provider::agent_session_types::{
    AgentAppMcp, AgentMcpRelay as CodexRelay, AgentPermissionAnswer as CodexAnswer, AgentSession,
    AgentSessionEvent, AgentSessionOptions as CodexSessionOptions, DEFAULT_AGENT_PERMISSION_MODE,
    agent_permission_mode_of,
};
use main_core::packages::ai_provider::task::JsError;
use main_core::shell::agent::agent_sessions::{
    AgentPermissionAnswer, AgentSessionHandle, AgentSessionOptions, CodexRunOptions,
};

use super::hosts::{Fault, RunnerFault};
use super::machine::later;
use crate::runtime::Driver;

/// `JsonValue::get` of a problem's fields
fn problem_field<'a>(problem: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match problem {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// `AgentProgramProblem` from the object an `AgentProgramError` carries
fn problem_of(problem: &JsonValue) -> Option<AgentProgramProblem> {
    let text = |key: &str| match problem_field(problem, key) {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    };
    let number = |key: &str| match problem_field(problem, key) {
        Some(JsonValue::Number(value)) => Some(*value),
        _ => None,
    };
    Some(match text("type")?.as_str() {
        "unsupported-path" => AgentProgramProblem::UnsupportedPath,
        "exited" => AgentProgramProblem::Exited {
            exit_code: number("exitCode"),
        },
        "no-answer" => AgentProgramProblem::NoAnswer {
            step: text("step").unwrap_or_default(),
        },
        "refused" => AgentProgramProblem::Refused {
            step: text("step").unwrap_or_default(),
            code: number("code"),
        },
        "no-model" => AgentProgramProblem::NoModel,
        _ => return None,
    })
}

/// What a start's thrown value is to the manager: a program problem, the
/// `kind` of a run error, or just an `Error` with its name and code
pub(super) fn fault_of(error: &JsError) -> RunnerFault {
    let problem = if error.name == AgentProgramError::NAME {
        error.prop("problem").and_then(problem_of)
    } else {
        None
    };
    let word = |key: &str| match error.prop(key) {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    };
    RunnerFault {
        problem,
        kind: word("kind"),
        fault: Fault {
            name: error.name.clone(),
            code: word("code"),
            message: error.message.clone(),
        },
    }
}

/// `{ ...options, meteredAccepted, webSearch, network }`, which the Codex runner takes as its own type
pub(super) fn codex_options(
    options: &AgentSessionOptions,
    codex: &CodexRunOptions,
) -> CodexAgentSessionOptions {
    CodexAgentSessionOptions {
        session: CodexSessionOptions {
            project_root: options.project_root.clone(),
            mode: agent_permission_mode_of(&options.mode)
                .or_else(|| agent_permission_mode_of(DEFAULT_AGENT_PERMISSION_MODE))
                .expect("the default mode is a mode"),
            model: options.model.clone(),
            effort: options.effort.clone(),
            cli_path: options.cli_path.clone(),
            instructions: options.instructions.clone(),
            open_documents: options.open_documents.clone(),
            protected_paths: options.protected_paths.clone(),
            skill_bundle_dir: options.skill_bundle_dir.clone(),
            app_mcp: options.app_mcp.as_ref().map(|(url, token)| AgentAppMcp {
                url: url.clone(),
                token: token.clone(),
            }),
            user_mcp_relays: options.user_mcp_relays.as_ref().map(|relays| {
                relays
                    .iter()
                    .map(|relay| CodexRelay {
                        name: relay.name.clone(),
                        url: relay.url.clone(),
                        token: relay.token.clone(),
                        tools: relay.tools.clone(),
                    })
                    .collect()
            }),
            session_dir: options.session_dir.clone(),
        },
        metered_accepted: codex.metered_accepted,
        web_search: Some(codex.web_search.clone()),
        network: Some(codex.network),
    }
}

/// `startCodexAgentSession(options, onEvent)`: `on_event` takes an event's JSON; `then` is called
/// on the core thread with what the start came to, outside any handler
pub(super) fn start(
    driver: &Driver,
    port: u64,
    options: CodexAgentSessionOptions,
    owner_id: i64,
    session_id: String,
    then: impl FnOnce(Result<Box<dyn AgentSessionHandle>, JsError>) + 'static,
) {
    let on_event: Rc<dyn Fn(&AgentSessionEvent)> = {
        let session_id = session_id.clone();
        Rc::new(move |event| {
            let (event, session_id) = (event.to_json(), session_id.clone());
            later(port, move |inner| {
                inner.on_event(owner_id, &session_id, &event)
            });
        })
    };
    let rt = driver.rt();
    let providers = driver.providers();
    let future = async move {
        let locate = providers.codex.borrow().locate.clone();
        start_codex_agent_session(&rt, &locate, &options, on_event, &CodexAgentDeps::default())
            .await
    };
    let handle_driver = driver.clone();
    driver.run(future, move |result| {
        then(result.map(|session| {
            Box::new(CodexHandle {
                session: Rc::new(session),
                driver: handle_driver,
                port,
                session_id,
            }) as Box<dyn AgentSessionHandle>
        }));
    });
}

/// A running Codex session as the manager holds it
struct CodexHandle {
    session: Rc<CodexAgentSession>,
    driver: Driver,
    port: u64,
    session_id: String,
}

impl AgentSessionHandle for CodexHandle {
    fn send(&mut self, text: &str) {
        let session = self.session.clone();
        let text = text.to_owned();
        let (port, session_id) = (self.port, self.session_id.clone());
        self.driver.run(
            async move {
                let sent = session.send(&text);
                sent.await.map_err(|error| error.message)
            },
            move |answer| later(port, move |inner| inner.send_finished(&session_id, answer)),
        );
    }

    fn answer(&mut self, id: &str, answer: &AgentPermissionAnswer) {
        self.session.answer(
            id,
            &if answer.allow {
                CodexAnswer::Allow {
                    scope: answer.scope.clone(),
                }
            } else {
                CodexAnswer::Deny {
                    message: answer.message.clone(),
                }
            },
        );
    }

    fn set_open_documents(&mut self, paths: &[String]) {
        self.session.set_open_documents(paths);
    }

    fn stop(&mut self) {
        self.session.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jscompat::JsObject;

    fn problem(pairs: Vec<(&str, JsonValue)>) -> JsonValue {
        let mut object = JsObject::new();
        for (key, value) in pairs {
            object.set(key, value);
        }
        JsonValue::Object(object)
    }

    fn word(value: &str) -> JsonValue {
        JsonValue::String(value.into())
    }

    #[test]
    fn a_program_error_carries_its_problem_to_the_manager() {
        let thrown = JsError::new("AgentProgramError", "exited")
            .named("AgentProgramError")
            .with(
                "problem",
                problem(vec![
                    ("type", word("exited")),
                    ("exitCode", JsonValue::Number(3.0)),
                ]),
            );
        let fault = fault_of(&thrown);
        assert_eq!(
            fault.problem,
            Some(AgentProgramProblem::Exited {
                exit_code: Some(3.0)
            })
        );
        assert_eq!(fault.fault.name, "AgentProgramError");
        let refused = JsError::new("AgentProgramError", "refused")
            .named("AgentProgramError")
            .with(
                "problem",
                problem(vec![("type", word("refused")), ("step", word("login"))]),
            );
        assert_eq!(
            fault_of(&refused).problem,
            Some(AgentProgramProblem::Refused {
                step: "login".into(),
                code: None
            })
        );
    }

    #[test]
    fn any_other_error_keeps_its_kind_name_and_code() {
        let thrown = JsError::new("Error", "no such file")
            .with("kind", word("not-installed"))
            .with("code", word("ENOENT"));
        let fault = fault_of(&thrown);
        assert_eq!(fault.problem, None);
        assert_eq!(fault.kind.as_deref(), Some("not-installed"));
        assert_eq!(fault.fault.code.as_deref(), Some("ENOENT"));
        assert_eq!(fault.fault.name, "Error");
    }

    #[test]
    fn a_problem_of_an_unknown_type_is_none() {
        let thrown = JsError::new("AgentProgramError", "x")
            .named("AgentProgramError")
            .with("problem", problem(vec![("type", word("mystery"))]));
        assert_eq!(fault_of(&thrown).problem, None);
    }
}
