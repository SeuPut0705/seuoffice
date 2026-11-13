//! The native menus of the tab strip (`tabs:show-menu`, `tabs:show-tab-menu`,
//! `tabs:show-new-menu`, `tabs:show-app-menu`) and what each entry does when
//! chosen. A menu is a list of [`MenuEntry`] for the host and a map from
//! entry id to [`MenuAction`] the state keeps until the menu closes.

use std::collections::HashMap;
use std::path::Path;

use jscompat::math_round;
use main_core::shell::split_layout::SplitOrientation;
use main_core::shell::tab_document_actions::{
    TabDocumentActionDeps, TabDocumentTarget, run_tab_document_action,
};
use main_core::shell::tab_duplicate::{DuplicateFileDeps, duplicate_document_file};
use main_core::shell::tab_manager::TabKind;
use main_core::shell::tab_menu::{
    MenuClick, TabMenuInput, TabSummary as MenuTab, is_program_file, tab_menu_template,
};
use shell_contract::ids::ViewId;
use shell_contract::ipc::{Responder, Target};
use shell_contract::value::IpcValue;

use super::host::{DocAction, MenuEntry, MenuEntryKind};
use super::open::NewKind;
use super::state::{Inner, TabsState};

/// What choosing a menu entry does
pub(super) enum MenuAction {
    Activate(String),
    Tab(MenuClick),
    /// "split right" / "split down" of a tab
    Split {
        tab_id: String,
        file_path: Option<String>,
        dropped: SplitOrientation,
    },
    Unsplit,
    /// an entry of the application menu, by the id its host gave it
    AppMenu(u32),
    New(NewKind),
    OpenFile,
}

/// `TAB_MENU_ICON`
fn tab_icon(kind: TabKind) -> &'static str {
    match kind {
        TabKind::Home | TabKind::Help => "home",
        TabKind::Docs => "docx",
        TabKind::Sheets => "xlsx",
        TabKind::Slides => "pptx",
        TabKind::Pdf => "pdf",
        TabKind::Markdown => "md",
        TabKind::Html => "html",
        TabKind::Mindmap => "mindmap",
        TabKind::Hwp => "hwp",
        TabKind::Epub => "epub",
        TabKind::Diagram => "diagram",
    }
}

/// `NEW_KIND_MENU`: label key, icon and what it opens, by the home kind
pub(super) fn new_kind_entry(kind: &str) -> Option<(&'static str, &'static str, NewKind)> {
    Some(match kind {
        "docx" => ("menuNewDoc", "docx", NewKind::Doc),
        "xlsx" => ("menuNewSheet", "xlsx", NewKind::Sheet),
        "pptx" => ("menuNewSlide", "pptx", NewKind::Slide),
        "md" => ("menuNewMarkdown", "md", NewKind::Markdown),
        "html" => ("menuNewHtml", "html", NewKind::Html),
        "xmind" => ("menuNewMindmap", "mindmap", NewKind::Mindmap),
        "drawio" => ("menuNewDiagram", "diagram", NewKind::Diagram),
        "hwp" => ("menuNewHwp", "hwp", NewKind::Hwp),
        "pdf" => ("menuNewPdf", "pdf", NewKind::Pdf),
        _ => return None,
    })
}

enum Row {
    Separator,
    Item {
        label: String,
        enabled: bool,
        action: Option<MenuAction>,
    },
}

/// A menu being built: entries with sequential ids and the actions behind them
#[derive(Default)]
struct Builder {
    entries: Vec<MenuEntry>,
    actions: HashMap<u32, MenuAction>,
}

impl Builder {
    fn push(
        &mut self,
        kind: MenuEntryKind,
        label: String,
        enabled: bool,
        checked: bool,
        icon: Option<&'static str>,
        action: Option<MenuAction>,
    ) {
        let id = self.entries.len() as u32;
        self.entries.push(MenuEntry {
            id,
            kind,
            label,
            enabled,
            checked,
            icon,
            submenu: Vec::new(),
        });
        if let Some(action) = action {
            self.actions.insert(id, action);
        }
    }

    fn item(&mut self, label: String, action: MenuAction) {
        self.push(
            MenuEntryKind::Normal,
            label,
            true,
            false,
            None,
            Some(action),
        );
    }

    fn separator(&mut self) {
        self.push(
            MenuEntryKind::Separator,
            String::new(),
            true,
            false,
            None,
            None,
        );
    }
}

/// `{ x: Math.round(x), y: Math.round(y) }` when both are numbers
pub(super) fn popup_at(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
    Some((math_round(x?), math_round(y?)))
}

fn menu_tab(tab: &main_core::shell::tab_manager::TabSummary) -> MenuTab {
    MenuTab {
        id: tab.id.clone(),
        kind: tab.kind.as_str().to_owned(),
        title: tab.title.clone(),
        closable: tab.closable,
        active: tab.active,
        file_path: tab.file_path.clone(),
    }
}

impl TabsState {
    /// `tabs:show-app-menu`
    pub(super) fn show_app_menu(&self, at: Option<(f64, f64)>, reply: Responder) {
        if self.inner.borrow().bridge.shell.is_none() {
            return reply.reply(Ok(IpcValue::Undefined));
        }
        let Some(entries) = self.hooks.app_menu_popup() else {
            return reply.reply(Ok(IpcValue::Undefined));
        };
        let mut actions = HashMap::new();
        fn collect(entries: &[MenuEntry], actions: &mut HashMap<u32, MenuAction>) {
            for entry in entries {
                if entry.kind != MenuEntryKind::Separator {
                    actions.insert(entry.id, MenuAction::AppMenu(entry.id));
                }
                collect(&entry.submenu, actions);
            }
        }
        collect(&entries, &mut actions);
        self.popup(entries, actions, at, reply);
    }

    /// `tabs:show-menu`: the list of all tabs
    pub(super) fn show_tab_list_menu(&self, at: Option<(f64, f64)>, reply: Responder) {
        let tabs = {
            let g = self.inner.borrow();
            match (&g.manager, g.bridge.shell) {
                (Some(m), Some(_)) => m.list(),
                _ => return reply.reply(Ok(IpcValue::Undefined)),
            }
        };
        let mut menu = Builder::default();
        for tab in tabs {
            menu.push(
                MenuEntryKind::Checkbox,
                tab.title.clone(),
                true,
                tab.active,
                Some(tab_icon(tab.kind)),
                Some(MenuAction::Activate(tab.id.clone())),
            );
        }
        self.popup(menu.entries, menu.actions, at, reply);
    }

    /// `tabs:show-new-menu`: the "+" menu
    pub(super) fn show_new_menu(&self, at: Option<(f64, f64)>, reply: Responder) {
        {
            let g = self.inner.borrow();
            if g.manager.is_none() || g.bridge.shell.is_none() {
                return reply.reply(Ok(IpcValue::Undefined));
            }
        }
        let tm = |key: &str| self.hooks.tm(key);
        let mut menu = Builder::default();
        let kinds: Vec<_> = self
            .hooks
            .visible_home_kinds()
            .iter()
            .filter_map(|k| new_kind_entry(k))
            .collect();
        if !kinds.is_empty() {
            // `enabled: false` so a platform without 'header' shows an inert label
            menu.push(
                MenuEntryKind::Header,
                tm("menuSectionNew"),
                false,
                false,
                None,
                None,
            );
            for (label, icon, kind) in kinds {
                menu.push(
                    MenuEntryKind::Normal,
                    tm(label),
                    true,
                    false,
                    Some(icon),
                    Some(MenuAction::New(kind)),
                );
            }
            menu.separator();
        }
        menu.item(tm("menuOpen"), MenuAction::OpenFile);
        self.popup(menu.entries, menu.actions, at, reply);
    }

    /// `tabs:show-tab-menu`: the context menu of one tab
    pub(super) fn show_tab_menu(&self, id: &str, at: Option<(f64, f64)>, reply: Responder) {
        let built = {
            let g = self.inner.borrow();
            let (Some(manager), Some(_)) = (&g.manager, g.bridge.shell) else {
                return reply.reply(Ok(IpcValue::Undefined));
            };
            let list = manager.list();
            let Some(tab) = list.iter().find(|t| t.id == id) else {
                return reply.reply(Ok(IpcValue::Undefined));
            };
            if tab.kind == TabKind::Home {
                return reply.reply(Ok(IpcValue::Undefined));
            }
            let tabs: Vec<MenuTab> = list.iter().map(menu_tab).collect();
            let can_detach = manager.can_detach_tab(id);
            let tm = |key: &str| self.hooks.tm(key);
            let template = tab_menu_template(&TabMenuInput {
                tab: &menu_tab(tab),
                tabs: &tabs,
                can_detach,
                file_exists: tab
                    .file_path
                    .as_deref()
                    .is_some_and(|p| !p.is_empty() && Path::new(p).exists()),
                can_reopen: !g.bridge.recently_closed.get_entries().is_empty(),
                tm: &tm,
            });
            let open_at = template
                .iter()
                .position(|item| item.id == Some("openInNewWindow"));
            let mut rows: Vec<Row> = template
                .into_iter()
                .map(|item| {
                    if item.item_type == Some("separator") {
                        Row::Separator
                    } else {
                        Row::Item {
                            label: item.label.unwrap_or_default(),
                            enabled: item.enabled.unwrap_or(true),
                            action: item.click.map(MenuAction::Tab),
                        }
                    }
                })
                .collect();
            // in-app split entries: document tabs only, right after the window actions
            if can_detach && tab.kind != TabKind::Help {
                let split = |label: &str, action: MenuAction| Row::Item {
                    label: tm(label),
                    enabled: true,
                    action: Some(action),
                };
                let to = |dropped| MenuAction::Split {
                    tab_id: tab.id.clone(),
                    file_path: tab.file_path.clone(),
                    dropped,
                };
                let mut extra = vec![
                    Row::Separator,
                    split("menuSplitRight", to(SplitOrientation::Side)),
                    split("menuSplitDown", to(SplitOrientation::Stack)),
                ];
                if manager.is_pane_tab(id) {
                    extra.push(split("menuUnsplit", MenuAction::Unsplit));
                }
                let at_index = open_at.map_or(0, |i| i + 1);
                rows.splice(at_index..at_index, extra);
            }
            rows
        };
        let mut menu = Builder::default();
        for row in built {
            match row {
                Row::Separator => menu.separator(),
                Row::Item {
                    label,
                    enabled,
                    action,
                } => menu.push(MenuEntryKind::Normal, label, enabled, false, None, action),
            }
        }
        self.popup(menu.entries, menu.actions, at, reply);
    }

    /// What a chosen entry does
    pub(super) fn run_menu_action(&self, action: MenuAction) {
        match action {
            MenuAction::Activate(id) => {
                self.inner
                    .borrow_mut()
                    .manager_call(|m, b| m.activate_tab(b, &id));
            }
            MenuAction::AppMenu(id) => self.hooks.app_menu_activate(id),
            MenuAction::New(kind) => self.rc().new_tab(kind),
            MenuAction::OpenFile => self.hooks.open_file_via_dialog(),
            MenuAction::Unsplit => {
                self.inner.borrow_mut().manager_call(|m, b| m.unsplit(b));
            }
            MenuAction::Split {
                tab_id,
                file_path,
                dropped,
            } => {
                let mut g = self.inner.borrow_mut();
                if g.manager.is_none() {
                    return;
                }
                let split = g.manager.as_ref().and_then(|m| m.split_state());
                let is_pane = g.manager.as_ref().is_some_and(|m| m.is_pane_tab(&tab_id));
                let doc_pane =
                    g.split_pane_of_document(split.as_ref(), &tab_id, file_path.as_deref());
                let intent = g.decide_drop(split.as_ref(), is_pane, doc_pane, dropped);
                if intent.is_some() {
                    g.manager_call(|m, b| {
                        let _ = m.split_with(b, &tab_id, intent);
                    });
                }
            }
            MenuAction::Tab(click) => self.run_tab_click(click),
        }
    }

    /// `tabMenuActions()`
    fn run_tab_click(&self, click: MenuClick) {
        match click {
            MenuClick::Save(id) => self.document_action(&id, "save"),
            MenuClick::SaveAs(id) => self.document_action(&id, "saveAs"),
            MenuClick::Print(id) => self.document_action(&id, "print"),
            MenuClick::OpenInNewWindow(id) => self.detach_tab_to_window(&id),
            MenuClick::SplitBeside(id) => self.split_beside(&id),
            MenuClick::Rename(id) => {
                self.inner
                    .borrow()
                    .bridge
                    .send_to_shell("tabs:start-rename", vec![IpcValue::String(id)]);
            }
            MenuClick::Duplicate(path) => {
                let hooks = &self.hooks;
                let tm = |key: &str| hooks.tm(key);
                let suffix = tm("copySuffix");
                let target = duplicate_document_file(
                    &path,
                    DuplicateFileDeps {
                        copy_suffix: &suffix,
                        record_recent_file: &mut |p| hooks.record_recent_file(p),
                        on_error: &mut |e| {
                            hooks.show_error_dialog(&tm("errDuplicateFailed"), &e.message)
                        },
                    },
                );
                if let Some(target) = target {
                    self.open_document_path(&target);
                }
            }
            MenuClick::CopyText(text) => {
                if let Some(clipboard) = self.services.hosts.get::<shell_contract::ClipboardHost>()
                {
                    clipboard.write_text(&text);
                }
            }
            MenuClick::Reveal(path) => {
                if let Some(os) = self.services.hosts.get::<shell_contract::OsShellHost>() {
                    os.show_item_in_folder(Path::new(&path));
                }
            }
            MenuClick::OpenDefault(path) => {
                // a document tab is a document, never a program
                if !is_program_file(&path)
                    && let Some(os) = self.services.hosts.get::<shell_contract::OsShellHost>()
                {
                    os.open_path(Path::new(&path));
                }
            }
            MenuClick::Move(id, to) => {
                self.inner
                    .borrow_mut()
                    .manager_call(|m, b| m.reorder_tab(b, &id, to as f64));
            }
            MenuClick::CloseTabs(ids) => self.close_tabs_in_order(ids),
            MenuClick::ReopenClosed => self.reopen_closed(),
        }
    }

    /// `recentlyClosed.reopenNext(openDocumentPath, existsSync)`
    fn reopen_closed(&self) {
        let mut tracker = {
            let mut g = self.inner.borrow_mut();
            std::mem::replace(
                &mut g.bridge.recently_closed,
                main_core::shell::tab_lifecycle::create_recently_closed_tracker(
                    main_core::shell::tab_lifecycle::MAX_RECENTLY_CLOSED,
                ),
            )
        };
        tracker.reopen_next(
            &mut |path| self.open_document_path(path),
            Some(&mut |path| Path::new(path).exists()),
        );
        self.inner.borrow_mut().bridge.recently_closed = tracker;
    }

    /// `runTabDocumentAction`
    fn document_action(&self, id: &str, action: &str) {
        let mut deps = DocActions {
            state: self,
            post: Vec::new(),
        };
        run_tab_document_action(&mut deps, id, action);
        for (tab_id, kind, view, path, act) in deps.post {
            self.hooks
                .tab_document_action(kind, view, &tab_id, path.as_deref(), act);
        }
    }

    /// `detachTabToWindow`: "Open in New Window" reparents the tab's live view
    /// into a detached editor window, unsaved edits included
    pub(super) fn detach_tab_to_window(&self, id: &str) {
        let mut g = self.inner.borrow_mut();
        let Some(record) = g.manager_call(|m, b| m.detach_tab(b, id)).flatten() else {
            return;
        };
        g.clear_pane_role(record.view);
        if let Some(window) = g.create_detached(record, None) {
            let windows = g.bridge.windows.clone();
            drop(g);
            windows.window_focus(window);
        }
    }

    /// two windows side by side, each on its own half of the screen the tab is on
    fn split_beside(&self, id: &str) {
        let mut g = self.inner.borrow_mut();
        let Some(shell) = g.bridge.shell else {
            return;
        };
        if g.manager.is_none() {
            return;
        }
        let Some(record) = g.manager_call(|m, b| m.detach_tab(b, id)).flatten() else {
            return;
        };
        let Some(window) = g.create_detached(record, None) else {
            return;
        };
        let windows = g.bridge.windows.clone();
        drop(g);
        let area = windows.window_work_area(shell.window);
        let half = (area.width / 2.0).floor();
        windows.window_set_frame(
            shell.window,
            &main_core::shell::split_layout::Rect {
                x: area.x,
                y: area.y,
                width: half,
                height: area.height,
            },
        );
        windows.window_set_frame(
            window,
            &main_core::shell::split_layout::Rect {
                x: area.x + half,
                y: area.y,
                width: area.width - half,
                height: area.height,
            },
        );
        windows.window_focus(window);
    }
}

/// `TabDocumentActionDeps` over the state; what an editor does is asked of
/// the hooks after the borrow ends
struct DocActions<'a> {
    state: &'a TabsState,
    post: Vec<(String, TabKind, ViewId, Option<String>, DocAction)>,
}

impl DocActions<'_> {
    fn inner(&self) -> std::cell::RefMut<'_, Inner> {
        self.state.inner.borrow_mut()
    }

    fn queue(&mut self, view: &ViewId, action: DocAction) {
        let found = {
            let g = self.state.inner.borrow();
            g.manager.as_ref().and_then(|m| {
                m.list()
                    .into_iter()
                    .find(|t| m.web_contents_for_tab(&t.id) == Some(*view))
            })
        };
        if let Some(tab) = found {
            self.post
                .push((tab.id, tab.kind, *view, tab.file_path, action));
        }
    }
}

impl TabDocumentActionDeps for DocActions<'_> {
    type Contents = ViewId;

    fn list(&mut self) -> Vec<MenuTab> {
        self.inner()
            .manager
            .as_ref()
            .map(|m| m.list().iter().map(menu_tab).collect())
            .unwrap_or_default()
    }
    fn activate_tab(&mut self, id: &str) {
        self.inner().manager_call(|m, b| m.activate_tab(b, id));
    }
    fn can_detach_tab(&mut self, id: &str) -> bool {
        self.inner()
            .manager
            .as_ref()
            .is_some_and(|m| m.can_detach_tab(id))
    }
    fn web_contents_for_tab(&mut self, id: &str) -> Option<ViewId> {
        self.inner()
            .manager
            .as_ref()
            .and_then(|m| m.web_contents_for_tab(id))
    }
    fn is_destroyed(&mut self, contents: &ViewId) -> bool {
        self.state.windows.view_destroyed(*contents)
    }
    fn send(&mut self, contents: &ViewId, channel: &str, command: &str) {
        let channel: &'static str = match channel {
            "menu:command" => "menu:command",
            "menu:action" => "menu:action",
            _ => "slides:menu",
        };
        self.state.events.emit(
            Target::View(*contents),
            channel,
            vec![IpcValue::String(command.to_owned())],
        );
    }
    fn save_pdf(&mut self, contents: &ViewId) {
        self.queue(contents, DocAction::Save)
    }
    fn save_pdf_as(&mut self, target: TabDocumentTarget<ViewId>) {
        self.queue(&target.web_contents, DocAction::SaveAs)
    }
    fn print_pdf(&mut self, contents: &ViewId) {
        self.queue(contents, DocAction::Print)
    }
    fn save_markdown(&mut self, contents: &ViewId, mode: &str) {
        self.queue(contents, save_mode(mode))
    }
    fn print_markdown(&mut self, contents: &ViewId) {
        self.queue(contents, DocAction::Print)
    }
    fn save_html(&mut self, contents: &ViewId, mode: &str) {
        self.queue(contents, save_mode(mode))
    }
    fn print_html(&mut self, contents: &ViewId) {
        self.queue(contents, DocAction::Print)
    }
    fn save_mindmap(&mut self, contents: &ViewId, mode: &str) {
        self.queue(contents, save_mode(mode))
    }
    fn print_mindmap(&mut self, contents: &ViewId) {
        self.queue(contents, DocAction::Print)
    }
    fn save_hwp(&mut self, contents: &ViewId, mode: &str) {
        self.queue(contents, save_mode(mode))
    }
    fn print_hwp(&mut self, contents: &ViewId) {
        self.queue(contents, DocAction::Print)
    }
}

fn save_mode(mode: &str) -> DocAction {
    if mode == "saveAs" {
        DocAction::SaveAs
    } else {
        DocAction::Save
    }
}
