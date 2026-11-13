//! `packages/ai-search/src/media-tools.ts`: the judgment of generate_image /
//! analyze_media that is not a network call: the settings file, the media
//! budget, the allowlist of local media directories. `loadMediaReference(s)`,
//! `generateImageTool` and `analyzeMediaTool` start requests at the vendors
//! and the Codex generator (engine-waiting): the editors' handlers call them
//! through traits of their own.

use crate::packages::ai_provider::legacy_settings::normalize_ai_settings;
use crate::packages::ai_provider::providers::{default_ai_settings, resolve_ai_settings};
use jscompat::node_path::host::dirname;
use jscompat::{JsonValue, json_parse};

/// `MEDIA_BUDGET`: the production budget of one media tool call
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MediaBudget {
    pub max_items: f64,
    pub max_item_bytes: f64,
    pub max_total_bytes: f64,
    pub concurrency: f64,
}

/// `MEDIA_BUDGET`
pub const MEDIA_BUDGET: MediaBudget = MediaBudget {
    // MAX_MEDIA_ITEMS: a media tool call is a handful of references
    max_items: 12.0,
    // MAX_MEDIA_BYTES: 200 MB
    max_item_bytes: 200.0 * 1024.0 * 1024.0,
    // MAX_MEDIA_TOTAL_BYTES
    max_total_bytes: 200.0 * 1024.0 * 1024.0,
    // MEDIA_LOAD_CONCURRENCY
    concurrency: 3.0,
};

/// `readAiSettingsFile(path)`: `file` is what `readFileSync` of the path gave,
/// `None` where `existsSync` is false or the read throws. A file that is not
/// JSON reads as no file.
pub fn read_ai_settings_file(file: Option<&str>) -> JsonValue {
    let stored = file
        .and_then(|text| json_parse(text).ok())
        .unwrap_or_else(|| JsonValue::Object(jscompat::JsObject::new()));
    resolve_ai_settings(None, Some(&stored), &mut default_ai_settings(None))
}

/// `readRoutingSettings(path)`: the settings the tools route on: a removed or
/// unknown selection reads as its default.
pub fn read_routing_settings(file: Option<&str>) -> JsonValue {
    normalize_ai_settings(None, Some(&read_ai_settings_file(file)), None)
}

/// `localMediaRoots(...roots)`: the roots that are not empty
pub fn local_media_roots(roots: &[Option<&str>]) -> Vec<String> {
    roots
        .iter()
        .filter_map(|root| root.filter(|r| !r.is_empty()))
        .map(str::to_owned)
        .collect()
}

/// `documentMediaRoots(docPath, attachmentDir)`: the Electron allowlist: the
/// open document's directory plus the app's attachment staging dir.
pub fn document_media_roots(doc_path: Option<&str>, attachment_dir: Option<&str>) -> Vec<String> {
    let doc_dir = doc_path.filter(|p| !p.is_empty()).map(dirname);
    local_media_roots(&[doc_dir.as_deref(), attachment_dir])
}

/// `realpathSync`
pub trait RealPath {
    /// the real path, or `None` where `realpathSync` throws
    fn realpath(&mut self, path: &str) -> Option<String>;
}

/// `verifiedLocalPath(ref, roots)`: the real path of `ref`, or `None` when
/// missing or outside `roots`. Both sides go through realpath so a planted
/// symlink cannot walk out, and containment is on whole segments. `sep` is
/// `path.sep`.
fn verified_local_path(
    fs: &mut dyn RealPath,
    reference: &str,
    roots: &[String],
    sep: &str,
) -> Option<String> {
    let real = fs.realpath(reference)?;
    if roots.is_empty() {
        return Some(real);
    }
    for root in roots {
        let Some(real_root) = fs.realpath(root) else {
            continue;
        };
        let prefix = if real_root.ends_with(sep) {
            real_root.clone()
        } else {
            format!("{real_root}{sep}")
        };
        if real == real_root || real.starts_with(&prefix) {
            return Some(real);
        }
    }
    None
}

/// `isLocalMediaPathAllowed(ref, roots)`: true when `ref` is a readable path;
/// with no `roots` the allowlist does not apply.
pub fn is_local_media_path_allowed(
    fs: &mut dyn RealPath,
    reference: &str,
    roots: &[String],
    sep: &str,
) -> bool {
    verified_local_path(fs, reference, roots, sep).is_some()
}
