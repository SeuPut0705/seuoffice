//! `packages/electron-utils/src/github-menu.ts`: repository coordinates and
//! the links derived from them.

use jscompat::js_regex;

use crate::packages::i18n::{PRODUCT_REPO_NAME, PRODUCT_REPO_OWNER, PRODUCT_REPO_SLUG};

pub const GITHUB_REPO_OWNER: &str = PRODUCT_REPO_OWNER;
pub const GITHUB_REPO_NAME: &str = PRODUCT_REPO_NAME;
pub const GITHUB_REPO_SLUG: &str = PRODUCT_REPO_SLUG;
/// `GITHUB_REPO_URL`
pub const GITHUB_REPO_URL: &str = "https://github.com/seuput-inc/seuoffice";
/// `GITHUB_REPO_DISPLAY`
pub const GITHUB_REPO_DISPLAY: &str = "github.com/seuput-inc/seuoffice";
/// `GITHUB_ISSUES_URL`
pub const GITHUB_ISSUES_URL: &str = "https://github.com/seuput-inc/seuoffice/issues";
/// `GITHUB_NEW_ISSUE_URL`
pub const GITHUB_NEW_ISSUE_URL: &str = "https://github.com/seuput-inc/seuoffice/issues/new";
/// `GITHUB_RELEASES_URL`
pub const GITHUB_RELEASES_URL: &str = "https://github.com/seuput-inc/seuoffice/releases";
/// `GITHUB_LATEST_RELEASE_URL`
pub const GITHUB_LATEST_RELEASE_URL: &str =
    "https://github.com/seuput-inc/seuoffice/releases/latest";

/// `githubReleaseTagUrl(version)`
pub fn github_release_tag_url(version: &str) -> String {
    let version = js_regex!(r"^v").replace_all(version, |_| String::new());
    format!("{GITHUB_RELEASES_URL}/tag/v{version}")
}
