//! `apps/docs/src/main/starred-files.ts`: the starred.json store behind the
//! home screen's favorites.

use std::path::Path;

use jscompat::{JsMap, JsObject, JsonValue, json_parse, trim};

use crate::node_fs::NodeError;
use crate::packages::electron_utils::atomic_write::write_json_atomic;

/// `StarredItem`: one starred file; `group` is the user-named group it belongs
/// to (`None` = ungrouped).
#[derive(Debug, Clone, PartialEq)]
pub struct StarredItem {
    pub path: String,
    pub group: Option<String>,
}

impl StarredItem {
    fn ungrouped(path: &str) -> Self {
        StarredItem {
            path: path.to_owned(),
            group: None,
        }
    }

    /// `{ path }` or `{ path, group }`
    fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("path", JsonValue::String(self.path.clone()));
        if let Some(group) = &self.group {
            object.set("group", JsonValue::String(group.clone()));
        }
        JsonValue::Object(object)
    }
}

/// `readJson(path)`: a missing or corrupted state file falls back to `null`.
fn read_json(path: &str) -> Option<JsonValue> {
    if !Path::new(path).exists() {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // readFileSync(path, 'utf-8') keeps a byte order mark
    json_parse(&String::from_utf8_lossy(&bytes)).ok()
}

/// One entry of either on-disk shape: a bare legacy path or an item object.
fn parse_starred_item(entry: &JsonValue) -> Option<StarredItem> {
    if let JsonValue::String(path) = entry {
        return Some(StarredItem::ungrouped(path));
    }
    if !matches!(entry, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let path = entry.get("path");
    let Some(JsonValue::String(path)) = path.as_deref() else {
        return None;
    };
    let group = entry.get("group");
    let group = match group.as_deref() {
        Some(JsonValue::String(group)) if !trim(group).is_empty() => Some(trim(group).to_owned()),
        _ => None,
    };
    Some(StarredItem {
        path: path.clone(),
        group,
    })
}

/// Parse either on-disk shape into entries. Unknown shapes (corrupt file) and
/// entries degrade to dropped or ungrouped rather than throwing.
pub fn parse_starred_items(raw: Option<&JsonValue>) -> Vec<StarredItem> {
    let entries: Vec<&JsonValue> = match raw {
        // legacy flat list: bare paths, and object entries degrade to ungrouped
        Some(JsonValue::Array(entries)) => entries.iter().collect(),
        Some(JsonValue::Object(object)) => match object.get("items") {
            Some(JsonValue::Array(entries)) => entries.iter().collect(),
            _ => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    entries.into_iter().filter_map(parse_starred_item).collect()
}

pub fn read_starred_items(file_path: &str) -> Vec<StarredItem> {
    parse_starred_items(read_json(file_path).as_ref())
}

/// `writeStarredItems`: `{ version: 1, items }` through `writeJsonAtomic`.
pub fn write_starred_items(file_path: &str, items: &[StarredItem]) -> Result<(), NodeError> {
    let mut store = JsObject::new();
    store.set("version", JsonValue::Number(1.0));
    store.set(
        "items",
        JsonValue::Array(items.iter().map(StarredItem::to_json).collect()),
    );
    write_json_atomic(file_path, &JsonValue::Object(store))
}

/// Star or unstar one path (unstar drops its group with it; re-starring
/// starts ungrouped).
pub fn toggle_starred_item(items: &[StarredItem], file_path: &str) -> Vec<StarredItem> {
    if items.iter().any(|item| item.path == file_path) {
        items
            .iter()
            .filter(|item| item.path != file_path)
            .cloned()
            .collect()
    } else {
        let mut next = items.to_vec();
        next.push(StarredItem::ungrouped(file_path));
        next
    }
}

/// Remove paths; `None` when nothing matched so callers skip the write.
pub fn drop_starred_items(
    items: &[StarredItem],
    file_paths: &[String],
) -> Option<Vec<StarredItem>> {
    // `new Set(filePaths)`
    if file_paths.is_empty() {
        return None;
    }
    let next: Vec<StarredItem> = items
        .iter()
        .filter(|item| !file_paths.contains(&item.path))
        .cloned()
        .collect();
    (next.len() != items.len()).then_some(next)
}

/// Assign each path to `group` (`None` or `''` clears the group); `None` when
/// no entry changed.
pub fn assign_starred_group(
    items: &[StarredItem],
    file_paths: &[String],
    group: Option<&str>,
) -> Option<Vec<StarredItem>> {
    if file_paths.is_empty() {
        return None;
    }
    let name = group.map_or("", trim);
    let mut changed = false;
    let next = items
        .iter()
        .map(|item| {
            if !file_paths.contains(&item.path) {
                return item.clone();
            }
            if item.group.as_deref().unwrap_or("") == name {
                return item.clone();
            }
            changed = true;
            StarredItem {
                path: item.path.clone(),
                group: (!name.is_empty()).then(|| name.to_owned()),
            }
        })
        .collect();
    changed.then_some(next)
}

/// Re-key one entry after a disk rename, keeping its group; `None` when absent.
pub fn rename_starred_item(
    items: &[StarredItem],
    old_path: &str,
    new_path: &str,
) -> Option<Vec<StarredItem>> {
    if !items.iter().any(|item| item.path == old_path) {
        return None;
    }
    Some(
        items
            .iter()
            .map(|item| {
                if item.path == old_path {
                    StarredItem {
                        path: new_path.to_owned(),
                        group: item.group.clone(),
                    }
                } else {
                    item.clone()
                }
            })
            .collect(),
    )
}

/// Group names in first-seen order (drives the Starred view's filter pills).
pub fn starred_group_names(items: &[StarredItem]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for item in items {
        if let Some(group) = item.group.as_deref().filter(|group| !group.is_empty())
            && !names.iter().any(|name| name == group)
        {
            names.push(group.to_owned());
        }
    }
    names
}

/// path -> group for the grouped entries only (ungrouped paths are absent).
pub fn starred_group_map(items: &[StarredItem]) -> JsMap<String> {
    let mut map = JsMap::new();
    for item in items {
        if let Some(group) = item.group.as_deref().filter(|group| !group.is_empty()) {
            map.set(item.path.clone(), group.to_owned());
        }
    }
    map
}
