//! `packages/project-store/src/folder-api.ts`: what the main process calls.

/// `isValidProjectId(value)` of a string: non-empty, `/^[A-Za-z0-9_-]+$/`.
/// (`$` of a pattern without the `m` flag does not match before a final line
/// feed, so "ab\n" is not valid.)
pub fn is_valid_project_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
