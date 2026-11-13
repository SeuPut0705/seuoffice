//! `apps/shell/src/main/mcp-client/hub-strings.ts`: text the main process
//! shows people about their MCP servers: the page the browser shows after a
//! server's sign-in, and why a "my PC" server could not start (the reason
//! view of a failed server). What the AI reads is English and lives with the
//! hub.
//!
//! The string table is `(key, en, ko)`; `en` defines the key set. Non-ASCII
//! text is written as escapes.

use jscompat::JsObject;

use crate::packages::i18n::{I18n, Lang, create_i18n};

/// `MCP_HUB_STRINGS` as `(key, en, ko)`.
pub const MCP_HUB_STRINGS: [(&str, &str, &str); 9] = [
    (
        "pageDoneTitle",
        "Signed in",
        "\u{B85C}\u{ADF8}\u{C778}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "pageDoneBody",
        "You can close this tab and go back to SeuOffice.",
        "\u{C774} \u{D0ED}\u{C744} \u{B2EB}\u{ACE0} SeuOffice\u{B85C} \u{B3CC}\u{C544}\u{AC00}\u{C138}\u{C694}.",
    ),
    (
        "pageFailedTitle",
        "Sign-in did not finish",
        "\u{B85C}\u{ADF8}\u{C778}\u{C744} \u{B9C8}\u{CE58}\u{C9C0} \u{BABB}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "pageFailedBody",
        "Go back to SeuOffice and try again.",
        "SeuOffice\u{B85C} \u{B3CC}\u{C544}\u{AC00} \u{B2E4}\u{C2DC} \u{C2DC}\u{B3C4}\u{D558}\u{C138}\u{C694}.",
    ),
    (
        "problemNeedsCommandWindow",
        "This command can\u{2019}t run without a command window.",
        "\u{C774} \u{BA85}\u{B839}\u{C740} \u{BA85}\u{B839} \u{CC3D} \u{C5C6}\u{C774} \u{C2E4}\u{D589}\u{D560} \u{C218} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "problemEmptyCommand",
        "Enter the command to run.",
        "\u{C2E4}\u{D589}\u{D560} \u{BA85}\u{B839}\u{C744} \u{B123}\u{C73C}\u{C138}\u{C694}.",
    ),
    (
        "problemNotAProgram",
        "This file can\u{2019}t be run as a program.",
        "\u{C774} \u{D30C}\u{C77C}\u{C740} \u{D504}\u{B85C}\u{ADF8}\u{B7A8}\u{C73C}\u{B85C} \u{C2E4}\u{D589}\u{D560} \u{C218} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "problemRuntimeMissing",
        "The program this server needs isn\u{2019}t on this PC.",
        "\u{C774} \u{C11C}\u{BC84}\u{C5D0} \u{D544}\u{C694}\u{D55C} \u{D504}\u{B85C}\u{ADF8}\u{B7A8}\u{C774} \u{C774} PC\u{C5D0} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "problemDidNotStart",
        "The server didn\u{2019}t start.",
        "\u{C11C}\u{BC84}\u{AC00} \u{C2DC}\u{C791}\u{B418}\u{C9C0} \u{C54A}\u{C558}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
];

/// `createI18n(MCP_HUB_STRINGS)`
fn translator() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in MCP_HUB_STRINGS {
        en.set(key, en_text.to_owned());
        ko.set(key, ko_text.to_owned());
    }
    create_i18n(en, ko)
}

/// `mcpHubText(lang, key)`: the text of `lang`, else English, else the key itself
pub fn mcp_hub_text(lang: Lang, key: &str) -> String {
    translator().t(lang, key, None)
}

/// `SignInPage` of `@seuoffice/google-drive`: what the browser shows once it
/// is back on this PC
#[derive(Debug, Clone, PartialEq)]
pub struct McpSignInPage {
    pub lang: String,
    pub title: String,
    pub body: String,
}

/// `LoopbackPages`
#[derive(Debug, Clone, PartialEq)]
pub struct McpSignInPages {
    pub done: McpSignInPage,
    pub failed: McpSignInPage,
}

/// The pages the browser shows after a server's sign-in, in the person's language
pub fn mcp_sign_in_pages(lang: Lang) -> McpSignInPages {
    let page = |title: &str, body: &str| McpSignInPage {
        lang: lang.as_str().to_owned(),
        title: mcp_hub_text(lang, title),
        body: mcp_hub_text(lang, body),
    };
    McpSignInPages {
        done: page("pageDoneTitle", "pageDoneBody"),
        failed: page("pageFailedTitle", "pageFailedBody"),
    }
}

/// `McpLaunchProblemKey`: why a "my PC" server could not start
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpLaunchProblemKey {
    NeedsCommandWindow,
    EmptyCommand,
    NotAProgram,
    RuntimeMissing,
    DidNotStart,
}

impl McpLaunchProblemKey {
    pub fn as_str(self) -> &'static str {
        match self {
            McpLaunchProblemKey::NeedsCommandWindow => "needs-command-window",
            McpLaunchProblemKey::EmptyCommand => "empty-command",
            McpLaunchProblemKey::NotAProgram => "not-a-program",
            McpLaunchProblemKey::RuntimeMissing => "runtime-missing",
            McpLaunchProblemKey::DidNotStart => "did-not-start",
        }
    }

    /// `PROBLEM_KEYS[problem]`
    fn string_key(self) -> &'static str {
        match self {
            McpLaunchProblemKey::NeedsCommandWindow => "problemNeedsCommandWindow",
            McpLaunchProblemKey::EmptyCommand => "problemEmptyCommand",
            McpLaunchProblemKey::NotAProgram => "problemNotAProgram",
            McpLaunchProblemKey::RuntimeMissing => "problemRuntimeMissing",
            McpLaunchProblemKey::DidNotStart => "problemDidNotStart",
        }
    }
}

/// Why a "my PC" server could not start, as the reason view says it
pub fn mcp_launch_problem_text(lang: Lang, problem: McpLaunchProblemKey) -> String {
    mcp_hub_text(lang, problem.string_key())
}
