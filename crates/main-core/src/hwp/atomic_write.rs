//! `apps/hwp/src/main/atomic-write.ts`: `atomicWriteFile`, imported from its
//! own electron-utils subpath (the barrel drags Electron-only modules into
//! headless bundles).

pub use crate::packages::electron_utils::atomic_write::atomic_write_file;
