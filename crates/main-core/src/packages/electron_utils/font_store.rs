//! `packages/electron-utils/src/font-store.ts`: the user font store, shared by
//! every app that can install a font file.

use std::fs;

use jscompat::js_regex;
use jscompat::node_path::host::{basename, join};

use crate::node_fs::{NodeError, node_error};

/// Reads the family names out of one font file.
pub type FontFileFamilies<'a> = dyn Fn(&str) -> Vec<String> + 'a;

/// `FontStoreEnv`: where the files live, and the injected name-table reader
/// (`None` for a host that offers no local install).
pub struct FontStoreEnv<'a> {
    pub dir: &'a str,
    pub font_file_families: Option<&'a FontFileFamilies<'a>>,
}

/// `SFNT_MAGIC`: the first four bytes a real font file starts with, as hex.
const SFNT_MAGIC: [&str; 4] = ["00010000", "4f54544f", "74746366", "74727565"];

/// `installLocalFontFiles(env, paths)`
pub fn install_local_font_files(
    env: &FontStoreEnv<'_>,
    paths: &[String],
) -> Result<Vec<String>, NodeError> {
    let Some(read_families) = env.font_file_families else {
        return Ok(Vec::new());
    };
    // mkdirSync(env.dir, { recursive: true })
    fs::create_dir_all(env.dir).map_err(|e| node_error(&e, "mkdir", env.dir))?;
    let mut installed: Vec<String> = Vec::new();
    for path in paths {
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let head: String = bytes.iter().take(4).map(|b| format!("{b:02x}")).collect();
        if !SFNT_MAGIC.contains(&head.as_str()) {
            continue;
        }
        let families = read_families(path);
        let Some(primary) = families.first().filter(|p| !p.is_empty()) else {
            continue;
        };
        let name = basename(path, None);
        let ext = js_regex!(r"\.(ttc|otc|otf)$", "i")
            .exec(&name)
            .and_then(|m| m.get(1).map(str::to_lowercase))
            .unwrap_or_else(|| "ttf".to_owned());
        // Family-derived name is the registry index key; the suffix keeps one
        // family's style files apart.
        let style_tag = if js_regex!(r"bold\s*italic", "i").test(&name) {
            "-BoldItalic"
        } else if js_regex!(r"bold", "i").test(&name) {
            "-Bold"
        } else if js_regex!(r"italic|oblique", "i").test(&name) {
            "-Italic"
        } else {
            ""
        };
        let stem = js_regex!(r"[\\/:]", "g").replace_all(primary, |_| String::new());
        let dest = join(&[env.dir, &format!("{stem}{style_tag}.{ext}")]);
        // unreadable or locked source: skip
        if crate::node_fs::copy_file(path, &dest, false).is_ok() {
            installed.extend(families.iter().cloned());
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for family in installed {
        if !unique.contains(&family) {
            unique.push(family);
        }
    }
    Ok(unique)
}
