//! `apps/shell/src/main/recent-files.ts`.
//!
//! `statPathEntries` and `statPathEntriesAsync` are one synchronous function
//! each (they differ only in how the TypeScript waits); a `ReadonlySet` of
//! starred paths is a `HashSet`.

use std::collections::HashSet;
use std::fs::Metadata;

use jscompat::node_path::host::basename;
use jscompat::{JsTypeError, JsonValue, math_max, math_min, to_primitive, trim};
use serde::Serialize;

use super::app_routing::document_extension;

const RECENT_PAGE_DEFAULT: f64 = 50.0;
const RECENT_PAGE_MAX: f64 = 200.0;

/// `RecentEntry` of `apps/shell/src/shared/home-api.ts`, its keys in the order
/// `toRecentEntry`'s literal writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub ext: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub starred: bool,
    /// `...(info ? {} : { missing: true })`: the key is there, last, or not at all
    #[serde(skip_serializing_if = "is_present")]
    pub missing: bool,
}

fn is_present(missing: &bool) -> bool {
    !*missing
}

/// `{ mtimeMs, size }` of a Node `Stats`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatInfo {
    pub mtime_ms: f64,
    pub size: u64,
}

impl StatInfo {
    /// What `statSync` answers for these metadata: `mtimeMs` is the seconds
    /// times 1000 plus the nanoseconds over 1e6, as doubles.
    pub fn of(meta: &Metadata) -> StatInfo {
        #[cfg(unix)]
        let mtime_ms = {
            use std::os::unix::fs::MetadataExt;
            meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6
        };
        #[cfg(not(unix))]
        let mtime_ms = match meta.modified() {
            Ok(time) => match time.duration_since(std::time::UNIX_EPOCH) {
                Ok(after) => {
                    after.as_secs() as f64 * 1000.0 + f64::from(after.subsec_nanos()) / 1e6
                }
                Err(before) => {
                    let before = before.duration();
                    -(before.as_secs() as f64 * 1000.0) - f64::from(before.subsec_nanos()) / 1e6
                }
            },
            Err(_) => 0.0,
        };
        StatInfo {
            mtime_ms,
            size: meta.len(),
        }
    }
}

fn to_recent_entry(
    path: &str,
    starred_paths: &HashSet<String>,
    info: Option<StatInfo>,
) -> RecentEntry {
    RecentEntry {
        path: path.to_owned(),
        name: basename(path, None),
        ext: document_extension(path),
        mtime_ms: info.map_or(0.0, |i| i.mtime_ms),
        size_bytes: info.map_or(0, |i| i.size),
        starred: starred_paths.contains(path),
        missing: info.is_none(),
    }
}

/// Explicit folder browsing retains its existing synchronous metadata contract.
pub fn stat_path_entries(paths: &[String], starred_paths: &HashSet<String>) -> Vec<RecentEntry> {
    paths
        .iter()
        .map(|path| {
            // an unavailable path stays listed, flagged missing
            let info = std::fs::metadata(path).ok().map(|meta| StatInfo::of(&meta));
            to_recent_entry(path, starred_paths, info)
        })
        .collect()
}

pub fn stat_path_entries_async(
    paths: &[String],
    starred_paths: &HashSet<String>,
) -> Vec<RecentEntry> {
    paths
        .iter()
        .map(|path| {
            // Keep unavailable paths listed, just as for a disconnected local drive.
            let info = std::fs::metadata(path).ok().map(|meta| StatInfo::of(&meta));
            to_recent_entry(path, starred_paths, info)
        })
        .collect()
}

pub const STAT_PATHS_MAX: usize = RECENT_PAGE_MAX as usize;

/// A renderer-supplied list is bounded like every recents page.
pub fn cap_stat_paths(paths: &[String]) -> Vec<String> {
    paths.iter().take(STAT_PATHS_MAX).cloned().collect()
}

/// What `normalizeRecentQuery` answers: `{ offset, limit, ext }`, `ext` left out when undefined.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentQueryNormal {
    pub offset: f64,
    pub limit: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
}

/// `Number(query.field)` for `query = raw ?? {}`: a field of what is not an
/// object is `undefined`, so `NaN`.
fn query_number(query: Option<&JsonValue>, field: &str) -> Result<f64, JsTypeError> {
    let value = match query {
        Some(JsonValue::Object(object)) => object.get(field),
        _ => None,
    };
    Ok(to_primitive(value)?.to_number())
}

pub fn normalize_recent_query(raw: Option<&JsonValue>) -> Result<RecentQueryNormal, JsTypeError> {
    let query = match raw {
        Some(JsonValue::Null) | None => None,
        other => other,
    };
    // offset/limit cross the preload boundary, so an IPC caller may send "10" rather than 10
    let raw_offset = query_number(query, "offset")?;
    let raw_limit = query_number(query, "limit")?;
    let offset = if raw_offset.is_finite() {
        math_max(0.0, raw_offset.floor())
    } else {
        0.0
    };
    let limit = if raw_limit.is_finite() {
        math_min(RECENT_PAGE_MAX, math_max(0.0, raw_limit.floor()))
    } else {
        RECENT_PAGE_DEFAULT
    };
    // Sidebar keys are bare extensions ("xlsx"), but IPC callers may send
    // ".xlsx", " XLSX ", or "..." — normalize so openable files cannot hide
    // behind a filter that only differs in dots/case/whitespace.
    let raw_ext = match query {
        Some(JsonValue::Object(object)) => match object.get("ext") {
            Some(JsonValue::String(ext)) => {
                trim(ext).to_lowercase().trim_start_matches('.').to_owned()
            }
            _ => String::new(),
        },
        _ => String::new(),
    };
    let ext = if raw_ext.is_empty() {
        None
    } else {
        Some(raw_ext)
    };
    Ok(RecentQueryNormal { offset, limit, ext })
}

/// sidebar filter keys that stand for a family of extensions, not one exact ext
pub const EXT_FAMILY: &[(&str, &[&str])] = &[
    // mirrors Home's FILTER_FAMILY and SEARCH_EXT_FAMILY
    ("docx", &["docx", "doc", "dot", "odt"]),
    // delimited text belongs to the sheets family; .ods opens as a converted .xlsx copy
    ("xlsx", &["xlsx", "xlsm", "xls", "csv", "tsv", "ods"]),
    ("pptx", &["pptx", "ppt", "odp", "otp"]),
    // the text app opens txt/json as source too
    ("md", &["md", "markdown", "txt", "json"]),
    ("html", &["html", "htm"]),
    ("hwp", &["hwp", "hwpx"]),
    // the mind map editor's own maps and the FreeMind / Freeplane maps it imports
    ("xmind", &["xmind", "mm"]),
    // the diagram editor's formats, a Visio drawing it imports included
    (
        "drawio",
        &["drawio", "dio", "drawio.svg", "drawio.png", "vsdx"],
    ),
];

/// The own and inherited names of `Object.prototype`: `EXT_FAMILY[name]` is
/// truthy for each, and none of them has `includes`.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Family-aware extension match for sidebar filters (recents and starred share it).
///
/// `EXT_FAMILY` is a plain object, so a filter that names a member of
/// `Object.prototype` finds a truthy `family` with no `includes`: that call
/// throws. (`pageRecentPaths` lower-cases the filter first, which leaves only
/// `constructor` and `__proto__`.)
pub fn matches_ext_family(entry_ext: &str, filter_ext: &str) -> Result<bool, JsTypeError> {
    if OBJECT_PROTOTYPE_KEYS.contains(&filter_ext) {
        return Err(JsTypeError("family.includes is not a function".to_owned()));
    }
    Ok(
        match EXT_FAMILY.iter().find(|(key, _)| *key == filter_ext) {
            Some((_, family)) => family.contains(&entry_ext),
            None => entry_ext == filter_ext,
        },
    )
}

/// `RecentPage`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentPage {
    pub entries: Vec<RecentEntry>,
    pub total: usize,
    #[serde(rename = "totalAll")]
    pub total_all: usize,
}

/// Page over the recents paths, preserving the source's newest-first order (unavailable paths stay, flagged missing).
pub fn page_recent_paths(
    paths: &[String],
    raw: Option<&JsonValue>,
    starred_paths: &HashSet<String>,
) -> Result<RecentPage, JsTypeError> {
    let RecentQueryNormal { offset, limit, ext } = normalize_recent_query(raw)?;
    // Probe only the returned page, without blocking main on unavailable mounts.
    let filtered: Vec<String> = match &ext {
        Some(ext) => {
            let mut kept = Vec::new();
            for p in paths {
                if matches_ext_family(&document_extension(p), ext)? {
                    kept.push(p.clone());
                }
            }
            kept
        }
        None => paths.to_vec(),
    };
    let page: &[String] = if limit == 0.0 {
        &[]
    } else {
        // `slice(offset, offset + limit)` of a list this long
        let len = filtered.len() as f64;
        let start = offset.min(len) as usize;
        let end = (offset + limit).min(len) as usize;
        if end > start {
            &filtered[start..end]
        } else {
            &[]
        }
    };
    Ok(RecentPage {
        entries: stat_path_entries_async(page, starred_paths),
        total: filtered.len(),
        total_all: paths.len(),
    })
}
