//! `apps/shell/src/main/projects/identity.ts`: a project's identity is the
//! `id` in `.seuoffice/project.json`, not its path (spec 5.11). When a folder
//! is added (or a missing project is re-picked) this decides whether it is a
//! project the list already knows, the same project moved, or a copy that
//! needs an id of its own.

use jscompat::node_path::host::join;
use jscompat::truthy;
use serde::{Deserialize, Serialize};

use super::folder_files::read_project_file;
use super::paths::{relative_inside, same_path};
use super::selection::delete_key;
use crate::node_fs::namespaced;
use crate::packages::project_store::{
    FolderIdentity, ProjectFolderFile, ProjectId, ProjectListEntry,
};
use crate::shell::app_settings::{ProjectListEntry as ListEntry, StoredProjectsSettings};

/// The `reason` of a refused `FolderClassification`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FolderRefusal {
    DifferentProject,
}

/// `FolderClassification`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FolderClassification {
    Refused {
        reason: FolderRefusal,
    },
    #[serde(rename_all = "camelCase")]
    Ok {
        identity: FolderIdentity,
        /// The project id to list the folder under; `None` (`null`) when a new one must be made
        id: Option<ProjectId>,
        /// The list entry the folder takes over (moved, re-picked)
        #[serde(skip_serializing_if = "Option::is_none")]
        previous: Option<ProjectListEntry>,
        /// For a copy: the project it was copied from (its trust and switches carry over)
        #[serde(skip_serializing_if = "Option::is_none")]
        copied_from: Option<ProjectId>,
        /// A list entry at this path whose id the folder no longer carries; it is dropped
        #[serde(skip_serializing_if = "Option::is_none")]
        stale_at_path: Option<ProjectId>,
    },
}

/// `ClassifyInput`
#[derive(Debug, Clone, Copy)]
pub struct ClassifyInput<'a> {
    /// Canonical folder path
    pub root: &'a str,
    /// The folder's `project.json`, or `None` (`null`)
    pub file: Option<&'a ProjectFolderFile>,
    pub settings: &'a StoredProjectsSettings,
    pub platform: &'a str,
    /// Re-picking this "folder missing" project
    pub relocate_id: Option<&'a str>,
}

/// An entry of `settings.list` as the project store's type
fn listed(entry: &ListEntry) -> ProjectListEntry {
    ProjectListEntry {
        id: entry.id.clone(),
        path: entry.path.clone(),
        pinned: entry.pinned,
        last_used_at: entry.last_used_at.clone(),
    }
}

/// `idAt(path)`
fn id_at(path: &str) -> Option<ProjectId> {
    match std::fs::metadata(namespaced(path)) {
        Ok(info) if info.is_dir() => {}
        _ => return None,
    }
    read_project_file(path, None).map(|file| file.id)
}

/// `classifyFolder(input)`
///
/// - Re-pick: the chosen folder becomes the project's new path when it has no
///   `project.json` or the same id; another id is refused.
/// - Already listed at this path (same id or no `project.json`): existing.
/// - Its id is listed at another path: a copy when that path still holds the same
///   id, otherwise the same project moved.
/// - Otherwise new (keeping the folder's id when it has one).
pub fn classify_folder(input: &ClassifyInput) -> FolderClassification {
    let ClassifyInput {
        root,
        file,
        settings,
        platform,
        relocate_id,
    } = *input;
    let at_path = settings
        .list
        .iter()
        .find(|item| same_path(&item.path, root, platform));

    if let Some(relocate_id) = truthy(relocate_id) {
        if file.is_some_and(|file| file.id != relocate_id)
            || at_path.is_some_and(|item| item.id != relocate_id)
        {
            return FolderClassification::Refused {
                reason: FolderRefusal::DifferentProject,
            };
        }
        return FolderClassification::Ok {
            identity: if at_path.is_some() {
                FolderIdentity::Existing
            } else {
                FolderIdentity::Moved
            },
            id: Some(relocate_id.to_owned()),
            previous: settings
                .list
                .iter()
                .find(|item| item.id == relocate_id)
                .map(listed),
            copied_from: None,
            stale_at_path: None,
        };
    }

    if let Some(item) = at_path
        && file.is_none_or(|file| file.id == item.id)
    {
        return FolderClassification::Ok {
            identity: FolderIdentity::Existing,
            id: Some(item.id.clone()),
            previous: None,
            copied_from: None,
            stale_at_path: None,
        };
    }
    let stale_at_path = at_path.map(|item| item.id.clone());
    let known = file.and_then(|file| {
        settings
            .list
            .iter()
            .find(|item| item.id == file.id && !same_path(&item.path, root, platform))
    });
    if let (Some(file), Some(known)) = (file, known) {
        if id_at(&known.path).as_deref() == Some(file.id.as_str()) {
            return FolderClassification::Ok {
                identity: FolderIdentity::Copied,
                id: None,
                previous: None,
                copied_from: Some(file.id.clone()),
                stale_at_path,
            };
        }
        return FolderClassification::Ok {
            identity: FolderIdentity::Moved,
            id: Some(file.id.clone()),
            previous: Some(listed(known)),
            copied_from: None,
            stale_at_path,
        };
    }
    FolderClassification::Ok {
        identity: FolderIdentity::New,
        id: file.map(|file| file.id.clone()),
        previous: None,
        copied_from: None,
        stale_at_path,
    }
}

/// `rebaseOptOuts(settings, id, oldRoot, newRoot, platform)`: "No project"
/// records of documents in a moved project follow it to the new path
pub fn rebase_opt_outs(
    settings: &mut StoredProjectsSettings,
    id: &str,
    old_root: &str,
    new_root: &str,
    platform: &str,
) {
    // `Object.entries(...)` is the list as it was before the loop changed it
    let entries: Vec<(String, String)> = settings
        .opted_out_documents
        .entries()
        .into_iter()
        .map(|(doc, project_id)| (doc.to_owned(), project_id.clone()))
        .collect();
    for (doc, project_id) in entries {
        if project_id != id {
            continue;
        }
        let Some(rel) = relative_inside(old_root, &doc, platform) else {
            continue;
        };
        delete_key(&mut settings.opted_out_documents, &doc);
        let mut parts: Vec<&str> = vec![new_root];
        parts.extend(rel.split('/'));
        settings
            .opted_out_documents
            .set(join(&parts), id.to_owned());
    }
}
