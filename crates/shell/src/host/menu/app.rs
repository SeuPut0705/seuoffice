//! The application menu (`applyMenuFor` of `apps/shell/src/main/index.ts`,
//! `buildDocsMenu`, Sheets' `installApplicationMenu`, `buildSlidesMenu`): one
//! menu per kind of tab, rebuilt whenever the active tab changes.
//!
//! The menus are built in three steps so that nearly all of it is a pure
//! function of the tab's kind and the language:
//!
//! 1. [`menu_for`] makes a tree of [`Node`]s on the core thread. The shared
//!    pieces (the application, Edit, Window, View and Help menus, Settings,
//!    About) come from `main-core`'s `app_menu` templates, never re-typed
//!    here. The items that send batch M's events are written once with no
//!    action; [`bind_events`] finds each one's channel and arguments by its
//!    label path in `shell_ipc_m::app_menu_items`, so the labels the events
//!    are found by and the labels shown are one string.
//! 2. [`number`] gives each clickable item the id `m-app-<n>` and returns what
//!    each id does.
//! 3. [`build_menu`], on the UI thread, makes the Tauri menu and sets it.
//!
//! One global `on_menu_event` listener ([`install`]) takes the ids that start
//! with `m-app-` and runs their [`Act`] on the core thread, where the tab
//! state lives.
//!
//! What Electron's menus had and this one does not, because the shell has no
//! seam for it yet (each is a missing `ShellTabs` or host method, not a choice):
//!
//! - New document / New Window items (`newDocumentMenuItems`, `newDiagramTab`,
//!   `newMindmapTab`, Docs' New Window, Slides' Open in New Window): `NewKind`
//!   of the W batch's tabs is private to it.
//! - Import PDF (Hangul), Export as Word / PowerPoint / Excel (PDF): the
//!   shell's own conversions are not ported.
//! - the document-link entries of File (`documentLinkFileMenuItems`) and the
//!   interface-zoom items of View (`changeUiScale`): their state is not ported.
//! - Check for Updates: batch U's updater is not in the shell yet. When it is,
//!   `check_updates_menu_item` goes into Help and the About box (it offers the
//!   check when `about_box` is told it can) beside About.
//! - the Dock menu (`installDockMenu`): Tauri 3 alpha.6 and its CEF runtime
//!   have no dock-menu API.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use main_core::packages::electron_utils::app_menu::{
    AboutAnswer, AppMenuLabels, MenuClick, MenuItem, ViewMenuOptions, about_answer, about_box,
    about_menu_item, app_menu_labels, app_menu_template, edit_menu_template, help_menu_template,
    settings_menu_item, toggle_dev_tools_item, view_menu_template, window_menu_template,
};
use main_core::packages::i18n::Lang;
use main_core::shell::feedback::{
    FEEDBACK_SURVEY_URL, FeedbackEnvironment, feedback_details, feedback_text, platform_label,
};
use main_core::shell::tab_manager::TabKind;
use shell_contract::editors::{SaveMode, editor_for};
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::Target;
use shell_contract::provided::Provided;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{ClipboardHost, DialogsHost, IpcValue, MainWindowHost, OsShellHost, ViewId};
use shell_ipc_m::{AppMenuItems, MenuAction, MenuDict, app_menu_items, current_lang, menu_label};
use shell_ipc_w::home_settings::HomeAppHost;
use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuItem as TauriItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, DynRuntime, Manager};
use tauri_runtime_cef::WebviewCefExt;

use super::super::HostContext;
use super::super::shell_tabs::shell_tabs;
use super::super::w::post_core;
use super::super::window::Windows;

use std::sync::Arc;

/// The id prefix of this menu's items; the one global listener takes these only
const ID_PREFIX: &str = "m-app-";

/// DevTools exist in a debug build or with the `devtools` feature (Tauri's own gate)
const DEV_TOOLS: bool = cfg!(any(debug_assertions, feature = "devtools"));

// ---- what a click does ----

/// An edit command of the page that has no predefined Tauri menu item
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameEdit {
    /// `role: 'delete'`
    Delete,
    /// `role: 'pasteAndMatchStyle'`
    PasteAndMatchStyle,
}

#[derive(Clone, Debug, PartialEq)]
enum Act {
    /// An item of batch M's table: [`bind_events`] replaces it with an
    /// [`Act::Emit`] found by the item's label path
    Unbound,
    /// `webContents.send(channel, ...args)` on the active editor of the menu's kind
    Emit {
        channel: &'static str,
        args: Vec<IpcValue>,
    },
    /// File > Open: `openFileViaDialog`
    Open,
    /// File > Open Recent: `openDocumentPath(path)`
    OpenRecent(String),
    /// `tabManager.openHomeTab()`
    BackToHome,
    /// `closeFocusedEditor`
    Close,
    /// `request<App>Save(contents, 'save' | 'saveAs')` of the active editor
    Save(SaveMode),
    /// `send<App>ExportRequest(contents, format)` of the active editor
    Export(&'static str),
    /// `openSettingsView`
    Settings,
    About,
    /// Help > User Guide: `tabManager.openHelpTab()`
    UserGuide,
    /// `openThirdPartyNotices`
    ThirdPartyNotices,
    /// `openFeedbackSurvey`
    Feedback,
    /// `role: 'toggleDevTools'`
    ToggleDevTools,
    /// `role: 'reload'` and `'forceReload'`
    Reload {
        ignore_cache: bool,
    },
    /// `win?.minimize()` of the focused window
    MinimizeWindow,
    /// `win?.close()` of the focused window
    CloseWindow,
    Frame(FrameEdit),
}

// ---- the menu as a value ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    About,
    Services,
    Hide,
    HideOthers,
    Unhide,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    /// macOS "Zoom": maximize
    Zoom,
    /// macOS "Bring All to Front"
    Front,
    Fullscreen,
    CloseWindow,
}

/// Menus the system treats specially on macOS
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuRole {
    Plain,
    Window,
    Help,
}

#[derive(Clone, Debug, PartialEq)]
struct Item {
    /// `m-app-<n>` once [`number`] ran; items with no action have none
    id: Option<String>,
    label: String,
    accelerator: Option<String>,
    enabled: bool,
    /// a checkbox's state
    checked: Option<bool>,
    act: Option<Act>,
}

#[derive(Clone, Debug, PartialEq)]
enum Node {
    Separator,
    Role {
        role: Role,
        label: Option<String>,
    },
    Item(Item),
    Menu {
        label: String,
        role: MenuRole,
        items: Vec<Node>,
    },
}

fn item(label: &str, accelerator: Option<&str>, act: Act) -> Node {
    Node::Item(Item {
        id: None,
        label: label.to_owned(),
        accelerator: accelerator.map(str::to_owned),
        enabled: true,
        checked: None,
        act: Some(act),
    })
}

/// An item of batch M's table
fn unbound(label: &str, accelerator: Option<&str>) -> Node {
    item(label, accelerator, Act::Unbound)
}

fn emit(
    label: &str,
    accelerator: Option<&str>,
    channel: &'static str,
    args: Vec<IpcValue>,
) -> Node {
    item(label, accelerator, Act::Emit { channel, args })
}

fn text(value: &str) -> IpcValue {
    IpcValue::String(value.to_owned())
}

fn submenu(label: &str, items: Vec<Node>) -> Node {
    Node::Menu {
        label: label.to_owned(),
        role: MenuRole::Plain,
        items,
    }
}

fn role(role: Role, label: &str) -> Node {
    Node::Role {
        role,
        label: Some(label.to_owned()),
    }
}

// ---- what the menu is built from ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }

    /// `process.platform`
    fn node(self) -> &'static str {
        match self {
            Os::Mac => "darwin",
            Os::Windows => "win32",
            Os::Linux => "linux",
        }
    }
}

/// What the Docs View menu's checkboxes and Insert menu show for a docs view
/// (`ViewMenuState`): the renderer reports it, the defaults are its initial state
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DocsViewState {
    pub ai_sidebar: bool,
    pub dark_canvas: bool,
    /// the tab shows an ODT document: equations and comments are off
    pub odt: bool,
}

impl Default for DocsViewState {
    fn default() -> Self {
        DocsViewState {
            ai_sidebar: true,
            dark_canvas: false,
            odt: false,
        }
    }
}

/// The titles `role: 'edit'` and the View menu's page-zoom roles carry in
/// the templates, which are the only way to read them
struct RoleLabels {
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    delete: String,
    select_all: String,
    actual_size: String,
    zoom_in: String,
    zoom_out: String,
    fullscreen: String,
}

impl RoleLabels {
    fn of(labels: &AppMenuLabels) -> RoleLabels {
        let edit = edit_menu_template::<Act>("linux", labels);
        let view = view_menu_template::<Act>(
            "linux",
            labels,
            ViewMenuOptions {
                dev_items: false,
                page_zoom: true,
            },
        );
        let label = |menu: &MenuItem<Act>, role: &str| {
            menu.submenu
                .iter()
                .flatten()
                .find(|entry| entry.role == Some(role))
                .and_then(|entry| entry.label.clone())
                .unwrap_or_default()
        };
        RoleLabels {
            undo: label(&edit, "undo"),
            redo: label(&edit, "redo"),
            cut: label(&edit, "cut"),
            copy: label(&edit, "copy"),
            paste: label(&edit, "paste"),
            delete: label(&edit, "delete"),
            select_all: label(&edit, "selectAll"),
            actual_size: label(&view, "resetZoom"),
            zoom_in: label(&view, "zoomIn"),
            zoom_out: label(&view, "zoomOut"),
            fullscreen: label(&view, "togglefullscreen"),
        }
    }
}

struct Ctx {
    os: Os,
    lang: Lang,
    /// `app.name`
    app_name: String,
    dev_tools: bool,
    /// Docs' File > Open Recent (`recent.json`, the first ten)
    recent: Vec<String>,
    docs_view: DocsViewState,
    labels: AppMenuLabels,
    roles: RoleLabels,
}

impl Ctx {
    fn new(
        os: Os,
        lang: Lang,
        app_name: String,
        dev_tools: bool,
        recent: Vec<String>,
        docs_view: DocsViewState,
    ) -> Ctx {
        let labels = app_menu_labels(lang.as_str());
        Ctx {
            os,
            lang,
            app_name,
            dev_tools,
            recent,
            docs_view,
            roles: RoleLabels::of(&labels),
            labels,
        }
    }

    fn mac(&self) -> bool {
        self.os == Os::Mac
    }

    /// the shell's `tm(key)`
    fn tm(&self, key: &str) -> String {
        menu_label(MenuDict::Shell, self.lang, key)
    }

    fn docs(&self, key: &str) -> String {
        menu_label(MenuDict::Docs, self.lang, key)
    }

    fn sheets(&self, key: &str) -> String {
        menu_label(MenuDict::Sheets, self.lang, key)
    }

    fn slides(&self, key: &str) -> String {
        menu_label(MenuDict::Slides, self.lang, key)
    }

    /// `registerAccelerator: false`: the key is shown but not registered, so a
    /// press reaches the editor, which takes it itself. Only Windows and Linux
    /// honored it, and a Tauri menu cannot show a key it does not register, so
    /// there the key is left off.
    fn shown_only(&self, accelerator: &'static str) -> Option<&'static str> {
        self.mac().then_some(accelerator)
    }

    /// The Redo key of the apps that take Undo and Redo themselves
    fn redo_key(&self) -> &'static str {
        if self.mac() { "Shift+Cmd+Z" } else { "Ctrl+Y" }
    }

    fn settings(&self) -> Node {
        self.node(&settings_menu_item(&self.labels, None))
            .unwrap_or(Node::Separator)
    }

    /// A template of `main-core` as nodes; `None` for what this shell leaves out
    fn node(&self, template: &MenuItem<Act>) -> Option<Node> {
        if template.separator {
            return Some(Node::Separator);
        }
        let label = template.label.clone();
        if let Some(items) = &template.submenu {
            let items = items.iter().filter_map(|i| self.node(i)).collect();
            return Some(Node::Menu {
                label: label?,
                role: if template.role == Some("help") {
                    MenuRole::Help
                } else {
                    MenuRole::Plain
                },
                items,
            });
        }
        if let Some(name) = template.role {
            return self.role_node(name, label);
        }
        let act = match template.click.clone()? {
            MenuClick::MinimizeWindow => Act::MinimizeWindow,
            MenuClick::CloseWindow => Act::CloseWindow,
            MenuClick::ToggleDevTools if self.dev_tools => Act::ToggleDevTools,
            MenuClick::ToggleDevTools => return None,
            // see the module's list of what is left out
            MenuClick::CheckUpdates => return None,
            MenuClick::About => Act::About,
            MenuClick::Settings(_) => Act::Settings,
            MenuClick::App(act) => act,
        };
        Some(item(&label?, template.accelerator, act))
    }

    /// `role: name` of a template: a predefined item, or what the role did
    /// where Tauri has no predefined item
    fn role_node(&self, name: &str, label: Option<String>) -> Option<Node> {
        let predefined = |role| {
            Some(Node::Role {
                role,
                label: label.clone(),
            })
        };
        match name {
            "undo" => predefined(Role::Undo),
            "redo" => predefined(Role::Redo),
            "cut" => predefined(Role::Cut),
            "copy" => predefined(Role::Copy),
            "paste" => predefined(Role::Paste),
            "selectAll" => predefined(Role::SelectAll),
            "togglefullscreen" => predefined(Role::Fullscreen),
            "about" => predefined(Role::About),
            "delete" => Some(item(&label?, None, Act::Frame(FrameEdit::Delete))),
            "reload" => Some(item(
                &label?,
                Some("CmdOrCtrl+R"),
                Act::Reload {
                    ignore_cache: false,
                },
            )),
            "forceReload" => Some(item(
                &label?,
                Some("CmdOrCtrl+Shift+R"),
                Act::Reload { ignore_cache: true },
            )),
            "services" => Some(role(Role::Services, &self.tm("roleServices"))),
            "hide" => Some(role(Role::Hide, &self.app_title("roleHide"))),
            "hideOthers" => Some(role(Role::HideOthers, &self.tm("roleHideOthers"))),
            "unhide" => Some(role(Role::Unhide, &self.tm("roleUnhide"))),
            "quit" => Some(role(Role::Quit, &self.app_title("roleQuit"))),
            // `role: 'editMenu'` and `'windowMenu'` of macOS, which Tauri has no
            // role for: the items the role holds
            "editMenu" => Some(Node::Menu {
                label: label?,
                role: MenuRole::Plain,
                items: edit_menu_template::<Act>("linux", &self.labels)
                    .submenu
                    .iter()
                    .flatten()
                    .filter_map(|entry| self.node(entry))
                    .collect(),
            }),
            "windowMenu" => Some(Node::Menu {
                label: label?,
                role: MenuRole::Window,
                items: vec![
                    role(Role::Minimize, self.labels.minimize()),
                    role(Role::Zoom, &self.tm("roleZoom")),
                    Node::Separator,
                    role(Role::Front, &self.tm("roleFront")),
                ],
            }),
            // the page-zoom roles: no menu of this app asks for them
            // (`ViewMenuOptions::page_zoom` is false), the apps zoom their documents
            _ => None,
        }
    }

    fn app_title(&self, key: &str) -> String {
        self.tm(key).replace("{app}", &self.app_name)
    }

    /// The macOS application menu, with Settings in it; no other system has one
    fn app_menu(&self) -> Option<Node> {
        let template = app_menu_template(
            self.os.node(),
            &self.labels,
            vec![settings_menu_item(&self.labels, None)],
            Some(&self.app_name),
        )?;
        self.node(&template)
    }

    fn edit_menu(&self) -> Node {
        self.node(&edit_menu_template(self.os.node(), &self.labels))
            .unwrap_or(Node::Separator)
    }

    fn window_menu(&self) -> Node {
        self.node(&window_menu_template(self.os.node(), &self.labels))
            .unwrap_or(Node::Separator)
    }

    fn dev_tools_item(&self) -> Option<Node> {
        self.node(&toggle_dev_tools_item(self.os.node(), &self.labels))
    }

    /// File > Back to Home (`installBackToHomeItems`, and each shell-built menu's own)
    fn back_to_home(&self) -> Node {
        item(
            &self.tm("backToHome"),
            Some("Shift+CmdOrCtrl+H"),
            Act::BackToHome,
        )
    }

    fn about(&self) -> Node {
        self.node(&about_menu_item(&self.labels))
            .unwrap_or(Node::Separator)
    }
}

// ---- the menus of the shell's own kinds ----

fn shell_open(ctx: &Ctx) -> Node {
    item(&ctx.tm("menuOpen"), Some("CmdOrCtrl+O"), Act::Open)
}

/// Save and Save As. Hangul's have no key: its embedded editor takes Ctrl+S
/// before the menu sees it
fn shell_save(ctx: &Ctx, keys: bool) -> [Node; 2] {
    [
        item(
            &ctx.tm("menuSave"),
            keys.then_some("CmdOrCtrl+S"),
            Act::Save(SaveMode::Save),
        ),
        item(
            &ctx.tm("menuSaveAs"),
            keys.then_some("CmdOrCtrl+Shift+S"),
            Act::Save(SaveMode::SaveAs),
        ),
    ]
}

fn shell_export(ctx: &Ctx, key: &str, format: &'static str) -> Node {
    item(&ctx.tm(key), None, Act::Export(format))
}

fn shell_print(ctx: &Ctx) -> Node {
    unbound(&ctx.tm("menuPrint"), Some("CmdOrCtrl+P"))
}

/// Close and Settings, which end every shell-built File menu but Home's
fn shell_file_end(ctx: &Ctx) -> Vec<Node> {
    vec![
        Node::Separator,
        item(&ctx.tm("menuClose"), Some("CmdOrCtrl+W"), Act::Close),
        Node::Separator,
        ctx.settings(),
    ]
}

/// A File menu of the entries in `parts`, then Close and Settings
fn shell_file(ctx: &Ctx, parts: Vec<Vec<Node>>) -> Node {
    let mut items: Vec<Node> = parts.into_iter().flatten().collect();
    items.extend(shell_file_end(ctx));
    submenu(&ctx.tm("menuFile"), items)
}

fn shell_help(ctx: &Ctx, user_guide: bool) -> Node {
    let mut items = Vec::new();
    if user_guide {
        items.push(item(&ctx.tm("menuUserGuide"), Some("F1"), Act::UserGuide));
        items.push(Node::Separator);
    }
    items.push(item(
        &ctx.tm("thirdPartyNotices"),
        None,
        Act::ThirdPartyNotices,
    ));
    items.push(Node::Separator);
    items.push(ctx.about());
    Node::Menu {
        label: ctx.tm("menuHelp"),
        role: MenuRole::Help,
        items,
    }
}

/// `[application menu], File, [the rest], Window, Help` of a shell-built kind
fn shell_menus(ctx: &Ctx, file: Node, middle: Vec<Node>, user_guide: bool) -> Vec<Node> {
    let mut menus: Vec<Node> = ctx.app_menu().into_iter().collect();
    menus.push(file);
    menus.extend(middle);
    menus.push(ctx.window_menu());
    menus.push(shell_help(ctx, user_guide));
    menus
}

/// Home's File menu closes the window (`role: 'close'`), not an editor; the
/// new-document entries before Open are left out (module docs)
fn home_menus(ctx: &Ctx) -> Vec<Node> {
    let file = submenu(
        &ctx.tm("menuFile"),
        vec![
            shell_open(ctx),
            Node::Separator,
            role(Role::CloseWindow, &ctx.tm("menuClose")),
            Node::Separator,
            ctx.settings(),
        ],
    );
    shell_menus(ctx, file, vec![ctx.edit_menu()], true)
}

fn pdf_menus(ctx: &Ctx) -> Vec<Node> {
    let convert = |format: &str, key| {
        emit(
            &ctx.tm(key),
            None,
            "pdf:convert-dialog-request",
            vec![IpcValue::Object(vec![("format".into(), text(format))])],
        )
    };
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, true).into(),
            vec![
                Node::Separator,
                convert("md", "menuExportMd"),
                convert("epub", "menuExportEpub"),
                Node::Separator,
                shell_print(ctx),
            ],
        ],
    );
    shell_menus(ctx, file, vec![ctx.edit_menu()], false)
}

fn markdown_menus(ctx: &Ctx) -> Vec<Node> {
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, true).into(),
            vec![
                Node::Separator,
                shell_export(ctx, "menuExportDocx", "docx"),
                shell_export(ctx, "menuExportOdt", "odt"),
                shell_export(ctx, "menuExportPdf", "pdf"),
                shell_export(ctx, "menuExportImages", "png"),
                shell_export(ctx, "menuOpenInDocs", "docs"),
                Node::Separator,
                shell_print(ctx),
            ],
        ],
    );
    shell_menus(ctx, file, vec![ctx.edit_menu()], false)
}

fn hwp_menus(ctx: &Ctx) -> Vec<Node> {
    let preview = |key, action| {
        emit(
            &ctx.tm(key),
            None,
            "hwp:preview-request",
            vec![text(action)],
        )
    };
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, false).into(),
            vec![
                Node::Separator,
                unbound(&ctx.tm("menuExportPdf"), None),
                preview("menuPreview", "open"),
                preview("menuPrint", "print"),
            ],
        ],
    );
    shell_menus(ctx, file, vec![ctx.edit_menu()], false)
}

fn html_menus(ctx: &Ctx) -> Vec<Node> {
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, true).into(),
            vec![
                Node::Separator,
                shell_export(ctx, "menuExportDocx", "docx"),
                shell_export(ctx, "menuExportOdt", "odt"),
                shell_export(ctx, "menuExportPdf", "pdf"),
                shell_export(ctx, "menuExportHtml", "html"),
                Node::Separator,
                shell_print(ctx),
            ],
        ],
    );
    shell_menus(ctx, file, vec![ctx.edit_menu()], false)
}

/// The Edit menu of the apps whose history and find are their own: Undo,
/// Redo and the finds go to the editor as events, the clipboard keeps the
/// page's roles
fn own_history_edit(
    ctx: &Ctx,
    channel: &'static str,
    finds: Vec<(String, &'static str, &'static str)>,
) -> Node {
    let key = |label: &str, accelerator: Option<&str>, command: &str| {
        emit(label, accelerator, channel, vec![text(command)])
    };
    let r = &ctx.roles;
    let mut items = vec![
        key(&r.undo, ctx.shown_only("CmdOrCtrl+Z"), "undo"),
        key(&r.redo, ctx.shown_only(ctx.redo_key()), "redo"),
        Node::Separator,
        role(Role::Cut, &r.cut),
        role(Role::Copy, &r.copy),
        role(Role::Paste, &r.paste),
        item(&r.delete, None, Act::Frame(FrameEdit::Delete)),
        Node::Separator,
        role(Role::SelectAll, &r.select_all),
    ];
    if !finds.is_empty() {
        items.push(Node::Separator);
    }
    for (label, accelerator, command) in finds {
        items.push(key(&label, ctx.shown_only(accelerator), command));
    }
    submenu(ctx.labels.edit(), items)
}

fn epub_menus(ctx: &Ctx) -> Vec<Node> {
    let channel = "epub:menu-command";
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, true).into(),
            vec![
                Node::Separator,
                emit(
                    &ctx.tm("menuTranslateBook"),
                    None,
                    channel,
                    vec![text("translate-book")],
                ),
            ],
        ],
    );
    let replace = if ctx.mac() { "Alt+Cmd+F" } else { "Ctrl+H" };
    let edit = own_history_edit(
        ctx,
        channel,
        vec![
            (ctx.tm("menuFind"), "CmdOrCtrl+F", "find"),
            (ctx.tm("menuReplace"), replace, "replace"),
        ],
    );
    let r = &ctx.roles;
    let zoom = |label: &str, accelerator, command| {
        emit(
            label,
            ctx.shown_only(accelerator),
            channel,
            vec![text(command)],
        )
    };
    let view = submenu(
        ctx.labels.view(),
        vec![
            zoom(&r.actual_size, "CmdOrCtrl+0", "zoom-reset"),
            zoom(&r.zoom_in, "CmdOrCtrl+=", "zoom-in"),
            zoom(&r.zoom_out, "CmdOrCtrl+-", "zoom-out"),
            Node::Separator,
            role(Role::Fullscreen, &r.fullscreen),
        ],
    );
    shell_menus(ctx, file, vec![edit, view], false)
}

fn diagram_menus(ctx: &Ctx) -> Vec<Node> {
    let channel = "diagram:menu-command";
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, true).into(),
            vec![
                Node::Separator,
                shell_export(ctx, "menuExportMapImage", "png"),
                shell_export(ctx, "menuExportSvg", "svg"),
                shell_export(ctx, "menuExportPdf", "pdf"),
                Node::Separator,
                shell_print(ctx),
            ],
        ],
    );
    let edit = own_history_edit(
        ctx,
        channel,
        vec![(ctx.tm("menuFind"), "CmdOrCtrl+F", "find")],
    );
    let r = &ctx.roles;
    let view = submenu(
        ctx.labels.view(),
        vec![
            emit(&r.actual_size, None, channel, vec![text("zoom-reset")]),
            emit(
                &r.zoom_in,
                ctx.shown_only("CmdOrCtrl+="),
                channel,
                vec![text("zoom-in")],
            ),
            emit(
                &r.zoom_out,
                ctx.shown_only("CmdOrCtrl+-"),
                channel,
                vec![text("zoom-out")],
            ),
            emit(
                &ctx.tm("menuZoomFit"),
                None,
                channel,
                vec![text("zoom-fit")],
            ),
            Node::Separator,
            role(Role::Fullscreen, &r.fullscreen),
        ],
    );
    shell_menus(ctx, file, vec![edit, view], false)
}

fn mindmap_menus(ctx: &Ctx) -> Vec<Node> {
    let file = shell_file(
        ctx,
        vec![
            vec![
                shell_open(ctx),
                Node::Separator,
                ctx.back_to_home(),
                Node::Separator,
            ],
            shell_save(ctx, true).into(),
            vec![
                Node::Separator,
                shell_export(ctx, "menuExportMapImage", "png"),
                shell_export(ctx, "menuExportMapSvg", "svg"),
                shell_export(ctx, "menuExportPdf", "pdf"),
                shell_export(ctx, "menuExportMapOutline", "markdown"),
                Node::Separator,
                shell_print(ctx),
            ],
        ],
    );
    let edit = own_history_edit(ctx, "mindmap:menu-command", Vec::new());
    shell_menus(ctx, file, vec![edit], false)
}

// ---- Docs ----

fn docs_menus(ctx: &Ctx) -> Vec<Node> {
    let d = |key: &str| ctx.docs(key);
    let recent = if ctx.recent.is_empty() {
        vec![Node::Item(Item {
            id: None,
            label: d("menuNoRecent"),
            accelerator: None,
            enabled: false,
            checked: None,
            act: None,
        })]
    } else {
        ctx.recent
            .iter()
            .map(|path| {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
                item(&name, None, Act::OpenRecent(path.clone()))
            })
            .collect()
    };
    let name_with_ai = ctx.labels.name_with_ai();
    let file = submenu(
        &d("menuFile"),
        vec![
            unbound(&d("menuNewDoc"), Some("CmdOrCtrl+N")),
            unbound(&d("menuOpen"), Some("CmdOrCtrl+O")),
            submenu(&d("menuOpenRecent"), recent),
            Node::Separator,
            ctx.back_to_home(),
            Node::Separator,
            item(&d("menuClose"), Some("CmdOrCtrl+W"), Act::Close),
            unbound(&d("menuSave"), Some("CmdOrCtrl+S")),
            unbound(&d("menuSaveAs"), Some("Shift+CmdOrCtrl+S")),
            unbound(name_with_ai, None),
            Node::Separator,
            unbound(&d("menuPageSetup"), None),
            unbound(&d("menuExportPdf"), None),
            unbound(&d("menuExportHwp"), None),
            unbound(&d("menuExportHtml"), None),
            unbound(&d("menuExportMarkdown"), None),
            unbound(&d("menuExportImages"), None),
            unbound(&d("menuPrint"), Some("CmdOrCtrl+P")),
        ],
    );
    let goto = if ctx.mac() { "Alt+Cmd+G" } else { "Ctrl+G" };
    let edit = submenu(
        &d("menuEdit"),
        vec![
            unbound(&d("menuUndo"), Some("CmdOrCtrl+Z")),
            unbound(&d("menuRedo"), Some("Shift+CmdOrCtrl+Z")),
            Node::Separator,
            role(Role::Cut, &d("menuCut")),
            role(Role::Copy, &d("menuCopy")),
            role(Role::Paste, &d("menuPaste")),
            item(
                &d("menuPasteMatch"),
                Some("Shift+CmdOrCtrl+V"),
                Act::Frame(FrameEdit::PasteAndMatchStyle),
            ),
            Node::Separator,
            unbound(&d("menuFindReplace"), Some("CmdOrCtrl+F")),
            unbound(&d("menuGoTo"), Some(goto)),
            Node::Separator,
            role(Role::SelectAll, &d("menuSelectAll")),
        ],
    );
    let checkbox = |label: String, checked: bool| {
        Node::Item(Item {
            id: None,
            label,
            accelerator: None,
            enabled: true,
            checked: Some(checked),
            act: Some(Act::Unbound),
        })
    };
    let mut zoom: Vec<Node> = [500, 200, 150, 125, 100, 75, 50, 25, 10]
        .iter()
        .map(|pct| unbound(&format!("{pct}%"), None))
        .collect();
    zoom.extend([
        unbound(&d("menuPageWidth"), None),
        unbound(&d("menuWholePage"), None),
        unbound(&d("menuMultiPage"), None),
    ]);
    let mut view = vec![
        unbound(&d("menuZoomIn"), Some("CmdOrCtrl+=")),
        unbound(&d("menuZoomOut"), Some("CmdOrCtrl+-")),
        unbound(&d("menuZoom100"), Some("CmdOrCtrl+0")),
        submenu(&d("menuZoom"), zoom),
        Node::Separator,
        checkbox(d("menuAiSidebar"), ctx.docs_view.ai_sidebar),
        checkbox(d("menuDarkMode"), ctx.docs_view.dark_canvas),
        Node::Separator,
        role(Role::Fullscreen, &d("menuFullscreen")),
    ];
    view.extend(ctx.dev_tools_item());
    let view = submenu(&d("menuView"), view);
    // an ODT document switches off what it cannot hold
    let odt_off = |label: String, act: Act| {
        Node::Item(Item {
            id: None,
            label,
            accelerator: None,
            enabled: !ctx.docs_view.odt,
            checked: None,
            act: Some(act),
        })
    };
    let insert = submenu(
        &d("menuInsert"),
        vec![
            unbound(&d("menuInsertTable"), None),
            unbound(&d("menuInsertImage"), None),
            unbound(&d("menuInsertPageBreak"), None),
            unbound(&d("menuInsertLink"), Some("CmdOrCtrl+K")),
            odt_off(d("menuInsertEquation"), Act::Unbound),
            Node::Separator,
            odt_off(d("menuComment"), Act::Unbound),
        ],
    );
    let format = submenu(
        &d("menuFormat"),
        vec![
            unbound(&d("menuBold"), Some("CmdOrCtrl+B")),
            unbound(&d("menuItalic"), Some("CmdOrCtrl+I")),
            unbound(&d("menuUnderline"), Some("CmdOrCtrl+U")),
            Node::Separator,
            submenu(
                &d("menuAlign"),
                vec![
                    unbound(&d("menuAlignLeft"), None),
                    unbound(&d("menuAlignCenter"), None),
                    unbound(&d("menuAlignRight"), None),
                    unbound(&d("menuAlignJustify"), None),
                ],
            ),
            Node::Separator,
            unbound(&d("menuFont"), Some("CmdOrCtrl+D")),
            unbound(&d("menuParagraph"), Some("Alt+CmdOrCtrl+M")),
        ],
    );
    let plain = |key: &str| unbound(&d(key), None);
    let table = submenu(
        &d("menuTable"),
        vec![
            submenu(
                &d("menuTableInsert"),
                vec![
                    plain("menuTableInsertTable"),
                    plain("menuTableColsLeft"),
                    plain("menuTableColsRight"),
                    plain("menuTableRowsAbove"),
                    plain("menuTableRowsBelow"),
                    plain("menuTableCells"),
                ],
            ),
            submenu(
                &d("menuTableDelete"),
                vec![
                    plain("menuTableDeleteTable"),
                    plain("menuTableDeleteColumns"),
                    plain("menuTableDeleteRows"),
                    plain("menuTableCells"),
                ],
            ),
            submenu(
                &d("menuTableSelect"),
                vec![
                    plain("menuTableSelectTable"),
                    plain("menuTableSelectColumn"),
                    plain("menuTableSelectRow"),
                    plain("menuTableSelectCell"),
                ],
            ),
            Node::Separator,
            plain("menuTableMergeCells"),
            plain("menuTableSplitCells"),
            plain("menuTableSplitTable"),
            Node::Separator,
            submenu(
                &d("menuTableAutoFit"),
                vec![
                    plain("menuTableAutoFitContents"),
                    plain("menuTableAutoFitWindow"),
                    plain("menuTableFixedWidth"),
                    Node::Separator,
                    plain("menuTableDistributeRows"),
                    plain("menuTableDistributeColumns"),
                ],
            ),
            plain("menuTableRepeatHeader"),
            Node::Separator,
            plain("menuTableGridlines"),
            plain("menuTableProperties"),
        ],
    );
    let mut tools = vec![plain("menuWordCount"), plain("menuAutoCorrect")];
    // Word for Mac keeps Settings in the application menu
    if !ctx.mac() {
        tools.push(ctx.settings());
    }
    tools.push(Node::Separator);
    tools.push(plain("menuAiProofread"));
    let tools = submenu(&d("menuTools"), tools);
    let help = Node::Menu {
        label: d("menuHelp"),
        role: MenuRole::Help,
        items: vec![
            unbound(&d("menuShortcuts"), Some("CmdOrCtrl+/")),
            Node::Separator,
            ctx.about(),
        ],
    };
    let mut menus: Vec<Node> = ctx.app_menu().into_iter().collect();
    menus.extend([file, edit, view, insert, format, table, tools]);
    menus.push(ctx.window_menu());
    menus.push(help);
    menus
}

// ---- Sheets and Slides ----

fn sheets_menus(ctx: &Ctx) -> Vec<Node> {
    let s = |key: &str| ctx.sheets(key);
    let file = submenu(
        &s("menuFile"),
        vec![
            unbound(&s("menuOpenWorkbook"), Some("CmdOrCtrl+O")),
            Node::Separator,
            ctx.back_to_home(),
            Node::Separator,
            unbound(&s("menuSave"), Some("CmdOrCtrl+S")),
            unbound(&s("menuSaveAs"), Some("Shift+CmdOrCtrl+S")),
            Node::Separator,
            unbound(&s("menuPrint"), Some("CmdOrCtrl+P")),
            Node::Separator,
            unbound(&s("menuExportPdf"), None),
            unbound(&s("menuExportCsv"), None),
            unbound(&s("menuExportOds"), None),
            Node::Separator,
            item(&s("menuClose"), Some("CmdOrCtrl+W"), Act::Close),
            Node::Separator,
            ctx.settings(),
        ],
    );
    // Undo and Redo go to the sheet: the page's roles would bind them to a
    // text-editing no-op that starves Univer of the shortcut
    let r = &ctx.roles;
    let edit = submenu(
        &s("menuEdit"),
        vec![
            unbound(&s("menuUndo"), Some("CmdOrCtrl+Z")),
            unbound(&s("menuRedo"), Some("Shift+CmdOrCtrl+Z")),
            Node::Separator,
            role(Role::Cut, &r.cut),
            role(Role::Copy, &r.copy),
            role(Role::Paste, &r.paste),
            Node::Separator,
            role(Role::SelectAll, &r.select_all),
        ],
    );
    // Ctrl+R is Fill Right and Ctrl+0/+/- hide columns or zoom the sheet: a
    // menu accelerator would swallow them
    let view = ctx.node(&view_menu_template(
        ctx.os.node(),
        &ctx.labels,
        ViewMenuOptions {
            dev_items: ctx.dev_tools,
            page_zoom: false,
        },
    ));
    let mut menus: Vec<Node> = ctx.app_menu().into_iter().collect();
    menus.extend([file, edit]);
    menus.extend(view);
    menus.push(ctx.window_menu());
    menus.extend(ctx.node(&help_menu_template(&ctx.labels, Vec::new(), ctx.os.node())));
    menus
}

fn slides_menus(ctx: &Ctx) -> Vec<Node> {
    let s = |key: &str| ctx.slides(key);
    let menu = |key: &str, accelerator: Option<&str>, command: &str| {
        emit(&s(key), accelerator, "slides:menu", vec![text(command)])
    };
    let file = submenu(
        &s("menuFile"),
        vec![
            menu("menuOpen", Some("CmdOrCtrl+O"), "open"),
            Node::Separator,
            ctx.back_to_home(),
            Node::Separator,
            menu("menuSave", Some("CmdOrCtrl+S"), "save"),
            menu("menuSaveAs", Some("CmdOrCtrl+Shift+S"), "save-as"),
            // macOS has no File ribbon tab: this is its only AI naming entry
            emit(
                ctx.labels.name_with_ai(),
                None,
                "slides:menu",
                vec![text("name-with-ai")],
            ),
            Node::Separator,
            menu("menuExportPdf", None, "export-pdf"),
            menu("menuExportImages", None, "export-images"),
            menu("menuExportImagesJpg", None, "export-images-jpg"),
            menu("menuPrint", Some("CmdOrCtrl+P"), "print"),
            Node::Separator,
            item(&s("menuClose"), Some("CmdOrCtrl+W"), Act::Close),
            Node::Separator,
            ctx.settings(),
        ],
    );
    // the clipboard goes to the renderer too: in text state it calls back to the
    // native clipboard, in canvas state it uses the element clipboard
    let edit = submenu(
        &s("menuEdit"),
        vec![
            menu("menuUndo", Some("CmdOrCtrl+Z"), "undo"),
            menu("menuRedo", Some("Shift+CmdOrCtrl+Z"), "redo"),
            Node::Separator,
            menu("menuCut", Some("CmdOrCtrl+X"), "cut"),
            menu("menuCopy", Some("CmdOrCtrl+C"), "copy"),
            menu("menuPaste", Some("CmdOrCtrl+V"), "paste"),
            role(Role::SelectAll, &ctx.roles.select_all),
        ],
    );
    let mut view = vec![
        menu("menuZoomIn", Some("CmdOrCtrl+="), "zoom-in"),
        menu("menuZoomOut", Some("CmdOrCtrl+-"), "zoom-out"),
        menu("menuActualSize", Some("CmdOrCtrl+0"), "zoom-reset"),
    ];
    if let Some(dev_tools) = ctx.dev_tools_item() {
        view.push(Node::Separator);
        view.push(dev_tools);
    }
    let view = submenu(&s("menuView"), view);
    let mut menus: Vec<Node> = ctx.app_menu().into_iter().collect();
    menus.extend([file, edit, view]);
    menus.extend(ctx.node(&help_menu_template(&ctx.labels, Vec::new(), ctx.os.node())));
    menus
}

// ---- all of it ----

/// `withHelpItems`: the user guide and the feedback survey in whatever Help
/// menu the kind built, the guide only where the menu has none of its own
fn with_help_items(ctx: &Ctx, menus: &mut [Node]) {
    let Some(Node::Menu { items, .. }) = menus.iter_mut().find(|menu| {
        matches!(
            menu,
            Node::Menu {
                role: MenuRole::Help,
                ..
            }
        )
    }) else {
        return;
    };
    let feedback = item(
        &feedback_text(ctx.lang, "menuLabel", None),
        None,
        Act::Feedback,
    );
    let has_guide = items
        .iter()
        .any(|entry| matches!(entry, Node::Item(i) if i.accelerator.as_deref() == Some("F1")));
    let mut head = if has_guide {
        vec![feedback, Node::Separator]
    } else {
        vec![
            item(&ctx.tm("menuUserGuide"), Some("F1"), Act::UserGuide),
            Node::Separator,
            feedback,
            Node::Separator,
        ]
    };
    head.append(items);
    *items = head;
}

/// Where batch M's table found each item of `menus`, by label path
#[derive(Debug, Default, PartialEq)]
struct Bound {
    found: Vec<Vec<String>>,
    /// items that wait for an event and the table has none for
    missing: Vec<Vec<String>>,
}

/// Replaces each [`Act::Unbound`] with the event the table names for its label path
fn bind_events(menus: &mut [Node], table: &AppMenuItems) -> Bound {
    fn walk(nodes: &mut [Node], path: &mut Vec<String>, table: &AppMenuItems, bound: &mut Bound) {
        for node in nodes {
            match node {
                Node::Menu { label, items, .. } => {
                    path.push(label.clone());
                    walk(items, path, table, bound);
                    path.pop();
                }
                Node::Item(item) if item.act == Some(Act::Unbound) => {
                    path.push(item.label.clone());
                    match table.iter().find(|(known, _)| known == path) {
                        Some((_, MenuAction::Event { channel, args })) => {
                            item.act = Some(Act::Emit {
                                channel,
                                args: args.clone(),
                            });
                            bound.found.push(path.clone());
                        }
                        None => bound.missing.push(path.clone()),
                    }
                    path.pop();
                }
                _ => {}
            }
        }
    }
    let mut bound = Bound::default();
    walk(menus, &mut Vec::new(), table, &mut bound);
    bound
}

/// Electron dropped a separator at either end of a menu and ran of them
/// together; so does this, which also covers an item left out
fn tidy(nodes: Vec<Node>) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::new();
    for node in nodes {
        match node {
            Node::Separator => {
                if !matches!(out.last(), None | Some(Node::Separator)) {
                    out.push(Node::Separator);
                }
            }
            Node::Menu { label, role, items } => out.push(Node::Menu {
                label,
                role,
                items: tidy(items),
            }),
            other => out.push(other),
        }
    }
    while matches!(out.last(), Some(Node::Separator)) {
        out.pop();
    }
    out
}

/// `applyMenuFor(kind)`'s menus: what the kind shows, in `ctx`'s language
fn menu_for(kind: TabKind, ctx: &Ctx) -> Vec<Node> {
    let mut menus = match kind {
        TabKind::Docs => docs_menus(ctx),
        TabKind::Sheets => sheets_menus(ctx),
        TabKind::Slides => slides_menus(ctx),
        TabKind::Pdf => pdf_menus(ctx),
        TabKind::Markdown => markdown_menus(ctx),
        TabKind::Html => html_menus(ctx),
        TabKind::Mindmap => mindmap_menus(ctx),
        TabKind::Hwp => hwp_menus(ctx),
        TabKind::Epub => epub_menus(ctx),
        TabKind::Diagram => diagram_menus(ctx),
        // the Help tab shows the home menu too
        TabKind::Home | TabKind::Help => home_menus(ctx),
    };
    with_help_items(ctx, &mut menus);
    let bound = bind_events(&mut menus, &app_menu_items(kind.as_str(), ctx.lang));
    for path in &bound.missing {
        eprintln!("shell: the {kind:?} menu item {path:?} has no event in batch M's table");
    }
    // an item with no event cannot do anything: it is not shown
    drop_unbound(tidy(menus))
}

fn drop_unbound(nodes: Vec<Node>) -> Vec<Node> {
    tidy(
        nodes
            .into_iter()
            .filter_map(|node| match node {
                Node::Item(Item {
                    act: Some(Act::Unbound),
                    ..
                }) => None,
                Node::Menu { label, role, items } => Some(Node::Menu {
                    label,
                    role,
                    items: drop_unbound(items),
                }),
                other => Some(other),
            })
            .collect(),
    )
}

// ---- ids ----

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Gives each item with an action the id `m-app-<n>`; the ids never repeat,
/// so a click on a menu that was replaced meanwhile finds nothing
fn number(menus: &mut [Node], next: &AtomicU32) -> HashMap<String, Act> {
    fn walk(nodes: &mut [Node], next: &AtomicU32, clicks: &mut HashMap<String, Act>) {
        for node in nodes {
            match node {
                Node::Menu { items, .. } => walk(items, next, clicks),
                Node::Item(item) => {
                    if let Some(act) = &item.act {
                        let id = format!("{ID_PREFIX}{}", next.fetch_add(1, Ordering::Relaxed));
                        clicks.insert(id.clone(), act.clone());
                        item.id = Some(id);
                    }
                }
                _ => {}
            }
        }
    }
    let mut clicks = HashMap::new();
    walk(menus, next, &mut clicks);
    clicks
}

/// What each id of the menu now set does, and for which kind of tab
static CLICKS: Mutex<Option<(TabKind, HashMap<String, Act>)>> = Mutex::new(None);

/// The kind of the menu last asked for, for a rebuild in another language
static KIND: Mutex<Option<TabKind>> = Mutex::new(None);

/// What a docs view last reported for its View and Insert menus
static DOCS_VIEWS: Mutex<Option<HashMap<ViewId, DocsViewState>>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---- Tauri ----

enum Built {
    Item(TauriItem<DynRuntime>),
    Check(CheckMenuItem<DynRuntime>),
    Predefined(PredefinedMenuItem<DynRuntime>),
    Submenu(Submenu<DynRuntime>),
}

impl Built {
    fn as_item(&self) -> &dyn IsMenuItem<DynRuntime> {
        match self {
            Built::Item(i) => i,
            Built::Check(i) => i,
            Built::Predefined(i) => i,
            Built::Submenu(i) => i,
        }
    }
}

fn predefined(
    app: &AppHandle,
    role: Role,
    label: Option<&str>,
) -> tauri::Result<PredefinedMenuItem<DynRuntime>> {
    match role {
        Role::About => PredefinedMenuItem::about(app, label, None),
        Role::Services => PredefinedMenuItem::services(app, label),
        Role::Hide => PredefinedMenuItem::hide(app, label),
        Role::HideOthers => PredefinedMenuItem::hide_others(app, label),
        Role::Unhide => PredefinedMenuItem::show_all(app, label),
        Role::Quit => PredefinedMenuItem::quit(app, label),
        Role::Undo => PredefinedMenuItem::undo(app, label),
        Role::Redo => PredefinedMenuItem::redo(app, label),
        Role::Cut => PredefinedMenuItem::cut(app, label),
        Role::Copy => PredefinedMenuItem::copy(app, label),
        Role::Paste => PredefinedMenuItem::paste(app, label),
        Role::SelectAll => PredefinedMenuItem::select_all(app, label),
        Role::Minimize => PredefinedMenuItem::minimize(app, label),
        Role::Zoom => PredefinedMenuItem::maximize(app, label),
        Role::Front => PredefinedMenuItem::bring_all_to_front(app, label),
        Role::Fullscreen => PredefinedMenuItem::fullscreen(app, label),
        Role::CloseWindow => PredefinedMenuItem::close_window(app, label),
    }
}

fn build_node(app: &AppHandle, node: &Node) -> tauri::Result<Built> {
    Ok(match node {
        Node::Separator => Built::Predefined(PredefinedMenuItem::separator(app)?),
        Node::Role { role, label } => Built::Predefined(predefined(app, *role, label.as_deref())?),
        Node::Item(item) => {
            let id = item.id.clone().unwrap_or_default();
            let accelerator = item.accelerator.as_deref();
            match item.checked {
                Some(checked) => Built::Check(CheckMenuItem::with_id(
                    app,
                    id,
                    &item.label,
                    item.enabled,
                    checked,
                    accelerator,
                )?),
                None => Built::Item(TauriItem::with_id(
                    app,
                    id,
                    &item.label,
                    item.enabled,
                    accelerator,
                )?),
            }
        }
        Node::Menu { label, role, items } => {
            let built = build_nodes(app, items)?;
            let refs: Vec<&dyn IsMenuItem<DynRuntime>> = built.iter().map(Built::as_item).collect();
            let menu = Submenu::with_items(app, label, true, &refs)?;
            if cfg!(target_os = "macos") {
                match role {
                    MenuRole::Window => menu.set_as_windows_menu_for_nsapp()?,
                    MenuRole::Help => menu.set_as_help_menu_for_nsapp()?,
                    MenuRole::Plain => {}
                }
            }
            Built::Submenu(menu)
        }
    })
}

fn build_nodes(app: &AppHandle, nodes: &[Node]) -> tauri::Result<Vec<Built>> {
    nodes.iter().map(|node| build_node(app, node)).collect()
}

fn build_menu(app: &AppHandle, menus: &[Node]) -> tauri::Result<Menu<DynRuntime>> {
    let built = build_nodes(app, menus)?;
    let refs: Vec<&dyn IsMenuItem<DynRuntime>> = built.iter().map(Built::as_item).collect();
    Menu::with_items(app, &refs)
}

/// On the UI thread: numbers the items, makes the Tauri menu and sets it
fn set_menu(app: &AppHandle, kind: TabKind, mut menus: Vec<Node>) {
    let clicks = number(&mut menus, &NEXT_ID);
    match build_menu(app, &menus).and_then(|menu| app.set_menu(menu)) {
        Ok(_) => *lock(&CLICKS) = Some((kind, clicks)),
        Err(error) => eprintln!("shell: setting the {kind:?} menu: {error}"),
    }
}

// ---- the entry points ----

struct Shell {
    app: AppHandle,
    windows: Arc<Windows>,
}

static SHELL: OnceLock<Shell> = OnceLock::new();

/// Registers the one listener for this menu's clicks; `host/menu.rs`'s `install` calls it
pub(crate) fn install(cx: &HostContext) {
    let _ = SHELL.set(Shell {
        app: cx.app.clone(),
        windows: cx.windows.clone(),
    });
    cx.app
        .on_menu_event(|app, event| dispatch(app, event.id().as_ref()));
}

/// `applyMenuFor(kind)`: sets the application menu of the active editor of
/// `kind`. Callable from any thread, never blocks: the menu is made from the
/// core thread's state and set on the UI thread.
pub(crate) fn apply_menu_for(app: &AppHandle, kind: TabKind) {
    *lock(&KIND) = Some(kind);
    let app = app.clone();
    post_core(move |provided, services| {
        let lang = match current_lang(services) {
            Ok(lang) => lang,
            Err(error) => return eprintln!("shell: the {kind:?} menu: {error}"),
        };
        let docs_view = if kind == TabKind::Docs {
            shell_tabs(provided)
                .and_then(|tabs| tabs.active_editor(TabKind::Docs))
                .and_then(|view| lock(&DOCS_VIEWS).as_ref()?.get(&view).copied())
                .unwrap_or_default()
        } else {
            DocsViewState::default()
        };
        let ctx = Ctx::new(
            Os::current(),
            lang,
            app.package_info().name.clone(),
            DEV_TOOLS,
            if kind == TabKind::Docs {
                recent_documents(services)
            } else {
                Vec::new()
            },
            docs_view,
        );
        let menus = menu_for(kind, &ctx);
        let on_ui = app.clone();
        if let Err(error) = app.run_on_main_thread(move || set_menu(&on_ui, kind, menus)) {
            eprintln!("shell: the {kind:?} menu: {error}");
        }
    });
}

/// A docs view reported the state of its View and Insert menus
/// (`docs:view-menu-state`): the menu shows it while the view is the active docs tab
#[allow(dead_code)] // called by D2's `docs:view-menu-state` host
pub(crate) fn note_docs_view_state(app: &AppHandle, view: ViewId, state: DocsViewState) {
    lock(&DOCS_VIEWS)
        .get_or_insert_with(HashMap::new)
        .insert(view, state);
    let app = app.clone();
    post_core(move |provided, _| {
        let active = shell_tabs(provided).and_then(|tabs| tabs.active_editor(TabKind::Docs));
        if active == Some(view) && *lock(&KIND) == Some(TabKind::Docs) {
            apply_menu_for(&app, TabKind::Docs);
        }
    });
}

/// `readJson<string[]>(RECENT_PATH(), []).slice(0, 10)`: Docs' own list
fn recent_documents(services: &Services) -> Vec<String> {
    let path = services.paths.path(PathName::UserData).join("recent.json");
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .map(|mut paths| {
            paths.truncate(10);
            paths
        })
        .unwrap_or_default()
}

// ---- clicks ----

fn dispatch(app: &AppHandle, id: &str) {
    if !id.starts_with(ID_PREFIX) {
        return;
    }
    let Some((kind, act)) = lock(&CLICKS)
        .as_ref()
        .and_then(|(kind, clicks)| clicks.get(id).map(|act| (*kind, act.clone())))
    else {
        return;
    };
    match act {
        Act::MinimizeWindow => with_focused_window(app, |window| window.minimize()),
        Act::CloseWindow => with_focused_window(app, |window| window.close()),
        act => post_core(move |provided, services| run(act, kind, provided, services)),
    }
}

/// `BrowserWindow.getFocusedWindow()`; the menu event runs on the UI thread
fn with_focused_window(app: &AppHandle, act: impl FnOnce(&tauri::Window) -> tauri::Result<()>) {
    let focused = app
        .windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false));
    if let Some(Err(error)) = focused.as_ref().map(act) {
        eprintln!("shell: a menu click on the focused window: {error}");
    }
}

/// The view a click on `kind`'s menu is about: its active editor, else the
/// shell window's own view (Home and Help have no editor)
fn target_view(provided: &Provided, services: &Services, kind: TabKind) -> Option<ViewId> {
    shell_tabs(provided)
        .and_then(|tabs| tabs.active_editor(kind))
        .or_else(|| services.hosts.get::<MainWindowHost>()?.view())
}

/// On the core thread
fn run(act: Act, kind: TabKind, provided: &Provided, services: &Services) {
    let Some(tabs) = shell_tabs(provided) else {
        return;
    };
    let editor = || tabs.active_editor(kind);
    match act {
        Act::Unbound | Act::MinimizeWindow | Act::CloseWindow => {}
        Act::Emit { channel, args } => {
            if let Some(view) = editor() {
                services.events.emit(Target::View(view), channel, args);
            }
        }
        Act::Open => tabs.open_file_via_dialog(),
        Act::OpenRecent(path) => {
            tabs.open_path(&path);
        }
        Act::BackToHome => tabs.open_home_tab(),
        Act::Close => tabs.close_focused_editor(),
        Act::Save(mode) => {
            let Some(view) = editor() else { return };
            if let Some(app) = editor_for(provided, view) {
                app.request_save(
                    view,
                    mode,
                    Box::new(move |done| {
                        if let Err(error) = done {
                            eprintln!("shell: menu {mode:?} of view {}: {}", view.0, error.message);
                        }
                    }),
                );
            }
        }
        Act::Export(format) => {
            let Some(view) = editor() else { return };
            if let Some(app) = editor_for(provided, view) {
                app.export_request(view, format);
            }
        }
        Act::Settings => {
            // the Settings view lives in the Home tab: the window comes back
            // first if it was hidden or minimized
            tabs.reveal_shell_window();
            tabs.open_home_tab();
            if let Some(view) = services
                .hosts
                .get::<MainWindowHost>()
                .and_then(|m| m.view())
            {
                services.events.emit(
                    Target::View(view),
                    "home:open-settings",
                    vec![IpcValue::Object(vec![("section".into(), text("general"))])],
                );
            }
        }
        Act::About => {
            let services = services.clone();
            services
                .workers
                .clone()
                .spawn(Box::new(move || show_about(&services)));
        }
        Act::Feedback => {
            let services = services.clone();
            services
                .workers
                .clone()
                .spawn(Box::new(move || open_feedback_survey(&services)));
        }
        Act::UserGuide => {
            if let Some(home) = services.hosts.get::<HomeAppHost>() {
                home.open_help(None);
            }
        }
        Act::ThirdPartyNotices => {
            if let (Some(home), Some(os)) = (
                services.hosts.get::<HomeAppHost>(),
                services.hosts.get::<OsShellHost>(),
            ) {
                let failure = os.open_path(&home.third_party_notices_path());
                if !failure.is_empty() {
                    eprintln!("shell: opening the third-party notices: {failure}");
                }
            }
        }
        Act::ToggleDevTools => on_webview(provided, services, kind, |webview| {
            #[cfg(any(debug_assertions, feature = "devtools"))]
            if webview.is_devtools_open() {
                webview.close_devtools();
            } else {
                webview.open_devtools();
            }
            #[cfg(not(any(debug_assertions, feature = "devtools")))]
            let _ = webview;
        }),
        Act::Reload { ignore_cache } => on_webview(provided, services, kind, move |webview| {
            let reloaded = webview.with_cef_webview(move |cef| {
                use cef::ImplBrowser;
                let browser = cef.browser();
                if ignore_cache {
                    browser.reload_ignore_cache();
                } else {
                    browser.reload();
                }
            });
            if let Err(error) = reloaded {
                eprintln!("shell: reload: {error}");
            }
        }),
        Act::Frame(edit) => on_webview(provided, services, kind, move |webview| {
            let edited = webview.with_cef_webview(move |cef| {
                use cef::{ImplBrowser, ImplFrame};
                if let Some(frame) = cef.browser().focused_frame() {
                    match edit {
                        FrameEdit::Delete => frame.del(),
                        FrameEdit::PasteAndMatchStyle => frame.paste_and_match_style(),
                    }
                }
            });
            if let Err(error) = edited {
                eprintln!("shell: {edit:?}: {error}");
            }
        }),
    }
}

/// Runs `job` on the UI thread with the webview of `kind`'s active view
fn on_webview(
    provided: &Provided,
    services: &Services,
    kind: TabKind,
    job: impl FnOnce(&tauri::Webview) + Send + 'static,
) {
    let (Some(shell), Some(view)) = (SHELL.get(), target_view(provided, services, kind)) else {
        return;
    };
    let windows = shell.windows.clone();
    let _ = shell.app.run_on_main_thread(move || {
        if let Some(webview) = windows.webview(view) {
            job(&webview);
        }
    });
}

/// Help > About. Runs on a worker: the box waits for the answer
fn show_about(services: &Services) {
    let (Some(shell), Ok(lang)) = (SHELL.get(), current_lang(services)) else {
        return;
    };
    let hosts = &services.hosts;
    let (Some(dialogs), Some(clipboard)) =
        (hosts.get::<DialogsHost>(), hosts.get::<ClipboardHost>())
    else {
        return;
    };
    let version = shell.app.package_info().version.to_string();
    let labels = app_menu_labels(lang.as_str());
    // `can_check` is false: the updater is not in the shell (module docs)
    let options = about_box(&labels, &version, lang.as_str(), false);
    let answer = dialogs.message(
        None,
        &MessageBox {
            kind: Some(options.kind.to_owned()),
            title: options.title,
            message: options.message,
            detail: options.detail,
            buttons: options.buttons,
            default_id: Some(options.default_id as usize),
            cancel_id: options.cancel_id.map(|id| id as usize),
            checkbox_label: None,
        },
    );
    if let AboutAnswer::CopyText(copied) = about_answer(answer.response as f64, &version) {
        clipboard.write_text(&copied);
    }
}

/// `openFeedbackSurvey`: shows the details that go into the survey, copies
/// them and opens the survey; the app sends nothing itself. Runs on a worker.
fn open_feedback_survey(services: &Services) {
    let (Some(shell), Ok(lang)) = (SHELL.get(), current_lang(services)) else {
        return;
    };
    let hosts = &services.hosts;
    let (Some(dialogs), Some(clipboard), Some(os), Some(home)) = (
        hosts.get::<DialogsHost>(),
        hosts.get::<ClipboardHost>(),
        hosts.get::<OsShellHost>(),
        hosts.get::<HomeAppHost>(),
    ) else {
        return;
    };
    let detail = feedback_details(
        lang,
        &FeedbackEnvironment {
            version: shell.app.package_info().version.to_string(),
            os: format!(
                "{} {}",
                platform_label(Os::current().node()),
                home.os_release()
            ),
            language: lang.as_str().to_owned(),
        },
    );
    let text = |key: &str| feedback_text(lang, key, None);
    let answer = dialogs.message(
        hosts.get::<MainWindowHost>().and_then(|main| main.window()),
        &MessageBox {
            kind: Some("info".into()),
            title: Some(text("dialogTitle")),
            message: text("dialogTitle"),
            detail: Some(format!("{}\n\n{detail}", text("dialogBody"))),
            buttons: vec![text("btnOpen"), text("btnCancel")],
            default_id: Some(0),
            cancel_id: Some(1),
            checkbox_label: None,
        },
    );
    if answer.response == 0 {
        clipboard.write_text(&detail);
        // the survey is only offered: a missing browser handler is not reported
        let _ = os.open_external(FEEDBACK_SURVEY_URL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(os: Os, lang: Lang) -> Ctx {
        Ctx::new(
            os,
            lang,
            "SeuOffice".into(),
            true,
            Vec::new(),
            DocsViewState::default(),
        )
    }

    const KINDS: [TabKind; 12] = [
        TabKind::Home,
        TabKind::Docs,
        TabKind::Sheets,
        TabKind::Slides,
        TabKind::Pdf,
        TabKind::Markdown,
        TabKind::Html,
        TabKind::Mindmap,
        TabKind::Hwp,
        TabKind::Epub,
        TabKind::Diagram,
        TabKind::Help,
    ];

    /// The menu without Tauri: one line per node, a submenu's items indented
    fn describe(nodes: &[Node]) -> Vec<String> {
        fn walk(nodes: &[Node], depth: usize, out: &mut Vec<String>) {
            let pad = "  ".repeat(depth);
            for node in nodes {
                match node {
                    Node::Separator => out.push(format!("{pad}---")),
                    Node::Role { role, label } => {
                        out.push(format!(
                            "{pad}<{role:?}> {}",
                            label.as_deref().unwrap_or("")
                        ));
                    }
                    Node::Item(item) => {
                        let mut line = format!("{pad}{}", item.label);
                        if let Some(accelerator) = &item.accelerator {
                            line += &format!(" [{accelerator}]");
                        }
                        if !item.enabled {
                            line += " (disabled)";
                        }
                        if let Some(checked) = item.checked {
                            line += if checked {
                                " (checked)"
                            } else {
                                " (unchecked)"
                            };
                        }
                        out.push(line);
                    }
                    Node::Menu { label, items, .. } => {
                        out.push(format!("{pad}{label} >"));
                        walk(items, depth + 1, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(nodes, 0, &mut out);
        out
    }

    fn items(nodes: &[Node]) -> Vec<&Item> {
        let mut out = Vec::new();
        for node in nodes {
            match node {
                Node::Item(item) => out.push(item),
                Node::Menu { items: inner, .. } => out.extend(items(inner)),
                _ => {}
            }
        }
        out
    }

    fn top_labels(nodes: &[Node]) -> Vec<String> {
        nodes
            .iter()
            .filter_map(|node| match node {
                Node::Menu { label, .. } => Some(label.clone()),
                _ => None,
            })
            .collect()
    }

    fn lines_of(kind: TabKind, os: Os, lang: Lang) -> Vec<String> {
        describe(&menu_for(kind, &ctx(os, lang)))
    }

    #[test]
    fn every_event_of_batch_m_has_its_item_and_every_item_its_action() {
        for lang in [Lang::En, Lang::Ko] {
            for os in [Os::Mac, Os::Windows, Os::Linux] {
                for kind in KINDS {
                    let c = ctx(os, lang);
                    let mut menus = match kind {
                        TabKind::Docs => docs_menus(&c),
                        TabKind::Sheets => sheets_menus(&c),
                        TabKind::Pdf => pdf_menus(&c),
                        TabKind::Markdown => markdown_menus(&c),
                        TabKind::Html => html_menus(&c),
                        TabKind::Mindmap => mindmap_menus(&c),
                        TabKind::Hwp => hwp_menus(&c),
                        TabKind::Diagram => diagram_menus(&c),
                        _ => continue,
                    };
                    let table = app_menu_items(kind.as_str(), lang);
                    let bound = bind_events(&mut menus, &table);
                    assert_eq!(
                        bound.missing,
                        Vec::<Vec<String>>::new(),
                        "{kind:?} {lang:?}"
                    );
                    let mut found = bound.found.clone();
                    found.sort();
                    let mut known: Vec<_> = table.iter().map(|(path, _)| path.clone()).collect();
                    known.sort();
                    assert_eq!(found, known, "{kind:?} {os:?} {lang:?}");
                }
            }
        }
    }

    #[test]
    fn a_built_menu_has_no_unbound_item_and_no_stray_separator() {
        fn check(nodes: &[Node]) {
            assert!(!matches!(nodes.first(), Some(Node::Separator)), "{nodes:?}");
            assert!(!matches!(nodes.last(), Some(Node::Separator)), "{nodes:?}");
            for pair in nodes.windows(2) {
                assert!(
                    !matches!(pair, [Node::Separator, Node::Separator]),
                    "{nodes:?}"
                );
            }
            for node in nodes {
                if let Node::Menu { items, .. } = node {
                    assert!(!items.is_empty());
                    check(items);
                }
            }
        }
        for kind in KINDS {
            for os in [Os::Mac, Os::Windows, Os::Linux] {
                let menus = menu_for(kind, &ctx(os, Lang::En));
                check(&menus);
                assert!(
                    items(&menus).iter().all(|i| i.act != Some(Act::Unbound)),
                    "{kind:?}"
                );
            }
        }
    }

    #[test]
    fn the_application_menu_is_the_macs_alone() {
        let mac = lines_of(TabKind::Pdf, Os::Mac, Lang::En);
        assert_eq!(mac[0], "SeuOffice >");
        assert_eq!(mac[1], "  <About> About SeuOffice");
        let linux = menu_for(TabKind::Pdf, &ctx(Os::Linux, Lang::En));
        assert_eq!(top_labels(&linux), ["File", "Edit", "Window", "Help"]);
        // Settings is in File where the application menu is not
        assert!(items(&linux).iter().any(|i| i.act == Some(Act::Settings)));
    }

    #[test]
    fn the_kinds_have_the_menus_their_typescript_builders_have() {
        let tops = |kind, os| top_labels(&menu_for(kind, &ctx(os, Lang::En)));
        assert_eq!(
            tops(TabKind::Docs, Os::Linux),
            [
                "File", "Edit", "View", "Insert", "Format", "Table", "Tools", "Window", "Help"
            ]
        );
        assert_eq!(
            tops(TabKind::Sheets, Os::Linux),
            ["File", "Edit", "View", "Window", "Help"]
        );
        assert_eq!(
            tops(TabKind::Slides, Os::Linux),
            ["File", "Edit", "View", "Help"]
        );
        assert_eq!(
            tops(TabKind::Epub, Os::Linux),
            ["File", "Edit", "View", "Window", "Help"]
        );
        assert_eq!(
            tops(TabKind::Mindmap, Os::Linux),
            ["File", "Edit", "Window", "Help"]
        );
        assert_eq!(tops(TabKind::Help, Os::Mac)[0], "SeuOffice");
        assert_eq!(
            tops(TabKind::Help, Os::Linux),
            tops(TabKind::Home, Os::Linux)
        );
    }

    #[test]
    fn the_pdf_file_menu_in_english_and_korean() {
        let en = lines_of(TabKind::Pdf, Os::Linux, Lang::En);
        assert_eq!(
            &en[..17],
            [
                "File >",
                "  Open\u{2026} [CmdOrCtrl+O]",
                "  ---",
                "  Back to Home [Shift+CmdOrCtrl+H]",
                "  ---",
                "  Save [CmdOrCtrl+S]",
                "  Save As\u{2026} [CmdOrCtrl+Shift+S]",
                "  ---",
                "  Export as Markdown\u{2026}",
                "  Export as EPUB\u{2026}",
                "  ---",
                "  Print\u{2026} [CmdOrCtrl+P]",
                "  ---",
                "  Close [CmdOrCtrl+W]",
                "  ---",
                "  Settings\u{2026} [CmdOrCtrl+,]",
                "Edit >",
            ]
        );
        let ko = lines_of(TabKind::Pdf, Os::Linux, Lang::Ko);
        assert_eq!(ko[0], "\u{D30C}\u{C77C} >");
        assert_eq!(ko[1], "  \u{C5F4}\u{AE30}\u{2026} [CmdOrCtrl+O]");
    }

    #[test]
    fn help_gets_the_guide_and_the_survey_once() {
        let help = |kind| {
            let lines = lines_of(kind, Os::Linux, Lang::En);
            let at = lines.iter().position(|l| l == "Help >").unwrap();
            lines[at..].to_vec()
        };
        // Home has its own guide: the survey goes before it
        assert_eq!(
            help(TabKind::Home),
            [
                "Help >",
                "  Send feedback",
                "  ---",
                "  User Guide [F1]",
                "  ---",
                "  Third-Party Notices",
                "  ---",
                "  About SeuOffice",
            ]
        );
        for kind in [
            TabKind::Docs,
            TabKind::Sheets,
            TabKind::Slides,
            TabKind::Pdf,
        ] {
            let lines = help(kind);
            assert_eq!(
                lines.iter().filter(|l| l.contains("[F1]")).count(),
                1,
                "{kind:?}"
            );
            assert_eq!(lines[1], "  User Guide [F1]", "{kind:?}");
        }
    }

    #[test]
    fn check_for_updates_is_left_out_everywhere() {
        for kind in KINDS {
            for os in [Os::Mac, Os::Windows, Os::Linux] {
                for lang in [Lang::En, Lang::Ko] {
                    let labels = app_menu_labels(lang.as_str());
                    let menus = menu_for(kind, &ctx(os, lang));
                    assert!(
                        items(&menus)
                            .iter()
                            .all(|i| i.label != labels.check_updates()),
                        "{kind:?} {os:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_docs_menu_follows_the_recent_list_and_the_view_state() {
        let mut c = ctx(Os::Linux, Lang::En);
        let none = describe(&menu_for(TabKind::Docs, &c));
        let at = none.iter().position(|l| l.contains("Open Recent")).unwrap();
        assert_eq!(none[at + 1], "    No Recent Documents (disabled)");
        assert!(none.contains(&"  AI Sidebar (checked)".to_owned()));
        assert!(none.contains(&"  Dark Mode (unchecked)".to_owned()));

        c.recent = vec!["/home/a/one.docx".into(), "/home/a/two.docx".into()];
        c.docs_view = DocsViewState {
            ai_sidebar: false,
            dark_canvas: true,
            odt: true,
        };
        let menus = menu_for(TabKind::Docs, &c);
        let lines = describe(&menus);
        assert!(lines.contains(&"    one.docx".to_owned()));
        assert!(lines.contains(&"    two.docx".to_owned()));
        assert!(lines.contains(&"  AI Sidebar (unchecked)".to_owned()));
        assert!(lines.contains(&"  Dark Mode (checked)".to_owned()));
        assert!(lines.contains(&"  Equation\u{2026} (disabled)".to_owned()));
        assert!(lines.contains(&"  Comment (disabled)".to_owned()));
        let recent: Vec<_> = items(&menus)
            .into_iter()
            .filter_map(|i| match &i.act {
                Some(Act::OpenRecent(path)) => Some(path.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(recent, ["/home/a/one.docx", "/home/a/two.docx"]);
    }

    #[test]
    fn settings_lives_in_tools_off_the_mac_and_in_the_application_menu_on_it() {
        let settings_in = |os| {
            let menus = menu_for(TabKind::Docs, &ctx(os, Lang::En));
            menus
                .iter()
                .filter_map(|menu| match menu {
                    Node::Menu {
                        label,
                        items: inner,
                        ..
                    } if !self::items(inner)
                        .iter()
                        .all(|i| i.act != Some(Act::Settings)) =>
                    {
                        Some(label.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(settings_in(Os::Mac), ["SeuOffice"]);
        assert_eq!(settings_in(Os::Linux), ["Tools"]);
    }

    #[test]
    fn keys_the_editor_takes_itself_are_shown_on_the_mac_only() {
        let key = |os| {
            lines_of(TabKind::Epub, os, Lang::En)
                .into_iter()
                .find(|l| l.starts_with("  Find"))
                .unwrap()
        };
        assert_eq!(key(Os::Mac), "  Find\u{2026} [CmdOrCtrl+F]");
        assert_eq!(key(Os::Windows), "  Find\u{2026}");
        let redo = |os| {
            lines_of(TabKind::Diagram, os, Lang::En)
                .into_iter()
                .find(|l| l.starts_with("  Redo"))
                .unwrap()
        };
        assert_eq!(redo(Os::Mac), "  Redo [Shift+Cmd+Z]");
        assert_eq!(redo(Os::Linux), "  Redo");
    }

    #[test]
    fn dev_tools_follow_the_build() {
        let mut c = ctx(Os::Linux, Lang::En);
        let toggles = |c: &Ctx, kind| {
            items(&menu_for(kind, c))
                .iter()
                .filter(|i| i.act == Some(Act::ToggleDevTools))
                .count()
        };
        assert_eq!(toggles(&c, TabKind::Docs), 1);
        assert_eq!(toggles(&c, TabKind::Slides), 1);
        assert_eq!(toggles(&c, TabKind::Sheets), 1);
        c.dev_tools = false;
        for kind in [TabKind::Docs, TabKind::Slides, TabKind::Sheets] {
            assert_eq!(toggles(&c, kind), 0, "{kind:?}");
        }
        // the Sheets View menu keeps Full Screen, and gains no Reload
        let lines = describe(&menu_for(TabKind::Sheets, &c));
        assert!(
            lines
                .iter()
                .any(|l| l.contains("Fullscreen") || l.contains("Full Screen"))
        );
        assert!(!lines.iter().any(|l| l.contains("Reload")));
    }

    #[test]
    fn slides_clicks_are_events_of_the_slides_view() {
        let menus = menu_for(TabKind::Slides, &ctx(Os::Linux, Lang::En));
        let events: Vec<_> = items(&menus)
            .into_iter()
            .filter_map(|i| match &i.act {
                Some(Act::Emit { channel, args }) => Some((*channel, args.clone())),
                _ => None,
            })
            .collect();
        assert!(events.iter().all(|(channel, _)| *channel == "slides:menu"));
        assert!(events.contains(&("slides:menu", vec![text("export-images-jpg")])));
        assert_eq!(events.len(), 16);
    }

    #[test]
    fn ids_map_to_their_clicks_and_never_repeat() {
        let next = AtomicU32::new(7);
        let mut first = menu_for(TabKind::Pdf, &ctx(Os::Linux, Lang::En));
        let clicks = number(&mut first, &next);
        let numbered = items(&first);
        let ids: Vec<_> = numbered.iter().filter_map(|i| i.id.clone()).collect();
        assert_eq!(ids.len(), clicks.len());
        assert_eq!(ids[0], "m-app-7");
        assert!(ids.iter().all(|id| id.starts_with(ID_PREFIX)));
        for item in numbered {
            assert_eq!(item.id.as_ref().map(|id| &clicks[id]), item.act.as_ref());
        }
        let save = items(&first)
            .into_iter()
            .find(|i| i.act == Some(Act::Save(SaveMode::SaveAs)))
            .and_then(|i| i.id.clone())
            .unwrap();
        assert_eq!(clicks[&save], Act::Save(SaveMode::SaveAs));

        // a rebuild's ids start where the last ones ended
        let mut second = menu_for(TabKind::Pdf, &ctx(Os::Linux, Lang::En));
        let again = number(&mut second, &next);
        assert!(clicks.keys().all(|id| !again.contains_key(id)));
    }

    /// Every key of every menu must be one muda (Tauri's menu) parses:
    /// modifiers `CmdOrCtrl`, `Cmd`, `Command`, `Ctrl`, `Alt`, `Shift`, and one
    /// key from its table. Electron's strings are valid as they stand, so the
    /// translation to Tauri is the identity; this keeps a typo from becoming
    /// a silently missing shortcut (Tauri drops a key it cannot parse).
    #[test]
    fn every_accelerator_is_one_tauris_menu_parses() {
        let modifiers = [
            "cmdorctrl",
            "cmd",
            "command",
            "ctrl",
            "control",
            "alt",
            "option",
            "shift",
        ];
        let key_ok = |key: &str| {
            matches!(key.len(), 1 if key.chars().all(|c| c.is_ascii_alphanumeric() || "=-/,".contains(c)))
                || (key.starts_with('F')
                    && key[1..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n)))
        };
        let mut seen = 0;
        for kind in KINDS {
            for os in [Os::Mac, Os::Windows, Os::Linux] {
                let menus = menu_for(kind, &ctx(os, Lang::En));
                for item in items(&menus) {
                    let Some(accelerator) = &item.accelerator else {
                        continue;
                    };
                    seen += 1;
                    let (key, mods) = accelerator
                        .rsplit_once('+')
                        .map_or((accelerator.as_str(), ""), |(mods, key)| (key, mods));
                    assert!(key_ok(key), "{accelerator}");
                    for modifier in mods.split('+').filter(|m| !m.is_empty()) {
                        assert!(
                            modifiers.contains(&modifier.to_lowercase().as_str()),
                            "{accelerator}"
                        );
                    }
                }
            }
        }
        assert!(seen > 200);
    }

    #[test]
    fn the_macos_window_menu_holds_what_the_role_did() {
        let mac = lines_of(TabKind::Pdf, Os::Mac, Lang::En);
        let at = mac.iter().position(|l| l == "Window >").unwrap();
        assert_eq!(
            &mac[at..at + 5],
            [
                "Window >",
                "  <Minimize> Minimize",
                "  <Zoom> Zoom",
                "  ---",
                "  <Front> Bring All to Front",
            ]
        );
        let windows = lines_of(TabKind::Pdf, Os::Windows, Lang::En);
        let at = windows.iter().position(|l| l == "Window >").unwrap();
        assert_eq!(
            &windows[at..at + 4],
            ["Window >", "  Minimize", "  ---", "  Close Window"]
        );
    }

    #[test]
    fn only_this_menus_ids_are_this_menus() {
        assert!(ID_PREFIX.starts_with("m-"));
        // a click on an id nobody numbered finds no action
        assert!(
            lock(&CLICKS)
                .as_ref()
                .is_none_or(|(_, clicks)| !clicks.contains_key("other-1"))
        );
    }
}
