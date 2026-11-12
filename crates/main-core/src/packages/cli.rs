//! `packages/cli/src/control-protocol.ts`: the wire format between the
//! seuoffice CLI and the running shell. The types are the shapes of the JSON
//! the two sides exchange; the shell reads a request as a raw value because
//! `parseEnvelope` checks only `token`, `cmd` and `path`.

use serde::Serialize;

pub const CONTROL_FILE: &str = "control.json";
pub const CONTROL_PROTOCOL: u32 = 1;
pub const CONTROL_MAX_REQUEST_BYTES: usize = 64 * 1024;

/// `ControlEndpoint`: what `userData/control.json` holds, its keys in the
/// order the shell writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ControlEndpoint {
    pub protocol: u32,
    pub pid: u32,
    /// unix socket path or `\\.\pipe\...` name
    pub endpoint: String,
    pub token: String,
}
