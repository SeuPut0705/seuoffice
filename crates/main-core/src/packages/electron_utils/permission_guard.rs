//! `packages/electron-utils/src/permission-guard.ts`.
//!
//! The Electron objects are traits with exactly the properties the
//! TypeScript reads: a frame is a [`FrameId`] that [`AskingContents`] answers
//! questions about (each may fail, as Electron throws on a frame torn down
//! while its question is in flight), the app and the session are
//! [`PermissionApp`] and [`GuardedSession`].

use std::rc::Rc;

use jscompat::node_path::host;
use url::Url;

use super::generated_images::file_url_to_path;
use super::renderer_scheme::{RENDERER_HOSTS, RENDERER_SCHEME};

/// Where the app's own pages are loaded from, besides the renderer scheme.
/// Both lists are `Object.entries` of the TypeScript's records, in
/// JavaScript's key order.
#[derive(Debug, Clone, Default)]
pub struct AppPages {
    /// a page name (a renderer host, or the shell's own name) to the dev server it is loaded from
    pub dev_urls: Vec<(String, Option<String>)>,
    /// a page name to the folder its windows are loaded from as files
    pub file_roots: Vec<(String, String)>,
}

pub struct PermissionPolicy {
    pub pages: AppPages,
    /// true while the slides editor in that webContents records narration
    pub microphone_open: Box<dyn Fn(i64) -> bool>,
}

/// One request or check, in the terms the decision is made in.
#[derive(Debug, Clone, Default)]
pub struct PermissionAsk {
    pub permission: String,
    pub web_contents_id: Option<i64>,
    /// the last address the asking frame loaded
    pub url: Option<String>,
    pub is_main_frame: bool,
    /// A frame inside a page only: whether it is that page's own, as
    /// `is_own_frame` finds. Left out (`None`), the frame is taken for a document.
    pub own_frame: Option<bool>,
    /// `media` only: the devices asked for; none is a screen capture
    pub media: Option<Vec<String>>,
}

/// A frame of an asking `webContents`.
pub type FrameId = usize;

/// A question about a frame torn down while it was in flight: Electron throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TornDown;

/// The part of a webContents the guard reads.
pub trait AskingContents {
    fn id(&self) -> i64;
    /// `contents.mainFrame`; `None` where it is undefined
    fn main_frame(&self) -> Result<Option<FrameId>, TornDown>;
    /// `frame.framesInSubtree` (the frame itself included)
    fn frames_in_subtree(&self, frame: FrameId) -> Result<Vec<FrameId>, TornDown>;
    /// `frame.url`
    fn frame_url(&self, frame: FrameId) -> Result<String, TornDown>;
    /// `frame.origin`: "null" for a sandboxed frame, whatever it loaded
    fn frame_origin(&self, frame: FrameId) -> Result<String, TornDown>;
    /// `frame.parent`
    fn frame_parent(&self, frame: FrameId) -> Result<Option<FrameId>, TornDown>;
}

/// The renderer host that records: its editor is the only page given `media`.
const SLIDES_PAGE: &str = "slides";

/// What any of the app's own pages may use, in its top frame and in a frame of its own.
fn is_app_page_permission(permission: &str) -> bool {
    matches!(
        permission,
        // navigator.clipboard.read/readText: Paste in the Word, the sheet and the HWP editor
        "clipboard-read"
        // navigator.clipboard.write/writeText: the copy buttons of every editor and of the
        // shell, and the HWP editor's own copy
        | "clipboard-sanitized-write"
        // requestFullscreen: the slide show and the editors' presentation views
        | "fullscreen"
        // queryLocalFonts: the font lists (only ever checked, never requested)
        | "local-fonts"
    )
}

fn fold(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

fn origin_of(address: &str) -> Option<String> {
    let url = Url::parse(address).ok()?;
    let origin = url.origin().ascii_serialization();
    // schemes without an origin of their own all read "null": never a match
    if origin == "null" { None } else { Some(origin) }
}

/// Which of the app's own pages `address` is: its name, or none for anything
/// else (a document, a printed copy in a temp folder, a web address).
pub fn app_page_of(pages: &AppPages, address: Option<&str>) -> Option<String> {
    let address = address.filter(|a| !a.is_empty())?;
    let url = Url::parse(address).ok()?;
    if url.scheme() == RENDERER_SCHEME {
        let hostname = url.host_str().unwrap_or("");
        return RENDERER_HOSTS
            .contains(&hostname)
            .then(|| hostname.to_owned());
    }
    if let Some(origin) = origin_of(address) {
        for (page, dev_url) in &pages.dev_urls {
            if let Some(dev_url) = dev_url.as_deref().filter(|d| !d.is_empty())
                && origin_of(dev_url).as_deref() == Some(origin.as_str())
            {
                return Some(page.clone());
            }
        }
    }
    if url.scheme() != "file" {
        return None;
    }
    let file = fold(&file_url_to_path(&url, cfg!(windows))?);
    for (page, root) in &pages.file_roots {
        if file.starts_with(&format!("{}{}", fold(&host::resolve(&[root])), host::SEP)) {
            return Some(page.clone());
        }
    }
    None
}

/// Whether the frame of `contents` that loaded `url` is the page's own: the top
/// frame is one of the app's pages, the frame loaded an address of that same
/// page, and it and every frame above it share the top frame's origin. A
/// document is shown in a sandboxed frame, which has an origin of its own even
/// after sending itself to an address of the app, so it never passes; neither
/// does anything such a frame holds.
fn is_own_frame(
    pages: &AppPages,
    contents: Option<&dyn AskingContents>,
    url: Option<&str>,
) -> bool {
    let (Some(contents), Some(url)) = (contents, url.filter(|u| !u.is_empty())) else {
        return false;
    };
    // Electron throws on a frame torn down while its question is in flight:
    // nothing to grant
    own_frame_of(pages, contents, url).unwrap_or(false)
}

fn own_frame_of(
    pages: &AppPages,
    contents: &dyn AskingContents,
    url: &str,
) -> Result<bool, TornDown> {
    let Some(top) = contents.main_frame()? else {
        return Ok(false);
    };
    let page = app_page_of(pages, Some(&contents.frame_url(top)?));
    let Some(page) = page else {
        return Ok(false);
    };
    if app_page_of(pages, Some(url)).as_deref() != Some(page.as_str()) {
        return Ok(false);
    }
    // Electron names the asking frame by its address alone: every frame at it has to qualify
    let mut asking = Vec::new();
    for frame in contents.frames_in_subtree(top)? {
        if frame != top && contents.frame_url(frame)? == url {
            asking.push(frame);
        }
    }
    if asking.is_empty() {
        return Ok(false);
    }
    for frame in asking {
        let mut at = Some(frame);
        while let Some(current) = at {
            let origin = contents.frame_origin(current)?;
            if origin == "null" || origin != contents.frame_origin(top)? {
                return Ok(false);
            }
            at = contents.frame_parent(current)?;
        }
    }
    Ok(true)
}

pub fn permission_allowed(policy: &PermissionPolicy, ask: &PermissionAsk) -> bool {
    let Some(web_contents_id) = ask.web_contents_id else {
        return false;
    };
    // A frame inside a page is a document (the HTML preview, a book chapter) unless it is the
    // page's own
    if !ask.is_main_frame && ask.own_frame != Some(true) {
        return false;
    }
    let Some(page) = app_page_of(&policy.pages, ask.url.as_deref()) else {
        return false;
    };
    if is_app_page_permission(&ask.permission) {
        return true;
    }
    let Some(media) = ask.media.as_ref() else {
        return false;
    };
    if !ask.is_main_frame || ask.permission != "media" || page != SLIDES_PAGE {
        return false;
    }
    // Insert > Screen Recording (getDisplayMedia): Electron asks for `media` with no
    // device, then leaves the choice of screen to the session's display-media handler
    if media.is_empty() {
        return true;
    }
    media.iter().all(|kind| kind == "audio") && (policy.microphone_open)(web_contents_id)
}

#[derive(Debug, Clone, Default)]
pub struct RequestDetails {
    pub is_main_frame: bool,
    pub requesting_url: Option<String>,
    pub media_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct CheckDetails {
    pub is_main_frame: bool,
    pub requesting_url: Option<String>,
    pub media_type: Option<String>,
}

/// The session's answer to a page asking for a permission: `callback` is
/// called once with the answer.
pub fn permission_request_handler(
    policy: &PermissionPolicy,
    contents: Option<&dyn AskingContents>,
    permission: &str,
    callback: &mut dyn FnMut(bool),
    details: &RequestDetails,
) {
    callback(permission_allowed(
        policy,
        &PermissionAsk {
            permission: permission.to_owned(),
            web_contents_id: contents.map(|c| c.id()),
            url: details.requesting_url.clone(),
            is_main_frame: details.is_main_frame,
            own_frame: Some(
                !details.is_main_frame
                    && is_own_frame(&policy.pages, contents, details.requesting_url.as_deref()),
            ),
            media: if permission == "media" {
                details.media_types.clone()
            } else {
                None
            },
        },
    ));
}

/// The session's answer to a page asking whether it holds a permission: the
/// same as to a request.
pub fn permission_check_handler(
    policy: &PermissionPolicy,
    contents: Option<&dyn AskingContents>,
    permission: &str,
    _requesting_origin: &str,
    details: &CheckDetails,
) -> bool {
    let device = details.media_type.as_deref();
    permission_allowed(
        policy,
        &PermissionAsk {
            permission: permission.to_owned(),
            web_contents_id: contents.map(|c| c.id()),
            url: details.requesting_url.clone(),
            is_main_frame: details.is_main_frame,
            own_frame: Some(
                !details.is_main_frame
                    && is_own_frame(&policy.pages, contents, details.requesting_url.as_deref()),
            ),
            // a check names one device; one that names none is not the microphone
            media: match device {
                Some(d) if d == "audio" || d == "video" => Some(vec![d.to_owned()]),
                _ => None,
            },
        },
    )
}

/// `ses.setPermissionRequestHandler(handler)`'s handler: contents, permission,
/// callback, details.
pub type PermissionRequestHandler =
    Box<dyn Fn(Option<&dyn AskingContents>, &str, &mut dyn FnMut(bool), &RequestDetails)>;

/// `ses.setPermissionCheckHandler(handler)`'s handler: contents, permission,
/// requesting origin, details.
pub type PermissionCheckHandler =
    Box<dyn Fn(Option<&dyn AskingContents>, &str, &str, &CheckDetails) -> bool>;

/// The part of a `Session` the guard uses.
pub trait GuardedSession {
    fn set_permission_request_handler(&mut self, handler: PermissionRequestHandler);
    fn set_permission_check_handler(&mut self, handler: PermissionCheckHandler);
}

/// A listener run for every session the app creates.
pub type SessionCreatedListener = Box<dyn Fn(&mut dyn GuardedSession)>;

/// A one-shot listener run once with the default session when the app is ready.
pub type ReadyListener = Box<dyn FnOnce(&mut dyn GuardedSession)>;

/// The part of the `App` the guard uses, with the `sessions` argument folded
/// in: `on_when_ready` hands the listener `sessions.defaultSession`.
pub trait PermissionApp {
    /// `app.on('session-created', listener)`
    fn on_session_created(&mut self, listener: SessionCreatedListener);
    /// `app.whenReady().then(() => listener(sessions.defaultSession))`
    fn when_ready(&mut self, listener: ReadyListener);
}

/// Guard the default session and every session created from now on. Call
/// before app ready, so no session exists without its answer.
pub fn install_permission_guard(app: &mut dyn PermissionApp, policy: Rc<PermissionPolicy>) {
    fn guard(policy: &Rc<PermissionPolicy>, ses: &mut dyn GuardedSession) {
        let for_requests = Rc::clone(policy);
        ses.set_permission_request_handler(Box::new(
            move |contents, permission, callback, details| {
                permission_request_handler(&for_requests, contents, permission, callback, details);
            },
        ));
        let for_checks = Rc::clone(policy);
        ses.set_permission_check_handler(Box::new(move |contents, permission, origin, details| {
            permission_check_handler(&for_checks, contents, permission, origin, details)
        }));
    }
    let on_created = Rc::clone(&policy);
    // fires inside session.fromPartition, before the caller can load a page in it
    app.on_session_created(Box::new(move |ses| guard(&on_created, ses)));
    // the default session is only reachable once the app is ready
    app.when_ready(Box::new(move |ses| guard(&policy, ses)));
}
