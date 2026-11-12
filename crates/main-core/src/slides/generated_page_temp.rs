//! `apps/slides/src/main/generated-page-temp.ts`.

use std::fs;

use jscompat::js_regex;
use jscompat::node_path::host::join;

use crate::shell::recent_files::StatInfo;

pub const GENERATED_PAGE_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

// seuoffice-cloud-pages is the retired cloud pipeline's directory: still swept so
// files from older builds expire
const GENERATED_PAGE_DIRS: [&str; 2] = ["seuoffice-cloud-pages", "seuoffice-local-pages"];

/// `cleanupExpiredGeneratedPages(tempRoot, now)`: the paths removed, in order.
pub fn cleanup_expired_generated_pages(temp_root: &str, now: f64) -> Vec<String> {
    let name_re = js_regex!(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pptx$",
        "i"
    );
    let cutoff = now - GENERATED_PAGE_TTL_MS;
    let mut removed = Vec::new();
    for dir_name in GENERATED_PAGE_DIRS {
        let dir = join(&[temp_root, dir_name]);
        // readdir(dir, { withFileTypes: true }): libuv sorts the names by bytes
        let Ok(read) = fs::read_dir(&dir) else {
            // The directory may not exist yet — nothing to sweep.
            continue;
        };
        let mut entries: Vec<(String, bool)> = read
            .filter_map(Result::ok)
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.file_type().is_ok_and(|kind| kind.is_file()),
                )
            })
            .collect();
        entries.sort();
        for (name, is_file) in entries {
            if !is_file || !name_re.test(&name) {
                continue;
            }
            let path = join(&[&dir, &name]);
            // lstat, then unlink: an error of either is swallowed
            let Ok(info) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !info.is_file() || StatInfo::of(&info).mtime_ms >= cutoff {
                continue;
            }
            if fs::remove_file(&path).is_err() {
                continue;
            }
            removed.push(path);
        }
    }
    removed
}
