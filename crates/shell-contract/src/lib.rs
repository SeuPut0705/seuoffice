//! The contract of the stage 3 shell (decisions 0025, 0029): what the area
//! batches share while they replace Electron in parallel. The shell is one
//! Tauri 3 process on the CEF runtime that links `main-core` directly; the
//! renderers keep their preloads, re-bundled over this IPC.
//!
//! Types and traits only. The Tauri adapter (a later `shell` crate) implements
//! them; each batch registers its handlers through [`ipc::Registry`]. The
//! design and the batch table are in `docs/seuoffice/` (the stage 3 shell
//! contract).

pub mod channels;
pub mod editors;
pub mod error;
pub mod hosts;
pub mod ids;
pub mod ipc;
pub mod provided;
pub mod runtime;
pub mod slides;
pub mod value;

pub use channels::{Batch, CHANNELS, ChannelSpec, PRELOADS, PreloadSpec, Surface};
pub use editors::{DocumentEditors, SaveMode, editor_for};
pub use error::IpcError;
pub use hosts::{ClipboardHost, ContentsHost, DialogsHost, Hosts, MainWindowHost, OsShellHost};
pub use ids::{DocumentHandle, RequestId, ViewId, WindowId};
pub use provided::Provided;
pub use value::{BytesKind, IpcValue};
