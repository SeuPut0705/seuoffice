//! `apps/pdf/src/main/atomic-write.ts`: the shared temp + rename writer, with
//! the bytes of a PDF.

use crate::node_fs::NodeError;
use crate::packages::electron_utils::atomic_write::atomic_write_file;

/// `writePdfAtomically(targetPath, bytes)`
pub fn write_pdf_atomically(target_path: &str, bytes: &[u8]) -> Result<(), NodeError> {
    atomic_write_file(target_path, bytes)
}
