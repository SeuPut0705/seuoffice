//! The stage 3 shell's IPC core, without Tauri (the stage 3 shell contract
//! under docs/seuoffice): the wire form of `IpcValue`, the channel table and
//! its start-up checks, the core thread, dispatch to the handlers, and the
//! per-view output stream. `crates/shell` puts Tauri around it;
//! `crates/ipc-probe` drives it with fakes for tools/ipc-diff.

pub mod core_thread;
pub mod dispatch;
pub mod outlet;
pub mod table;
pub mod wire;

use shell_contract::ipc::RegisterBatch;

/// Every batch's `register`, in the order the shell calls them
pub const BATCHES: &[RegisterBatch] = &[
    shell_ipc_u::register,
    shell_ipc_a::register,
    shell_ipc_m::register,
    shell_ipc_w::register,
    shell_ipc_d1::register,
    shell_ipc_d2::register,
];
