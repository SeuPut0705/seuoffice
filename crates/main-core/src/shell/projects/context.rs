//! `apps/shell/src/main/projects/context.ts`: the instructions and memory one
//! request carries for a trusted project (spec 5.4, 5.10). Pure: given the
//! texts as read now and the trust record, it returns what to send, the
//! notices, and the hashes to record.
//!
//! Lengths and cuts are in UTF-16 code units, as `String.length` and `slice`
//! count them. The limits are whole numbers (`u64`): the TypeScript's `number`
//! parameters only ever hold the two constants or a whole limit a caller
//! chose.

use jscompat::trim;

use super::folder_files::hash_text;
use super::memory::memory_has_content;
use super::trust::HashedTexts;
use crate::packages::project_store::{
    ProjectHashedFile, ProjectInstructionsSource, ProjectNotice, ProjectSettings,
    ProjectTrustRecord, project_folder_name,
};

/// `INSTRUCTIONS_LIMIT_CHARS`: instructions sent per request, all sources
/// together; the tail past this is dropped with a notice
pub const INSTRUCTIONS_LIMIT_CHARS: u64 = 32_000;

/// `INSTRUCTION_PARTS`, in order: the source of each part
const INSTRUCTION_PARTS: [ProjectInstructionsSource; 3] = [
    ProjectInstructionsSource::Instructions,
    ProjectInstructionsSource::Agents,
    ProjectInstructionsSource::Claude,
];

/// `INSTRUCTION_PARTS[..].label(dataDir)`: the line naming each part;
/// `instructions.md` is named in the data folder it was read from
fn part_label(source: ProjectInstructionsSource, data_dir: &str) -> String {
    match source {
        ProjectInstructionsSource::Instructions => {
            format!("{data_dir}/{}", project_folder_name("instructionsFile"))
        }
        ProjectInstructionsSource::Agents => project_folder_name("rootAgentsFile").to_owned(),
        ProjectInstructionsSource::Claude => project_folder_name("rootClaudeFile").to_owned(),
    }
}

/// `texts[source]`
fn source_text(texts: &HashedTexts, source: ProjectInstructionsSource) -> Option<&str> {
    match source {
        ProjectInstructionsSource::Instructions => texts.instructions.as_deref(),
        ProjectInstructionsSource::Agents => texts.agents.as_deref(),
        ProjectInstructionsSource::Claude => texts.claude.as_deref(),
    }
}

/// The `instructions` object of `TrustedContext`
#[derive(Debug, Clone, PartialEq)]
pub struct TrustedInstructions {
    pub text: String,
    pub sources: Vec<ProjectInstructionsSource>,
    pub data_dir: String,
}

/// The `memory` object of `TrustedContext`
#[derive(Debug, Clone, PartialEq)]
pub struct TrustedMemory {
    pub text: String,
    /// `text.length`
    pub chars: u64,
}

/// `TrustedContext`
#[derive(Debug, Clone, PartialEq)]
pub struct TrustedContext {
    pub instructions: Option<TrustedInstructions>,
    pub memory: Option<TrustedMemory>,
    pub notices: Vec<ProjectNotice>,
    /// `hashUpdates`: the new hash per changed file, in the order the keys
    /// were set; `None` (`null`) drops the hash of a file that is gone
    pub hash_updates: Vec<(ProjectHashedFile, Option<String>)>,
}

/// `text.length`
fn length(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

/// `cutAt(text, limit)`: `text` cut to `limit` characters without splitting
/// a surrogate pair
pub fn cut_at(text: &str, limit: u64) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() as u64 <= limit {
        return text.to_owned();
    }
    // `limit` is below the length here, so it is a valid index
    let mut end = limit as usize;
    // `text.charCodeAt(end - 1)`: out of range (`end` 0) is NaN, no match
    if let Some(code) = end.checked_sub(1).map(|at| units[at])
        && (0xd800..=0xdbff).contains(&code)
    {
        end -= 1;
    }
    String::from_utf16_lossy(&units[..end])
}

/// `assembleTrustedContext(texts, record, switches, limitChars, memoryLimitChars)`
///
/// - Instructions: `instructions.md`, then the root `AGENTS.md` and `CLAUDE.md` when
///   they are read, each under a line naming its file; cut at `limitChars` with an
///   "instructions-truncated" notice.
/// - Memory: the whole `memory.md`, never cut; over `memoryLimitChars` adds "memory-long".
/// - A file whose hash differs from the record changed outside the app: one
///   "instructions-changed" / "memory-changed" notice, and its new hash is returned.
///
/// `limit_chars` is `INSTRUCTIONS_LIMIT_CHARS` and `memory_limit_chars` is
/// `MEMORY_SOFT_LIMIT_CHARS` where the TypeScript leaves them out (the
/// caller passes them).
pub fn assemble_trusted_context(
    texts: &HashedTexts,
    record: &ProjectTrustRecord,
    switches: &ProjectSettings,
    limit_chars: u64,
    memory_limit_chars: u64,
) -> TrustedContext {
    let mut notices: Vec<ProjectNotice> = Vec::new();
    let mut hash_updates: Vec<(ProjectHashedFile, Option<String>)> = Vec::new();
    let mut changed: Vec<ProjectInstructionsSource> = Vec::new();
    let mut memory_changed = false;
    let watched: &[ProjectHashedFile] = if switches.read_agents_files {
        &[
            ProjectHashedFile::Instructions,
            ProjectHashedFile::Agents,
            ProjectHashedFile::Claude,
            ProjectHashedFile::Memory,
        ]
    } else {
        &[ProjectHashedFile::Instructions, ProjectHashedFile::Memory]
    };
    for &file in watched {
        let text = texts.text(file);
        let known = record.hashes.get(file.as_str());
        let Some(text) = text else {
            if known.is_some() {
                hash_updates.push((file, None));
            }
            continue;
        };
        let hash = hash_text(text);
        if Some(&hash) == known {
            continue;
        }
        hash_updates.push((file, Some(hash)));
        let nonblank = !trim(text).is_empty();
        match file {
            ProjectHashedFile::Memory => memory_changed = memory_has_content(Some(text)),
            ProjectHashedFile::Instructions if nonblank => {
                changed.push(ProjectInstructionsSource::Instructions);
            }
            ProjectHashedFile::Agents if nonblank => {
                changed.push(ProjectInstructionsSource::Agents)
            }
            ProjectHashedFile::Claude if nonblank => {
                changed.push(ProjectInstructionsSource::Claude)
            }
            _ => {}
        }
    }
    if !changed.is_empty() {
        notices.push(ProjectNotice::InstructionsChanged { files: changed });
    }
    if memory_changed {
        notices.push(ProjectNotice::MemoryChanged);
    }

    let mut instructions: Option<TrustedInstructions> = None;
    let mut parts: Vec<(ProjectInstructionsSource, String)> = Vec::new();
    for source in INSTRUCTION_PARTS {
        if source != ProjectInstructionsSource::Instructions && !switches.read_agents_files {
            continue;
        }
        let Some(text) = source_text(texts, source) else {
            continue;
        };
        if trim(text).is_empty() {
            continue;
        }
        parts.push((
            source,
            format!("[{}]\n{}", part_label(source, &texts.data_dir), trim(text)),
        ));
    }
    if !parts.is_empty() {
        let full = parts
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let text = cut_at(&full, limit_chars);
        let text_length = length(&text);
        let mut sources: Vec<ProjectInstructionsSource> = Vec::new();
        let mut offset: u64 = 0;
        for (source, part) in &parts {
            if offset < text_length {
                sources.push(*source);
            }
            offset += length(part) + 2;
        }
        let full_length = length(&full);
        instructions = Some(TrustedInstructions {
            text,
            sources,
            data_dir: texts.data_dir.clone(),
        });
        if text_length < full_length {
            notices.push(ProjectNotice::InstructionsTruncated {
                chars: full_length,
                limit: limit_chars,
            });
        }
    }

    let mut memory: Option<TrustedMemory> = None;
    if let Some(text) = texts.memory.as_deref()
        && memory_has_content(Some(text))
    {
        let chars = length(text);
        memory = Some(TrustedMemory {
            text: text.to_owned(),
            chars,
        });
        if chars > memory_limit_chars {
            notices.push(ProjectNotice::MemoryLong {
                chars,
                limit: memory_limit_chars,
            });
        }
    }
    TrustedContext {
        instructions,
        memory,
        notices,
        hash_updates,
    }
}
