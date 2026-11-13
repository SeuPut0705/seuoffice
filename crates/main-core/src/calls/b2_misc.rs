//! The functions of group `b2-misc` (tools/main-diff/groups/b2-misc.ts): the
//! i18n package and the small modules of electron-utils.
//!
//! A scenario function (a bridge, a dialog, a sender) takes a list of steps
//! and answers one entry per step; each call of the fake it drives is one
//! `logs` line. A `Uint8Array` is `{"$bytes": byteLength}` in JSON.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::abort_on_destroyed::{self, DestroyableSender};
use crate::packages::electron_utils::author_name::{
    AUTHOR_NAME_KEY, AUTHOR_NAME_MAX, configured_author_name, read_author_name_setting,
    resolve_author_name, sanitize_author_name, system_author_name,
};
use crate::packages::electron_utils::default_save_dir::{
    DEFAULT_SAVE_DIR_KEY, PathProvider, SaveDirState, Thrown, configured_default_save_dir,
    create_dir_levels, default_save_dir_fallback, documents_dir_or_fallback, is_usable_save_dir,
    read_default_save_dir_setting, resolve_default_save_dir,
};
use crate::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, FallbackDir, save_as_suggestion, show_open_dialog_with_memory,
    show_save_dialog_with_memory,
};
use crate::packages::electron_utils::doc_attach_channels::{
    DOC_ATTACH_BRIDGE_KEY, DOC_ATTACH_CHANNELS,
};
use crate::packages::electron_utils::font_store::{FontStoreEnv, install_local_font_files};
use crate::packages::electron_utils::github_menu::{
    GITHUB_ISSUES_URL, GITHUB_LATEST_RELEASE_URL, GITHUB_NEW_ISSUE_URL, GITHUB_RELEASES_URL,
    GITHUB_REPO_DISPLAY, GITHUB_REPO_NAME, GITHUB_REPO_OWNER, GITHUB_REPO_SLUG, GITHUB_REPO_URL,
    github_release_tag_url,
};
use crate::packages::electron_utils::hwp_default_format::{
    HWP_DEFAULT_FORMAT_KEY, normalize_hwp_default_format, read_hwp_default_format,
};
use crate::packages::electron_utils::marked_odt::{
    MarkedOdtText, marked_odt_box, marked_odt_choice,
};
use crate::packages::electron_utils::mcp_tools_channels::{
    MCP_TOOLS_BRIDGE_KEY, MCP_TOOLS_CHANNELS, mcp_call_id_of, mcp_server_name_of,
    mcp_tool_call_request_of,
};
use crate::packages::electron_utils::numbered_export_paths::numbered_export_paths;
use crate::packages::electron_utils::outbound_channels::{
    MAX_CONFIRM_ADDRESS_LENGTH, MAX_CONFIRM_ADDRESSES, OUTBOUND_CHANNELS, confirm_request_of,
};
use crate::packages::electron_utils::project_folder_bridge::{
    ProjectFolderBridge, ProjectFolderBridgeIpc, Subscription,
};
use crate::packages::electron_utils::split_pane_bridge::{
    IpcRejected, SPLIT_PANE_BRIDGE_KEY, SPLIT_PANE_CHANNELS, SplitPaneBridge, SplitPaneIpc,
};
use crate::packages::electron_utils::template_font_response::template_font_response;
use crate::packages::electron_utils::template_fonts_dir::{
    TEMPLATE_FONTS_DIR_NAME, TEMPLATE_FONTS_REPO_DIR, TemplateFontsHost, template_fonts_dir,
};
use crate::packages::electron_utils::user_skills_channels::{
    self as skills, EditorsValue, USER_SKILLS_BRIDGE_KEY, USER_SKILLS_CHANNELS,
};
use crate::packages::i18n::{
    self, DEV_USER_DATA_DIR_NAME, ENV_PREFIX, I18n, LANGS, OLD_APP_MCP_SERVER_NAMES,
    OLD_CLI_BUNDLE_FILES, OLD_CLI_COMMANDS, OLD_ENV_NAMES, OLD_ENV_PREFIX, OLD_HOME_DIR_NAMES,
    OLD_MCP_RESOURCE_SCHEMES, OLD_MCP_SERVER_NAMES, OLD_MCP_TOOL_NAMES, OLD_PROJECT_DATA_DIR_NAMES,
    OLD_SKILL_NAMES, PRODUCT_NAME, PRODUCT_REPO_NAME, PRODUCT_REPO_OWNER, PRODUCT_REPO_SLUG,
    UPSTREAM_PRODUCT_NAME, USER_DATA_DIR_NAME,
};
use crate::packages::project_store::{
    PROJECT_FOLDER_BRIDGE_KEY, PROJECT_FOLDER_CHANNELS, PROJECT_FOLDER_EVENTS,
    PROJECT_FOLDER_LISTEN_CHANNEL, PROJECT_FOLDER_NAMES, ProjectFolderEventMethod,
    ProjectFolderListenMessage,
};
use crate::packages::ui::{
    TEMPLATE_FONT_FILES, TEMPLATE_FONT_HOST, TEMPLATE_FONT_SCHEME, template_font_file_of,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---------- i18n ----------
        "i18n.LANGS" => Ok(Some(Value::Array(
            LANGS.iter().map(|l| Value::from(l.as_str())).collect(),
        ))),
        "i18n.isLang" => Ok(Some(Value::Bool(i18n::is_lang_value(jv(args, 0).as_ref())))),
        "i18n.normalizeLang" => Ok(Some(Value::from(
            i18n::normalize_lang(opt_str(args, 0)).as_str(),
        ))),
        "i18n.requestedLanguage" => Ok(Some(Value::from(i18n::requested_language(
            jv(args, 0).as_ref(),
            opt_str(args, 1),
        )))),
        "i18n.installLang" => Ok(Some(Value::from(
            i18n::install_lang(jv(args, 0).as_ref(), opt_str(args, 1)).as_str(),
        ))),
        "i18n.htmlLang" => str_arg(args, 0).map(|lang| {
            Some(Value::from(i18n::html_lang(i18n::normalize_lang(Some(
                lang,
            )))))
        }),
        "i18n.isRtlLang" => Ok(Some(Value::Bool(i18n::is_rtl_lang(opt_str(args, 0))))),
        "i18n.htmlDir" => Ok(Some(Value::from(i18n::html_dir(opt_str(args, 0))))),
        "i18n.macShortcutsToWin" => {
            str_arg(args, 0).map(|text| Some(Value::from(i18n::mac_shortcuts_to_win(text))))
        }
        "i18n.platformShortcuts" => {
            str_arg(args, 0).map(|text| Some(Value::from(i18n::platform_shortcuts(text))))
        }
        "i18n.format" => str_arg(args, 0).map(|template| {
            Some(Value::from(match jv(args, 1) {
                Some(JsonValue::Object(params)) => i18n::format(template, &params),
                _ => template.to_owned(),
            }))
        }),
        "i18n.createI18n" => create_i18n_call(args),
        "i18n.documentLocaleFor" => Ok(Some(Value::from(i18n::document_locale_for(opt_str(
            args, 0,
        ))))),
        "i18n.documentLocale" => {
            str_arg(args, 0).map(|requested| Some(Value::from(i18n::document_locale(requested))))
        }
        "i18n.productName" => Ok(Some(Value::from(i18n::product_name(opt_str(args, 0))))),
        "i18n.UPSTREAM_PRODUCT_NAME" => Ok(Some(Value::from(UPSTREAM_PRODUCT_NAME))),
        "i18n.PRODUCT_NAME" => Ok(Some(Value::from(PRODUCT_NAME))),
        "i18n.USER_DATA_DIR_NAME" => Ok(Some(Value::from(USER_DATA_DIR_NAME))),
        "i18n.DEV_USER_DATA_DIR_NAME" => Ok(Some(Value::from(DEV_USER_DATA_DIR_NAME))),
        "i18n.PRODUCT_REPO_OWNER" => Ok(Some(Value::from(PRODUCT_REPO_OWNER))),
        "i18n.PRODUCT_REPO_NAME" => Ok(Some(Value::from(PRODUCT_REPO_NAME))),
        "i18n.PRODUCT_REPO_SLUG" => Ok(Some(Value::from(PRODUCT_REPO_SLUG))),
        "i18n.OLD_ENV_PREFIX" => Ok(Some(Value::from(OLD_ENV_PREFIX))),
        "i18n.ENV_PREFIX" => Ok(Some(Value::from(ENV_PREFIX))),
        "i18n.OLD_ENV_NAMES" => Ok(Some(strings(&OLD_ENV_NAMES))),
        "i18n.adoptOldEnv" => adopt_old_env_call(args),
        "i18n.OLD_HOME_DIR_NAMES" => Ok(Some(strings(&OLD_HOME_DIR_NAMES))),
        "i18n.OLD_PROJECT_DATA_DIR_NAMES" => Ok(Some(strings(&OLD_PROJECT_DATA_DIR_NAMES))),
        "i18n.OLD_CLI_COMMANDS" => Ok(Some(strings(&OLD_CLI_COMMANDS))),
        "i18n.OLD_CLI_BUNDLE_FILES" => Ok(Some(strings(&OLD_CLI_BUNDLE_FILES))),
        "i18n.OLD_MCP_SERVER_NAMES" => Ok(Some(strings(&OLD_MCP_SERVER_NAMES))),
        "i18n.OLD_APP_MCP_SERVER_NAMES" => Ok(Some(strings(&OLD_APP_MCP_SERVER_NAMES))),
        "i18n.OLD_SKILL_NAMES" => Ok(Some(strings(&OLD_SKILL_NAMES))),
        "i18n.OLD_MCP_TOOL_NAMES" => Ok(Some(pairs(&OLD_MCP_TOOL_NAMES))),
        "i18n.OLD_MCP_RESOURCE_SCHEMES" => Ok(Some(strings(&OLD_MCP_RESOURCE_SCHEMES))),
        "i18n.existingOrCurrent" => existing_or_current_call(args, cx),

        // ---------- user-skills-channels ----------
        "user-skills-channels.USER_SKILLS_BRIDGE_KEY" => {
            Ok(Some(Value::from(USER_SKILLS_BRIDGE_KEY)))
        }
        "user-skills-channels.USER_SKILLS_CHANNELS" => Ok(Some(pairs(&USER_SKILLS_CHANNELS))),
        "user-skills-channels.USER_SKILL_PREVIEW_TEXT_MAX_CHARS" => {
            Ok(Some(Value::from(skills::USER_SKILL_PREVIEW_TEXT_MAX_CHARS)))
        }
        "user-skills-channels.skillIdOf" => Ok(string_or_undefined(skills::skill_id_of(
            jv(args, 0).as_ref(),
        ))),
        "user-skills-channels.invokeOf" => {
            Ok(skills::invoke_of(jv(args, 0).as_ref()).map(Value::from))
        }
        "user-skills-channels.editorsValueOf" => {
            Ok(match skills::editors_value_of(jv(args, 0).as_ref()) {
                EditorsValue::Undefined => None,
                EditorsValue::All => Some(Value::from("all")),
                EditorsValue::List(ids) => {
                    Some(Value::Array(ids.into_iter().map(Value::from).collect()))
                }
                EditorsValue::Malformed => Some(Value::Null),
            })
        }
        "user-skills-channels.statePatchOf" => {
            Ok(json_out(skills::state_patch_of(jv(args, 0).as_ref())))
        }
        "user-skills-channels.USER_SKILL_BODY_MAX" => {
            Ok(Some(Value::from(skills::USER_SKILL_BODY_MAX)))
        }
        "user-skills-channels.saveInputOf" => {
            Ok(json_out(skills::save_input_of(jv(args, 0).as_ref())))
        }
        "user-skills-channels.USER_SKILL_TEMPLATE_MAX_BYTES" => {
            Ok(Some(Value::from(skills::USER_SKILL_TEMPLATE_MAX_BYTES)))
        }
        "user-skills-channels.cardSaveInputOf" => {
            Ok(json_out(skills::card_save_input_of(jv(args, 0).as_ref())))
        }
        "user-skills-channels.USER_SKILL_PASTE_MAX_CHARS" => {
            Ok(Some(Value::from(skills::USER_SKILL_PASTE_MAX_CHARS)))
        }
        "user-skills-channels.importTextOf" => Ok(string_or_undefined(skills::import_text_of(
            jv(args, 0).as_ref(),
        ))),
        "user-skills-channels.USER_SKILL_BUNDLE_MAX" => {
            Ok(Some(Value::from(skills::USER_SKILL_BUNDLE_MAX)))
        }
        "user-skills-channels.skillIdListOf" => Ok(skills::skill_id_list_of(jv(args, 0).as_ref())
            .map(|ids| Value::Array(ids.into_iter().map(Value::from).collect()))),
        "user-skills-channels.installRequestOf" => {
            Ok(json_out(skills::install_request_of(jv(args, 0).as_ref())))
        }
        "user-skills-channels.skillViewsOf" => Ok(Some(Value::Array(
            skills::skill_views_of(jv(args, 0).as_ref())
                .iter()
                .map(json_value_to_serde)
                .collect(),
        ))),
        "user-skills-channels.skillsResultOf" => Ok(Some(json_value_to_serde(
            &skills::skills_result_of(jv(args, 0).as_ref()),
        ))),
        "user-skills-channels.USER_SKILL_HANDOFF_TEXT_MAX" => {
            Ok(Some(Value::from(skills::USER_SKILL_HANDOFF_TEXT_MAX)))
        }
        "user-skills-channels.templateOpenInputOf" => Ok(json_out(skills::template_open_input_of(
            jv(args, 0).as_ref(),
        ))),
        "user-skills-channels.previewInputOf" => {
            Ok(json_out(skills::preview_input_of(jv(args, 0).as_ref())))
        }
        "user-skills-channels.handoffTargetOf" => Ok(string_or_undefined(
            skills::handoff_target_of(jv(args, 0).as_ref()),
        )),
        "user-skills-channels.previewEndedOf" => {
            Ok(json_out(skills::preview_ended_of(jv(args, 0).as_ref())))
        }

        // ---------- mcp-tools-channels ----------
        "mcp-tools-channels.MCP_TOOLS_BRIDGE_KEY" => Ok(Some(Value::from(MCP_TOOLS_BRIDGE_KEY))),
        "mcp-tools-channels.MCP_TOOLS_CHANNELS" => Ok(Some(pairs(&MCP_TOOLS_CHANNELS))),
        "mcp-tools-channels.mcpServerNameOf" => Ok(string_or_undefined(mcp_server_name_of(
            jv(args, 0).as_ref(),
        ))),
        "mcp-tools-channels.mcpCallIdOf" => {
            Ok(string_or_undefined(mcp_call_id_of(jv(args, 0).as_ref())))
        }
        "mcp-tools-channels.mcpToolCallRequestOf" => {
            Ok(mcp_tool_call_request_of(jv(args, 0).as_ref())
                .map(|request| json_value_to_serde(&request.to_json())))
        }

        // ---------- outbound-channels ----------
        "outbound-channels.OUTBOUND_CHANNELS" => Ok(Some(pairs(&OUTBOUND_CHANNELS))),
        "outbound-channels.MAX_CONFIRM_ADDRESSES" => Ok(Some(Value::from(MAX_CONFIRM_ADDRESSES))),
        "outbound-channels.MAX_CONFIRM_ADDRESS_LENGTH" => {
            Ok(Some(Value::from(MAX_CONFIRM_ADDRESS_LENGTH)))
        }
        "outbound-channels.confirmRequestOf" => {
            Ok(Some(match confirm_request_of(jv(args, 0).as_ref()) {
                Some(request) => {
                    let mut object = Map::new();
                    object.insert("tool".into(), Value::from(request.tool));
                    object.insert(
                        "addresses".into(),
                        Value::Array(request.addresses.into_iter().map(Value::from).collect()),
                    );
                    Value::Object(object)
                }
                None => Value::Null,
            }))
        }

        // ---------- doc-attach-channels ----------
        "doc-attach-channels.DOC_ATTACH_CHANNELS" => Ok(Some(pairs(&DOC_ATTACH_CHANNELS))),
        "doc-attach-channels.DOC_ATTACH_BRIDGE_KEY" => Ok(Some(Value::from(DOC_ATTACH_BRIDGE_KEY))),

        // ---------- folder-api / project-folder-bridge ----------
        "folder-api.PROJECT_FOLDER_NAMES" => Ok(Some(pairs(&PROJECT_FOLDER_NAMES))),
        "folder-api.PROJECT_FOLDER_EVENTS" => {
            let mut object = Map::new();
            for (method, channel) in PROJECT_FOLDER_EVENTS {
                object.insert(method.as_str().into(), Value::from(channel));
            }
            Ok(Some(Value::Object(object)))
        }
        "folder-api.PROJECT_FOLDER_CHANNELS" => Ok(Some(pairs(&PROJECT_FOLDER_CHANNELS))),
        "folder-api.PROJECT_FOLDER_LISTEN_CHANNEL" => {
            Ok(Some(Value::from(PROJECT_FOLDER_LISTEN_CHANNEL)))
        }
        "folder-api.PROJECT_FOLDER_BRIDGE_KEY"
        | "project-folder-bridge.PROJECT_FOLDER_BRIDGE_KEY" => {
            Ok(Some(Value::from(PROJECT_FOLDER_BRIDGE_KEY)))
        }
        "project-folder-bridge.projectFolderBridge" => project_folder_bridge_call(args, cx),

        // ---------- split-pane-bridge ----------
        "split-pane-bridge.SPLIT_PANE_CHANNELS" => Ok(Some(pairs(&SPLIT_PANE_CHANNELS))),
        "split-pane-bridge.SPLIT_PANE_BRIDGE_KEY" => Ok(Some(Value::from(SPLIT_PANE_BRIDGE_KEY))),
        "split-pane-bridge.splitPaneBridge" => split_pane_bridge_call(args, cx),

        // ---------- default-save-dir ----------
        "default-save-dir.DEFAULT_SAVE_DIR_KEY" => Ok(Some(Value::from(DEFAULT_SAVE_DIR_KEY))),
        "default-save-dir.readDefaultSaveDirSetting" => str_arg(args, 0).map(|path| {
            Some(match read_default_save_dir_setting(path) {
                Some(dir) => Value::from(dir),
                None => Value::Null,
            })
        }),
        "default-save-dir.createDirLevels" => str_arg(args, 0).and_then(|dir| {
            create_dir_levels(dir)
                .map(|()| None)
                .map_err(CallError::from)
        }),
        "default-save-dir.isUsableSaveDir" => {
            str_arg(args, 0).map(|dir| Some(Value::Bool(is_usable_save_dir(dir))))
        }
        "default-save-dir.resolveDefaultSaveDir" => resolve_default_save_dir_call(args, cx, false),
        "default-save-dir.defaultSaveDirFallback" => resolve_default_save_dir_call(args, cx, true),
        "default-save-dir.documentsDirOrFallback" => {
            let app = app_arg(arg(args, 0), cx);
            let result = documents_dir_or_fallback(&app);
            cx.logs.extend(app.logs.into_inner());
            result.map(|dir| Some(Value::from(dir))).map_err(thrown)
        }
        "default-save-dir.configuredDefaultSaveDir" => configured_default_save_dir_call(args, cx),

        // ---------- dialog-memory ----------
        "dialog-memory.showOpenDialogWithMemory" => dialog_call(args, cx, true),
        "dialog-memory.showSaveDialogWithMemory" => dialog_call(args, cx, false),
        "dialog-memory.saveAsSuggestion" => str_arg(args, 1)
            .map(|name| Some(Value::from(save_as_suggestion(opt_str(args, 0), name)))),

        // ---------- author-name ----------
        "author-name.AUTHOR_NAME_KEY" => Ok(Some(Value::from(AUTHOR_NAME_KEY))),
        "author-name.AUTHOR_NAME_MAX" => Ok(Some(Value::from(AUTHOR_NAME_MAX))),
        "author-name.sanitizeAuthorName" => Ok(Some(Value::from(sanitize_author_name(
            jv(args, 0).as_ref(),
        )))),
        "author-name.readAuthorNameSetting" => {
            str_arg(args, 0).map(|path| Some(Value::from(read_author_name_setting(path))))
        }
        "author-name.systemAuthorName" => {
            Ok(Some(Value::from(system_author_name(opt_str(args, 0)))))
        }
        "author-name.resolveAuthorName" => str_arg(args, 0)
            .map(|path| Some(Value::from(resolve_author_name(path, opt_str(args, 1))))),
        "author-name.configuredAuthorName" => str_arg(args, 0).map(|user_data| {
            Some(Value::from(configured_author_name(
                user_data,
                opt_str(args, 1),
            )))
        }),

        // ---------- font-store ----------
        "font-store.installLocalFontFiles" => font_store_call(args, cx),

        // ---------- github-menu ----------
        "github-menu.GITHUB_REPO_OWNER" => Ok(Some(Value::from(GITHUB_REPO_OWNER))),
        "github-menu.GITHUB_REPO_NAME" => Ok(Some(Value::from(GITHUB_REPO_NAME))),
        "github-menu.GITHUB_REPO_SLUG" => Ok(Some(Value::from(GITHUB_REPO_SLUG))),
        "github-menu.GITHUB_REPO_URL" => Ok(Some(Value::from(GITHUB_REPO_URL))),
        "github-menu.GITHUB_REPO_DISPLAY" => Ok(Some(Value::from(GITHUB_REPO_DISPLAY))),
        "github-menu.GITHUB_ISSUES_URL" => Ok(Some(Value::from(GITHUB_ISSUES_URL))),
        "github-menu.GITHUB_NEW_ISSUE_URL" => Ok(Some(Value::from(GITHUB_NEW_ISSUE_URL))),
        "github-menu.GITHUB_RELEASES_URL" => Ok(Some(Value::from(GITHUB_RELEASES_URL))),
        "github-menu.GITHUB_LATEST_RELEASE_URL" => Ok(Some(Value::from(GITHUB_LATEST_RELEASE_URL))),
        "github-menu.githubReleaseTagUrl" => {
            str_arg(args, 0).map(|version| Some(Value::from(github_release_tag_url(version))))
        }

        // ---------- hwp-default-format ----------
        "hwp-default-format.HWP_DEFAULT_FORMAT_KEY" => {
            Ok(Some(Value::from(HWP_DEFAULT_FORMAT_KEY)))
        }
        "hwp-default-format.normalizeHwpDefaultFormat" => Ok(Some(
            serde_json::to_value(normalize_hwp_default_format(jv(args, 0).as_ref()))
                .expect("a format prints"),
        )),
        "hwp-default-format.readHwpDefaultFormat" => {
            let app = app_arg(arg(args, 0), cx);
            let format = read_hwp_default_format(&app);
            cx.logs.extend(app.logs.into_inner());
            Ok(Some(serde_json::to_value(format).expect("a format prints")))
        }

        // ---------- marked-odt ----------
        "marked-odt.markedOdtBox" => marked_odt_text(args)
            .map(|text| Some(serde_json::to_value(marked_odt_box(&text)).expect("a box prints"))),
        "marked-odt.markedOdtChoice" => number_arg(args, 0).map(|response| {
            // `withDocx = true`: a default stands for a missing argument
            let with_docx = arg(args, 1).and_then(Value::as_bool).unwrap_or(true);
            Some(
                serde_json::to_value(marked_odt_choice(response, with_docx))
                    .expect("a choice prints"),
            )
        }),

        // ---------- numbered-export-paths ----------
        "numbered-export-paths.numberedExportPaths" => str_arg(args, 0).and_then(|target| {
            let count = number_arg(args, 1)?;
            numbered_export_paths(target, count)
                .map(|paths| Some(Value::Array(paths.into_iter().map(Value::from).collect())))
                .map_err(|e| CallError::plain(e.0))
        }),

        // ---------- template-font-response, template-fonts ----------
        "template-font-response.templateFontResponse" => template_font_response_call(args),
        "template-fonts.TEMPLATE_FONT_SCHEME" => Ok(Some(Value::from(TEMPLATE_FONT_SCHEME))),
        "template-fonts.TEMPLATE_FONT_HOST" => Ok(Some(Value::from(TEMPLATE_FONT_HOST))),
        "template-fonts.TEMPLATE_FONT_FILES" => Ok(Some(strings(&TEMPLATE_FONT_FILES))),
        "template-fonts.templateFontFileOf" => str_arg(args, 0).map(|url| {
            Some(match template_font_file_of(url) {
                Some(file) => Value::from(file),
                None => Value::Null,
            })
        }),

        // ---------- template-fonts-dir ----------
        "template-fonts-dir.TEMPLATE_FONTS_DIR_NAME" => {
            Ok(Some(Value::from(TEMPLATE_FONTS_DIR_NAME)))
        }
        "template-fonts-dir.TEMPLATE_FONTS_REPO_DIR" => {
            Ok(Some(Value::from(TEMPLATE_FONTS_REPO_DIR)))
        }
        "template-fonts-dir.templateFontsDir" => template_fonts_dir_call(args),

        // ---------- abort-on-destroyed ----------
        "abort-on-destroyed.abortOnDestroyed" => abort_on_destroyed_call(args, cx),

        _ => return None,
    })
}

// ---------- argument helpers ----------

fn jv(args: &[Value], i: usize) -> Option<JsonValue> {
    arg(args, i).map(json_value_from_serde)
}

/// A string argument where `null` or a missing one is `null` or `undefined`.
fn opt_str(args: &[Value], i: usize) -> Option<&str> {
    arg(args, i).and_then(Value::as_str)
}

fn json_out(value: Option<JsonValue>) -> Option<Value> {
    value.as_ref().map(json_value_to_serde)
}

fn string_or_undefined(value: Option<String>) -> Option<Value> {
    value.map(Value::from)
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(*s)).collect())
}

/// An object of (key, value) pairs in the order given.
fn pairs(items: &[(&str, &str)]) -> Value {
    let mut object = Map::new();
    for (key, value) in items {
        object.insert((*key).to_owned(), Value::from(*value));
    }
    Value::Object(object)
}

fn thrown(e: Thrown) -> CallError {
    CallError::plain(e.0)
}

/// `MarkedOdtText` from its JSON; `saveDocx` absent is `undefined`
fn marked_odt_text(args: &[Value]) -> Result<MarkedOdtText, CallError> {
    let text = arg(args, 0)
        .and_then(Value::as_object)
        .ok_or_else(|| CallError::plain("argument 0 is not an object"))?;
    let field = |key: &str| {
        text.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| CallError::plain(format!("{key} is not a string")))
    };
    Ok(MarkedOdtText {
        title: field("title")?,
        message: field("message")?,
        detail: field("detail")?,
        save_docx: text
            .contains_key("saveDocx")
            .then(|| field("saveDocx"))
            .transpose()?,
        clear_marks: field("clearMarks")?,
        cancel: field("cancel")?,
    })
}

/// A number argument; the strings "NaN", "Infinity" and "-Infinity" stand for
/// what JSON cannot carry.
fn number_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    match arg(args, i) {
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) if s == "NaN" => Ok(f64::NAN),
        Some(Value::String(s)) if s == "Infinity" => Ok(f64::INFINITY),
        Some(Value::String(s)) if s == "-Infinity" => Ok(f64::NEG_INFINITY),
        _ => Err(CallError::plain(format!("argument {i} is not a number"))),
    }
}

/// The calls of a fake, in order.
#[derive(Default)]
struct Logger(RefCell<Vec<Vec<Value>>>);

impl Logger {
    fn push(&self, line: Vec<Value>) {
        self.0.borrow_mut().push(line);
    }
}

// ---------- i18n ----------

fn string_dict(value: Option<&Value>) -> JsObject<String> {
    let mut dict = JsObject::new();
    if let Some(Value::Object(map)) = value {
        for (key, text) in map {
            if let Value::String(text) = text {
                dict.set(key.clone(), text.clone());
            }
        }
    }
    dict
}

/// `createI18n({ en, ko })(lang, key, params)`
fn create_i18n_call(args: &[Value]) -> Answer {
    let i18n = I18n {
        en: string_dict(arg(args, 0)),
        ko: string_dict(arg(args, 1)),
    };
    let lang = i18n::normalize_lang(Some(str_arg(args, 2)?));
    let key = str_arg(args, 3)?;
    let params = match jv(args, 4) {
        Some(JsonValue::Object(params)) => Some(params),
        _ => None,
    };
    Ok(Some(Value::from(i18n.t(lang, key, params.as_ref()))))
}

/// `adoptOldEnv(env)`: the names it set, then the environment.
fn adopt_old_env_call(args: &[Value]) -> Answer {
    let mut env = string_dict(arg(args, 0));
    let adopted = i18n::adopt_old_env(&mut env);
    let mut out = Map::new();
    out.insert(
        "adopted".into(),
        Value::Array(adopted.into_iter().map(Value::from).collect()),
    );
    let mut env_out = Map::new();
    for (key, value) in env.entries() {
        env_out.insert(key.to_owned(), Value::from(value.clone()));
    }
    out.insert("env".into(), Value::Object(env_out));
    Ok(Some(Value::Object(out)))
}

/// `existingOrCurrent(current, oldNames, exists)`; `exists` logs its argument.
fn existing_or_current_call(args: &[Value], cx: &mut Context) -> Answer {
    let current = str_arg(args, 0)?;
    let old: Vec<String> = string_list(args, 1)?;
    let existing: Vec<String> = string_list(args, 2)?;
    let old_refs: Vec<&str> = old.iter().map(String::as_str).collect();
    // `inUse` (argument 3), a list like `exists`, logged as ["inUse", name]
    let in_use_list: Option<Vec<String>> = match arg(args, 3) {
        None | Some(Value::Null) => None,
        Some(_) => Some(string_list(args, 3)?),
    };
    let logs = std::cell::RefCell::new(Vec::new());
    let mut in_use = |name: &str| {
        logs.borrow_mut()
            .push(vec![Value::from("inUse"), Value::from(name)]);
        in_use_list
            .as_ref()
            .is_some_and(|l| l.iter().any(|e| e == name))
    };
    let answer = i18n::existing_or_current(
        current,
        &old_refs,
        |name| {
            logs.borrow_mut().push(vec![Value::from(name)]);
            existing.iter().any(|e| e == name)
        },
        in_use_list
            .is_some()
            .then_some(&mut in_use as &mut dyn FnMut(&str) -> bool),
    );
    cx.logs.extend(logs.into_inner());
    Ok(Some(Value::from(answer)))
}

fn string_list(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain(format!("argument {i} is not a list")))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| CallError::plain("not a string"))
        })
        .collect()
}

// ---------- the bridges ----------

struct BridgeIpc<'a> {
    log: &'a Logger,
}

impl ProjectFolderBridgeIpc for BridgeIpc<'_> {
    type Reply = Value;

    fn invoke(&mut self, channel: &str, args: Option<&Value>) -> Value {
        let mut line = vec![Value::from("invoke"), Value::from(channel)];
        if let Some(args) = args {
            line.push(args.clone());
        }
        self.log.push(line);
        Value::from(format!("reply:{channel}"))
    }

    fn on(&mut self, channel: &str, listener: u64) {
        self.log.push(vec![
            Value::from("on"),
            Value::from(channel),
            Value::from(listener),
        ]);
    }

    fn remove_listener(&mut self, channel: &str, listener: u64) {
        self.log.push(vec![
            Value::from("removeListener"),
            Value::from(channel),
            Value::from(listener),
        ]);
    }

    fn send(&mut self, channel: &str, message: &ProjectFolderListenMessage) {
        self.log.push(vec![
            Value::from("send"),
            Value::from(channel),
            serde_json::to_value(message).expect("a message prints"),
        ]);
    }
}

/// Steps: `["request", name]`, `["request", name, args]`, `["subscribe", method]`,
/// `["unsubscribe", index]`.
fn project_folder_bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("argument 0 is not a list"))?;
    let log = Logger::default();
    let mut ipc = BridgeIpc { log: &log };
    let mut bridge = ProjectFolderBridge::new();
    let mut subscriptions: Vec<Subscription> = Vec::new();
    let mut results = Vec::new();
    for step in steps {
        let step = step
            .as_array()
            .ok_or_else(|| CallError::plain("a step is not a list"))?;
        let op = step.first().and_then(Value::as_str).unwrap_or("");
        let result = match op {
            "request" => {
                let name = step.get(1).and_then(Value::as_str).unwrap_or("");
                bridge
                    .request(&mut ipc, name, step.get(2))
                    .ok_or_else(|| CallError::plain(format!("no request method {name}")))?
            }
            "subscribe" => {
                let method = step.get(1).and_then(Value::as_str).unwrap_or("");
                let method = ProjectFolderEventMethod::from_name(method)
                    .ok_or_else(|| CallError::plain(format!("no event method {method}")))?;
                subscriptions.push(bridge.subscribe(&mut ipc, method));
                Value::from(subscriptions.len() - 1)
            }
            "unsubscribe" => {
                let index = step.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
                let subscription = subscriptions
                    .get_mut(index)
                    .ok_or_else(|| CallError::plain("no such subscription"))?;
                bridge.unsubscribe(&mut ipc, subscription);
                Value::Null
            }
            other => return Err(CallError::plain(format!("unknown step {other}"))),
        };
        results.push(result);
    }
    cx.logs.extend(log.0.into_inner());
    Ok(Some(Value::Array(results)))
}

struct SplitIpc<'a> {
    log: &'a Logger,
    /// "value", "undefined" or "reject"
    mode: String,
    value: Value,
}

impl SplitPaneIpc for SplitIpc<'_> {
    fn invoke(&mut self, channel: &str) -> Result<Option<Value>, IpcRejected> {
        self.log
            .push(vec![Value::from("invoke"), Value::from(channel)]);
        match self.mode.as_str() {
            "reject" => Err(IpcRejected),
            "undefined" => Ok(None),
            _ => Ok(Some(self.value.clone())),
        }
    }

    fn on(&mut self, channel: &str, listener: u64) {
        self.log.push(vec![
            Value::from("on"),
            Value::from(channel),
            Value::from(listener),
        ]);
    }

    fn remove_listener(&mut self, channel: &str, listener: u64) {
        self.log.push(vec![
            Value::from("removeListener"),
            Value::from(channel),
            Value::from(listener),
        ]);
    }

    fn send(&mut self, channel: &str) {
        self.log
            .push(vec![Value::from("send"), Value::from(channel)]);
    }
}

/// Steps: `["getRole"]`, `["onRoleChanged"]`, `["unsubscribe", index]`,
/// `["requestFocus"]`, `["reportFocus"]`; argument 1 says what `invoke` does:
/// `{ mode: "value" | "undefined" | "reject", value }`.
fn split_pane_bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("argument 0 is not a list"))?;
    let config = arg(args, 1);
    let log = Logger::default();
    let mut ipc = SplitIpc {
        log: &log,
        mode: config
            .and_then(|c| c.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("value")
            .to_owned(),
        value: config
            .and_then(|c| c.get("value"))
            .cloned()
            .unwrap_or(Value::Null),
    };
    let mut bridge = SplitPaneBridge::new();
    let mut listeners: Vec<u64> = Vec::new();
    let mut results = Vec::new();
    for step in steps {
        let step = step
            .as_array()
            .ok_or_else(|| CallError::plain("a step is not a list"))?;
        let result = match step.first().and_then(Value::as_str).unwrap_or("") {
            "getRole" => bridge.get_role(&mut ipc),
            "onRoleChanged" => {
                listeners.push(bridge.on_role_changed(&mut ipc));
                Value::from(listeners.len() - 1)
            }
            "unsubscribe" => {
                let index = step.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
                let listener = *listeners
                    .get(index)
                    .ok_or_else(|| CallError::plain("no such subscription"))?;
                bridge.remove_role_listener(&mut ipc, listener);
                Value::Null
            }
            "requestFocus" => {
                bridge.request_focus(&mut ipc);
                Value::Null
            }
            "reportFocus" => {
                bridge.report_focus(&mut ipc);
                Value::Null
            }
            other => return Err(CallError::plain(format!("unknown step {other}"))),
        };
        results.push(result);
    }
    cx.logs.extend(log.0.into_inner());
    Ok(Some(Value::Array(results)))
}

// ---------- default-save-dir ----------

/// An `app` of `{ userData, documents, home }`, each a path or `{ throws }`;
/// each `getPath` is one log line.
struct FakeApp {
    paths: HashMap<String, Result<String, String>>,
    logs: RefCell<Vec<Vec<Value>>>,
}

impl PathProvider for FakeApp {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        self.logs
            .borrow_mut()
            .push(vec![Value::from("getPath"), Value::from(name)]);
        match self.paths.get(name) {
            Some(Ok(path)) => Ok(path.clone()),
            Some(Err(message)) => Err(Thrown(message.clone())),
            None => Ok(String::new()),
        }
    }
}

fn app_arg(spec: Option<&Value>, _cx: &Context) -> FakeApp {
    let mut paths = HashMap::new();
    if let Some(Value::Object(map)) = spec {
        for (name, value) in map {
            let entry = match value {
                Value::String(path) => Ok(path.clone()),
                other => Err(other
                    .get("throws")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()),
            };
            paths.insert(name.clone(), entry);
        }
    }
    FakeApp {
        paths,
        logs: RefCell::new(Vec::new()),
    }
}

/// One step of a scenario: the time of the call, and what happens to the
/// folder before it.
struct Step {
    at: f64,
    mkdir: Option<String>,
    chmod: Option<(String, u32)>,
}

fn steps_arg(spec: Option<&Value>) -> Option<Vec<Step>> {
    let list = spec?.as_array()?;
    Some(
        list.iter()
            .map(|step| Step {
                at: step.get("at").and_then(Value::as_f64).unwrap_or(0.0),
                mkdir: step.get("mkdir").and_then(Value::as_str).map(str::to_owned),
                chmod: step
                    .get("chmod")
                    .and_then(Value::as_array)
                    .and_then(|pair| {
                        Some((
                            pair.first()?.as_str()?.to_owned(),
                            pair.get(1)?.as_u64()? as u32,
                        ))
                    }),
            })
            .collect(),
    )
}

fn apply_step(step: &Step) {
    if let Some(path) = &step.mkdir {
        let _ = fs::create_dir_all(path);
    }
    if let Some((path, mode)) = &step.chmod {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(*mode));
        }
        // fs.chmodSync on Windows sets the read-only attribute alone, from the
        // owner's write bit
        #[cfg(not(unix))]
        if let Ok(meta) = fs::metadata(path) {
            let mut permissions = meta.permissions();
            permissions.set_readonly(mode & 0o200 == 0);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn answer_text(result: Result<String, Thrown>) -> Value {
    match result {
        Ok(dir) => Value::from(dir),
        Err(e) => {
            let mut object = Map::new();
            object.insert("error".into(), Value::from(e.0));
            Value::Object(object)
        }
    }
}

fn fallback_value(state: &SaveDirState) -> Value {
    match default_save_dir_fallback(state) {
        Some(fallback) => {
            let mut object = Map::new();
            object.insert("blocked".into(), Value::from(fallback.blocked));
            object.insert("using".into(), Value::from(fallback.using));
            Value::Object(object)
        }
        None => Value::Null,
    }
}

/// `resolveDefaultSaveDir(configured, fallbackDir)` over steps (argument 2:
/// `[{ at, mkdir?, chmod? }]`, each a call at `now + at`). Without steps it
/// is one call, answering its value or throwing. `fallback_only` answers
/// `defaultSaveDirFallback()` after the last step instead.
fn resolve_default_save_dir_call(args: &[Value], cx: &mut Context, fallback_only: bool) -> Answer {
    let configured = opt_str(args, 0);
    let fallbacks: Vec<String> = match arg(args, 1) {
        Some(Value::String(dir)) => vec![dir.clone()],
        _ => string_list(args, 1)?,
    };
    let mut state = SaveDirState::new();
    let steps = steps_arg(arg(args, 2));
    let Some(steps) = steps else {
        let result = resolve_default_save_dir(&mut state, configured, &fallbacks, cx.now_ms);
        if fallback_only {
            return Ok(Some(fallback_value(&state)));
        }
        return result.map(|dir| Some(Value::from(dir))).map_err(thrown);
    };
    let mut results = Vec::new();
    for step in &steps {
        apply_step(step);
        results.push(answer_text(resolve_default_save_dir(
            &mut state,
            configured,
            &fallbacks,
            cx.now_ms + step.at,
        )));
    }
    if fallback_only {
        return Ok(Some(fallback_value(&state)));
    }
    let mut out = Map::new();
    out.insert("results".into(), Value::Array(results));
    out.insert("fallback".into(), fallback_value(&state));
    Ok(Some(Value::Object(out)))
}

/// `configuredDefaultSaveDir(app)`; argument 1 as for
/// [`resolve_default_save_dir_call`].
fn configured_default_save_dir_call(args: &[Value], cx: &mut Context) -> Answer {
    let app = app_arg(arg(args, 0), cx);
    let mut state = SaveDirState::new();
    let result = match steps_arg(arg(args, 1)) {
        None => configured_default_save_dir(&app, &mut state, cx.now_ms)
            .map(|dir| Some(Value::from(dir)))
            .map_err(thrown),
        Some(steps) => {
            let mut results = Vec::new();
            for step in &steps {
                apply_step(step);
                results.push(answer_text(configured_default_save_dir(
                    &app,
                    &mut state,
                    cx.now_ms + step.at,
                )));
            }
            let mut out = Map::new();
            out.insert("results".into(), Value::Array(results));
            out.insert("fallback".into(), fallback_value(&state));
            Ok(Some(Value::Object(out)))
        }
    };
    cx.logs.extend(app.logs.into_inner());
    result
}

// ---------- dialog-memory ----------

struct FakeDialog<'a> {
    log: &'a Logger,
    result: Value,
}

impl Dialog for FakeDialog<'_> {
    type Window = ();

    fn show_open_dialog(
        &mut self,
        parent: Option<&()>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        self.record("showOpenDialog", parent, options);
        json_value_from_serde(&self.result)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&()>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        self.record("showSaveDialog", parent, options);
        json_value_from_serde(&self.result)
    }
}

impl FakeDialog<'_> {
    fn record(&self, name: &str, parent: Option<&()>, options: &JsObject<JsonValue>) {
        let mut line = vec![Value::from(name)];
        if parent.is_some() {
            line.push(Value::from("<window>"));
        }
        line.push(json_value_to_serde(&JsonValue::Object(options.clone())));
        self.log.push(line);
    }
}

/// Steps `{ parent, options, fallbackDir, result }` over one dialog and its
/// memory. A save step's `fallbackDir` is a string, `null`, `{ fn }` (a
/// function answering `fn`, or nothing when `null`) or `{ throws }`.
fn dialog_call(args: &[Value], cx: &mut Context, open: bool) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("argument 0 is not a list"))?;
    let log = Logger::default();
    let mut memory = DialogMemory::new();
    let mut results = Vec::new();
    for step in steps {
        let mut dialog = FakeDialog {
            log: &log,
            result: step.get("result").cloned().unwrap_or(Value::Null),
        };
        let parent = step.get("parent").and_then(Value::as_bool).unwrap_or(false);
        let parent = parent.then_some(());
        let options = match step.get("options").map(json_value_from_serde) {
            Some(JsonValue::Object(options)) => options,
            _ => JsObject::new(),
        };
        let fallback = step.get("fallbackDir");
        let result = if open {
            show_open_dialog_with_memory(
                &mut memory,
                &mut dialog,
                parent.as_ref(),
                &options,
                fallback.and_then(Value::as_str),
            )
        } else {
            let fn_answer = fallback
                .and_then(|f| f.get("fn"))
                .map(|f| f.as_str().map(str::to_owned));
            let throws = fallback
                .and_then(|f| f.get("throws"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let resolver = move || match (&throws, &fn_answer) {
                (Some(message), _) => Err(Thrown(message.clone())),
                (None, Some(answer)) => Ok(answer.clone()),
                (None, None) => Ok(None),
            };
            let spec = match fallback {
                Some(Value::String(dir)) => Some(FallbackDir::Dir(dir)),
                Some(Value::Object(_)) => Some(FallbackDir::Resolve(&resolver)),
                _ => None,
            };
            show_save_dialog_with_memory(
                &mut memory,
                &mut dialog,
                parent.as_ref(),
                &options,
                spec.as_ref(),
            )
        };
        results.push(json_value_to_serde(&result));
    }
    cx.logs.extend(log.0.into_inner());
    Ok(Some(Value::Array(results)))
}

// ---------- font-store ----------

/// `installLocalFontFiles(env, paths)`: argument 0 is `{ dir, families }`,
/// `families` being `[[path, [family, ...]], ...]` for the injected reader or
/// `null` for a host without one; every read is a log line.
fn font_store_call(args: &[Value], cx: &mut Context) -> Answer {
    let env = arg(args, 0).ok_or_else(|| CallError::plain("argument 0 is missing"))?;
    let dir = env
        .get("dir")
        .and_then(Value::as_str)
        .ok_or_else(|| CallError::plain("env.dir is not a string"))?;
    let mut table: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(Value::Array(entries)) = env.get("families") {
        for entry in entries {
            let path = entry
                .get(0)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let families = entry
                .get(1)
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|f| f.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            table.push((path, families));
        }
    }
    let has_reader = matches!(env.get("families"), Some(Value::Array(_)));
    let paths = string_list(args, 1)?;
    let log = Logger::default();
    let reader = |path: &str| -> Vec<String> {
        log.push(vec![Value::from("fontFileFamilies"), Value::from(path)]);
        table
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, f)| f.clone())
            .unwrap_or_default()
    };
    let font_env = FontStoreEnv {
        dir,
        font_file_families: if has_reader { Some(&reader) } else { None },
    };
    let result = install_local_font_files(&font_env, &paths);
    cx.logs.extend(log.0.into_inner());
    result
        .map(|installed| {
            Some(Value::Array(
                installed.into_iter().map(Value::from).collect(),
            ))
        })
        .map_err(CallError::from)
}

// ---------- template-font-response ----------

/// `templateFontResponse(url, dir)` over the real file reader, as `null` or
/// `{ status, headers, body }` with the headers as `Headers` lists them (names
/// in lower case, sorted) and the body as hex.
fn template_font_response_call(args: &[Value]) -> Answer {
    let url = str_arg(args, 0)?;
    let dir = str_arg(args, 1)?;
    let mut read = |path: &str| fs::read(path).map_err(|_| ());
    let Some(response) = template_font_response(url, dir, &mut read) else {
        return Ok(Some(Value::Null));
    };
    let mut headers: Vec<(String, String)> = response
        .headers
        .into_iter()
        .map(|(name, value)| (name.to_lowercase(), value))
        .collect();
    headers.sort();
    let mut out = Map::new();
    out.insert("status".into(), Value::from(response.status));
    out.insert(
        "headers".into(),
        Value::Array(
            headers
                .into_iter()
                .map(|(name, value)| Value::Array(vec![Value::from(name), Value::from(value)]))
                .collect(),
        ),
    );
    out.insert(
        "body".into(),
        Value::from(
            response
                .body
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
        ),
    );
    Ok(Some(Value::Object(out)))
}

// ---------- template-fonts-dir ----------

struct FakeHost {
    is_packaged: bool,
    app_path: String,
    resources_path: String,
}

impl TemplateFontsHost for FakeHost {
    fn is_packaged(&self) -> bool {
        self.is_packaged
    }
    fn get_app_path(&self) -> String {
        self.app_path.clone()
    }
    fn resources_path(&self) -> String {
        self.resources_path.clone()
    }
}

fn template_fonts_dir_call(args: &[Value]) -> Answer {
    let host = arg(args, 0).ok_or_else(|| CallError::plain("argument 0 is missing"))?;
    let text = |key: &str| {
        host.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let host = FakeHost {
        is_packaged: host
            .get("isPackaged")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        app_path: text("appPath"),
        resources_path: text("resourcesPath"),
    };
    Ok(Some(Value::from(template_fonts_dir(&host))))
}

// ---------- abort-on-destroyed ----------

/// A sender of `{ destroyed, hasOn, onThrows, removeThrows }`; each call is a
/// log line, listeners are the numbers the module hands out.
struct FakeSender<'a> {
    log: &'a Logger,
    destroyed: bool,
    has_on: bool,
    on_throws: bool,
    gone_registered: Cell<bool>,
    navigation_registered: Cell<bool>,
}

impl DestroyableSender for FakeSender<'_> {
    fn is_destroyed(&mut self) -> bool {
        self.log.push(vec![Value::from("isDestroyed")]);
        self.destroyed
    }

    fn once_destroyed(&mut self, listener: u64) {
        self.log.push(vec![
            Value::from("once"),
            Value::from("destroyed"),
            Value::from(listener),
        ]);
        self.gone_registered.set(true);
    }

    fn remove_destroyed_listener(&mut self, listener: u64) {
        self.log.push(vec![
            Value::from("removeListener"),
            Value::from("destroyed"),
            Value::from(listener),
        ]);
        self.gone_registered.set(false);
    }

    fn on_navigation(&mut self, listener: u64) -> bool {
        if !self.has_on {
            return false;
        }
        self.log.push(vec![
            Value::from("on"),
            Value::from("did-start-navigation"),
            Value::from(listener),
        ]);
        if self.on_throws {
            return false;
        }
        self.navigation_registered.set(true);
        true
    }

    fn remove_navigation_listener(&mut self, listener: u64) {
        self.log.push(vec![
            Value::from("removeListener"),
            Value::from("did-start-navigation"),
            Value::from(listener),
        ]);
        self.navigation_registered.set(false);
    }
}

/// Steps: `["destroyed"]`, `["navigate", ...args]`, `["dispose"]`; the answer
/// is whether the controller was aborted after each step.
fn abort_on_destroyed_call(args: &[Value], cx: &mut Context) -> Answer {
    let config = arg(args, 0).ok_or_else(|| CallError::plain("argument 0 is missing"))?;
    let flag = |key: &str| config.get(key).and_then(Value::as_bool).unwrap_or(false);
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("argument 1 is not a list"))?;
    let log = Logger::default();
    let mut sender = FakeSender {
        log: &log,
        destroyed: flag("destroyed"),
        has_on: flag("hasOn"),
        on_throws: flag("onThrows"),
        gone_registered: Cell::new(false),
        navigation_registered: Cell::new(false),
    };
    let aborted = Cell::new(false);
    let mut abort = || {
        if !aborted.get() {
            aborted.set(true);
            log.push(vec![Value::from("abort")]);
        }
    };
    let disposer = abort_on_destroyed::abort_on_destroyed(&mut sender, &mut abort);
    let mut results = vec![Value::Bool(aborted.get())];
    for step in steps {
        let step = step
            .as_array()
            .ok_or_else(|| CallError::plain("a step is not a list"))?;
        match step.first().and_then(Value::as_str).unwrap_or("") {
            "destroyed" => {
                // `once`: the listener runs for the first event only
                if sender.gone_registered.get() {
                    sender.gone_registered.set(false);
                    abort_on_destroyed::on_gone(&mut abort);
                }
            }
            "navigate" => {
                if sender.navigation_registered.get() {
                    let event: Vec<JsonValue> =
                        step[1..].iter().map(json_value_from_serde).collect();
                    abort_on_destroyed::on_navigation(&event, &mut abort);
                }
            }
            "dispose" => disposer.dispose(&mut sender),
            other => return Err(CallError::plain(format!("unknown step {other}"))),
        }
        results.push(Value::Bool(aborted.get()));
    }
    cx.logs.extend(log.0.into_inner());
    Ok(Some(Value::Array(results)))
}
