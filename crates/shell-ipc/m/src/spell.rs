//! The docs renderer's spellcheck and context-menu channels
//! (`registerDocsIpc` in apps/docs/src/main/docs-main.ts): the claim/arm
//! protocol that lets the renderer draw its own right-click menu, the
//! session-long "Ignore All" journal, and the spellchecker languages.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::rc::Rc;

use jscompat::{JsonValue, to_iso_string, trim};
use main_core::packages::electron_utils::atomic_write::write_json_atomic;
use main_core::packages::electron_utils::context_menu::{
    ContextMenuParams, MenuCommand, VIEW_IMAGE_CHANNEL,
};
use shell_contract::ipc::{RegisterError, Registry, Target};
use shell_contract::runtime::Services;
use shell_contract::{IpcError, IpcValue, ViewId};

use crate::Ctx;
use crate::handler::{error, invoke, invoke_later, send, send_sync};
use crate::hosts::{KeyInput, MHost, MHostRef, PeersRef};
use crate::state::{MState, MStateRef};
use crate::value::{arg, as_str, object, string, strings};

const JOURNAL_FILE: &str = "spell-ignored.json";
const DIAG_FILE: &str = "spell-diag.log";
/// `statSync(path).size > 256 * 1024` restarts the log
const DIAG_MAX_BYTES: u64 = 256 * 1024;
/// `.slice(-128 * 1024)`, counted in UTF-16 units as JavaScript counts
const DIAG_KEEP_UNITS: usize = 128 * 1024;
/// `line.length > 500`
const DIAG_MAX_LINE_UNITS: usize = 500;
/// the pause `docs:respell-kick` waits for the input pipeline
const RESPELL_DELAY_MS: u64 = 120;

/// `journalIgnoredWords()`: `writeJsonAtomic(SPELL_IGNORED_PATH(), [...spellIgnored.keys()])`
fn write_journal(path: &str, words: &[String]) -> Result<(), IpcError> {
    let array = JsonValue::Array(words.iter().cloned().map(JsonValue::String).collect());
    write_json_atomic(path, &array).map_err(|e| error(e.message))
}

/// The word-release half of `releaseSpellIgnores(wcId)`. The journal error is
/// dropped: the TypeScript threw it out of a `destroyed` listener, where
/// nothing could catch it.
fn release_view(host: &dyn MHost, state: &MState, journal: &str, view: ViewId) {
    let released = state.view_destroyed(view);
    if released.is_empty() {
        return;
    }
    for word in &released {
        host.spell_remove_word(word);
    }
    let _ = write_journal(journal, &state.spell_ignored_words());
}

/// The `docs:context-menu-arm` interceptor, called by the shell's
/// `context-menu` hook before it pops the native menu. True suppresses the
/// native menu: the renderer got the click's data and draws its own.
pub fn intercept_context_menu(
    services: &Services,
    view: ViewId,
    params: &ContextMenuParams,
) -> bool {
    let (Some(state), Some(host), Some(peers)) = (
        services.hosts.get::<MStateRef>(),
        services.hosts.get::<MHostRef>(),
        services.hosts.get::<PeersRef>(),
    ) else {
        return false;
    };
    if peers.docs_torn_down(view) || services.views.sender_of(view).is_none() {
        return false;
    }
    let Some(seq) = state.take_context_menu_claim(view, host.now_ms()) else {
        return false;
    };
    let request = object([
        ("seq", IpcValue::Number(seq)),
        ("misspelledWord", string(&params.misspelled_word)),
        ("suggestions", strings(&params.dictionary_suggestions)),
    ]);
    services
        .events
        .emit(Target::View(view), "docs:context-menu", vec![request]);
    true
}

/// What `popupMenu`'s click handlers did through IPC or the spellchecker;
/// the commands that need the shell (copy image, save image, edit actions)
/// come back for it to carry out.
pub fn context_menu_command(
    services: &Services,
    view: ViewId,
    command: MenuCommand,
) -> Option<MenuCommand> {
    match command {
        MenuCommand::ViewImage(src) => {
            let src = src.map_or(IpcValue::Undefined, IpcValue::String);
            services
                .events
                .emit(Target::View(view), VIEW_IMAGE_CHANNEL, vec![src]);
            None
        }
        MenuCommand::ReplaceMisspelling(word) => {
            if let Some(host) = services.hosts.get::<MHostRef>() {
                host.replace_misspelling(view, &word);
            }
            None
        }
        other => Some(other),
    }
}

/// `docs:spell-diag`: append one line to the size-capped trace. Every
/// failure is swallowed, as the TypeScript's `catch {}` did.
fn append_diag(path: &str, line: &str, now_ms: f64) {
    let _ = (|| -> Option<()> {
        if fs::metadata(path).is_ok_and(|m| m.len() > DIAG_MAX_BYTES) {
            let bytes = fs::read(path).ok()?;
            let units: Vec<u16> = String::from_utf8_lossy(&bytes).encode_utf16().collect();
            let tail = &units[units.len().saturating_sub(DIAG_KEEP_UNITS)..];
            // indexOf('\n') + 1: drops the first, probably partial, line; -1 keeps all
            let from = tail.iter().position(|&u| u == 10).map_or(0, |i| i + 1);
            fs::write(path, String::from_utf16_lossy(&tail[from..])).ok()?;
        }
        // toISOString throws on an invalid date, after the truncation
        let stamp = to_iso_string(now_ms)?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .ok()?;
        file.write_all(format!("{stamp} {line}\n").as_bytes()).ok()
    })();
}

fn languages(host: &dyn MHost, view: ViewId, available: &[String]) -> IpcValue {
    object([
        ("active", strings(host.spell_languages(view))),
        ("available", strings(available)),
    ])
}

pub(crate) fn register(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let journal = cx.user_data_file(JOURNAL_FILE);

    // a crash leaves ignored words in the dictionary; the journal names them
    let orphans = fs::read(&journal)
        .ok()
        .and_then(|bytes| jscompat::json_parse(&String::from_utf8_lossy(&bytes)).ok());
    if let Some(JsonValue::Array(items)) = &orphans {
        for word in items {
            if let JsonValue::String(word) = word {
                cx.host.spell_remove_word(word);
            }
        }
        if !items.is_empty() {
            let _ = write_journal(&journal, &cx.state.spell_ignored_words());
        }
    }

    {
        let host = cx.host.clone();
        let state = cx.state.clone();
        let journal = journal.clone();
        cx.services.views.on_destroyed(Box::new(move |view| {
            release_view(&*host, &state, &journal, view)
        }));
    }

    send(registry, "docs:spell-diag", {
        let cx = cx.clone();
        move |_, args| {
            let Some(line) = as_str(arg(&args, 0)) else {
                return;
            };
            if line.encode_utf16().count() > DIAG_MAX_LINE_UNITS {
                return;
            }
            append_diag(&cx.user_data_file(DIAG_FILE), line, cx.host.now_ms());
        }
    })?;

    send_sync(registry, "docs:context-menu-claim", {
        let cx = cx.clone();
        move |call, args| {
            // answered first in the TypeScript, whatever the argument
            if let IpcValue::Number(seq) = arg(&args, 0) {
                cx.state
                    .claim_context_menu(call.sender.view, *seq, cx.host.now_ms());
            }
            IpcValue::Bool(true)
        }
    })?;

    send(registry, "docs:context-menu-arm", {
        let cx = cx.clone();
        move |call, _| cx.state.arm_context_menu(call.sender.view)
    })?;

    invoke(registry, "docs:spell-ignore-word", {
        let cx = cx.clone();
        let journal = journal.clone();
        move |call, args| {
            let Some(word) = as_str(arg(&args, 0)) else {
                return Ok(IpcValue::Bool(false));
            };
            let word = trim(word);
            if word.is_empty() {
                return Ok(IpcValue::Bool(false));
            }
            let view = call.sender.view;
            // a word nobody ignored yet goes to the journal before it joins the dictionary
            if cx.state.spell_ignore(word, view) {
                write_journal(&journal, &cx.state.spell_ignored_words())?;
            }
            Ok(IpcValue::Bool(cx.host.spell_add_word(view, word)))
        }
    })?;

    invoke(registry, "docs:spell-add-word", {
        let cx = cx.clone();
        let journal = journal.clone();
        move |call, args| {
            let Some(word) = as_str(arg(&args, 0)) else {
                return Ok(IpcValue::Bool(false));
            };
            let word = trim(word);
            if word.is_empty() {
                return Ok(IpcValue::Bool(false));
            }
            // promoted to a permanent word: no longer released when the tab closes
            if cx.state.spell_unignore(word) {
                write_journal(&journal, &cx.state.spell_ignored_words())?;
            }
            Ok(IpcValue::Bool(
                cx.host.spell_add_word(call.sender.view, word),
            ))
        }
    })?;

    invoke(registry, "docs:spell-replace", {
        let cx = cx.clone();
        move |call, args| {
            if let Some(word) = as_str(arg(&args, 0)).filter(|w| !w.is_empty()) {
                cx.host.replace_misspelling(call.sender.view, word);
            }
            Ok(IpcValue::Undefined)
        }
    })?;

    invoke(registry, "docs:spell-languages", {
        let cx = cx.clone();
        move |call, _| {
            let view = call.sender.view;
            let available = cx.host.spell_available_languages(view);
            Ok(languages(&*cx.host, view, &available))
        }
    })?;

    invoke(registry, "docs:spell-set-languages", {
        let cx = cx.clone();
        move |call, args| {
            let view = call.sender.view;
            // `new Set(...)`: first occurrence order, duplicates dropped
            let mut available: Vec<String> = Vec::new();
            for language in cx.host.spell_available_languages(view) {
                if !available.contains(&language) {
                    available.push(language);
                }
            }
            let next: Vec<String> = match arg(&args, 0) {
                IpcValue::Array(items) => items
                    .iter()
                    .filter_map(as_str)
                    .filter(|l| available.iter().any(|a| a == l))
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            };
            if !next.is_empty() {
                cx.host.spell_set_languages(view, &next);
            }
            Ok(languages(&*cx.host, view, &available))
        }
    })?;

    invoke_later(registry, "docs:respell-kick", {
        let cx = cx.clone();
        move |call, _, reply| {
            let view = call.sender.view;
            if cx.peers.docs_torn_down(view) || cx.services.views.sender_of(view).is_none() {
                return reply.reply(Ok(IpcValue::Undefined));
            }
            cx.contents.focus(view);
            // Blink only respells after a user activation, and only a keydown grants one
            for input in [KeyInput::KeyDown, KeyInput::Char, KeyInput::KeyUp] {
                cx.host.send_space(view, input);
            }
            // answer once the input pipeline has delivered the keystroke
            cx.services.workers.spawn(Box::new(move || {
                std::thread::sleep(std::time::Duration::from_millis(RESPELL_DELAY_MS));
                reply.reply(Ok(IpcValue::Undefined))
            }));
        }
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use shell_contract::channels::Surface;

    use super::*;
    use crate::testkit::{Probe, sender};

    const NOW: f64 = 1_700_000_000_000.0;

    fn docs(n: u32) -> shell_contract::ipc::Sender {
        sender(n, Surface::Docs)
    }

    fn probe(config: serde_json::Value) -> Probe {
        Probe::new(config, vec![docs(1), docs(2)])
    }

    fn text(value: &str) -> IpcValue {
        IpcValue::String(value.to_owned())
    }

    fn params(word: &str, suggestions: &[&str]) -> ContextMenuParams {
        ContextMenuParams {
            misspelled_word: word.to_owned(),
            dictionary_suggestions: suggestions.iter().map(|s| (*s).to_owned()).collect(),
            ..Default::default()
        }
    }

    fn journal(probe: &Probe) -> String {
        std::fs::read_to_string(probe.user_data().join("spell-ignored.json")).unwrap()
    }

    fn state(probe: &Probe) -> &MStateRef {
        probe.services.hosts.get::<MStateRef>().unwrap()
    }

    #[test]
    fn a_claimed_click_of_an_armed_view_is_forwarded_and_the_native_menu_suppressed() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(
                docs(1),
                "docs:context-menu-claim",
                vec![IpcValue::Number(7.0)]
            ),
            Ok(IpcValue::Bool(true))
        );
        p.call(docs(1), "docs:context-menu-arm", vec![]).unwrap();
        assert!(intercept_context_menu(
            &p.services,
            ViewId(1),
            &params("teh", &["the", "ten"])
        ));
        assert_eq!(
            p.take_events(),
            vec![(
                Target::View(ViewId(1)),
                "docs:context-menu",
                vec![object([
                    ("seq", IpcValue::Number(7.0)),
                    ("misspelledWord", text("teh")),
                    ("suggestions", strings(["the", "ten"])),
                ])]
            )]
        );
        // the claim is spent: the next right-click is the native menu's
        assert!(!intercept_context_menu(
            &p.services,
            ViewId(1),
            &params("", &[])
        ));
        assert!(p.take_events().is_empty());
    }

    #[test]
    fn claims_are_taken_oldest_first_and_a_non_number_claim_is_still_answered() {
        let p = probe(json!({}));
        p.call(docs(1), "docs:context-menu-arm", vec![]).unwrap();
        for seq in [1.0, 2.0] {
            p.call(
                docs(1),
                "docs:context-menu-claim",
                vec![IpcValue::Number(seq)],
            )
            .unwrap();
        }
        assert_eq!(
            p.call(docs(1), "docs:context-menu-claim", vec![text("3")]),
            Ok(IpcValue::Bool(true))
        );
        for expected in [1.0, 2.0] {
            assert!(intercept_context_menu(
                &p.services,
                ViewId(1),
                &params("", &[])
            ));
            let events = p.take_events();
            assert_eq!(
                events[0].2,
                vec![object([
                    ("seq", IpcValue::Number(expected)),
                    ("misspelledWord", text("")),
                    ("suggestions", strings(Vec::<String>::new())),
                ])]
            );
        }
        assert!(!intercept_context_menu(
            &p.services,
            ViewId(1),
            &params("", &[])
        ));
    }

    #[test]
    fn a_claim_older_than_two_seconds_or_of_an_unarmed_view_shows_the_native_menu() {
        let p = probe(json!({ "now": NOW }));
        p.call(docs(1), "docs:context-menu-arm", vec![]).unwrap();
        state(&p).claim_context_menu(ViewId(1), 1.0, NOW - 2001.0);
        assert!(!intercept_context_menu(
            &p.services,
            ViewId(1),
            &params("", &[])
        ));
        // exactly 2 s old is still live
        state(&p).claim_context_menu(ViewId(1), 2.0, NOW - 2000.0);
        assert!(intercept_context_menu(
            &p.services,
            ViewId(1),
            &params("", &[])
        ));
        // view 2 claimed without arming
        p.call(
            docs(2),
            "docs:context-menu-claim",
            vec![IpcValue::Number(3.0)],
        )
        .unwrap();
        assert!(!intercept_context_menu(
            &p.services,
            ViewId(2),
            &params("", &[])
        ));
    }

    #[test]
    fn a_torn_down_or_gone_view_is_never_intercepted() {
        let p = probe(json!({ "tornDown": [1] }));
        for view in [1, 2] {
            p.call(docs(view), "docs:context-menu-arm", vec![]).unwrap();
            p.call(
                docs(view),
                "docs:context-menu-claim",
                vec![IpcValue::Number(1.0)],
            )
            .unwrap();
        }
        assert!(!intercept_context_menu(
            &p.services,
            ViewId(1),
            &params("", &[])
        ));
        // view 9 is not among the shell's views
        state(&p).arm_context_menu(ViewId(9));
        state(&p).claim_context_menu(ViewId(9), 1.0, NOW);
        assert!(!intercept_context_menu(
            &p.services,
            ViewId(9),
            &params("", &[])
        ));
        assert!(intercept_context_menu(
            &p.services,
            ViewId(2),
            &params("", &[])
        ));
    }

    #[test]
    fn context_menu_commands_split_between_ipc_and_the_shell() {
        let p = probe(json!({}));
        assert_eq!(
            context_menu_command(
                &p.services,
                ViewId(1),
                MenuCommand::ViewImage(Some("x.png".into()))
            ),
            None
        );
        assert_eq!(
            context_menu_command(&p.services, ViewId(1), MenuCommand::ViewImage(None)),
            None
        );
        assert_eq!(
            p.take_events(),
            vec![
                (
                    Target::View(ViewId(1)),
                    "seuoffice:view-image",
                    vec![text("x.png")]
                ),
                (
                    Target::View(ViewId(1)),
                    "seuoffice:view-image",
                    vec![IpcValue::Undefined]
                ),
            ]
        );
        assert_eq!(
            context_menu_command(
                &p.services,
                ViewId(2),
                MenuCommand::ReplaceMisspelling("the".into())
            ),
            None
        );
        assert_eq!(p.take_calls(), vec!["replaceMisspelling 2 the"]);
        let copy = MenuCommand::CopyImageAt { x: 1.0, y: 2.0 };
        assert_eq!(
            context_menu_command(&p.services, ViewId(1), copy.clone()),
            Some(copy)
        );
    }

    #[test]
    fn ignore_journals_new_words_and_the_last_closing_view_releases_them() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(docs(1), "docs:spell-ignore-word", vec![text("  qwx ")]),
            Ok(IpcValue::Bool(true))
        );
        assert_eq!(journal(&p), "[\n  \"qwx\"\n]");
        p.call(docs(2), "docs:spell-ignore-word", vec![text("qwx")])
            .unwrap();
        p.call(docs(2), "docs:spell-ignore-word", vec![text("zzv")])
            .unwrap();
        assert_eq!(journal(&p), "[\n  \"qwx\",\n  \"zzv\"\n]");
        assert_eq!(
            p.take_calls(),
            vec!["addWord 1 qwx", "addWord 2 qwx", "addWord 2 zzv"]
        );

        release_view(
            &*p.fake,
            state(&p),
            &p.user_data().join("spell-ignored.json").to_string_lossy(),
            ViewId(2),
        );
        // qwx is still held by view 1; only zzv leaves
        assert_eq!(p.take_calls(), vec!["removeWord zzv"]);
        assert_eq!(journal(&p), "[\n  \"qwx\"\n]");
        release_view(
            &*p.fake,
            state(&p),
            &p.user_data().join("spell-ignored.json").to_string_lossy(),
            ViewId(1),
        );
        assert_eq!(p.take_calls(), vec!["removeWord qwx"]);
        assert_eq!(journal(&p), "[]");
    }

    #[test]
    fn ignore_and_add_refuse_blank_and_non_string_words() {
        let p = probe(json!({}));
        for channel in ["docs:spell-ignore-word", "docs:spell-add-word"] {
            for word in [
                text(""),
                text(" \u{feff}\t"),
                IpcValue::Number(1.0),
                IpcValue::Undefined,
            ] {
                assert_eq!(
                    p.call(docs(1), channel, vec![word]),
                    Ok(IpcValue::Bool(false))
                );
            }
        }
        assert!(p.take_calls().is_empty());
        assert!(!p.user_data().join("spell-ignored.json").exists());
    }

    #[test]
    fn adding_an_ignored_word_makes_it_permanent() {
        let p = probe(json!({ "addWord": false }));
        p.call(docs(1), "docs:spell-ignore-word", vec![text("qwx")])
            .unwrap();
        // the host's answer is the handler's answer
        assert_eq!(
            p.call(docs(1), "docs:spell-add-word", vec![text(" qwx")]),
            Ok(IpcValue::Bool(false))
        );
        assert_eq!(journal(&p), "[]");
        p.take_calls();
        release_view(
            &*p.fake,
            state(&p),
            &p.user_data().join("spell-ignored.json").to_string_lossy(),
            ViewId(1),
        );
        assert!(p.take_calls().is_empty());
        // adding a word nobody ignored leaves the journal alone
        p.call(docs(1), "docs:spell-add-word", vec![text("other")])
            .unwrap();
        assert_eq!(journal(&p), "[]");
    }

    #[test]
    fn start_up_scrubs_the_words_a_crash_left_in_the_dictionary() {
        // the folder exists before register runs: build the shell on a prepared journal
        let first = probe(json!({}));
        let dir = first.user_data();
        std::fs::write(dir.join("spell-ignored.json"), "[\"aaa\", \"bbb\", 3]").unwrap();
        let mut registry = crate::testkit::FakeRegistry::default();
        crate::register(&mut registry, &first.services).unwrap();
        let removed: Vec<String> = first
            .take_calls()
            .into_iter()
            .filter(|c| c.starts_with("removeWord"))
            .collect();
        assert_eq!(removed, vec!["removeWord aaa", "removeWord bbb"]);
        // rewritten with what this process holds: nothing
        assert_eq!(journal(&first), "[]");
    }

    #[test]
    fn replace_needs_a_non_empty_string() {
        let p = probe(json!({}));
        assert_eq!(
            p.call(docs(2), "docs:spell-replace", vec![text("the ")]),
            Ok(IpcValue::Undefined)
        );
        for word in [text(""), IpcValue::Null, IpcValue::Number(2.0)] {
            assert_eq!(
                p.call(docs(2), "docs:spell-replace", vec![word]),
                Ok(IpcValue::Undefined)
            );
        }
        // not trimmed
        assert_eq!(p.take_calls(), vec!["replaceMisspelling 2 the "]);
    }

    #[test]
    fn languages_report_the_session_and_set_keeps_only_available_strings() {
        let p = probe(
            json!({ "spellLanguages": ["en-US"], "spellAvailable": ["en-US", "ko", "en-US"] }),
        );
        let report = |active: &[&str], available: &[&str]| {
            Ok(object([
                ("active", strings(active)),
                ("available", strings(available)),
            ]))
        };
        assert_eq!(
            p.call(docs(1), "docs:spell-languages", vec![]),
            report(&["en-US"], &["en-US", "ko", "en-US"])
        );
        // duplicates pass through the filter; `available` is the deduped Set
        let langs = IpcValue::Array(vec![
            text("ko"),
            text("xx"),
            IpcValue::Number(1.0),
            text("ko"),
        ]);
        assert_eq!(
            p.call(docs(1), "docs:spell-set-languages", vec![langs]),
            report(&["ko", "ko"], &["en-US", "ko"])
        );
        // nothing valid: no change
        for bad in [
            IpcValue::Array(vec![text("xx")]),
            text("ko"),
            IpcValue::Undefined,
        ] {
            assert_eq!(
                p.call(docs(1), "docs:spell-set-languages", vec![bad]),
                report(&["ko", "ko"], &["en-US", "ko"])
            );
        }
        // the fake keeps the language set in its call log: one set, no later ones
        assert_eq!(p.take_calls(), vec!["setLanguages ko,ko"]);
    }

    fn diag_path(p: &Probe) -> std::path::PathBuf {
        p.user_data().join("spell-diag.log")
    }

    #[test]
    fn diag_appends_stamped_lines_and_drops_long_or_non_string_ones() {
        let p = probe(json!({ "now": 1_700_000_000_123u64 }));
        p.call(docs(1), "docs:spell-diag", vec![text("toggle on")])
            .unwrap();
        p.call(docs(1), "docs:spell-diag", vec![text("kick")])
            .unwrap();
        p.call(docs(1), "docs:spell-diag", vec![IpcValue::Number(1.0)])
            .unwrap();
        p.call(docs(1), "docs:spell-diag", vec![text(&"x".repeat(501))])
            .unwrap();
        // 500 UTF-16 units of astral characters is 250 chars: kept; 501 units: dropped
        p.call(
            docs(1),
            "docs:spell-diag",
            vec![text(&"\u{1F600}".repeat(250))],
        )
        .unwrap();
        p.call(docs(1), "docs:spell-diag", vec![text(&"a".repeat(250))])
            .unwrap();
        let log = std::fs::read_to_string(diag_path(&p)).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines[0], "2023-11-14T22:13:20.123Z toggle on");
        assert_eq!(lines[1], "2023-11-14T22:13:20.123Z kick");
        assert_eq!(lines.len(), 4);
        assert!(lines[2].ends_with(&"\u{1F600}".repeat(250)));
    }

    #[test]
    fn diag_over_256_kib_restarts_from_the_last_half_without_the_partial_line() {
        let p = probe(json!({ "now": 0 }));
        // 'é' is 2 bytes and 1 unit: 2 * 140_000 bytes > 256 KiB, then a newline-bounded tail
        let mut old = "é".repeat(140_000);
        old.push('\n');
        old.push_str("last line\n");
        std::fs::write(diag_path(&p), &old).unwrap();
        p.call(docs(1), "docs:spell-diag", vec![text("fresh")])
            .unwrap();
        let log = std::fs::read_to_string(diag_path(&p)).unwrap();
        // the 128 Ki-unit tail starts inside the long line, which is dropped whole
        assert_eq!(log, "last line\n1970-01-01T00:00:00.000Z fresh\n");

        // at or under the cap nothing is cut
        let small = "y".repeat(256 * 1024);
        std::fs::write(diag_path(&p), &small).unwrap();
        p.call(docs(1), "docs:spell-diag", vec![text("fresh")])
            .unwrap();
        let log = std::fs::read_to_string(diag_path(&p)).unwrap();
        assert_eq!(
            log.len(),
            small.len() + "1970-01-01T00:00:00.000Z fresh\n".len()
        );
    }

    #[test]
    fn diag_over_the_cap_without_a_newline_keeps_the_whole_tail() {
        let p = probe(json!({ "now": 0 }));
        std::fs::write(diag_path(&p), "z".repeat(256 * 1024 + 1)).unwrap();
        p.call(docs(1), "docs:spell-diag", vec![text("a")]).unwrap();
        let log = std::fs::read_to_string(diag_path(&p)).unwrap();
        assert_eq!(
            log,
            format!("{}1970-01-01T00:00:00.000Z a\n", "z".repeat(128 * 1024))
        );
    }

    #[test]
    fn respell_kick_types_one_space_and_answers_after_the_pause() {
        let p = probe(json!({}));
        let started = std::time::Instant::now();
        assert_eq!(
            p.call(docs(1), "docs:respell-kick", vec![]),
            Ok(IpcValue::Undefined)
        );
        assert!(started.elapsed() >= std::time::Duration::from_millis(120));
        assert_eq!(
            p.take_calls(),
            vec![
                "focus 1",
                "sendInput 1 KeyDown",
                "sendInput 1 Char",
                "sendInput 1 KeyUp"
            ]
        );
    }

    #[test]
    fn respell_kick_does_nothing_for_a_torn_down_or_gone_view() {
        let p = probe(json!({ "tornDown": [1] }));
        assert_eq!(
            p.call(docs(1), "docs:respell-kick", vec![]),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(
            p.call(sender(9, Surface::Docs), "docs:respell-kick", vec![]),
            Ok(IpcValue::Undefined)
        );
        assert!(p.take_calls().is_empty());
    }
}
