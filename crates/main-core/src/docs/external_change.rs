//! `apps/docs/src/main/external-change.ts`.

/// `DiskFileState`: the disk snapshot recorded at the last read or write of a
/// document path. The numbers are doubles, as the TypeScript holds them.
#[derive(Debug, Clone, PartialEq)]
pub struct DiskFileState {
    pub mtime_ms: f64,
    pub size: f64,
    pub hash: String,
}

/// True when the file on disk no longer matches the recorded state. No record
/// or a missing file (`current` is `None`) is not a conflict. `read_hash` runs
/// only when mtime and size already disagree (NaN equals nothing). It answers
/// `Err` with the message of what it threw.
pub fn is_externally_modified(
    recorded: Option<&DiskFileState>,
    current: Option<(f64, f64)>,
    read_hash: &mut dyn FnMut() -> Result<Option<String>, String>,
) -> Result<bool, String> {
    let (Some(recorded), Some((mtime_ms, size))) = (recorded, current) else {
        return Ok(false);
    };
    if mtime_ms == recorded.mtime_ms && size == recorded.size {
        return Ok(false);
    }
    let hash = read_hash()?;
    Ok(hash.is_some_and(|hash| hash != recorded.hash))
}
