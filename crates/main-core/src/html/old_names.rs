//! `apps/html/src/main/old-names.ts`.

/// The app-owned asset list's name before this product took its own names
/// (decision 0024). An assets folder that has it keeps using it.
pub const OLD_ASSET_MANIFEST_FILENAMES: [&str; 1] = [".genoffice-assets.json"];

/// `ASSET_MANIFEST_FILENAME_WRITTEN`: the name a NEW assets folder gets its
/// list under. Still the old one: 0.12.37 reads only that name.
pub const ASSET_MANIFEST_FILENAME_WRITTEN: &str = ".genoffice-assets.json";
