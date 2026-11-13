//! Identities the shell hands to handlers. They keep Electron's meaning so a
//! ported handler reads like the TypeScript it replaces.

use std::path::PathBuf;

/// An OS window: Electron's `BrowserWindow.id`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WindowId(pub u32);

/// One webview: Electron's `webContents.id`. A window holds one or more (the
/// shell window's tabs were `WebContentsView`s). Every message has one sender.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ViewId(pub u32);

/// One `invoke` of one view, issued by the renderer side of the bridge; the
/// reply carries it back
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RequestId(pub u64);

/// A document as the Electron build already names it: the view that shows it
/// and its file, if saved. No new identity is introduced: renderers pass
/// paths today, and the handlers keep keying by view and path.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DocumentHandle {
    pub view: ViewId,
    pub path: Option<PathBuf>,
}
