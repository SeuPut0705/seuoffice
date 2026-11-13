//! `apps/pdf/src/main/text-edit.ts`, the part that finds the rebuild fonts:
//! `EDIT_FONT_PATHS`, `loadEditFont` and `listEditFonts`. The rest of that file
//! (pdf-lib, PDFium) is batch E.
//!
//! `editFontCache` is an [`EditFontCache`] the caller owns. `readFileSync(p)`
//! reads `map_path(p)`: the identity for the app, a fixture folder for the
//! comparison.

use std::fs;

use jscompat::JsMap;

/// `EditFontStyle`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditFontStyle {
    Regular,
    Bold,
    Italic,
    BoldItalic,
}

impl EditFontStyle {
    /// the name the TypeScript writes: `regular`, `bold`, `italic`, `bolditalic`
    pub fn as_str(self) -> &'static str {
        match self {
            EditFontStyle::Regular => "regular",
            EditFontStyle::Bold => "bold",
            EditFontStyle::Italic => "italic",
            EditFontStyle::BoldItalic => "bolditalic",
        }
    }

    fn at(self) -> usize {
        match self {
            EditFontStyle::Regular => 0,
            EditFontStyle::Bold => 1,
            EditFontStyle::Italic => 2,
            EditFontStyle::BoldItalic => 3,
        }
    }
}

/// Font files for the user-selectable rebuild fonts by style (regular, bold,
/// italic, bolditalic), first readable wins (single-face sfnt only). The ids
/// are in the order `Object.keys` lists them.
pub const EDIT_FONT_PATHS: [(&str, [&[&str]; 4]); 3] = [
    (
        "arial",
        [
            &[
                "/System/Library/Fonts/Supplemental/Arial.ttf",
                "C:\\Windows\\Fonts\\arial.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                "C:\\Windows\\Fonts\\arialbd.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
                "C:\\Windows\\Fonts\\ariali.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
                "C:\\Windows\\Fonts\\arialbi.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf",
            ],
        ],
    ),
    (
        "times",
        [
            &[
                "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
                "C:\\Windows\\Fonts\\times.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
                "C:\\Windows\\Fonts\\timesbd.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
                "C:\\Windows\\Fonts\\timesi.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
                "C:\\Windows\\Fonts\\timesbi.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
            ],
        ],
    ),
    (
        "courier",
        [
            &[
                "/System/Library/Fonts/Supplemental/Courier New.ttf",
                "C:\\Windows\\Fonts\\cour.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
                "C:\\Windows\\Fonts\\courbd.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Courier New Italic.ttf",
                "C:\\Windows\\Fonts\\couri.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationMono-Italic.ttf",
            ],
            &[
                "/System/Library/Fonts/Supplemental/Courier New Bold Italic.ttf",
                "C:\\Windows\\Fonts\\courbi.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationMono-BoldItalic.ttf",
            ],
        ],
    ),
];

/// `editFontCache`: `${id}#${style}` to the bytes, or `None` for none readable
#[derive(Default)]
pub struct EditFontCache {
    cache: JsMap<Option<Vec<u8>>>,
}

impl EditFontCache {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `EDIT_FONT_PATHS[id]?.[style] ?? []`: an id the table does not own (the
/// ones `Object.prototype` answers included) has no paths
fn paths_of(id: &str, style: EditFontStyle) -> &'static [&'static str] {
    EDIT_FONT_PATHS
        .iter()
        .find(|(own, _)| *own == id)
        .map_or(&[][..], |(_, by_style)| by_style[style.at()])
}

/// `loadEditFont(id, style)`: the first readable file of the id's list for the
/// style, cached (also when none is readable)
pub fn load_edit_font<'c>(
    cache: &'c mut EditFontCache,
    id: &str,
    style: EditFontStyle,
    map_path: &dyn Fn(&str) -> String,
) -> Option<&'c [u8]> {
    let key = format!("{id}#{}", style.as_str());
    if !cache.cache.has(&key) {
        let mut found: Option<Vec<u8>> = None;
        for p in paths_of(id, style) {
            if let Ok(bytes) = fs::read(map_path(p)) {
                found = Some(bytes);
                break;
            }
        }
        cache.cache.set(key.clone(), found);
    }
    cache.cache.get(&key).and_then(|bytes| bytes.as_deref())
}

/// `listEditFonts()`: edit-font ids that resolve to a readable font file
pub fn list_edit_fonts(
    cache: &mut EditFontCache,
    map_path: &dyn Fn(&str) -> String,
) -> Vec<String> {
    EDIT_FONT_PATHS
        .iter()
        .filter(|(id, _)| load_edit_font(cache, id, EditFontStyle::Regular, map_path).is_some())
        .map(|(id, _)| (*id).to_owned())
        .collect()
}
