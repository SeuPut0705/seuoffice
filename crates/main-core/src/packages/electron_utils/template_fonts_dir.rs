//! `packages/electron-utils/src/template-fonts-dir.ts`: where the design
//! templates' shared font set lives.

use jscompat::node_path::host::{join, resolve};

/// `TEMPLATE_FONTS_DIR_NAME`
pub const TEMPLATE_FONTS_DIR_NAME: &str = "template-fonts";

/// `TEMPLATE_FONTS_REPO_DIR`
pub const TEMPLATE_FONTS_REPO_DIR: &str = "packages/ui/template-fonts";

/// `TemplateFontsHost`: `app.isPackaged`, `app.getAppPath()` and
/// `process.resourcesPath`.
pub trait TemplateFontsHost {
    fn is_packaged(&self) -> bool;
    fn get_app_path(&self) -> String;
    fn resources_path(&self) -> String;
}

/// `templateFontsDir(host)`
pub fn template_fonts_dir(host: &dyn TemplateFontsHost) -> String {
    if host.is_packaged() {
        return join(&[&host.resources_path(), TEMPLATE_FONTS_DIR_NAME]);
    }
    resolve(&[&host.get_app_path(), "..", "..", TEMPLATE_FONTS_REPO_DIR])
}
