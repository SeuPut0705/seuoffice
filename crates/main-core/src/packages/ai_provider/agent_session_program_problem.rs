//! `packages/ai-provider/src/agent-session/program-problem.ts`: what went
//! wrong with an agent session's program when `AiRunError` has no kind for it.

use jscompat::{JsObject, JsonValue};

/// `AgentProgramProblem`
#[derive(Debug, Clone, PartialEq)]
pub enum AgentProgramProblem {
    UnsupportedPath,
    Exited { exit_code: Option<f64> },
    NoAnswer { step: String },
    Refused { step: String, code: Option<f64> },
    NoModel,
}

impl AgentProgramProblem {
    /// the `type` of the problem
    pub fn type_name(&self) -> &'static str {
        match self {
            AgentProgramProblem::UnsupportedPath => "unsupported-path",
            AgentProgramProblem::Exited { .. } => "exited",
            AgentProgramProblem::NoAnswer { .. } => "no-answer",
            AgentProgramProblem::Refused { .. } => "refused",
            AgentProgramProblem::NoModel => "no-model",
        }
    }

    /// the problem as the object the TypeScript holds, keys in the order of its literal;
    /// an `undefined` field leaves no key
    pub fn to_json(&self) -> JsonValue {
        let mut object: JsObject<JsonValue> = JsObject::new();
        object.set("type", JsonValue::String(self.type_name().to_owned()));
        match self {
            AgentProgramProblem::UnsupportedPath | AgentProgramProblem::NoModel => {}
            AgentProgramProblem::Exited { exit_code } => {
                if let Some(code) = exit_code {
                    object.set("exitCode", JsonValue::Number(*code));
                }
            }
            AgentProgramProblem::NoAnswer { step } => {
                object.set("step", JsonValue::String(step.clone()));
            }
            AgentProgramProblem::Refused { step, code } => {
                object.set("step", JsonValue::String(step.clone()));
                if let Some(code) = code {
                    object.set("code", JsonValue::Number(*code));
                }
            }
        }
        JsonValue::Object(object)
    }
}

/// `AgentProgramError`: an `Error` named `AgentProgramError` that carries the problem
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProgramError {
    pub problem: AgentProgramProblem,
    pub message: String,
}

impl AgentProgramError {
    /// `this.name`
    pub const NAME: &'static str = "AgentProgramError";

    pub fn new(problem: AgentProgramProblem, message: impl Into<String>) -> Self {
        AgentProgramError {
            problem,
            message: message.into(),
        }
    }
}
