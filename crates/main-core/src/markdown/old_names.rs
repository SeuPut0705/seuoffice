//! `apps/markdown/src/main/old-names.ts`: names this app wrote before the
//! product took its own names (decision 0024).

/// `OLD_ASSET_MANIFEST_FILENAMES`: the app-owned asset list in `assets/`.
pub const OLD_ASSET_MANIFEST_FILENAMES: [&str; 1] = [".genoffice-assets.json"];

/// `ASSET_MANIFEST_FILENAME_WRITTEN`: the name a NEW assets folder gets its
/// list under. Still the old one: 0.12.37 reads only that name.
pub const ASSET_MANIFEST_FILENAME_WRITTEN: &str = ".genoffice-assets.json";

/// `OLD_CONVERSION_SESSION_MARKERS`: the marker of a conversion session folder.
pub const OLD_CONVERSION_SESSION_MARKERS: [&str; 1] = [".genoffice-markdown-conversion.json"];
