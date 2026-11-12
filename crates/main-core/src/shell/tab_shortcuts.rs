//! `apps/shell/src/main/tab-shortcuts.ts`.

/// `TabShortcutInput`
#[derive(Debug, Clone, PartialEq)]
pub struct TabShortcutInput {
    /// Electron's Input.type: keyDown / keyUp / char
    pub input_type: String,
    pub key: String,
    pub control: bool,
    pub meta: bool,
    pub alt: bool,
    pub shift: bool,
}

/// `TabShortcut`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabShortcut {
    Next,
    Previous,
    Close,
}

impl TabShortcut {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            TabShortcut::Next => "next",
            TabShortcut::Previous => "previous",
            TabShortcut::Close => "close",
        }
    }
}

/// `tabShortcutOf(input, platform)`; `platform` is `process.platform`
/// (`"darwin"`, `"win32"`, `"linux"`).
pub fn tab_shortcut_of(input: &TabShortcutInput, platform: &str) -> Option<TabShortcut> {
    if input.input_type != "keyDown" || input.alt {
        return None;
    }

    if input.key == "Tab" {
        // Ctrl only: Cmd+Tab is the OS app switcher and Alt+Tab is the window switcher
        if !input.control || input.meta {
            return None;
        }
        return Some(if input.shift {
            TabShortcut::Previous
        } else {
            TabShortcut::Next
        });
    }

    if input.key.to_lowercase() != "w" || input.shift {
        return None;
    }
    // the platform's own close chord: Cmd+W on macOS, Ctrl+W elsewhere
    if platform == "darwin" {
        return (input.meta && !input.control).then_some(TabShortcut::Close);
    }
    (input.control && !input.meta).then_some(TabShortcut::Close)
}

/// `TabShortcutHost`: what the shell can do for a tab shortcut.
pub trait TabShortcutHost {
    /// the shell window's own webContents (tab strip and Home)
    fn is_shell_contents(&mut self, web_contents_id: f64) -> bool;
    /// a document tab's WebContentsView
    fn has_tab(&mut self, web_contents_id: f64) -> bool;
    /// kind of the active tab, or `None` when the list is empty
    fn active_kind(&mut self) -> Option<String>;
    /// `direction` is 1 or -1
    fn cycle(&mut self, direction: i32);
    fn close_active(&mut self);
}

/// `handleTabShortcut`: true when the shell acted. `platform` is
/// `process.platform`, which the TypeScript reads as the default of
/// `tabShortcutOf`.
pub fn handle_tab_shortcut(
    input: &TabShortcutInput,
    web_contents_id: f64,
    host: &mut dyn TabShortcutHost,
    platform: &str,
) -> bool {
    let Some(shortcut) = tab_shortcut_of(input, platform) else {
        return false;
    };
    if !host.is_shell_contents(web_contents_id) && !host.has_tab(web_contents_id) {
        return false;
    }
    if shortcut == TabShortcut::Close {
        if host.active_kind().as_deref() == Some("home") {
            return false;
        }
        host.close_active();
        return true;
    }
    host.cycle(if shortcut == TabShortcut::Next { 1 } else { -1 });
    true
}
