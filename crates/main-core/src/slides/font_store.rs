//! `apps/slides/src/main/font-store.ts`: the install half of the font store,
//! wired to this app. `app.getPath('userData')` and the font registry
//! (`setUserFontDir`, `fontFileFamilies` of `./fonts`) stay with the caller:
//! they come in as closures.

use jscompat::node_path::host::join;

use crate::node_fs::NodeError;
use crate::packages::electron_utils::font_store::{
    FontFileFamilies, FontStoreEnv, install_local_font_files as install_into_store,
};

/// `fontStoreDir()`: `join(app.getPath('userData'), 'fonts')`
pub fn font_store_dir(get_user_data: &mut dyn FnMut() -> String) -> String {
    join(&[&get_user_data(), "fonts"])
}

/// `initFontStore()`: wire the store dir into the font registry.
pub fn init_font_store(
    get_user_data: &mut dyn FnMut() -> String,
    set_user_font_dir: &mut dyn FnMut(&str),
) {
    let dir = font_store_dir(get_user_data);
    set_user_font_dir(&dir);
}

/// `installLocalFontFiles(paths)`: the store, described to the shared module
/// in this app's terms.
pub fn install_local_font_files(
    get_user_data: &mut dyn FnMut() -> String,
    font_file_families: &FontFileFamilies<'_>,
    paths: &[String],
) -> Result<Vec<String>, NodeError> {
    let dir = font_store_dir(get_user_data);
    let env = FontStoreEnv {
        dir: &dir,
        font_file_families: Some(font_file_families),
    };
    install_into_store(&env, paths)
}
