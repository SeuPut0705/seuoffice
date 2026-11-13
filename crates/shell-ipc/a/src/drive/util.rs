//! Small shared helpers of the Drive module: running on the core thread from
//! a worker, a clock, `path.resolve`, and the UTF-16 strings JavaScript slices.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use shell_contract::runtime::{Thread, run_on};

/// `Date.now()` as the module's clock type
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// `Date.now()`
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}

/// Runs `job` on the core thread and returns its result: what a handler body
/// of the TypeScript did on the main thread, asked from a worker. Called on
/// the core thread itself it just runs.
pub fn on_core<R: Send + 'static>(
    core: &dyn Thread,
    job: impl FnOnce() -> R + Send + 'static,
) -> R {
    if core.is_current() {
        job()
    } else {
        run_on(core, job)
    }
}

/// `path.resolve(path)`: absolute, `.` and `..` folded in, no disk access
pub fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The components of `resolve(path)`, as compared by Node on this platform
/// (case-insensitively on Windows)
fn folded_components(path: &Path) -> Vec<String> {
    resolve(path)
        .components()
        .map(|c| {
            let text = c.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

/// `resolve(a) === resolve(b)`, ignoring case on Windows
pub fn same_path(a: &Path, b: &Path) -> bool {
    folded_components(a) == folded_components(b)
}

/// `relative(resolve(dir), resolve(path))` leads to something inside `dir`:
/// a non-empty path that does not start with a `..` step
pub fn is_inside(dir: &Path, path: &Path) -> bool {
    let dir = folded_components(dir);
    let path = folded_components(path);
    path.len() > dir.len() && path[..dir.len()] == dir[..]
}

/// `text.slice(from, to)` where the indexes count UTF-16 units. A cut
/// through a surrogate pair cannot be a Rust string and reads as U+FFFD.
pub fn slice_utf16(text: &str, from: usize, to: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    slice_units(&units, from, to)
}

/// `slice_utf16` of units already encoded
pub fn slice_units(units: &[u16], from: usize, to: usize) -> String {
    let to = to.min(units.len());
    let from = from.min(to);
    String::from_utf16_lossy(&units[from..to])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_whole_parent_step_leads_out_of_a_folder() {
        let cache = Path::new("/data/drive-cache");
        assert!(is_inside(cache, Path::new("/data/drive-cache/x/a.docx")));
        assert!(is_inside(cache, Path::new("/data/drive-cache/..x/a.docx")));
        assert!(!is_inside(cache, Path::new("/data/drive-cache")));
        assert!(!is_inside(cache, Path::new("/data/drive-cache/../secret")));
        assert!(!is_inside(cache, Path::new("/data/drive-cache-2/a")));
        assert!(!is_inside(cache, Path::new("/elsewhere/a")));
    }

    #[test]
    fn slicing_counts_utf16_units() {
        assert_eq!(slice_utf16("a😀b", 1, 3), "😀");
        assert_eq!(slice_utf16("abc", 1, 99), "bc");
        assert_eq!(slice_utf16("abc", 5, 9), "");
    }
}
