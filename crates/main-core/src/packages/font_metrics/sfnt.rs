//! `packages/font-metrics/src/sfnt.ts`. The directory scan, the table readers,
//! the font index, `norm`, `styleTokens` and `styleScore` live in
//! `crate::pdf::font_locate` (they were ported with `font-locate.ts`); this
//! file holds the rest of the module: the folders the app itself ships
//! (`configureExtraFontDirs`), the two indexes the module keeps in variables
//! (`getFontIndex`, `getAppFontIndex`) and `familyAliases`.
//!
//! The module state is a [`FontScan`] the caller owns. `process.platform` and
//! `homedir()`, which `fontDirs()` reads, are its [`FontEnv`].

use std::collections::HashSet;

use crate::pdf::font_locate::{
    FontEnv, FontIndex, font_dirs, font_files, is_canonical_record, norm,
};

/// `extraDirs`, `dirsGeneration`, `index` and `appIndex` of `sfnt.ts`.
pub struct FontScan {
    env: FontEnv,
    extra_dirs: Vec<String>,
    generation: u64,
    index: Option<FontIndex>,
    app_index: Option<FontIndex>,
}

impl FontScan {
    pub fn new(env: FontEnv) -> Self {
        FontScan {
            env,
            extra_dirs: Vec::new(),
            generation: 0,
            index: None,
            app_index: None,
        }
    }

    /// `configureExtraFontDirs(dirs)`: replaces any earlier list and drops the
    /// scan built with it; an empty list restores the system-only behavior.
    pub fn configure_extra_font_dirs(&mut self, dirs: &[String]) {
        self.extra_dirs = dirs.to_vec();
        self.app_index = None;
        self.generation += 1;
    }

    /// `fontDirsGeneration()`: bumped by `configure_extra_font_dirs`
    pub fn font_dirs_generation(&self) -> u64 {
        self.generation
    }

    /// `systemFontFiles()`: every font file under the platform's font directories
    pub fn system_font_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        for dir in font_dirs(&self.env) {
            font_files(&dir, 2, &mut out);
        }
        out
    }

    /// `scannedFontFiles()`: every system font file, then the app's own font
    /// folders (scanned flat)
    pub fn scanned_font_files(&self) -> Vec<String> {
        let mut out = self.system_font_files();
        for dir in &self.extra_dirs {
            font_files(dir, 0, &mut out);
        }
        out
    }

    /// `getFontIndex()`, built on first use
    pub fn font_index(&mut self) -> &FontIndex {
        if self.index.is_none() {
            let mut index = FontIndex::default();
            for dir in font_dirs(&self.env) {
                index.index_font_directory(&dir);
            }
            self.index = Some(index);
        }
        self.index.as_ref().expect("the index was just built")
    }

    /// `getAppFontIndex()`: the installed fonts, then the app's own font
    /// folders; the same index as `font_index` while none is named. Built on
    /// a copy of the system index.
    pub fn app_font_index(&mut self) -> &FontIndex {
        if self.extra_dirs.is_empty() {
            return self.font_index();
        }
        if self.app_index.is_none() {
            let mut app = self.font_index().clone();
            for dir in &self.extra_dirs {
                let mut files = Vec::new();
                font_files(dir, 0, &mut files);
                for path in files {
                    app.index_file(&path);
                }
            }
            self.app_index = Some(app);
        }
        self.app_index.as_ref().expect("the index was just built")
    }

    /// `familyAliases(name)` over the system index
    pub fn family_aliases(&mut self, name: &str) -> Vec<String> {
        family_aliases_in(self.font_index(), name)
    }
}

/// `familyAliases(name, index)`: the other family spellings of the installed
/// face a declared name belongs to, the canonical (en-US) one first. Only the
/// spellings of the same (platform, name id) slot count as aliases; the match
/// is exact after normalization, never fuzzy.
pub fn family_aliases_in(index: &FontIndex, name: &str) -> Vec<String> {
    let key = norm(name);
    if key.is_empty() {
        return Vec::new();
    }
    let Some(faces) = index.by_family.get(&key) else {
        return Vec::new();
    };
    if faces.is_empty() {
        return Vec::new();
    }
    let mut canonical: Vec<String> = Vec::new();
    let mut localized: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(key.clone());
    for &at in faces {
        let records = &index.faces[at].family_records;
        // the (platform, name id) slots this face writes the matched name under
        let mut matched_slots: HashSet<(i64, i64)> = HashSet::new();
        for record in records {
            if norm(&record.name) == key {
                matched_slots.insert((record.platform, record.name_id));
            }
        }
        if matched_slots.is_empty() {
            continue;
        }
        for record in records {
            if !matched_slots.contains(&(record.platform, record.name_id)) {
                continue;
            }
            let record_key = norm(&record.name);
            if seen.contains(&record_key) {
                continue;
            }
            seen.insert(record_key);
            if is_canonical_record(record.platform, record.language) {
                canonical.push(record.name.clone());
            } else {
                localized.push(record.name.clone());
            }
        }
    }
    canonical.extend(localized);
    canonical
}
