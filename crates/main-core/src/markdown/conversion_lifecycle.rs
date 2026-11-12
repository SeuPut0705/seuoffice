//! `apps/markdown/src/main/conversion-lifecycle.ts`: the session folders a
//! Markdown conversion writes its output into, and their expiry.

use std::fs;

use jscompat::node_path::host::{basename, extname, join, resolve};
use jscompat::{JsonValue, js_regex, json_parse, number_to_string, slice_utf16};

use super::fs_util::{
    is_path_inside, mkdir, mkdir_p, plain_error, read_file_utf8, rm_recursive_force,
    write_file_excl,
};
use super::old_names::OLD_CONVERSION_SESSION_MARKERS;
use crate::node_fs::{NodeError, namespaced, node_error};

pub const MARKDOWN_CONVERSION_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const SESSION_MARKER: &str = ".seuoffice-markdown-conversion.json";

fn replace_control_characters(value: &str) -> String {
    value
        .chars()
        .map(|c| if (c as u32) < 32 { '_' } else { c })
        .collect()
}

fn safe_base_name(input: &str) -> String {
    let raw = basename(input, None);
    let ext = extname(&raw);
    let stem = &raw[..raw.len() - ext.len()];
    let cleaned = replace_control_characters(stem);
    let cleaned = js_regex!(r#"[/\\:*?"<>|]+"#, "g").replace_all(&cleaned, |_| "_".to_owned());
    let cleaned = js_regex!(r"\s+", "g").replace_all(&cleaned, |_| "_".to_owned());
    let cleaned = cleaned.trim_start_matches('.');
    let cleaned = slice_utf16(cleaned, 0.0, Some(100.0));
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        "Untitled".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// `id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || randomUUID()`
fn safe_id(id: &str, random_uuid: &dyn Fn() -> String) -> String {
    let kept: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let kept = slice_utf16(&kept, 0.0, Some(80.0));
    if kept.is_empty() { random_uuid() } else { kept }
}

/// `readSessionMarker(directory)`: the marker's `createdAt`, under its
/// current name or an earlier one; `None` is the TypeScript's `null`.
fn read_session_marker(directory: &str) -> Option<f64> {
    let names = std::iter::once(SESSION_MARKER).chain(OLD_CONVERSION_SESSION_MARKERS);
    for name in names {
        match read_file_utf8(&join(&[directory, name])) {
            Ok(text) => {
                let Ok(JsonValue::Object(value)) = json_parse(&text) else {
                    return None;
                };
                let version_ok =
                    matches!(value.get("version"), Some(JsonValue::Number(v)) if *v == 1.0);
                let created = match value.get("createdAt") {
                    Some(JsonValue::Number(x)) if x.is_finite() && *x >= 0.0 => *x,
                    _ => return None,
                };
                if !version_ok {
                    return None;
                }
                return Some(created);
            }
            Err(error) => {
                if error.code != Some("ENOENT") {
                    return None;
                }
            }
        }
    }
    None
}

/// `cleanupStaleMarkdownConversions(root, now, ttlMs)`
pub fn cleanup_stale_markdown_conversions(
    root: &str,
    now: f64,
    ttl_ms: f64,
) -> Result<Vec<String>, NodeError> {
    let absolute_root = resolve(&[root]);
    mkdir_p(&absolute_root)?;
    let mut removed: Vec<String> = Vec::new();
    let reader = fs::read_dir(namespaced(&absolute_root))
        .map_err(|e| node_error(&e, "scandir", &absolute_root))?;
    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in reader {
        let entry = entry.map_err(|e| node_error(&e, "scandir", &absolute_root))?;
        let kind = entry
            .file_type()
            .map_err(|e| node_error(&e, "scandir", &absolute_root))?;
        entries.push((
            entry.file_name().to_string_lossy().into_owned(),
            kind.is_dir(),
        ));
    }
    // libuv sorts the names by bytes
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir) in entries {
        if !is_dir || !name.starts_with("session-") {
            continue;
        }
        let directory = join(&[&absolute_root, &name]);
        if !is_path_inside(&absolute_root, &directory) {
            continue;
        }
        let Some(created_at) = read_session_marker(&directory) else {
            continue;
        };
        if now - created_at < ttl_ms {
            continue;
        }
        rm_recursive_force(&directory)?;
        removed.push(directory);
    }
    Ok(removed)
}

/// `createMarkdownConversionSession`'s `options`
#[derive(Default)]
pub struct SessionOptions<'a> {
    pub now: Option<f64>,
    pub id: Option<&'a str>,
    pub ttl_ms: Option<f64>,
}

/// `createMarkdownConversionSession(root, options)`; `clock_now` is
/// `Date.now()` and `random_uuid` is `randomUUID()`.
pub fn create_markdown_conversion_session(
    root: &str,
    options: &SessionOptions<'_>,
    clock_now: f64,
    random_uuid: &dyn Fn() -> String,
) -> Result<String, NodeError> {
    let now = options.now.unwrap_or(clock_now);
    let absolute_root = resolve(&[root]);
    cleanup_stale_markdown_conversions(
        &absolute_root,
        now,
        options.ttl_ms.unwrap_or(MARKDOWN_CONVERSION_TTL_MS),
    )?;
    let raw_id = match options.id {
        Some(id) => id.to_owned(),
        None => random_uuid(),
    };
    let id = safe_id(&raw_id, random_uuid);
    let directory = join(&[
        &absolute_root,
        &format!("session-{}-{id}", number_to_string(now)),
    ]);
    if !is_path_inside(&absolute_root, &directory) {
        return Err(plain_error("invalid Markdown conversion session path"));
    }
    mkdir(&directory)?;
    let created_at = if now.is_finite() {
        number_to_string(now)
    } else {
        "null".to_owned()
    };
    write_file_excl(
        &join(&[&directory, SESSION_MARKER]),
        format!("{{\"version\":1,\"createdAt\":{created_at}}}\n").as_bytes(),
    )?;
    Ok(directory)
}

/// `writeMarkdownConversion(sessionDirectory, suggestedName, bytes, id)`
pub fn write_markdown_conversion(
    session_directory: &str,
    suggested_name: &str,
    bytes: &[u8],
    id: Option<&str>,
    random_uuid: &dyn Fn() -> String,
) -> Result<String, NodeError> {
    let id = match id {
        Some(id) => id.to_owned(),
        None => random_uuid(),
    };
    if read_session_marker(session_directory).is_none() {
        return Err(plain_error("invalid Markdown conversion session"));
    }
    let base = safe_base_name(suggested_name);
    let safe = safe_id(&id, random_uuid);
    for suffix in 0..100_000u32 {
        let tail = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let target = join(&[session_directory, &format!("{base}-{safe}{tail}.docx")]);
        if !is_path_inside(&resolve(&[session_directory]), &resolve(&[&target])) {
            return Err(plain_error("invalid Markdown conversion output path"));
        }
        match write_file_excl(&target, bytes) {
            Ok(()) => return Ok(target),
            Err(error) if error.code == Some("EEXIST") => continue,
            Err(error) => return Err(error),
        }
    }
    Err(plain_error("Markdown conversion name space exhausted"))
}
