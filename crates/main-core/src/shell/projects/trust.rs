//! `apps/shell/src/main/projects/trust.ts`: the first-time trust check (spec
//! 5.10). Before a folder joins the list, the person sees everything in it
//! this install did not write: the instructions, the memory, the root
//! `AGENTS.md` / `CLAUDE.md`, and chats another install wrote (by the chat
//! info or by any one message). Nothing here decides; the guide records the
//! answer.

use jscompat::{JsonValue, json_parse, trim};

use super::folder_files::{
    data_dir_name, hash_text, plain_file_in, plain_folder_entries, read_folder_text,
};
use super::memory::memory_has_content;
use crate::node_fs::namespaced;
use crate::packages::project_store::{
    ProjectForeignChat, ProjectHashedFile, ProjectHashes, ProjectId, ProjectTrustPrompt,
    is_valid_project_id, project_folder_name,
};

/// `HashedTexts`: the texts the trust record hashes, read as they are now
/// (`None` when absent)
#[derive(Debug, Clone, PartialEq)]
pub struct HashedTexts {
    /// The data folder name `instructions` and `memory` were read from
    /// (`dataDirName`)
    pub data_dir: String,
    pub instructions: Option<String>,
    pub memory: Option<String>,
    pub agents: Option<String>,
    pub claude: Option<String>,
}

impl HashedTexts {
    /// `texts[file]`
    pub fn text(&self, file: ProjectHashedFile) -> Option<&str> {
        match file {
            ProjectHashedFile::Instructions => self.instructions.as_deref(),
            ProjectHashedFile::Memory => self.memory.as_deref(),
            ProjectHashedFile::Agents => self.agents.as_deref(),
            ProjectHashedFile::Claude => self.claude.as_deref(),
        }
    }
}

/// `readHashedTexts(root)`
pub fn read_hashed_texts(root: &str) -> HashedTexts {
    let data_dir = data_dir_name(root);
    let instructions = read_folder_text(
        root,
        &[data_dir.as_str(), project_folder_name("instructionsFile")],
    );
    let memory = read_folder_text(
        root,
        &[data_dir.as_str(), project_folder_name("memoryFile")],
    );
    let agents = read_folder_text(root, &[project_folder_name("rootAgentsFile")]);
    let claude = read_folder_text(root, &[project_folder_name("rootClaudeFile")]);
    HashedTexts {
        data_dir,
        instructions,
        memory,
        agents,
        claude,
    }
}

/// `hashesOf(texts)`: hashes of the present texts, keyed as in the trust record
pub fn hashes_of(texts: &HashedTexts) -> ProjectHashes {
    let mut out = ProjectHashes::new();
    for file in ProjectHashedFile::ALL {
        if let Some(text) = texts.text(file) {
            out.set(file.as_str(), hash_text(text));
        }
    }
    out
}

/// `shown(text)`: text worth showing: absent and blank files carry nothing
fn shown(text: Option<&str>) -> Option<String> {
    text.filter(|text| !trim(text).is_empty())
        .map(str::to_owned)
}

/// `ChatInfoLike`; `origin` is `None` for anything but a string, which never
/// equals an install id
struct ChatInfoLike {
    project_id: String,
    title: String,
    updated_at: String,
    origin: Option<String>,
}

/// `parseChatInfo(text, id)`
fn parse_chat_info(text: Option<&str>, id: &str) -> Option<ChatInfoLike> {
    let text = text?;
    let Ok(JsonValue::Object(raw)) = json_parse(text) else {
        return None;
    };
    match raw.get("id") {
        Some(JsonValue::String(raw_id)) if raw_id == id => {}
        _ => return None,
    }
    let Some(JsonValue::String(project_id)) = raw.get("projectId") else {
        return None;
    };
    if !is_valid_project_id(project_id) {
        return None;
    }
    let string_or_empty = |key: &str| match raw.get(key) {
        Some(JsonValue::String(value)) => value.clone(),
        _ => String::new(),
    };
    Some(ChatInfoLike {
        project_id: project_id.clone(),
        title: string_or_empty("title"),
        updated_at: string_or_empty("updatedAt"),
        origin: match raw.get("origin") {
            Some(JsonValue::String(origin)) => Some(origin.clone()),
            _ => None,
        },
    })
}

/// The lines `readline.createInterface({ input, crlfDelay: Infinity })` gives
/// for a text: split at `\n`, `\r\n` and a lone `\r`, the last line without a
/// terminator kept, no empty line after a final terminator
fn readline_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\n' => {
                lines.push(&text[start..at]);
                at += 1;
                start = at;
            }
            b'\r' => {
                lines.push(&text[start..at]);
                at += if bytes.get(at + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = at;
            }
            _ => at += 1,
        }
    }
    if start < bytes.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// `hasForeignMessage(root, chatId, installId, dataDir)`: whether any message
/// line of a chat was written by another install. The scan stops at the first
/// foreign line; unreadable lines are skipped, as chat reading does. A file
/// that cannot be read counts as foreign: under "without" such a chat stays
/// hidden. The file is read whole where the TypeScript streams it.
pub fn has_foreign_message(
    root: &str,
    chat_id: &str,
    install_id: &str,
    data_dir: Option<&str>,
) -> bool {
    let data_dir = data_dir.map_or_else(|| data_dir_name(root), str::to_owned);
    let file = format!("{chat_id}{}", project_folder_name("chatMessagesExt"));
    let Some(path) = plain_file_in(
        root,
        &[
            data_dir.as_str(),
            project_folder_name("chatsDir"),
            file.as_str(),
        ],
    ) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(namespaced(&path)) else {
        return true;
    };
    let text = String::from_utf8_lossy(&bytes);
    for line in readline_lines(&text) {
        if trim(line).is_empty() {
            continue;
        }
        match json_parse(line) {
            Err(_) => continue,
            Ok(JsonValue::Object(record)) => match record.get("origin") {
                Some(JsonValue::String(origin)) if origin == install_id => {}
                _ => return true,
            },
            // an array is an object with no `origin`
            Ok(JsonValue::Array(_)) => return true,
            Ok(_) => continue,
        }
    }
    false
}

/// `listForeignChats(root, projectId, installId, dataDir)`: chats of this
/// project (info `projectId` equal to `projectId`) written by another install.
/// Chats of another project id never show in the list, so they are left out.
pub fn list_foreign_chats(
    root: &str,
    project_id: &str,
    install_id: &str,
    data_dir: Option<&str>,
) -> Vec<ProjectForeignChat> {
    let data_dir = data_dir.map_or_else(|| data_dir_name(root), str::to_owned);
    let chat_info_ext = project_folder_name("chatInfoExt");
    let chats_dir = project_folder_name("chatsDir");
    let mut out = Vec::new();
    let mut names = plain_folder_entries(root, &[data_dir.as_str(), chats_dir]);
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for name in &names {
        let Some(id) = name.strip_suffix(chat_info_ext) else {
            continue;
        };
        if !is_valid_project_id(id) {
            continue;
        }
        let text = read_folder_text(root, &[data_dir.as_str(), chats_dir, name.as_str()]);
        let Some(info) = parse_chat_info(text.as_deref(), id) else {
            continue;
        };
        if info.project_id != project_id {
            continue;
        }
        if info.origin.as_deref() != Some(install_id)
            || has_foreign_message(root, id, install_id, Some(data_dir.as_str()))
        {
            out.push(ProjectForeignChat {
                id: id.to_owned(),
                title: info.title,
                updated_at: info.updated_at,
            });
        }
    }
    out
}

/// `TrustScanInput`
#[derive(Debug, Clone, PartialEq)]
pub struct TrustScanInput {
    pub root: String,
    pub project_id: ProjectId,
    pub name: String,
    pub install_id: String,
}

/// `TrustScan`
#[derive(Debug, Clone, PartialEq)]
pub struct TrustScan {
    pub prompt: ProjectTrustPrompt,
    /// Whether there is anything to confirm at all
    pub foreign: bool,
    /// Hashes of the texts as shown, recorded with the answer
    pub hashes: ProjectHashes,
}

/// `scanForTrust(input)`: what the trust prompt shows for a folder, and
/// whether it has to be shown
pub fn scan_for_trust(input: &TrustScanInput) -> TrustScan {
    let texts = read_hashed_texts(&input.root);
    let foreign_chats = list_foreign_chats(
        &input.root,
        &input.project_id,
        &input.install_id,
        Some(texts.data_dir.as_str()),
    );
    let prompt = ProjectTrustPrompt {
        project_id: input.project_id.clone(),
        name: input.name.clone(),
        folder_path: input.root.clone(),
        instructions: shown(texts.instructions.as_deref()),
        memory: if memory_has_content(texts.memory.as_deref()) {
            texts.memory.clone()
        } else {
            None
        },
        agents: shown(texts.agents.as_deref()),
        claude: shown(texts.claude.as_deref()),
        foreign_chats,
    };
    let foreign = prompt.instructions.is_some()
        || prompt.memory.is_some()
        || prompt.agents.is_some()
        || prompt.claude.is_some()
        || !prompt.foreign_chats.is_empty();
    TrustScan {
        prompt,
        foreign,
        hashes: hashes_of(&texts),
    }
}
