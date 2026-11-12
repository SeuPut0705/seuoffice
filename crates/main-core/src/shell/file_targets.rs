//! `apps/shell/src/main/file-targets.ts`.
//!
//! A `path` that is not a string in the TypeScript (`typeof path !== 'string'`)
//! is `None` here.

/// `FileTargetSources`; `&mut self` because a source may count its calls.
pub trait FileTargetSources {
    fn inside_any_root(&mut self, path: &str) -> bool;
    fn tracked_paths(&self) -> &[String];
}

/// `MoveSourceSources`
pub trait MoveSourceSources: FileTargetSources {
    fn is_directory(&mut self, path: &str) -> bool;
    fn is_any_root(&mut self, path: &str) -> bool;
}

/// `isUserVisibleFile`: a recent may live outside every root, so roots alone
/// cannot gate the file IPCs.
pub fn is_user_visible_file<S: FileTargetSources + ?Sized>(
    path: Option<&str>,
    sources: &mut S,
) -> bool {
    let Some(path) = path else {
        return false;
    };
    if path.is_empty() {
        return false;
    }
    if sources.inside_any_root(path) {
        return true;
    }
    sources
        .tracked_paths()
        .iter()
        .any(|tracked| tracked == path)
}

/// `isMoveSource`
pub fn is_move_source<S: MoveSourceSources + ?Sized>(path: Option<&str>, sources: &mut S) -> bool {
    let Some(path) = path else {
        return false;
    };
    if path.is_empty() {
        return false;
    }
    if sources.is_directory(path) {
        return sources.inside_any_root(path) && !sources.is_any_root(path);
    }
    // `isUserVisibleFile(path, sources)` re-checks the type and the empty string
    is_user_visible_file(Some(path), sources)
}
