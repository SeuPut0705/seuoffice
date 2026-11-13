//! App-wide settings: the language, the UI and document themes, the author
//! name, the auto-save default, the CSV limit, markdown's paper theme, and
//! the few shell queries that sit with them (split panes, dropped files, the
//! slides font settings). Ported from `registerHomeIpc`, `registerSplitIpc`
//! and `registerDroppedFilesIpc` of `apps/shell/src/main/index.ts`, and the
//! same channels in the editor mains.

use std::rc::Rc;

use jscompat::{JsonValue, json_parse, json_stringify_pretty, number_to_string, value_to_string};
use main_core::packages::electron_utils::author_name::{
    AUTHOR_NAME_KEY, configured_author_name, read_author_name_setting, sanitize_author_name,
    system_author_name,
};
use main_core::packages::electron_utils::template_fonts_dir::{
    TemplateFontsHost, template_fonts_dir,
};
use main_core::packages::i18n::{self, LANGS, Lang};
use main_core::shell::app_settings::{
    read_app_settings, write_app_setting, write_app_setting_then,
};
use main_core::shell::atomic_write::atomic_write_file;
use main_core::shell::csv_import_limit::csv_import_limit_mb;
use shell_contract::channels::Surface;
use shell_contract::ipc::{RegisterError, Registry, Reply, Target};
use shell_contract::{IpcError, IpcValue};

use crate::Ctx;
use crate::handler::{error, invoke, invoke_later};
use crate::state::{DOC_THEMES, UI_THEMES};
use crate::value::{arg, as_str, object, string, to_json, to_serde};

/// `MARKDOWN_THEME_IDS` of apps/markdown/src/shared/markdown-theme.ts
const MARKDOWN_THEME_IDS: [&str; 7] = [
    "default",
    "notion-light",
    "notion-dark",
    "drake-dark",
    "blubook",
    "nord",
    "newsprint",
];

/// `templateFontsDir({ isPackaged, getAppPath, resourcesPath })`
pub(crate) struct TemplateFonts<'a>(pub &'a dyn crate::hosts::MHost);

impl TemplateFontsHost for TemplateFonts<'_> {
    fn is_packaged(&self) -> bool {
        self.0.is_packaged()
    }

    fn get_app_path(&self) -> String {
        self.0.app_path()
    }

    fn resources_path(&self) -> String {
        self.0.resources_path()
    }
}

fn node_error(e: main_core::node_fs::NodeError) -> IpcError {
    error(e.message)
}

fn lang_of(cx: &Ctx) -> Lang {
    cx.state.language(&*cx.host, &cx.settings_path()).lang
}

/// `notifyQuickLookLangOrThemeChanged()`: the tray menu, then the quick-look
/// window's language and theme
fn notify_quick_look(cx: &Ctx) {
    cx.host.sync_tray_menu();
    let target = Target::Surface(Surface::ShellQuickLook);
    cx.emit(
        target,
        "quick-look:lang-changed",
        vec![string(lang_of(cx).as_str())],
    );
    cx.emit(
        target,
        "quick-look:theme-changed",
        vec![string(cx.state.theme(&cx.settings_path()))],
    );
}

/// `authorNameSetting()`
fn author_name_setting(cx: &Ctx) -> (String, String) {
    (
        read_author_name_setting(&cx.settings_path()),
        system_author_name(cx.host.username().as_deref()),
    )
}

fn set_language(cx: &Ctx, raw: &IpcValue) -> Reply {
    let Some(lang) = as_str(raw)
        .filter(|s| i18n::is_lang(s))
        .and_then(|s| LANGS.into_iter().find(|l| l.as_str() == s))
    else {
        return Ok(IpcValue::Undefined);
    };
    if lang == lang_of(cx) {
        return Ok(IpcValue::Undefined);
    }
    write_app_setting_then(
        &cx.settings_path(),
        "language",
        Some(JsonValue::String(lang.as_str().to_owned())),
        |_| cx.state.set_language(lang),
    )
    .map_err(node_error)?;
    cx.host.rebuild_menus_for_language();
    notify_quick_look(cx);
    cx.emit(
        Target::All,
        "app:language-changed",
        vec![string(lang.as_str())],
    );
    Ok(IpcValue::Undefined)
}

fn set_theme(cx: &Ctx, raw: &IpcValue) -> Reply {
    let path = cx.settings_path();
    let Some(theme) = as_str(raw).filter(|t| UI_THEMES.contains(t)) else {
        return Ok(IpcValue::Undefined);
    };
    if theme == cx.state.theme(&path) {
        return Ok(IpcValue::Undefined);
    }
    // the cache moves before the write, as `cachedTheme = theme` did
    cx.state.set_theme(theme);
    write_app_setting(&path, "theme", Some(JsonValue::String(theme.to_owned())))
        .map_err(node_error)?;
    cx.host.set_native_theme(theme);
    cx.host.refresh_title_bar_overlay();
    notify_quick_look(cx);
    cx.emit(Target::All, "app:theme-changed", vec![string(theme)]);
    Ok(IpcValue::Undefined)
}

fn set_document_theme(cx: &Ctx, raw: &IpcValue) -> Reply {
    let path = cx.settings_path();
    let Some(theme) = as_str(raw).filter(|t| DOC_THEMES.contains(t)) else {
        return Ok(IpcValue::Undefined);
    };
    if theme == cx.state.doc_theme(&path) {
        return Ok(IpcValue::Undefined);
    }
    cx.state.set_doc_theme(theme);
    write_app_setting(
        &path,
        "documentTheme",
        Some(JsonValue::String(theme.to_owned())),
    )
    .map_err(node_error)?;
    cx.emit(
        Target::All,
        "app:document-theme-changed",
        vec![string(theme)],
    );
    Ok(IpcValue::Undefined)
}

fn set_author_name(cx: &Ctx, raw: &IpcValue) -> Reply {
    let path = cx.settings_path();
    let value = sanitize_author_name(to_json(raw).as_ref());
    if value != read_author_name_setting(&path) {
        write_app_setting(
            &path,
            AUTHOR_NAME_KEY,
            Some(JsonValue::String(value.clone())),
        )
        .map_err(node_error)?;
        let effective = if value.is_empty() {
            system_author_name(cx.host.username().as_deref())
        } else {
            value
        };
        cx.emit(
            Target::All,
            "app:author-name-changed",
            vec![string(effective)],
        );
    }
    let (value, fallback) = author_name_setting(cx);
    Ok(object([
        ("value", string(value)),
        ("fallback", string(fallback)),
    ]))
}

/// `normalizeMarkdownTheme(value)`: `String(value)` when it names a theme
fn normalize_markdown_theme(value: Option<&serde_json::Value>) -> &'static str {
    let text = value_to_string(value);
    MARKDOWN_THEME_IDS
        .into_iter()
        .find(|id| *id == text)
        .unwrap_or("default")
}

/// `JSON.parse(await readFile(path, 'utf8'))`; `None` where either throws
fn read_json_file(path: &str) -> Option<JsonValue> {
    let bytes = std::fs::read(path).ok()?;
    json_parse(&String::from_utf8_lossy(&bytes)).ok()
}

fn get_markdown_theme(cx: &Ctx) -> IpcValue {
    let raw = read_json_file(&cx.user_data_file("markdown-settings.json"));
    // `raw?.markdownTheme`: only an object has the key
    let theme = match &raw {
        Some(JsonValue::Object(object)) => object.get("markdownTheme").cloned(),
        _ => None,
    };
    string(normalize_markdown_theme(
        theme.map(|t| jscompat::json_value_to_serde(&t)).as_ref(),
    ))
}

fn set_markdown_theme(cx: &Ctx, raw: &IpcValue) -> Reply {
    let normalized = normalize_markdown_theme(to_serde(raw).as_ref());
    let path = cx.user_data_file("markdown-settings.json");
    let file = match read_json_file(&path).unwrap_or(JsonValue::Object(Default::default())) {
        JsonValue::Object(mut object) => {
            object.set("markdownTheme", JsonValue::String(normalized.to_owned()));
            JsonValue::Object(object)
        }
        // a property set on an array is not written by JSON.stringify
        array @ JsonValue::Array(_) => array,
        JsonValue::Null => {
            return Err(type_error(
                "Cannot set properties of null (setting 'markdownTheme')".into(),
            ));
        }
        JsonValue::Bool(b) => return Err(primitive_property("boolean", &b.to_string())),
        JsonValue::Number(n) => return Err(primitive_property("number", &number_to_string(n))),
        JsonValue::String(s) => return Err(primitive_property("string", &s)),
    };
    atomic_write_file(&path, json_stringify_pretty(&file, 2).as_bytes()).map_err(node_error)?;
    Ok(string(normalized))
}

fn type_error(message: String) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message,
    }
}

/// What strict-mode code throws for `primitive.markdownTheme = ...`
fn primitive_property(kind: &str, text: &str) -> IpcError {
    type_error(format!(
        "Cannot create property 'markdownTheme' on {kind} '{text}'"
    ))
}

pub(crate) fn register(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let language = |cx: Rc<Ctx>| move |_: &_, _| Ok(string(lang_of(&cx).as_str()));
    invoke(registry, "app:get-language", language(cx.clone()))?;
    invoke(registry, "home:get-language", language(cx.clone()))?;
    let c = cx.clone();
    invoke(registry, "app:get-document-locale", move |_, _| {
        let requested = c.state.language(&*c.host, &c.settings_path()).requested;
        Ok(string(i18n::document_locale_for(Some(&requested))))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-language", move |_, args| {
        set_language(&c, arg(&args, 0))
    })?;

    let theme = |cx: Rc<Ctx>| move |_: &_, _| Ok(string(cx.state.theme(&cx.settings_path())));
    invoke(registry, "app:get-theme", theme(cx.clone()))?;
    invoke(registry, "home:get-theme", theme(cx.clone()))?;
    let c = cx.clone();
    invoke(registry, "home:set-theme", move |_, args| {
        set_theme(&c, arg(&args, 0))
    })?;

    let doc_theme =
        |cx: Rc<Ctx>| move |_: &_, _| Ok(string(cx.state.doc_theme(&cx.settings_path())));
    invoke(registry, "app:get-document-theme", doc_theme(cx.clone()))?;
    invoke(registry, "home:get-document-theme", doc_theme(cx.clone()))?;
    let c = cx.clone();
    invoke(registry, "home:set-document-theme", move |_, args| {
        set_document_theme(&c, arg(&args, 0))
    })?;

    let c = cx.clone();
    invoke(registry, "home:get-author-name", move |_, _| {
        let (value, fallback) = author_name_setting(&c);
        Ok(object([
            ("value", string(value)),
            ("fallback", string(fallback)),
        ]))
    })?;
    let c = cx.clone();
    invoke(registry, "app:get-author-name", move |_, _| {
        let (value, fallback) = author_name_setting(&c);
        Ok(string(if value.is_empty() { fallback } else { value }))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-author-name", move |_, args| {
        set_author_name(&c, arg(&args, 0))
    })?;
    let c = cx.clone();
    invoke(registry, "user:display-name", move |call, _| {
        if !c.docs.sheets_session(call.sender.view) {
            return Err(error("Untrusted IPC sender."));
        }
        let user_data = c.user_data().to_string_lossy().into_owned();
        Ok(string(configured_author_name(
            &user_data,
            c.host.username().as_deref(),
        )))
    })?;

    let c = cx.clone();
    invoke(registry, "app:get-auto-save-default", move |_, _| {
        let (on, updated_at) = c.state.auto_save_default(&c.settings_path());
        Ok(object([
            ("on", IpcValue::Bool(on)),
            ("updatedAt", IpcValue::Number(updated_at)),
        ]))
    })?;
    let c = cx.clone();
    invoke(registry, "app:get-csv-import-limit", move |_, _| {
        Ok(IpcValue::Number(csv_import_limit_mb(&read_app_settings(
            &c.settings_path(),
        ))))
    })?;

    let c = cx.clone();
    invoke(registry, "markdown:get-theme", move |_, _| {
        Ok(get_markdown_theme(&c))
    })?;
    let c = cx.clone();
    invoke(registry, "markdown:set-theme", move |_, args| {
        set_markdown_theme(&c, arg(&args, 0))
    })?;

    let c = cx.clone();
    invoke(registry, "docs:system-locale", move |_, _| {
        Ok(string(c.host.system_locale()))
    })?;

    let c = cx.clone();
    invoke(registry, "slides:open-font-settings", move |_, _| {
        if c.host.reveal_home()
            && let Some(view) = c.main_window.view()
        {
            c.emit(
                Target::View(view),
                "home:open-settings",
                vec![object([
                    ("section", string("general")),
                    ("field", string("slidesAiFonts")),
                ])],
            );
        }
        Ok(IpcValue::Undefined)
    })?;
    let c = cx.clone();
    invoke_later(
        registry,
        "slides:open-template-fonts-folder",
        move |_, _, reply| {
            let host = c.host.clone();
            let os = c.os.clone();
            c.services.workers.spawn(Box::new(move || {
                let folder = template_fonts_dir(&TemplateFonts(&*host));
                reply.reply(Ok(IpcValue::Bool(
                    os.open_path(std::path::Path::new(&folder)).is_empty(),
                )))
            }))
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use shell_contract::channels::Surface::{Docs, Markdown, Sheets, Shell, ShellQuickLook};
    use shell_contract::ipc::Target;
    use shell_contract::{IpcValue, ViewId};

    use crate::testkit::{Probe, sender};
    use crate::value::{object, string};

    fn probe(config: serde_json::Value) -> Probe {
        Probe::new(
            config,
            vec![sender(1, Shell), sender(2, Docs), sender(9, ShellQuickLook)],
        )
    }

    fn settings(p: &Probe) -> serde_json::Value {
        let text = std::fs::read_to_string(p.user_data().join("app-settings.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn the_language_settles_from_the_setting_then_the_app_locale() {
        let p = probe(json!({ "appLocale": "ko-KR" }));
        assert_eq!(
            p.call(sender(2, Docs), "app:get-language", vec![]),
            Ok(string("ko"))
        );
        assert_eq!(
            p.call(sender(2, Docs), "app:get-document-locale", vec![]),
            Ok(string("ko"))
        );

        let p = probe(json!({ "appLocale": "ko-KR" }));
        std::fs::write(
            p.user_data().join("app-settings.json"),
            r#"{"language":"en"}"#,
        )
        .unwrap();
        assert_eq!(
            p.call(sender(1, Shell), "home:get-language", vec![]),
            Ok(string("en"))
        );
    }

    #[test]
    fn setting_the_language_persists_rebuilds_menus_and_broadcasts_in_order() {
        let p = probe(json!({ "appLocale": "en-US" }));
        assert_eq!(
            p.call(sender(1, Shell), "home:set-language", vec![string("ko")]),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(settings(&p)["language"], "ko");
        assert_eq!(
            p.take_calls(),
            vec!["rebuildMenusForLanguage", "syncTrayMenu"]
        );
        let events = p.take_events();
        assert_eq!(
            events,
            vec![
                (
                    Target::Surface(ShellQuickLook),
                    "quick-look:lang-changed",
                    vec![string("ko")]
                ),
                (
                    Target::Surface(ShellQuickLook),
                    "quick-look:theme-changed",
                    vec![string("system")]
                ),
                (Target::All, "app:language-changed", vec![string("ko")]),
            ]
        );
        // the document locale follows the chosen language
        assert_eq!(
            p.call(sender(2, Docs), "app:get-document-locale", vec![]),
            Ok(string("ko"))
        );
    }

    #[test]
    fn an_unknown_or_unchanged_language_does_nothing() {
        let p = probe(json!({ "appLocale": "en-US" }));
        for lang in [
            string("en"),
            string("KO"),
            IpcValue::Number(1.0),
            IpcValue::Undefined,
        ] {
            assert_eq!(
                p.call(sender(1, Shell), "home:set-language", vec![lang]),
                Ok(IpcValue::Undefined)
            );
        }
        assert!(p.take_events().is_empty());
        assert!(!p.user_data().join("app-settings.json").exists());
    }

    #[test]
    fn a_failed_write_rejects_and_keeps_the_language() {
        let p = probe(json!({ "appLocale": "en-US" }));
        std::fs::create_dir_all(p.user_data().join("app-settings.json")).unwrap();
        let answer = p.call(sender(1, Shell), "home:set-language", vec![string("ko")]);
        assert!(answer.is_err(), "{answer:?}");
        assert!(p.take_events().is_empty());
        assert_eq!(
            p.call(sender(1, Shell), "app:get-language", vec![]),
            Ok(string("en"))
        );
    }

    #[test]
    fn the_theme_sets_the_native_theme_and_broadcasts() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(sender(2, Docs), "app:get-theme", vec![]),
            Ok(string("system"))
        );
        p.call(sender(1, Shell), "home:set-theme", vec![string("dark")])
            .unwrap();
        assert_eq!(settings(&p)["theme"], "dark");
        assert_eq!(
            p.take_calls(),
            vec![
                "nativeTheme.themeSource dark",
                "refreshTitleBarOverlay",
                "syncTrayMenu"
            ]
        );
        assert_eq!(
            p.take_events().last().unwrap(),
            &(Target::All, "app:theme-changed", vec![string("dark")])
        );
        assert_eq!(
            p.call(sender(1, Shell), "home:get-theme", vec![]),
            Ok(string("dark"))
        );
        // a theme outside the three is ignored
        p.call(sender(1, Shell), "home:set-theme", vec![string("follow")])
            .unwrap();
        assert!(p.take_events().is_empty());
    }

    #[test]
    fn the_document_theme_reads_follow_until_set() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(sender(2, Docs), "app:get-document-theme", vec![]),
            Ok(string("follow"))
        );
        p.call(
            sender(1, Shell),
            "home:set-document-theme",
            vec![string("light")],
        )
        .unwrap();
        assert_eq!(
            p.take_events(),
            vec![(
                Target::All,
                "app:document-theme-changed",
                vec![string("light")]
            )]
        );
        assert!(p.take_calls().is_empty(), "the native theme is untouched");
        assert_eq!(
            p.call(sender(1, Shell), "home:get-document-theme", vec![]),
            Ok(string("light"))
        );
    }

    #[test]
    fn the_author_name_falls_back_to_the_account_and_is_sanitized() {
        let p = probe(json!({ "username": "  kim  " }));
        assert_eq!(
            p.call(sender(2, Docs), "app:get-author-name", vec![]),
            Ok(string("kim"))
        );
        let answer = p.call(
            sender(1, Shell),
            "home:set-author-name",
            vec![string("  Lee \n  Ji  ")],
        );
        assert_eq!(
            answer,
            Ok(object([
                ("value", string("Lee Ji")),
                ("fallback", string("kim"))
            ]))
        );
        assert_eq!(
            p.take_events(),
            vec![(
                Target::All,
                "app:author-name-changed",
                vec![string("Lee Ji")]
            )]
        );
        // unchanged: no write, no event, the same answer
        p.call(
            sender(1, Shell),
            "home:set-author-name",
            vec![string("Lee Ji")],
        )
        .unwrap();
        assert!(p.take_events().is_empty());
        // a non-string clears it; the event carries the fallback
        p.call(
            sender(1, Shell),
            "home:set-author-name",
            vec![IpcValue::Null],
        )
        .unwrap();
        assert_eq!(
            p.take_events(),
            vec![(Target::All, "app:author-name-changed", vec![string("kim")])]
        );
        let p = probe(json!({ "username": null }));
        assert_eq!(
            p.call(sender(1, Shell), "home:get-author-name", vec![]),
            Ok(object([
                ("value", string("")),
                ("fallback", string("User"))
            ]))
        );
    }

    #[test]
    fn the_display_name_needs_a_sheets_tab() {
        let p = Probe::new(
            json!({ "username": "kim", "sheetsViews": [4] }),
            vec![sender(4, Sheets), sender(5, Sheets)],
        );
        assert_eq!(
            p.call(sender(4, Sheets), "user:display-name", vec![]),
            Ok(string("kim"))
        );
        let refused = p.call(sender(5, Sheets), "user:display-name", vec![]);
        assert_eq!(
            refused.unwrap_err().to_string(),
            "Error: Untrusted IPC sender."
        );
    }

    #[test]
    fn auto_save_and_csv_limit_read_the_file() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(sender(2, Docs), "app:get-auto-save-default", vec![]),
            Ok(object([
                ("on", IpcValue::Bool(false)),
                ("updatedAt", IpcValue::Number(0.0))
            ]))
        );
        assert_eq!(
            p.call(sender(2, Docs), "app:get-csv-import-limit", vec![]),
            Ok(IpcValue::Number(256.0))
        );
        std::fs::write(
            p.user_data().join("app-settings.json"),
            r#"{"autoSaveDefault":true,"autoSaveDefaultUpdatedAt":5,"csvImportLimitMb":64}"#,
        )
        .unwrap();
        assert_eq!(
            p.call(sender(2, Docs), "app:get-auto-save-default", vec![]),
            Ok(object([
                ("on", IpcValue::Bool(true)),
                ("updatedAt", IpcValue::Number(5.0))
            ]))
        );
        assert_eq!(
            p.call(sender(2, Docs), "app:get-csv-import-limit", vec![]),
            Ok(IpcValue::Number(64.0))
        );
    }

    #[test]
    fn the_markdown_theme_lives_in_its_own_file() {
        let p = probe(json!({}));
        let md = sender(3, Markdown);
        assert_eq!(
            p.call(md, "markdown:get-theme", vec![]),
            Ok(string("default"))
        );
        std::fs::write(
            p.user_data().join("markdown-settings.json"),
            r#"{"imageHost":null}"#,
        )
        .unwrap();
        assert_eq!(
            p.call(md, "markdown:set-theme", vec![string("nord")]),
            Ok(string("nord"))
        );
        assert_eq!(
            std::fs::read_to_string(p.user_data().join("markdown-settings.json")).unwrap(),
            "{\n  \"imageHost\": null,\n  \"markdownTheme\": \"nord\"\n}"
        );
        assert_eq!(p.call(md, "markdown:get-theme", vec![]), Ok(string("nord")));
        // String(['nord']) is 'nord'; anything else is the default, written
        assert_eq!(
            p.call(
                md,
                "markdown:set-theme",
                vec![IpcValue::Array(vec![string("nord")])]
            ),
            Ok(string("nord"))
        );
        assert_eq!(
            p.call(md, "markdown:set-theme", vec![string("sepia")]),
            Ok(string("default"))
        );
        assert_eq!(
            p.call(md, "markdown:get-theme", vec![]),
            Ok(string("default"))
        );
    }

    #[test]
    fn a_markdown_settings_file_that_is_not_an_object() {
        let p = probe(json!({}));
        let md = sender(3, Markdown);
        let file = p.user_data().join("markdown-settings.json");
        std::fs::write(&file, "null").unwrap();
        assert_eq!(
            p.call(md, "markdown:set-theme", vec![string("nord")])
                .unwrap_err()
                .to_string(),
            "TypeError: Cannot set properties of null (setting 'markdownTheme')"
        );
        std::fs::write(&file, "5").unwrap();
        assert_eq!(
            p.call(md, "markdown:set-theme", vec![string("nord")])
                .unwrap_err()
                .to_string(),
            "TypeError: Cannot create property 'markdownTheme' on number '5'"
        );
        std::fs::write(&file, "[1]").unwrap();
        assert_eq!(
            p.call(md, "markdown:set-theme", vec![string("nord")]),
            Ok(string("nord"))
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[\n  1\n]");
    }

    #[test]
    fn the_font_settings_open_on_the_home_tab() {
        let p = probe(json!({ "mainView": 1 }));
        assert_eq!(
            p.call(sender(2, Docs), "slides:open-font-settings", vec![]),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(
            p.take_events(),
            vec![(
                Target::View(ViewId(1)),
                "home:open-settings",
                vec![object([
                    ("section", string("general")),
                    ("field", string("slidesAiFonts"))
                ])]
            )]
        );
        let p = probe(json!({ "mainView": 1, "revealHome": false }));
        p.call(sender(2, Docs), "slides:open-font-settings", vec![])
            .unwrap();
        assert!(p.take_events().is_empty());
    }

    #[test]
    fn the_template_fonts_folder_answers_whether_it_opened() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(sender(2, Docs), "slides:open-template-fonts-folder", vec![]),
            Ok(IpcValue::Bool(true))
        );
        let p = probe(json!({ "openPath": "no app" }));
        assert_eq!(
            p.call(sender(2, Docs), "slides:open-template-fonts-folder", vec![]),
            Ok(IpcValue::Bool(false))
        );
        assert_eq!(
            p.call(sender(2, Docs), "docs:system-locale", vec![]),
            Ok(string("en-US"))
        );
    }
}
