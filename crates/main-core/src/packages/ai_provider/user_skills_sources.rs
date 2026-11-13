//! `packages/ai-provider/src/user-skills/sources.ts`: only `folderHoldsData`,
//! which the project folders call to tell a data folder in use from an empty
//! one.

use jscompat::node_path::host::join;

use crate::node_fs::{namespaced, node_error};

/// `folderHoldsData(dir, depth)`: whether `dir` holds a file anywhere in its
/// first few levels (a `.DS_Store` does not count): a folder made by hand with
/// nothing put in it yet holds no data. Missing (or not a folder): no. Any
/// other failure to read it (no permission, an I/O error) says nothing about
/// what it holds, so it counts as holding data: the folder in use is kept
/// rather than switched for another.
pub fn folder_holds_data(dir: &str, depth: i64) -> bool {
    let listed = {
        #[cfg(windows)]
        {
            // libuv's `fs__scandir` says ENOTDIR for a file on Windows
            if std::fs::metadata(namespaced(dir)).is_ok_and(|info| !info.is_dir()) {
                Err(Some("ENOTDIR"))
            } else {
                list(dir)
            }
        }
        #[cfg(not(windows))]
        {
            list(dir)
        }
    };
    let entries = match listed {
        Ok(entries) => entries,
        Err(code) => return code != Some("ENOENT") && code != Some("ENOTDIR"),
    };
    entries.iter().any(|(name, is_dir)| {
        if *is_dir {
            depth > 1 && folder_holds_data(&join(&[dir, name]), depth - 1)
        } else {
            name != ".DS_Store"
        }
    })
}

/// `readdirSync(dir, { withFileTypes: true })` as (name, isDirectory); `Err`
/// holds the error's `code`
fn list(dir: &str) -> Result<Vec<(String, bool)>, Option<&'static str>> {
    let reader =
        std::fs::read_dir(namespaced(dir)).map_err(|e| node_error(&e, "scandir", dir).code)?;
    let mut entries = Vec::new();
    for entry in reader {
        let entry = entry.map_err(|e| node_error(&e, "scandir", dir).code)?;
        // a link is not a directory here, as for a `Dirent`
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        entries.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
    Ok(entries)
}
