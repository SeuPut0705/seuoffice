//! `apps/shell/src/main/knowledge-base.ts`: the read caps (`KB_READ_MAX_BYTES`,
//! `kbReadMaxBytes`) the project tools share.

use jscompat::node_path::host::extname;

use crate::packages::file_parse::attachable::attachable_max_bytes;

/// `KB_READ_MAX_BYTES`: byte cap per corpus file
pub const KB_READ_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// `kbReadMaxBytes(filePath)`: the largest file with this path read for the AI
/// (`attachableMaxBytes`, pictures aside)
pub fn kb_read_max_bytes(file_path: &str) -> f64 {
    let cap = attachable_max_bytes(&extname(file_path));
    if cap.is_finite() {
        cap.max(KB_READ_MAX_BYTES)
    } else {
        cap
    }
}
