//! `apps/shell/src/main/permission-guard.ts`: which addresses are the app's
//! own pages in this run. The decision itself is
//! [`crate::packages::electron_utils::permission_guard`]'s.

use std::rc::Rc;

use crate::packages::electron_utils::permission_guard::{
    AppPages, PermissionApp, PermissionPolicy, install_permission_guard,
};

/// `DEV_URL_ENV`: the dev server each editor's runtime is configured with, by
/// renderer host, in the order the TypeScript literal writes them.
pub const DEV_URL_ENV: [(&str, &str); 10] = [
    ("shell", "ELECTRON_RENDERER_URL"),
    ("docs", "DOCS_RENDERER_URL"),
    ("sheets", "SHEETS_RENDERER_URL"),
    ("slides", "SLIDES_RENDERER_URL"),
    ("pdf", "PDF_RENDERER_URL"),
    ("markdown", "MARKDOWN_RENDERER_URL"),
    ("html", "HTML_RENDERER_URL"),
    ("mindmap", "MINDMAP_RENDERER_URL"),
    ("hwp", "HWP_RENDERER_URL"),
    ("epub", "EPUB_RENDERER_URL"),
];

/// `ShellPermissionGuardOptions`; `env` answers `options.env ?? process.env`
/// (a variable that is not set is `None`).
pub struct ShellPermissionGuardOptions<'a> {
    /// true while the slides editor in that webContents records narration
    pub microphone_open: Box<dyn Fn(i64) -> bool>,
    /// the folder the shell's own windows are loaded from (`out/renderer`)
    pub renderer_dir: &'a str,
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

/// the `pages` literal of `installShellPermissionGuard`
pub fn shell_permission_pages(
    renderer_dir: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> AppPages {
    AppPages {
        // Object.fromEntries keeps a page whose variable is not set, as undefined
        dev_urls: DEV_URL_ENV
            .iter()
            .map(|(page, name)| ((*page).to_owned(), env(name)))
            .collect(),
        file_roots: vec![("shell".to_owned(), renderer_dir.to_owned())],
    }
}

/// `installShellPermissionGuard`; the caller hands over the Electron `app`
/// (with the sessions folded in, see [`PermissionApp`])
pub fn install_shell_permission_guard(
    app: &mut dyn PermissionApp,
    options: ShellPermissionGuardOptions<'_>,
) {
    let pages = shell_permission_pages(options.renderer_dir, options.env);
    install_permission_guard(
        app,
        Rc::new(PermissionPolicy {
            pages,
            microphone_open: options.microphone_open,
        }),
    );
}
