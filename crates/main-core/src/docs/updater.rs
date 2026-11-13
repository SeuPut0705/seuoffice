//! `apps/docs/src/main/updater.ts`: full-package auto-update for the
//! standalone SeuOffice Docs app. Updates download silently in the background
//! and a single native dialog offers "Restart & Install" once the payload is
//! ready.
//!
//! The module's state (`started`, `dismissedVersion`) is a [`DocsUpdater`]
//! value. `electron-updater`, the timers, `app.isPackaged` and
//! `process.platform` stay with the caller: the updater and the timers as an
//! [`AutoUpdater`], the two values as parameters. The caller wires what
//! [`DocsUpdater::init`] registered: each `error` event to
//! [`DocsUpdater::on_error`], each `update-downloaded` to
//! [`DocsUpdater::on_update_downloaded`], and the timers to
//! [`DocsUpdater::check`]. `console.log('[docs-updater]', ...)` is `log`.

use jscompat::{JsObject, JsonValue};

use crate::packages::electron_utils::message_box::{
    MessageBox, MessageBoxOptions, ParentWindow, show_over_open_parent,
};
use crate::packages::i18n::{I18n, Lang, create_i18n};

/// `FIRST_CHECK_DELAY_MS`
pub const FIRST_CHECK_DELAY_MS: f64 = 15_000.0;
/// `RECHECK_INTERVAL_MS`
pub const RECHECK_INTERVAL_MS: f64 = 4.0 * 60.0 * 60.0 * 1000.0;

/// The tag `console.log` is given first.
pub const LOG_TAG: &str = "[docs-updater]";

/// `tUpd`: the dictionaries as `(key, en, ko)`; `en` defines the key set.
const UPDATER_STRINGS: [(&str, &str, &str); 5] = [
    (
        "updTitle",
        "Software Update",
        "\u{C18C}\u{D504}\u{D2B8}\u{C6E8}\u{C5B4} \u{C5C5}\u{B370}\u{C774}\u{D2B8}",
    ),
    (
        "updHeadline",
        "A new version is available",
        "\u{C0C8} \u{BC84}\u{C804}\u{C774} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "updDesc",
        "This update includes performance improvements and bug fixes. We recommend updating now.",
        "\u{C774} \u{C5C5}\u{B370}\u{C774}\u{D2B8}\u{C5D0}\u{B294} \u{C131}\u{B2A5} \u{AC1C}\u{C120}\u{ACFC} \u{BC84}\u{ADF8} \u{C218}\u{C815}\u{C774} \u{D3EC}\u{D568}\u{B418}\u{C5B4} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}. \u{C9C0}\u{AE08} \u{C5C5}\u{B370}\u{C774}\u{D2B8}\u{D558}\u{B294} \u{AC83}\u{C744} \u{AD8C}\u{C7A5}\u{D569}\u{B2C8}\u{B2E4}.",
    ),
    (
        "updInstall",
        "Restart & Install",
        "\u{B2E4}\u{C2DC} \u{C2DC}\u{C791} \u{BC0F} \u{C124}\u{CE58}",
    ),
    (
        "updLater",
        "Remind me later",
        "\u{B098}\u{C911}\u{C5D0} \u{C54C}\u{B9BC}",
    ),
];

fn translator() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in UPDATER_STRINGS {
        en.set(key, en_text.to_owned());
        ko.set(key, ko_text.to_owned());
    }
    create_i18n(en, ko)
}

/// What a call of `electron-updater` threw or rejected with: an `Error`
/// (logged by its message) or any other value (logged as it is).
#[derive(Debug, Clone, PartialEq)]
pub enum Thrown {
    Error(String),
    Value(JsonValue),
}

impl Thrown {
    fn logged(&self) -> JsonValue {
        match self {
            Thrown::Error(message) => JsonValue::String(message.clone()),
            Thrown::Value(value) => value.clone(),
        }
    }
}

/// `autoUpdater` and the timers, as far as the module uses them.
pub trait AutoUpdater {
    fn set_auto_download(&mut self, on: bool);
    fn set_auto_install_on_app_quit(&mut self, on: bool);
    fn set_disable_differential_download(&mut self, on: bool);
    /// `autoUpdater.on('error', ...)`
    fn on_error(&mut self);
    /// `autoUpdater.on('update-downloaded', ...)`
    fn on_update_downloaded(&mut self);
    /// `autoUpdater.quitAndInstall(isSilent, isForceRunAfter)`
    fn quit_and_install(&mut self, is_silent: bool, is_force_run_after: bool);
    /// `autoUpdater.checkForUpdates()`: `Err` is a rejection
    fn check_for_updates(&mut self) -> Result<(), Thrown>;
    /// `setTimeout(check, ms)`
    fn set_timeout(&mut self, ms: f64);
    /// `setInterval(check, ms)`
    fn set_interval(&mut self, ms: f64);
}

fn tagged(args: Vec<JsonValue>) -> Vec<JsonValue> {
    let mut line = vec![JsonValue::String(LOG_TAG.to_owned())];
    line.extend(args);
    line
}

/// `started` and `dismissedVersion`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocsUpdater {
    started: bool,
    /// version the user declined this session: no nagging until next launch
    dismissed_version: Option<String>,
}

impl DocsUpdater {
    pub fn new() -> Self {
        Self::default()
    }

    /// `initDocsAutoUpdater(getWindow)`, without the `getWindow` it keeps for
    /// [`DocsUpdater::on_update_downloaded`].
    ///
    /// Unpacked runs have no app-update.yml and must not ask the feed with a
    /// dev version. Windows updates via NSIS; macOS via the zip target.
    pub fn init(&mut self, is_packaged: bool, platform: &str, updater: &mut dyn AutoUpdater) {
        if self.started {
            return;
        }
        self.started = true;
        if !is_packaged {
            return;
        }
        if platform != "win32" && platform != "darwin" {
            return;
        }
        updater.set_auto_download(true);
        updater.set_auto_install_on_app_quit(true);
        // full-package policy: never attempt blockmap differential downloads
        updater.set_disable_differential_download(true);
        updater.on_error();
        updater.on_update_downloaded();
        updater.set_timeout(FIRST_CHECK_DELAY_MS);
        updater.set_interval(RECHECK_INTERVAL_MS);
    }

    /// The `error` listener: background failures are expected offline; log only.
    pub fn on_error(&self, error: &Thrown, log: &mut dyn FnMut(Vec<JsonValue>)) {
        log(tagged(vec![
            JsonValue::String("error:".to_owned()),
            error.logged(),
        ]));
    }

    /// The `update-downloaded` listener: `get_window` is `getWindow()`, read
    /// after the line is logged; `lang` is `getUiLang()`.
    pub fn on_update_downloaded<W, D>(
        &mut self,
        version: &str,
        lang: Lang,
        get_window: &mut dyn FnMut() -> Option<W>,
        dialog: &D,
        updater: &mut dyn AutoUpdater,
        log: &mut dyn FnMut(Vec<JsonValue>),
    ) where
        W: ParentWindow,
        D: MessageBox<W> + ?Sized,
    {
        if self.dismissed_version.as_deref() == Some(version) {
            return;
        }
        log(tagged(vec![
            JsonValue::String("downloaded:".to_owned()),
            JsonValue::String(version.to_owned()),
        ]));
        let window = get_window();
        self.prompt_install(window.as_ref(), version, lang, dialog, updater);
    }

    fn prompt_install<W, D>(
        &mut self,
        window: Option<&W>,
        version: &str,
        lang: Lang,
        dialog: &D,
        updater: &mut dyn AutoUpdater,
    ) where
        W: ParentWindow,
        D: MessageBox<W> + ?Sized,
    {
        let t = translator();
        let options = MessageBoxOptions {
            kind: "info",
            title: Some(t.t(lang, "updTitle", None)),
            message: format!("{} ({version})", t.t(lang, "updHeadline", None)),
            detail: Some(t.t(lang, "updDesc", None)),
            buttons: vec![t.t(lang, "updInstall", None), t.t(lang, "updLater", None)],
            default_id: 0,
            cancel_id: Some(1),
            no_link: None,
        };
        let response = show_over_open_parent(dialog, window, &options);
        if response == 0.0 {
            updater.quit_and_install(true, true);
        } else {
            // autoInstallOnAppQuit still applies the update on normal quit
            self.dismissed_version = Some(version.to_owned());
        }
    }

    /// `check()`: what the first timer and the interval run.
    pub fn check(updater: &mut dyn AutoUpdater, log: &mut dyn FnMut(Vec<JsonValue>)) {
        if let Err(error) = updater.check_for_updates() {
            log(tagged(vec![
                JsonValue::String("check failed:".to_owned()),
                error.logged(),
            ]));
        }
    }
}
