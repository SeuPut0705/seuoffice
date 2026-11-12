//! `apps/markdown/src/main/wiki-create.ts`: creating the note an unresolved
//! `[[target]]` names.

use std::fs::{self, OpenOptions};

use jscompat::js_regex;
use jscompat::node_path::host::{dirname, extname, is_absolute, join};
use jscompat::trim;
use serde::Serialize;

use super::wiki_resolve::split_target;
use crate::node_fs::{NodeError, code_of, namespaced, node_error};

/// characters no file name can carry; Windows names the set, the rest inherit it
const ILLEGAL_NAME_CHARS: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// the note types a created file may have
const NOTE_EXTS: [&str; 3] = [".md", ".markdown", ".txt"];

/// Windows device names (`RESERVED_NAME`)
fn is_reserved_segment(segment: &str) -> bool {
    let head = segment.split('.').next().unwrap_or("");
    js_regex!(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", "i").test(trim(head))
}

/// One directory segment of a created note's path, safe to join on every
/// supported filesystem.
fn sanitize_segment(segment: &str) -> String {
    let replaced: String = segment
        .chars()
        .map(|c| {
            if ILLEGAL_NAME_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = replaced.trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        "_".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// `CreateNoteOptions`
pub struct CreateNoteOptions<'a> {
    /// the vault root a directory-carrying target lands under
    pub root: &'a str,
    /// directory of the open document; a bare name is created here, '' for an untitled one
    pub from_dir: &'a str,
}

/// `CreatedNote`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreatedNote {
    /// absolute path of the note, created or already there
    pub path: String,
    /// the spelling a link to it resolves by
    pub target: String,
    /// the `#Heading` part of the target, for the caller to open on
    pub fragment: String,
    /// false when a file already occupied the path and nothing was written
    pub created: bool,
}

fn file_exists(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok_and(|meta| meta.is_file())
}

/// `createWikiNote(target, options)`: `Ok(None)` is the TypeScript's `null`.
pub fn create_wiki_note(
    target: &str,
    options: &CreateNoteOptions<'_>,
) -> Result<Option<CreatedNote>, NodeError> {
    let split = split_target(target);
    let (name, fragment) = (split.name, split.fragment);
    if name.is_empty() {
        return Ok(None);
    }
    // nothing created here may reach outside the vault
    if is_absolute(&name) || name.split(['\\', '/']).any(|segment| segment == "..") {
        return Ok(None);
    }
    let segments: Vec<String> = name
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .map(sanitize_segment)
        .collect();
    if segments.is_empty() {
        return Ok(None);
    }
    if segments.iter().any(|segment| is_reserved_segment(segment)) {
        return Ok(None);
    }
    let base = &segments[segments.len() - 1];
    // resolution's own candidate rule, mirrored exactly
    let ext = extname(base).to_lowercase();
    if !ext.is_empty() && !NOTE_EXTS.contains(&ext.as_str()) {
        return Ok(None);
    }
    let file_name = if ext.is_empty() {
        format!("{base}.md")
    } else {
        base.clone()
    };
    let dir: Option<String> = if segments.len() > 1 {
        if options.root.is_empty() {
            None
        } else {
            let mut parts: Vec<&str> = vec![options.root];
            parts.extend(segments[..segments.len() - 1].iter().map(String::as_str));
            Some(join(&parts))
        }
    } else if options.from_dir.is_empty() {
        Some(options.root.to_owned())
    } else {
        Some(options.from_dir.to_owned())
    };
    let Some(dir) = dir.filter(|dir| !dir.is_empty()) else {
        return Ok(None);
    };
    let path = join(&[&dir, &file_name]);
    let link_target = {
        let mut parts: Vec<&str> = segments[..segments.len() - 1]
            .iter()
            .map(String::as_str)
            .collect();
        parts.push(base);
        parts.join("/")
    };
    let note = |created: bool| CreatedNote {
        path: path.clone(),
        target: link_target.clone(),
        fragment: fragment.clone(),
        created,
    };
    // already there: opening it is the whole job, a second write would clobber it
    if file_exists(&path) {
        return Ok(Some(note(false)));
    }
    let parent = dirname(&path);
    fs::create_dir_all(namespaced(&parent)).map_err(|e| node_error(&e, "mkdir", &parent))?;
    // exclusive create: a file that appeared since the check above is kept
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(namespaced(&path))
    {
        Ok(_) => {}
        Err(e) => {
            if code_of(&e) == Some("EEXIST") && file_exists(&path) {
                return Ok(Some(note(false)));
            }
            return Err(node_error(&e, "open", &path));
        }
    }
    Ok(Some(note(true)))
}
