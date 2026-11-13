//! `packages/electron-utils/src/app-menu.ts`: localized replacements for
//! Electron's role menus, whose built-in labels are English only and (for
//! `role: 'windowMenu'` on Windows and Linux) follow macOS conventions.
//!
//! The templates are values ([`MenuItem`]); what a click does is a
//! [`MenuClick`] the caller carries out with Electron. The two invokers the
//! TypeScript keeps in module variables (the shell's update check and its
//! Settings view) stay with the caller; the About box asks whether the
//! update check is there. The window an app's own entry belongs to is the
//! caller's type `C`.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

use super::context_menu::{ContextMenuLabels, base_lang, context_menu_labels};
use super::message_box::MessageBoxOptions;
use crate::packages::i18n::{PRODUCT_NAME, product_name};

/// The labels `appMenuLabels` adds to the context menu's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Labels {
    window: &'static str,
    minimize: &'static str,
    close_window: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    delete: &'static str,
    view: &'static str,
    reload: &'static str,
    force_reload: &'static str,
    toggle_dev_tools: &'static str,
    actual_size: &'static str,
    zoom_in: &'static str,
    zoom_out: &'static str,
    fullscreen: &'static str,
    help: &'static str,
    about: &'static str,
    check_updates: &'static str,
    version: &'static str,
    settings: &'static str,
    name_with_ai: &'static str,
    /// the Korean table writes `nameWithAi` before `settings`
    name_with_ai_first: bool,
}

const EN: Labels = Labels {
    window: "Window",
    minimize: "Minimize",
    close_window: "Close Window",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    delete: "Delete",
    view: "View",
    reload: "Reload",
    force_reload: "Force Reload",
    toggle_dev_tools: "Developer Tools",
    actual_size: "Actual Size",
    zoom_in: "Zoom In",
    zoom_out: "Zoom Out",
    fullscreen: "Full Screen",
    help: "Help",
    about: "About SeuOffice",
    check_updates: "Check for Updates\u{2026}",
    version: "Version",
    settings: "Settings\u{2026}",
    name_with_ai: "Name with AI\u{2026}",
    name_with_ai_first: false,
};

const KO: Labels = Labels {
    window: "\u{CC3D}",
    minimize: "\u{CD5C}\u{C18C}\u{D654}",
    close_window: "\u{CC3D} \u{B2EB}\u{AE30}",
    edit: "\u{D3B8}\u{C9D1}",
    undo: "\u{C2E4}\u{D589} \u{CDE8}\u{C18C}",
    redo: "\u{B2E4}\u{C2DC} \u{C2E4}\u{D589}",
    delete: "\u{C0AD}\u{C81C}",
    view: "\u{BCF4}\u{AE30}",
    reload: "\u{C0C8}\u{B85C}\u{ACE0}\u{CE68}",
    force_reload: "\u{AC15}\u{C81C} \u{C0C8}\u{B85C}\u{ACE0}\u{CE68}",
    toggle_dev_tools: "\u{AC1C}\u{BC1C}\u{C790} \u{B3C4}\u{AD6C}",
    actual_size: "\u{C2E4}\u{C81C} \u{D06C}\u{AE30}",
    zoom_in: "\u{D655}\u{B300}",
    zoom_out: "\u{CD95}\u{C18C}",
    fullscreen: "\u{C804}\u{CCB4} \u{D654}\u{BA74}",
    help: "\u{B3C4}\u{C6C0}\u{B9D0}",
    about: "SeuOffice \u{C815}\u{BCF4}",
    check_updates: "\u{C5C5}\u{B370}\u{C774}\u{D2B8} \u{D655}\u{C778}\u{2026}",
    version: "\u{BC84}\u{C804}",
    settings: "\u{C124}\u{C815}\u{2026}",
    name_with_ai: "AI\u{B85C} \u{C774}\u{B984} \u{C9C0}\u{C815}\u{2026}",
    name_with_ai_first: true,
};

fn labels_of(lang: &str) -> Option<Labels> {
    match lang {
        "en" => Some(EN),
        "ko" => Some(KO),
        _ => None,
    }
}

/// `AppMenuLabels`: the context menu's labels and the menus' own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppMenuLabels {
    pub context: ContextMenuLabels,
    own: Labels,
}

impl AppMenuLabels {
    pub fn window(&self) -> &'static str {
        self.own.window
    }
    pub fn minimize(&self) -> &'static str {
        self.own.minimize
    }
    pub fn close_window(&self) -> &'static str {
        self.own.close_window
    }
    pub fn edit(&self) -> &'static str {
        self.own.edit
    }
    pub fn view(&self) -> &'static str {
        self.own.view
    }
    pub fn help(&self) -> &'static str {
        self.own.help
    }
    pub fn about(&self) -> &'static str {
        self.own.about
    }
    pub fn check_updates(&self) -> &'static str {
        self.own.check_updates
    }
    pub fn version(&self) -> &'static str {
        self.own.version
    }
    pub fn settings(&self) -> &'static str {
        self.own.settings
    }
    pub fn name_with_ai(&self) -> &'static str {
        self.own.name_with_ai
    }
}

impl Serialize for AppMenuLabels {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let c = &self.context;
        let o = &self.own;
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in [
            ("cut", c.cut),
            ("copy", c.copy),
            ("paste", c.paste),
            ("selectAll", c.select_all),
            ("viewImage", c.view_image),
            ("copyImage", c.copy_image),
            ("saveImageAs", c.save_image_as),
            ("window", o.window),
            ("minimize", o.minimize),
            ("closeWindow", o.close_window),
            ("edit", o.edit),
            ("undo", o.undo),
            ("redo", o.redo),
            ("delete", o.delete),
            ("view", o.view),
            ("reload", o.reload),
            ("forceReload", o.force_reload),
            ("toggleDevTools", o.toggle_dev_tools),
            ("actualSize", o.actual_size),
            ("zoomIn", o.zoom_in),
            ("zoomOut", o.zoom_out),
            ("fullscreen", o.fullscreen),
            ("help", o.help),
            ("about", o.about),
            ("checkUpdates", o.check_updates),
            ("version", o.version),
        ] {
            map.serialize_entry(key, value)?;
        }
        let last = [("settings", o.settings), ("nameWithAi", o.name_with_ai)];
        let order = if o.name_with_ai_first { [1, 0] } else { [0, 1] };
        for i in order {
            map.serialize_entry(last[i].0, last[i].1)?;
        }
        map.end()
    }
}

/// `appMenuLabels(lang)`: the table of the language, of its base language,
/// or English, over the context menu's labels of the same language.
pub fn app_menu_labels(lang: &str) -> AppMenuLabels {
    AppMenuLabels {
        context: context_menu_labels(lang),
        own: labels_of(lang)
            .or_else(|| labels_of(base_lang(lang)))
            .unwrap_or(EN),
    }
}

/// What a click on an entry does; `C` is an app's own entry.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuClick<C> {
    /// `win?.minimize()` of the window the menu belongs to
    MinimizeWindow,
    /// `win?.close()`
    CloseWindow,
    /// [`DevToolsToggle::toggle`]
    ToggleDevTools,
    /// the shell's update check, when one is registered
    CheckUpdates,
    /// [`about_box`], then [`about_answer`]
    About,
    /// the shell's Settings view when registered, else this fallback
    Settings(Option<C>),
    /// an app's own entry
    App(C),
}

/// One entry of a menu template, its keys in the order the literals write
/// them; the click is not part of what JSON shows.
#[derive(Debug, Clone, PartialEq)]
pub struct MenuItem<C> {
    pub separator: bool,
    pub role: Option<&'static str>,
    pub label: Option<String>,
    pub accelerator: Option<&'static str>,
    pub submenu: Option<Vec<MenuItem<C>>>,
    pub click: Option<MenuClick<C>>,
}

impl<C> MenuItem<C> {
    fn empty() -> Self {
        MenuItem {
            separator: false,
            role: None,
            label: None,
            accelerator: None,
            submenu: None,
            click: None,
        }
    }

    /// `{ type: 'separator' }`
    pub fn separator() -> Self {
        MenuItem {
            separator: true,
            ..MenuItem::empty()
        }
    }

    /// `{ role }`
    pub fn role(role: &'static str) -> Self {
        MenuItem {
            role: Some(role),
            ..MenuItem::empty()
        }
    }

    /// `{ role, label }`
    pub fn role_labeled(role: &'static str, label: &str) -> Self {
        MenuItem {
            role: Some(role),
            label: Some(label.to_owned()),
            ..MenuItem::empty()
        }
    }

    /// `{ label, click }`
    pub fn clickable(label: &str, click: MenuClick<C>) -> Self {
        MenuItem {
            label: Some(label.to_owned()),
            click: Some(click),
            ..MenuItem::empty()
        }
    }

    /// `{ label, submenu }`
    pub fn menu(label: &str, submenu: Vec<MenuItem<C>>) -> Self {
        MenuItem {
            label: Some(label.to_owned()),
            submenu: Some(submenu),
            ..MenuItem::empty()
        }
    }
}

impl<C> Serialize for MenuItem<C> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        if self.separator {
            map.serialize_entry("type", "separator")?;
        }
        if let Some(role) = self.role {
            map.serialize_entry("role", role)?;
        }
        if let Some(label) = &self.label {
            map.serialize_entry("label", label)?;
        }
        if let Some(accelerator) = self.accelerator {
            map.serialize_entry("accelerator", accelerator)?;
        }
        if let Some(submenu) = &self.submenu {
            map.serialize_entry("submenu", submenu)?;
        }
        map.end()
    }
}

/// `windowMenuTemplate(platform, labels)`: macOS keeps the native role;
/// Windows and Linux get only the conventional items.
pub fn window_menu_template<C>(platform: &str, labels: &AppMenuLabels) -> MenuItem<C> {
    if platform == "darwin" {
        return MenuItem::role_labeled("windowMenu", labels.window());
    }
    MenuItem::menu(
        labels.window(),
        vec![
            MenuItem::clickable(labels.minimize(), MenuClick::MinimizeWindow),
            MenuItem::separator(),
            MenuItem::clickable(labels.close_window(), MenuClick::CloseWindow),
        ],
    )
}

/// `editMenuTemplate(platform, labels)`: macOS keeps `role: 'editMenu'`;
/// elsewhere the items Electron would generate, with localized labels.
pub fn edit_menu_template<C>(platform: &str, labels: &AppMenuLabels) -> MenuItem<C> {
    if platform == "darwin" {
        return MenuItem::role_labeled("editMenu", labels.edit());
    }
    let o = &labels.own;
    let c = &labels.context;
    MenuItem::menu(
        o.edit,
        vec![
            MenuItem::role_labeled("undo", o.undo),
            MenuItem::role_labeled("redo", o.redo),
            MenuItem::separator(),
            MenuItem::role_labeled("cut", c.cut),
            MenuItem::role_labeled("copy", c.copy),
            MenuItem::role_labeled("paste", c.paste),
            MenuItem::role_labeled("delete", o.delete),
            MenuItem::separator(),
            MenuItem::role_labeled("selectAll", c.select_all),
        ],
    )
}

/// `toggleDevToolsItem(labels)`; `platform` is `process.platform`
pub fn toggle_dev_tools_item<C>(platform: &str, labels: &AppMenuLabels) -> MenuItem<C> {
    MenuItem {
        accelerator: Some(if platform == "darwin" {
            "Alt+Command+I"
        } else {
            "Ctrl+Shift+I"
        }),
        ..MenuItem::clickable(labels.own.toggle_dev_tools, MenuClick::ToggleDevTools)
    }
}

/// The `webContents` the Developer Tools entry works on, as the caller sees
/// them; `W` names one.
pub trait DevToolsHost<W> {
    /// `webContents.getFocusedWebContents()`
    fn focused(&self) -> Option<W>;
    fn is_destroyed(&self, contents: &W) -> bool;
    /// `contents.devToolsWebContents`
    fn dev_tools_web_contents(&self, contents: &W) -> Option<W>;
    fn is_dev_tools_opened(&self, contents: &W) -> bool;
    fn close_dev_tools(&mut self, contents: &W);
    /// `contents.openDevTools({ mode: 'detach' })`
    fn open_dev_tools_detached(&mut self, contents: &W);
}

/// The click of the Developer Tools entry. `role: 'toggleDevTools'` docks
/// them into the window, under the shell's stacked views, so they open
/// detached; the last window they opened for is remembered, so the entry
/// closes them again while their own window has the focus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevToolsToggle<W> {
    last_detached_target: Option<W>,
}

impl<W> Default for DevToolsToggle<W> {
    fn default() -> Self {
        DevToolsToggle {
            last_detached_target: None,
        }
    }
}

impl<W: Clone + PartialEq> DevToolsToggle<W> {
    pub fn toggle(&mut self, host: &mut dyn DevToolsHost<W>) {
        let focused = host.focused();
        let previous = self
            .last_detached_target
            .clone()
            .filter(|last| !host.is_destroyed(last));
        let wc = match &focused {
            None => previous,
            Some(focused) => {
                let of_previous = previous
                    .as_ref()
                    .and_then(|previous| host.dev_tools_web_contents(previous));
                if of_previous.as_ref() == Some(focused) {
                    previous
                } else {
                    Some(focused.clone())
                }
            }
        };
        let Some(wc) = wc else {
            return;
        };
        if host.is_dev_tools_opened(&wc) {
            host.close_dev_tools(&wc);
            if self.last_detached_target.as_ref() == Some(&wc) {
                self.last_detached_target = None;
            }
        } else {
            host.open_dev_tools_detached(&wc);
            self.last_detached_target = Some(wc);
        }
    }
}

/// `ViewMenuOptions`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewMenuOptions {
    /// Reload, Force Reload, Developer Tools
    pub dev_items: bool,
    /// the page-zoom roles
    pub page_zoom: bool,
}

impl Default for ViewMenuOptions {
    fn default() -> Self {
        ViewMenuOptions {
            dev_items: true,
            page_zoom: true,
        }
    }
}

/// `viewMenuTemplate(labels, options)`; `platform` is `process.platform`
pub fn view_menu_template<C>(
    platform: &str,
    labels: &AppMenuLabels,
    options: ViewMenuOptions,
) -> MenuItem<C> {
    let o = &labels.own;
    let mut groups: Vec<Vec<MenuItem<C>>> = Vec::new();
    if options.dev_items {
        groups.push(vec![
            MenuItem::role_labeled("reload", o.reload),
            MenuItem::role_labeled("forceReload", o.force_reload),
            toggle_dev_tools_item(platform, labels),
        ]);
    }
    if options.page_zoom {
        groups.push(vec![
            MenuItem::role_labeled("resetZoom", o.actual_size),
            MenuItem::role_labeled("zoomIn", o.zoom_in),
            MenuItem::role_labeled("zoomOut", o.zoom_out),
        ]);
    }
    groups.push(vec![MenuItem::role_labeled(
        "togglefullscreen",
        o.fullscreen,
    )]);
    let mut submenu = Vec::new();
    for (index, group) in groups.into_iter().enumerate() {
        if index > 0 {
            submenu.push(MenuItem::separator());
        }
        submenu.extend(group);
    }
    MenuItem::menu(o.view, submenu)
}

/// `checkUpdatesMenuItem(labels)`
pub fn check_updates_menu_item<C>(labels: &AppMenuLabels) -> MenuItem<C> {
    MenuItem::clickable(labels.check_updates(), MenuClick::CheckUpdates)
}

/// `aboutMenuItem(labels)`
pub fn about_menu_item<C>(labels: &AppMenuLabels) -> MenuItem<C> {
    MenuItem::clickable(labels.about(), MenuClick::About)
}

/// The box Help > About shows: the product's name in the UI language and
/// the app's version. `can_check`: the shell registered its update check.
pub fn about_box(
    labels: &AppMenuLabels,
    version: &str,
    ui_lang: &str,
    can_check: bool,
) -> MessageBoxOptions {
    let name = product_name(Some(ui_lang));
    let mut buttons = vec!["OK".to_owned(), labels.context.copy.to_owned()];
    if can_check {
        buttons.push(labels.check_updates().to_owned());
    }
    MessageBoxOptions {
        kind: "info",
        title: Some(name.to_owned()),
        message: name.to_owned(),
        detail: Some(format!("{} {version}", labels.version())),
        buttons,
        default_id: 0,
        cancel_id: Some(0),
        no_link: None,
    }
}

/// What the About box's answer asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AboutAnswer {
    Nothing,
    /// `clipboard.writeText(text)`
    CopyText(String),
    /// the shell's update check
    CheckUpdates,
}

/// `response` of the About box
pub fn about_answer(response: f64, version: &str) -> AboutAnswer {
    if response == 1.0 {
        AboutAnswer::CopyText(format!("{PRODUCT_NAME} {version}"))
    } else if response == 2.0 {
        AboutAnswer::CheckUpdates
    } else {
        AboutAnswer::Nothing
    }
}

/// `helpCheckUpdatesItems(labels, platform)`: inside Help on macOS only,
/// where the menu bar is the app's menu.
pub fn help_check_updates_items<C>(labels: &AppMenuLabels, platform: &str) -> Vec<MenuItem<C>> {
    if platform == "darwin" {
        vec![check_updates_menu_item(labels)]
    } else {
        Vec::new()
    }
}

/// `appMenuPopupTemplate(menus, labels)`: the tab bar's popup, the window's
/// menus and then Check for Updates.
pub fn app_menu_popup_template<C>(
    menus: Vec<MenuItem<C>>,
    labels: &AppMenuLabels,
) -> Vec<MenuItem<C>> {
    let mut out = menus;
    out.push(MenuItem::separator());
    out.push(check_updates_menu_item(labels));
    out
}

/// `settingsMenuItem(labels, fallback)`
pub fn settings_menu_item<C>(labels: &AppMenuLabels, fallback: Option<C>) -> MenuItem<C> {
    MenuItem {
        accelerator: Some("CmdOrCtrl+,"),
        ..MenuItem::clickable(labels.settings(), MenuClick::Settings(fallback))
    }
}

/// `appMenuTemplate(platform, labels, { extra, appLabel })`: the macOS
/// application menu; every other platform has none. `app_label` defaults to
/// the product's name.
pub fn app_menu_template<C>(
    platform: &str,
    labels: &AppMenuLabels,
    extra: Vec<MenuItem<C>>,
    app_label: Option<&str>,
) -> Option<MenuItem<C>> {
    if platform != "darwin" {
        return None;
    }
    let mut submenu = vec![MenuItem::role_labeled("about", labels.about())];
    submenu.extend(extra);
    submenu.extend([
        MenuItem::separator(),
        MenuItem::role("services"),
        MenuItem::separator(),
        MenuItem::role("hide"),
        MenuItem::role("hideOthers"),
        MenuItem::role("unhide"),
        MenuItem::separator(),
        MenuItem::role("quit"),
    ]);
    Some(MenuItem::menu(app_label.unwrap_or(PRODUCT_NAME), submenu))
}

/// `helpMenuTemplate(labels, extraItems, platform)`: Check for Updates
/// (macOS) and About; the app's items go before a separator.
pub fn help_menu_template<C>(
    labels: &AppMenuLabels,
    extra_items: Vec<MenuItem<C>>,
    platform: &str,
) -> MenuItem<C> {
    let has_extra = !extra_items.is_empty();
    let mut submenu = extra_items;
    if has_extra {
        submenu.push(MenuItem::separator());
    }
    submenu.extend(help_check_updates_items(labels, platform));
    submenu.push(about_menu_item(labels));
    MenuItem {
        role: Some("help"),
        ..MenuItem::menu(labels.help(), submenu)
    }
}
