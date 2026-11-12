//! `apps/shell/src/main/folder-roots.ts`: the folders the user added to the
//! home tree beside the default save folder.

use std::fs;

use jscompat::node_path::host::{basename, is_absolute, resolve};
use jscompat::{JsObject, JsonValue};

use super::app_settings::Settings;

/// `FOLDER_ROOTS_KEY`
pub const FOLDER_ROOTS_KEY: &str = "folderRoots";

/// `readExtraRoots(settings, defaultDir)`
pub fn read_extra_roots(settings: &Settings, default_dir: &str) -> Vec<String> {
    let Some(JsonValue::Array(raw)) = settings.get(FOLDER_ROOTS_KEY) else {
        return Vec::new();
    };
    let mut seen = vec![resolve(&[default_dir])];
    let mut out = Vec::new();
    for entry in raw {
        let JsonValue::String(entry) = entry else {
            continue;
        };
        if !is_absolute(entry) {
            continue;
        }
        let key = resolve(&[entry]);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(entry.clone());
    }
    out
}

/// `withExtraRoot(extras, defaultDir, path)`: the list with `path` appended,
/// or `None` (null) when it already is a root.
pub fn with_extra_root(extras: &[String], default_dir: &str, path: &str) -> Option<Vec<String>> {
    let key = resolve(&[path]);
    if key == resolve(&[default_dir]) || extras.iter().any(|e| resolve(&[e]) == key) {
        return None;
    }
    let mut list = extras.to_vec();
    list.push(path.to_owned());
    Some(list)
}

/// `withoutExtraRoot(extras, path)`
pub fn without_extra_root(extras: &[String], path: &str) -> Vec<String> {
    let key = resolve(&[path]);
    extras
        .iter()
        .filter(|e| resolve(&[e]) != key)
        .cloned()
        .collect()
}

/// `FolderRoot`
#[derive(Debug, Clone, PartialEq)]
pub struct FolderRoot {
    pub path: String,
    pub name: String,
    pub usable: bool,
    pub readable: bool,
    pub removable: bool,
}

impl FolderRoot {
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("path", JsonValue::String(self.path.clone()));
        object.set("name", JsonValue::String(self.name.clone()));
        object.set("usable", JsonValue::Bool(self.usable));
        object.set("readable", JsonValue::Bool(self.readable));
        object.set("removable", JsonValue::Bool(self.removable));
        JsonValue::Object(object)
    }
}

/// `accessSync(path, mode)` as a yes or no
#[cfg(unix)]
fn accessible(path: &str, mode: i32) -> bool {
    match std::ffi::CString::new(path) {
        // SAFETY: `c_path` is a valid NUL-terminated string for the call
        Ok(c_path) => unsafe { libc::access(c_path.as_ptr(), mode) == 0 },
        Err(_) => false,
    }
}

/// `describeExtraRoot(path)`: shown as it is, never created.
pub fn describe_extra_root(path: &str) -> FolderRoot {
    let mut readable = false;
    let mut usable = false;
    if let Ok(metadata) = fs::metadata(path) {
        readable = metadata.is_dir();
        if readable {
            #[cfg(unix)]
            {
                usable = accessible(path, libc::R_OK) && accessible(path, libc::W_OK);
            }
            // libuv refuses write access only to a read-only file, never to a folder
            #[cfg(windows)]
            {
                usable = true;
            }
        }
    }
    let name = basename(path, None);
    let name = if name.is_empty() {
        path.to_owned()
    } else {
        name
    };
    FolderRoot {
        path: path.to_owned(),
        name,
        usable,
        readable,
        removable: true,
    }
}
