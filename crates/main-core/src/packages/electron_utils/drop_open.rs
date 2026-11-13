//! `packages/electron-utils/src/drop-open.ts`: the payload judgment of an OS
//! file drop. The preload half of the file (`droppableFilePaths`,
//! `installDropOpenBridge`: DOM events and `webUtils`) is not here: it runs
//! in a renderer. What moved is `partitionDropPayload`, which the shell's main
//! process calls on what the preload sent.

use jscompat::{JsRegex, js_regex, trim};
use serde_json::Value;

/// `DROP_OPEN_CHANNEL`
pub const DROP_OPEN_CHANNEL: &str = "app:open-dropped-files";

/// upper bound on how many files one drop may ask to open
pub const MAX_DROPPED_FILES: usize = 20;

/// `OPENABLE_DOC_RE`
pub fn openable_doc_re() -> &'static JsRegex {
    js_regex!(
        r"\.(docx|doc|dot|odt|xlsx|xlsm|xls|csv|tsv|ods|pptx|ppt|odp|otp|pdf|md|markdown|html|htm|xmind|mm|hwp|hwpx|epub|drawio|dio|vsdx|drawio\.svg|drawio\.png)$",
        "i"
    )
}

/// `KNOWN_UNSUPPORTED_DOC_RE`
pub fn known_unsupported_doc_re() -> &'static JsRegex {
    js_regex!(r"\.(rtf|pps|xlsb|pages|key|numbers)$", "i")
}

/// `SKILL_DROP_RE`
pub fn skill_drop_re() -> &'static JsRegex {
    js_regex!(r"(?:^|[\\/])skill\.md$|\.zip$", "i")
}

/// What `partitionDropPayload` answers, its keys in the order of the literal.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DropPartition {
    pub supported: Vec<String>,
    pub skill_files: Vec<String>,
    pub unsupported_exts: Vec<String>,
}

/// `partitionDropPayload(raw)`: strings only, trimmed, deduped, capped, then
/// split into directly-openable paths, files that may hold skills, and
/// known-unsupported extensions (unique, first-seen order).
pub fn partition_drop_payload(raw: &Value) -> DropPartition {
    let mut out = DropPartition::default();
    let Value::Array(entries) = raw else {
        return out;
    };
    let mut seen: Vec<String> = Vec::new();
    for entry in entries {
        let Value::String(entry) = entry else {
            continue;
        };
        let path = trim(entry);
        if path.is_empty() || seen.iter().any(|held| held == path) {
            continue;
        }
        seen.push(path.to_owned());
        // first: a SKILL.md is also a markdown file, and goes to the skill preview
        if skill_drop_re().test(path) {
            if out.skill_files.len() < MAX_DROPPED_FILES {
                out.skill_files.push(path.to_owned());
            }
        } else if openable_doc_re().test(path) {
            // keep scanning for unsupported entries even after hitting the open cap
            if out.supported.len() < MAX_DROPPED_FILES {
                out.supported.push(path.to_owned());
            }
        } else if known_unsupported_doc_re().test(path) {
            // the pattern ends the path in an ASCII extension
            let at = path.rfind('.').map_or(0, |dot| dot + 1);
            let ext = path[at..].to_ascii_lowercase();
            if !out.unsupported_exts.contains(&ext) {
                out.unsupported_exts.push(ext);
            }
        }
    }
    out
}
