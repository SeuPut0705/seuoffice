//! `apps/shell/src/main/agent/agent-mcp.ts`: the app's own MCP server as an
//! agent session sees it (decision 0032).
//!
//! One server per session: loopback, a port the system picks, and a fresh
//! token the program must send with every request. The tools are the existing
//! open-document tools, narrowed: no tab closing, no editing session of its
//! own, no headless file creation; withheld words read as their `{{label}}`;
//! a deck that withholds anything is not edited; `read_hwp` and `read_pdf`
//! only inside the project folder; `propose_skill` and
//! `propose_skill_install` only show a card or a proposal.
//!
//! The stage 3 shell runs on one core thread, so every `await` of the
//! TypeScript that a renderer or another window answers (an editor command,
//! an open document's read, the skill card) is a [`ToolStep::Await`] of a
//! [`HostCall`] named after the TypeScript interface and method
//! (`"SlidesControl"` `"readDeck"`, ...). A control is therefore only
//! present or not in [`AgentMcpDeps`]. `withholdingSlides` and
//! `withholdingOpenDocuments` wrap a control in the TypeScript; here they
//! rewrite the steps of the tools that were given the control
//! ([`withholding_slides`], [`withholding_open_documents`]): the calls the
//! wrapper changes, answers or refuses are rewritten, every other step passes
//! through.
//!
//! `startAgentMcpServer` awaits `service.start(0)`, a state machine over the
//! caller's listener: [`start_agent_mcp_server`] returns the server, the
//! start's id and the commands the service issued; the caller drives the
//! service through [`AgentMcpServer::service`] as it drives any
//! `McpServerService` (see `shell::mcp::mcp_server`, which also says how a
//! `Command::ToolCall` is answered) and the promise of the TypeScript
//! resolves when `Command::StartSettled` for that id arrives with `Ok`.
//!
//! Engine-waiting: `redactMarkdownSource` and `redactHtmlSource` of the
//! file-parse package have no port yet, so they are the [`SourceRedactor`]
//! trait; the PDF and HWP readers the tools import are passed in as the
//! traits of `pdf_tools` and `hwp_tools`, the CLI as `CliRunner`.

use std::rc::Rc;

use jscompat::{JsonValue, json_stringify, slice_utf16, trim};

use crate::packages::ai_provider::agent_session_claude::AGENT_APP_MCP_TOOLS;
use crate::packages::ai_provider::agent_session_policy::{
    comparable_path, is_inside_path, process_platform,
};
use crate::packages::mcp_sdk::server::{Command, StartId, StopId};
use crate::packages::zod::{ZodShape, z};
use crate::shell::mcp::cli_runner::CliRunner;
use crate::shell::mcp::mcp_server::{
    HostCall, McpHost, McpServerService, McpServerServiceOptions, McpToolDefinition, Settled,
    ToolStep,
};
use crate::shell::mcp::tools::document_tools::{
    DefaultSaveDir, DocToolDeps, create_document_tools,
};
use crate::shell::mcp::tools::hwp_tools::{HwpTextReader, create_hwp_tools};
use crate::shell::mcp::tools::open_documents_tools::{
    OpenDocumentsDeps, create_open_document_tools,
};
use crate::shell::mcp::tools::pdf_tools::{PdfTextReader, create_pdf_tools};
use crate::shell::mcp::tools::session_tools::{SharedSessionHost, create_session_host, string_of};
use crate::shell::mcp::tools::sheets_tools::{SheetsToolDeps, create_sheets_tools};
use crate::shell::mcp::tools::slides_tools::{SlidesToolDeps, create_slides_tools};

/// `AGENT_MCP_TOOL_NAMES`: the 13 tools; the programs' start checks hold a
/// session to the same list
pub const AGENT_MCP_TOOL_NAMES: [&str; 13] = AGENT_APP_MCP_TOOLS;

/// `AgentSkillProposalInput`: what `propose_skill` hands to the agent window
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSkillProposalInput {
    pub title: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub wants_template: bool,
    pub target_id: String,
    /// a document the model thinks should be the template: a project file or an open tab's path
    pub suggested_template_path: String,
}

impl AgentSkillProposalInput {
    /// the `input` argument of the `AgentSkillToolHooks.proposeSkill` call
    fn to_json(&self) -> JsonValue {
        let mut out = jscompat::JsObject::new();
        out.set("title", JsonValue::String(self.title.clone()));
        out.set("name", JsonValue::String(self.name.clone()));
        out.set("description", JsonValue::String(self.description.clone()));
        out.set("body", JsonValue::String(self.body.clone()));
        out.set("wantsTemplate", JsonValue::Bool(self.wants_template));
        out.set("targetId", JsonValue::String(self.target_id.clone()));
        out.set(
            "suggestedTemplatePath",
            JsonValue::String(self.suggested_template_path.clone()),
        );
        JsonValue::Object(out)
    }
}

const PROPOSE_SKILL_DESCRIPTION: &str = concat!(
    "Show the person a card in the agent window with a skill to save: a new skill, or a change ",
    "to an existing one (give targetId). This tool never saves anything; the person checks the ",
    "card and presses Save. When you make a skill from the work, keep what would repeat: the ",
    "order of steps, the rules, the tone and wording, the checks before finishing. Leave out ",
    "values used only once (names of people, dates, this particular content): list them in the ",
    "body as values given each time instead. Write the body as instructions to an assistant, in ",
    "the language of the conversation. Set wantsTemplate when a finished document should be kept ",
    "as a template to fill in next time, and name it in suggestedTemplatePath (a file of the ",
    "project folder or a document open in the app); the person picks the template on the card."
);

const PROPOSE_INSTALL_DESCRIPTION: &str = concat!(
    "Propose installing a skill from GitHub. The app shows the person the address; they open a ",
    "preview of what the skill holds and decide whether to install it. This tool installs ",
    "nothing and only reports that the proposal was shown. Never install skills any other way ",
    "(no `npx skills add`). A skill installed this way is available from the next session."
);

const CARD_SHOWN: &str = concat!(
    "The skill card is shown to the person in the agent window. Nothing is saved until they ",
    "press Save on it, so it is not saved yet. Tell them briefly what the card holds and that ",
    "they can change it before saving."
);

const PREVIEW_SHOWN: &str = concat!(
    "The install proposal is shown to the person in the agent window. Nothing is installed ",
    "unless they open the preview and press Install there. A skill installed this way is ",
    "available from the next session, not in this one."
);

/// `text(value, max)`: a string cut to `max` UTF-16 code units, else `''`
fn text(value: Option<&JsonValue>, max: f64) -> String {
    match value {
        Some(JsonValue::String(text)) => slice_utf16(text, 0.0, Some(max)),
        _ => String::new(),
    }
}

/// `text(args.key, max).trim()`
fn trimmed(args: &JsonValue, key: &str, max: f64) -> String {
    trim(&text(args.get(key).as_deref(), max)).to_owned()
}

fn skill_shape() -> ZodShape {
    z::shape(vec![
        (
            "title",
            z::string().describe(
                "short title in the language the person writes in, shown in the skill list",
            ),
        ),
        (
            "name",
            z::string().optional().describe(
                "English name: lowercase letters, digits and hyphens, 1-64 characters, e.g. meeting-minutes",
            ),
        ),
        (
            "description",
            z::string().describe("one or two sentences: what the skill does and when to use it"),
        ),
        ("body", z::string().describe("the instructions (Markdown)")),
        (
            "wantsTemplate",
            z::boolean()
                .optional()
                .describe("keep a finished document as the skill template"),
        ),
        (
            "targetId",
            z::string().optional().describe(
                "the existing skill to change: its name as listed in this session (e.g. meeting-minutes or meeting-minutes--builtin) or its id (e.g. app:meeting-minutes); leave out for a new skill",
            ),
        ),
        (
            "suggestedTemplatePath",
            z::string()
                .optional()
                .describe("the document to keep as the template: a project file or an open document"),
        ),
    ])
}

/// `createAgentSkillTools(hooks, openTabs)`: the two skill tools; they show
/// and return, and never write a file. `has_hooks` is whether the agent
/// window gave hooks; without them (`NO_WINDOW`) the tools refuse. The hooks
/// are the host's: `proposeSkill` is a `HostCall` of `"AgentSkillToolHooks"`
/// with the input as its one argument, and the host reads the open tabs for
/// the card (`context.openTabs()`) itself.
pub fn create_agent_skill_tools<'h>(has_hooks: bool) -> Vec<McpToolDefinition<'h>> {
    vec![
        McpToolDefinition {
            name: "propose_skill".to_owned(),
            description: PROPOSE_SKILL_DESCRIPTION.to_owned(),
            input_schema: Some(skill_shape()),
            handler: Box::new(move |args| {
                let input = AgentSkillProposalInput {
                    title: trimmed(&args, "title", 500.0),
                    name: trimmed(&args, "name", 200.0),
                    description: trimmed(&args, "description", 5_000.0),
                    body: text(args.get("body").as_deref(), 200_000.0),
                    wants_template: matches!(
                        args.get("wantsTemplate").as_deref(),
                        Some(JsonValue::Bool(true))
                    ),
                    target_id: trimmed(&args, "targetId", 512.0),
                    suggested_template_path: trimmed(&args, "suggestedTemplatePath", 4_096.0),
                };
                if input.title.is_empty() {
                    return ToolStep::Done(Err("title must not be empty".to_owned()));
                }
                if trim(&input.body).is_empty() {
                    return ToolStep::Done(Err("body must not be empty".to_owned()));
                }
                if !has_hooks {
                    return ToolStep::Done(Err(
                        "Skill cards are not available in this session.".to_owned(),
                    ));
                }
                let shown = input.title.clone();
                ToolStep::Await {
                    call: HostCall {
                        control: "AgentSkillToolHooks",
                        method: "proposeSkill",
                        args: vec![input.to_json()],
                    },
                    then: Box::new(move |settled: Settled| match settled {
                        Err(message) => ToolStep::Done(Err(message)),
                        Ok(_) => ToolStep::Done(Ok(Some(JsonValue::String(format!(
                            "Skill card shown: {}\n{CARD_SHOWN}",
                            json_stringify(&JsonValue::String(shown))
                        ))))),
                    }),
                }
            }),
        },
        McpToolDefinition {
            name: "propose_skill_install".to_owned(),
            description: PROPOSE_INSTALL_DESCRIPTION.to_owned(),
            input_schema: Some(z::shape(vec![(
                "address",
                z::string().describe(
                    "a GitHub address of the skill (https://github.com/owner/repo/tree/branch/path) or owner/repo@skill",
                ),
            )])),
            handler: Box::new(move |args| {
                let address = trimmed(&args, "address", 2_048.0);
                if address.is_empty() {
                    return ToolStep::Done(Err("address must not be empty".to_owned()));
                }
                if !has_hooks {
                    return ToolStep::Done(Err(
                        "Skill install proposals are not available in this session.".to_owned(),
                    ));
                }
                ToolStep::Await {
                    call: HostCall {
                        control: "AgentSkillToolHooks",
                        method: "proposeInstall",
                        args: vec![JsonValue::String(address)],
                    },
                    then: Box::new(|settled: Settled| match settled {
                        Err(message) => ToolStep::Done(Err(message)),
                        Ok(_) => {
                            ToolStep::Done(Ok(Some(JsonValue::String(PREVIEW_SHOWN.to_owned()))))
                        }
                    }),
                }
            }),
        },
    ]
}

/// `redactMarkdownSource` and `redactHtmlSource` of `@seuoffice/file-parse`
/// (engine-waiting): the source with its withheld words as their labels
pub trait SourceRedactor {
    fn redact_markdown_source(&self, source: &str) -> String;
    fn redact_html_source(&self, source: &str) -> String;
}

/// `AgentMcpDeps`, plus what the TypeScript's module imports reach (the CLI,
/// the HWP and PDF readers, the redactor). A control is present or not: the
/// host answers its `HostCall`s.
pub struct AgentMcpDeps<'h> {
    pub version: String,
    pub default_save_dir: DefaultSaveDir<'h>,
    pub docs_control: bool,
    pub slides_control: bool,
    /// the slides control has a `deckWithholds` (`withholdingSlides` takes a
    /// deck to withhold something when it has none)
    pub slides_deck_withholds: bool,
    pub sheets_control: bool,
    pub open_documents_control: bool,
    pub resolve_target: bool,
    /// the agent window's skill card and install proposal; absent, the two tools refuse
    pub skill_tools: bool,
    pub cli: Option<Rc<dyn CliRunner + 'h>>,
    pub hwp_reader: Rc<dyn HwpTextReader + 'h>,
    pub pdf_reader: Rc<dyn PdfTextReader + 'h>,
    pub redactor: Rc<dyn SourceRedactor + 'h>,
}

const WITHHELD_DECK: &str = "This presentation withholds some of its content from AI. It cannot be edited from an agent session; ask the person to edit it in the app instead.";

/// `withholdingSlides(control)`, applied to a step of a tool that was given
/// the control: slides that read withheld words as labels and are not edited
/// while they withhold anything. `deck_withholds` is whether the control has
/// a `deckWithholds`.
pub fn withholding_slides<'h>(step: ToolStep<'h>, deck_withholds: bool) -> ToolStep<'h> {
    let (call, then) = match step {
        ToolStep::Await { call, then } => (call, then),
        done => return done,
    };
    let rewrap = move |settled: Settled| withholding_slides(then(settled), deck_withholds);
    if call.control != "SlidesControl" {
        return ToolStep::Await {
            call,
            then: Box::new(rewrap),
        };
    }
    let wc = call.args.first().cloned().unwrap_or(JsonValue::Null);
    match call.method {
        "readDeck" => {
            let mut options = jscompat::JsObject::new();
            options.set("withhold", JsonValue::Bool(true));
            ToolStep::Await {
                call: HostCall {
                    control: "SlidesControl",
                    method: "readDeck",
                    args: vec![wc, JsonValue::Object(options)],
                },
                then: Box::new(rewrap),
            }
        }
        "runTxn" => {
            // without a way to tell, the deck is taken to withhold something
            if !deck_withholds {
                return rewrap(Err(WITHHELD_DECK.to_owned()));
            }
            ToolStep::Await {
                call: HostCall {
                    control: "SlidesControl",
                    method: "deckWithholds",
                    args: vec![wc],
                },
                then: Box::new(move |settled: Settled| match settled {
                    Err(message) => rewrap(Err(message)),
                    Ok(withholds) if withholds.as_ref().is_some_and(|value| value.truthy()) => {
                        rewrap(Err(WITHHELD_DECK.to_owned()))
                    }
                    Ok(_) => ToolStep::Await {
                        call,
                        then: Box::new(rewrap),
                    },
                }),
            }
        }
        _ => ToolStep::Await {
            call,
            then: Box::new(rewrap),
        },
    }
}

/// `withholdingOpenDocuments(control)`, applied to a step of a tool that was
/// given the control: open documents read with their withheld words as
/// labels, and never closed
pub fn withholding_open_documents<'h>(
    step: ToolStep<'h>,
    redactor: Rc<dyn SourceRedactor + 'h>,
) -> ToolStep<'h> {
    let (call, then) = match step {
        ToolStep::Await { call, then } => (call, then),
        done => return done,
    };
    let again = Rc::clone(&redactor);
    let rewrap = move |settled: Settled| withholding_open_documents(then(settled), again);
    if call.control != "OpenDocumentsControl" {
        return ToolStep::Await {
            call,
            then: Box::new(rewrap),
        };
    }
    match call.method {
        "read" => {
            let kind = match call.args.first().and_then(|tab| tab.get("kind")).as_deref() {
                Some(JsonValue::String(kind)) => kind.clone(),
                _ => String::new(),
            };
            if kind == "slides" {
                return rewrap(Err(
                    "Read a presentation with read_deck, passing its id or path as `document`."
                        .to_owned(),
                ));
            }
            ToolStep::Await {
                call,
                then: Box::new(move |settled: Settled| {
                    let content = match settled {
                        Ok(content) => content,
                        Err(message) => return rewrap(Err(message)),
                    };
                    if kind == "markdown" {
                        return rewrap(string_of(content.as_ref()).map(|source| {
                            Some(JsonValue::String(redactor.redact_markdown_source(&source)))
                        }));
                    }
                    if kind == "html" {
                        return rewrap(string_of(content.as_ref()).map(|source| {
                            Some(JsonValue::String(redactor.redact_html_source(&source)))
                        }));
                    }
                    rewrap(Ok(content))
                }),
            }
        }
        "close" => rewrap(Err(
            "Closing documents is not available in an agent session.".to_owned(),
        )),
        "save" => rewrap(Err(
            "Saving open documents is not available in an agent session.".to_owned(),
        )),
        _ => ToolStep::Await {
            call,
            then: Box::new(rewrap),
        },
    }
}

/// every step of every tool goes through `wrap`
fn wrap_steps<'h>(
    tools: Vec<McpToolDefinition<'h>>,
    wrap: Rc<dyn Fn(ToolStep<'h>) -> ToolStep<'h> + 'h>,
) -> Vec<McpToolDefinition<'h>> {
    tools
        .into_iter()
        .map(|tool| {
            let McpToolDefinition {
                name,
                description,
                input_schema,
                handler,
            } = tool;
            let wrap = Rc::clone(&wrap);
            let mut inner = handler;
            McpToolDefinition {
                name,
                description,
                input_schema,
                handler: Box::new(move |args| wrap(inner(args))),
            }
        })
        .collect()
}

/// `insideProject(tool, projectRoot, platform)`
fn inside_project<'h>(
    tool: McpToolDefinition<'h>,
    project_root: &str,
    platform: Option<&str>,
) -> McpToolDefinition<'h> {
    let McpToolDefinition {
        name,
        description,
        input_schema,
        handler,
    } = tool;
    let mut inner = handler;
    let project_root = project_root.to_owned();
    let platform = platform.map(str::to_owned);
    McpToolDefinition {
        name,
        description,
        input_schema,
        handler: Box::new(move |args| {
            let path = match args.get("path").as_deref() {
                Some(JsonValue::String(path)) => path.clone(),
                _ => String::new(),
            };
            let platform = platform.as_deref();
            let root = comparable_path(&project_root, &project_root, platform);
            if path.is_empty()
                || !is_inside_path(&comparable_path(&path, &root, platform), &root, platform)
            {
                return ToolStep::Done(Err(
                    "Only files inside the project folder can be read here.".to_owned(),
                ));
            }
            inner(args)
        }),
    }
}

/// `buildAgentMcpTools(deps, projectRoot, platform)`: `platform` `None` is
/// `process.platform`
pub fn build_agent_mcp_tools<'h>(
    deps: &AgentMcpDeps<'h>,
    project_root: &str,
    platform: Option<&str>,
) -> Vec<McpToolDefinition<'h>> {
    let host: SharedSessionHost = create_session_host();
    let mut all: Vec<McpToolDefinition<'h>> = Vec::new();
    all.extend(create_document_tools(
        Rc::new(DocToolDeps {
            version: deps.version.clone(),
            default_save_dir: Rc::clone(&deps.default_save_dir),
            background: Some(false),
            open_in_tab: None,
            docs: deps.docs_control,
            extra_formats: None,
            cli: deps.cli.clone(),
            resolve_target: deps.resolve_target,
        }),
        Rc::clone(&host),
    ));
    let slides = create_slides_tools(
        Rc::new(SlidesToolDeps {
            default_save_dir: Rc::clone(&deps.default_save_dir),
            background: Some(false),
            slides: deps.slides_control,
            cli: deps.cli.clone(),
            resolve_target: deps.resolve_target,
        }),
        Rc::clone(&host),
    );
    if deps.slides_control {
        let deck_withholds = deps.slides_deck_withholds;
        all.extend(wrap_steps(
            slides,
            Rc::new(move |step| withholding_slides(step, deck_withholds)),
        ));
    } else {
        all.extend(slides);
    }
    all.extend(create_sheets_tools(
        Rc::new(SheetsToolDeps {
            default_save_dir: Rc::clone(&deps.default_save_dir),
            background: Some(false),
            sheets: deps.sheets_control,
            cli: deps.cli.clone(),
            resolve_target: deps.resolve_target,
        }),
        host,
    ));
    all.extend(create_hwp_tools(Rc::clone(&deps.hwp_reader)));
    all.extend(create_pdf_tools(Rc::clone(&deps.pdf_reader)));
    let open = create_open_document_tools(OpenDocumentsDeps {
        control: deps.open_documents_control,
        default_save_dir: Rc::clone(&deps.default_save_dir),
    });
    if deps.open_documents_control {
        let redactor = Rc::clone(&deps.redactor);
        all.extend(wrap_steps(
            open,
            Rc::new(move |step| withholding_open_documents(step, Rc::clone(&redactor))),
        ));
    } else {
        all.extend(open);
    }
    all.extend(create_agent_skill_tools(deps.skill_tools));
    all.into_iter()
        .filter(|tool| AGENT_MCP_TOOL_NAMES.contains(&tool.name.as_str()))
        .map(|tool| {
            if tool.name == "read_hwp" || tool.name == "read_pdf" {
                inside_project(tool, project_root, platform)
            } else {
                tool
            }
        })
        .collect()
}

/// `node:crypto` as the agent MCP modules use it
pub trait AgentMcpHost {
    /// `randomBytes(n)`
    fn random_bytes(&self, n: usize) -> Vec<u8>;
    /// `randomUUID()`
    fn random_uuid(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
}

/// the host of a `McpServerService` over an [`AgentMcpHost`]
pub(super) struct ServiceHost(pub Rc<dyn AgentMcpHost>);

impl McpHost for ServiceHost {
    fn random_uuid(&self) -> String {
        self.0.random_uuid()
    }

    fn now_ms(&self) -> f64 {
        self.0.now_ms()
    }
}

/// `randomBytes(24).toString('hex')`
pub(super) fn session_token(host: &dyn AgentMcpHost) -> String {
    host.random_bytes(24)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `AgentMcpServer`: one session's server. The caller drives
/// [`service`](Self::service) and stops it when the session ends.
pub struct AgentMcpServer<'h> {
    service: McpServerService<'h>,
    token: String,
}

impl<'h> AgentMcpServer<'h> {
    /// the session's token, sent as `Authorization: Bearer <token>`
    pub fn token(&self) -> &str {
        &self.token
    }

    /// `${service.getUrl()}/mcp`: valid once the start settled
    pub fn url(&self) -> String {
        format!("{}/mcp", self.service.get_url())
    }

    /// the service the caller drives (requests, listener, timers)
    pub fn service(&mut self) -> &mut McpServerService<'h> {
        &mut self.service
    }

    /// `stop()`
    pub fn stop(&mut self) -> (StopId, Vec<Command>) {
        self.service.stop()
    }
}

/// `startAgentMcpServer(deps, projectRoot)`: makes the session's service and
/// starts it on port 0. The returned commands are the start's; the TypeScript
/// promise resolves with `Command::StartSettled` of the returned id.
pub fn start_agent_mcp_server<'h>(
    deps: Rc<AgentMcpDeps<'h>>,
    project_root: &str,
    host: Rc<dyn AgentMcpHost>,
) -> (AgentMcpServer<'h>, StartId, Vec<Command>) {
    let token = session_token(&*host);
    let project_root = project_root.to_owned();
    let version = deps.version.clone();
    let mut service = McpServerService::new(
        McpServerServiceOptions {
            port: 0.0,
            tools: None,
            tools_factory: Some(Box::new(move || {
                build_agent_mcp_tools(&deps, &project_root, Some(process_platform()))
            })),
            server_factory: None,
            version: Some(version),
            max_listen_attempts: Some(1.0),
            listen_retry_delay_ms: None,
            token: Some(token.clone()),
        },
        Box::new(ServiceHost(host)),
    );
    let (start, commands) = service.start(Some(0.0));
    (AgentMcpServer { service, token }, start, commands)
}
