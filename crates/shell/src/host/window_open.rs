//! `window.open` and `target=_blank` of the shell's pages. CEF is always
//! answered "no new window"; what the Electron build's `setWindowOpenHandler`
//! of each app did instead is this table, by the surface of the page that
//! asked: open the URL in the operating system's browser (and mail client),
//! or nothing. A page without a bridge has no surface and gets nothing.

use shell_contract::Surface;

/// What a page may open outside the app
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenPolicy {
    /// nothing opens
    Deny,
    /// `http:` and `https:` (`safeExternalUrl(url)`)
    Web,
    /// `http:`, `https:` and `mailto:`
    WebAndMail,
}

/// One match on the surface: the `setWindowOpenHandler` of the page's app
pub fn policy_of(surface: Option<Surface>) -> OpenPolicy {
    use OpenPolicy::*;
    match surface {
        Some(
            Surface::Docs
            | Surface::Slides
            | Surface::Shell
            | Surface::ShellAgent
            | Surface::ShellDocPicker
            | Surface::ShellGenerate
            | Surface::ShellPdfTools
            | Surface::ShellQuickLook,
        ) => Web,
        Some(Surface::Html | Surface::Hwp | Surface::Markdown | Surface::Pdf) => WebAndMail,
        Some(
            Surface::Diagram
            | Surface::Epub
            | Surface::Mindmap
            | Surface::Sheets
            | Surface::ShellPdfPassword
            | Surface::ShellInbox
            | Surface::ShellUpdate,
        )
        | None => Deny,
    }
}

/// The URL to hand to the OS for a page's `window.open(url)`, or none
pub fn external_target(policy: OpenPolicy, url: &str) -> Option<String> {
    use main_core::packages::electron_utils::safe_external_url::{
        SafeExternalUrlOptions, safe_external_url,
    };
    match policy {
        OpenPolicy::Deny => None,
        OpenPolicy::Web => safe_external_url(Some(url), None),
        OpenPolicy::WebAndMail => safe_external_url(
            Some(url),
            Some(&SafeExternalUrlOptions {
                allowed_protocols: Some(vec!["http:".into(), "https:".into(), "mailto:".into()]),
            }),
        ),
    }
}

/// A page of `surface` asked for a new window at `url`: opens it outside the
/// app when the policy allows. Off the calling thread, which is CEF's UI
/// thread: starting the browser can take a while.
pub fn requested(surface: Option<Surface>, url: &str) {
    let Some(target) = external_target(policy_of(surface), url) else {
        crate::trace::trace!("window", "window.open of {surface:?} refused: {url}");
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("shell-open-external".into())
        .spawn(move || {
            if let Err(error) = super::os_shell::open_external(&target) {
                eprintln!("shell: opening {target}: {error}");
            }
        });
    if let Err(error) = spawned {
        eprintln!("shell: cannot start the thread that opens {url}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(surface: Surface, url: &str) -> Option<String> {
        external_target(policy_of(Some(surface)), url)
    }

    #[test]
    fn each_surface_has_its_policy() {
        assert_eq!(policy_of(Some(Surface::Docs)), OpenPolicy::Web);
        assert_eq!(policy_of(Some(Surface::Shell)), OpenPolicy::Web);
        assert_eq!(policy_of(Some(Surface::ShellQuickLook)), OpenPolicy::Web);
        assert_eq!(policy_of(Some(Surface::Markdown)), OpenPolicy::WebAndMail);
        assert_eq!(policy_of(Some(Surface::Pdf)), OpenPolicy::WebAndMail);
        assert_eq!(policy_of(Some(Surface::Sheets)), OpenPolicy::Deny);
        assert_eq!(policy_of(Some(Surface::ShellUpdate)), OpenPolicy::Deny);
        assert_eq!(policy_of(None), OpenPolicy::Deny);
    }

    #[test]
    fn what_may_leave_the_app() {
        for surface in [Surface::Docs, Surface::Html] {
            assert_eq!(
                target(surface, "https://example.com/a?b=1").as_deref(),
                Some("https://example.com/a?b=1")
            );
            assert_eq!(target(surface, "javascript:alert(1)"), None);
            assert_eq!(target(surface, "file:///etc/passwd"), None);
            assert_eq!(target(surface, "not a url"), None);
        }
        // mailto only where the app allowed it
        assert_eq!(target(Surface::Docs, "mailto:a@example.com"), None);
        assert_eq!(
            target(Surface::Html, "mailto:a@example.com").as_deref(),
            Some("mailto:a@example.com")
        );
        // the URL is handed over trimmed
        assert_eq!(
            target(Surface::Docs, "  https://example.com/x \n").as_deref(),
            Some("https://example.com/x")
        );
        assert_eq!(target(Surface::Diagram, "https://example.com/"), None);
        assert_eq!(
            external_target(policy_of(None), "https://example.com/"),
            None
        );
    }
}
