//! `apps/shell/src/main/projects/selection.ts`: which project a window's AI
//! panel starts with (spec 5.2), and how a choice made there is remembered
//! (spec 4). Pure rules over the `projects` settings; document paths arrive
//! canonical. Only `findUnregisteredProject` reads the disk (`project.json`
//! of the folders above a document), synchronously here.

use jscompat::{JsObject, truthy};
use serde::{Deserialize, Serialize};

use super::folder_files::read_project_file;
use super::paths::{RefusalContext, is_inside_folder, location_refusal, path_api, same_path};
use crate::packages::project_store::{ProjectId, ProjectSelection, UnregisteredProjectHint};
use crate::shell::app_settings::{OutsideDocumentChoice, ProjectListEntry, StoredProjectsSettings};

/// `ResolvedSelectionTarget`: whose AI panel asks, with a saved document's
/// path already canonical
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResolvedSelectionTarget {
    #[serde(rename_all = "camelCase")]
    Document {
        doc_key: String,
    },
    #[serde(rename_all = "camelCase")]
    Untitled {
        #[serde(default)]
        project_id: Option<ProjectId>,
    },
    Home,
}

/// `delete record[key]` on an object kept as a [`JsObject`] (it has no
/// `delete`): the other entries keep their order, and a key set again goes
/// to the end
pub(super) fn delete_key<V: Clone>(record: &mut JsObject<V>, key: &str) {
    *record = record
        .entries()
        .into_iter()
        .filter(|(name, _)| *name != key)
        .map(|(name, value)| (name.to_owned(), value.clone()))
        .collect();
}

/// `findPathKey(record, path, platform)`: the key of `record` naming the same
/// path as `path`, if any (earlier spellings included)
pub fn find_path_key<V>(record: &JsObject<V>, path: &str, platform: &str) -> Option<String> {
    if record.get(path).is_some() {
        return Some(path.to_owned());
    }
    record
        .entries()
        .into_iter()
        .map(|(key, _)| key)
        .find(|key| same_path(key, path, platform))
        .map(str::to_owned)
}

/// `item.path.length`
fn path_length(item: &ProjectListEntry) -> usize {
    item.path.encode_utf16().count()
}

/// `containerOf(docKey, settings, platform)`: the registered project folder
/// holding a document; the nearest one when they nest
pub fn container_of<'a>(
    doc_key: &str,
    settings: &'a StoredProjectsSettings,
    platform: &str,
) -> Option<&'a ProjectListEntry> {
    let mut best: Option<&ProjectListEntry> = None;
    for item in &settings.list {
        if same_path(&item.path, doc_key, platform) {
            continue;
        }
        if !is_inside_folder(doc_key, &item.path, platform) {
            continue;
        }
        if best.is_none_or(|best| path_length(item) > path_length(best)) {
            best = Some(item);
        }
    }
    best
}

/// `listedId(settings, id)`
fn listed_id(settings: &StoredProjectsSettings, id: Option<&str>) -> Option<ProjectId> {
    truthy(id)
        .filter(|id| settings.list.iter().any(|item| item.id == *id))
        .map(str::to_owned)
}

/// `selectionFor(settings, target, platform)`: the starting selection without
/// the unregistered-folder hint:
/// - inside a registered project folder: that project, unless the document was set to "no project";
/// - outside every project folder: the remembered choice and its last chat, else "no project";
/// - untitled: "no project", or the project a create flow opened it in;
/// - home: the home panel's last choice.
pub fn selection_for(
    settings: &StoredProjectsSettings,
    target: &ResolvedSelectionTarget,
    platform: &str,
) -> ProjectSelection {
    let selection =
        |project_id: Option<ProjectId>, initial_chat_id: Option<ProjectId>| ProjectSelection {
            project_id,
            initial_chat_id,
            unregistered_project_hint: None,
        };
    let doc_key = match target {
        ResolvedSelectionTarget::Home => {
            let home = settings.home_project_id.as_ref().and_then(Option::as_deref);
            return selection(listed_id(settings, home), None);
        }
        ResolvedSelectionTarget::Untitled { project_id } => {
            return selection(listed_id(settings, project_id.as_deref()), None);
        }
        ResolvedSelectionTarget::Document { doc_key } => doc_key,
    };
    if let Some(container) = container_of(doc_key, settings, platform) {
        let opted_out = find_path_key(&settings.opted_out_documents, doc_key, platform);
        let project_id = if truthy(opted_out.as_deref()).is_some() {
            None
        } else {
            Some(container.id.clone())
        };
        return selection(project_id, None);
    }
    let key = find_path_key(&settings.outside_documents, doc_key, platform);
    let choice = truthy(key.as_deref()).and_then(|key| settings.outside_documents.get(key));
    let project_id = listed_id(
        settings,
        choice.and_then(|choice| choice.project_id.as_deref()),
    );
    let last_chat = choice.and_then(|choice| truthy(choice.last_chat_id.as_deref()));
    let initial_chat_id = match (&project_id, last_chat) {
        (Some(_), Some(chat)) => Some(chat.to_owned()),
        _ => None,
    };
    selection(project_id, initial_chat_id)
}

/// `recordSelection(settings, target, projectId, platform)`: remember a choice
/// (changes `settings`). A document inside a project keeps only "no project"
/// (or its undoing); a document outside every project keeps its choice (and
/// its last chat while the project stays the same); the home panel keeps its
/// last choice; an untitled document keeps nothing.
pub fn record_selection(
    settings: &mut StoredProjectsSettings,
    target: &ResolvedSelectionTarget,
    project_id: Option<&str>,
    platform: &str,
) {
    let doc_key = match target {
        ResolvedSelectionTarget::Home => {
            settings.home_project_id = Some(project_id.map(str::to_owned));
            return;
        }
        ResolvedSelectionTarget::Untitled { .. } => return,
        ResolvedSelectionTarget::Document { doc_key } => doc_key,
    };
    if let Some(container_id) =
        container_of(doc_key, settings, platform).map(|container| container.id.clone())
    {
        let key = find_path_key(&settings.opted_out_documents, doc_key, platform);
        let has_key = truthy(key.as_deref()).is_some();
        match project_id {
            None => {
                if let Some(key) = truthy(key.as_deref()) {
                    delete_key(&mut settings.opted_out_documents, key);
                }
                settings.opted_out_documents.set(doc_key, container_id);
            }
            Some(id) if id == container_id && has_key => {
                if let Some(key) = key {
                    delete_key(&mut settings.opted_out_documents, &key);
                }
            }
            Some(_) => {}
        }
        return;
    }
    let key = find_path_key(&settings.outside_documents, doc_key, platform);
    let key = truthy(key.as_deref());
    let before = key.and_then(|key| settings.outside_documents.get(key).cloned());
    if let Some(key) = key {
        delete_key(&mut settings.outside_documents, key);
    }
    let kept_chat = match (project_id, &before) {
        (Some(id), Some(before)) if before.project_id.as_deref() == Some(id) => {
            truthy(before.last_chat_id.as_deref()).map(str::to_owned)
        }
        _ => None,
    };
    settings.outside_documents.set(
        doc_key,
        OutsideDocumentChoice {
            project_id: project_id.map(str::to_owned),
            last_chat_id: kept_chat,
        },
    );
}

/// `recordOutsideChat(settings, docKey, projectId, chatId, platform)`: a
/// document outside every project folder last used `chatId` of `projectId`
/// (changes `settings`)
pub fn record_outside_chat(
    settings: &mut StoredProjectsSettings,
    doc_key: &str,
    project_id: &str,
    chat_id: &str,
    platform: &str,
) {
    if container_of(doc_key, settings, platform).is_some() {
        return;
    }
    if !settings.list.iter().any(|item| item.id == project_id) {
        return;
    }
    let key = find_path_key(&settings.outside_documents, doc_key, platform);
    if let Some(key) = truthy(key.as_deref()) {
        delete_key(&mut settings.outside_documents, key);
    }
    settings.outside_documents.set(
        doc_key,
        OutsideDocumentChoice {
            project_id: Some(project_id.to_owned()),
            last_chat_id: Some(chat_id.to_owned()),
        },
    );
}

/// `dropFromList(settings, id)`: "Remove from list": the entry, its pin and
/// the project's per-document records go (changes `settings`)
pub fn drop_from_list(settings: &mut StoredProjectsSettings, id: &str) {
    settings.list.retain(|item| item.id != id);
    // `Object.entries` is taken first and each match is deleted; the entries
    // that stay keep their order
    settings.opted_out_documents = settings
        .opted_out_documents
        .entries()
        .into_iter()
        .filter(|(_, record)| record.as_str() != id)
        .map(|(doc, record)| (doc.to_owned(), record.clone()))
        .collect();
    settings.outside_documents = settings
        .outside_documents
        .entries()
        .into_iter()
        .filter(|(_, choice)| choice.project_id.as_deref() != Some(id))
        .map(|(doc, choice)| (doc.to_owned(), choice.clone()))
        .collect();
    if settings.home_project_id.as_ref().and_then(Option::as_deref) == Some(id) {
        settings.home_project_id = Some(None);
    }
}

/// `findUnregisteredProject(docKey, settings, ctx)`: the nearest unregistered
/// folder above a document holding `.seuoffice/project.json` (spec 5.2),
/// stopping at the registered project folder holding the document. Folders
/// that could never be a project (drive, home, protected) are skipped.
pub fn find_unregistered_project(
    doc_key: &str,
    settings: &StoredProjectsSettings,
    ctx: &RefusalContext,
) -> Option<UnregisteredProjectHint> {
    let platform = ctx.platform.as_str();
    let api = path_api(platform);
    let stop_at =
        container_of(doc_key, settings, platform).map(|container| container.path.as_str());
    let mut dir = api.dirname(doc_key);
    loop {
        if let Some(stop_at) = truthy(stop_at)
            && same_path(&dir, stop_at, platform)
        {
            return None;
        }
        let listed = settings
            .list
            .iter()
            .any(|item| same_path(&item.path, &dir, platform));
        if !listed
            && location_refusal(&dir, ctx).is_none()
            && let Some(file) = read_project_file(&dir, None)
        {
            return Some(UnregisteredProjectHint {
                name: file.name,
                folder_path: dir,
            });
        }
        let parent = api.dirname(&dir);
        if parent == dir {
            return None;
        }
        dir = parent;
    }
}
