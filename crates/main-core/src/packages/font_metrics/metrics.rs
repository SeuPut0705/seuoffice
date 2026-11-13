//! `packages/font-metrics/src/metrics.ts`: vertical metrics of installed
//! fonts, resolved by exact family name (nameID 1/16, all languages,
//! normalized), never fuzzy.
//!
//! The module state (`cacheFile`, `persisted`, `misses`, `missesGeneration`)
//! is a [`MetricsCache`] the caller owns. The font folders are the
//! [`FontScan`]'s.
//!
//! The persisted file is read back the way the TypeScript reads it, as JSON of
//! any shape; an entry whose `m` is not what this module writes (a hand-made
//! file) is treated as no entry, where the TypeScript would hand `m` out as it
//! is.

use std::collections::HashSet;
use std::fs;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsObject, JsonValue, json_parse, json_stringify};
use serde::Serialize;

use super::sfnt::FontScan;
use crate::pdf::font_locate::{FaceRef, Thrown, norm, read_table, read_table_dir, style_score};
use crate::shell::recent_files::StatInfo;

/// `FaceVerticalMetrics`, its keys in the order the literal writes them
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceVerticalMetrics {
    pub units_per_em: i64,
    pub hhea_ascender: i64,
    pub hhea_descender: i64,
    pub hhea_line_gap: i64,
    pub typo_ascender: Option<i64>,
    pub typo_descender: Option<i64>,
    pub typo_line_gap: Option<i64>,
    pub win_ascent: Option<i64>,
    pub win_descent: Option<i64>,
    /// OS/2 fsSelection bit 7 (USE_TYPO_METRICS)
    pub use_typo_metrics: bool,
    pub x_avg_char_width: Option<i64>,
    /// OS/2 ulCodePageRange1; bits 17-21 flag the East Asian code pages
    pub code_page_range1: Option<i64>,
}

fn u16_be(b: &[u8], at: usize) -> i64 {
    i64::from(u16::from_be_bytes([b[at], b[at + 1]]))
}

fn i16_be(b: &[u8], at: usize) -> i64 {
    i64::from(i16::from_be_bytes([b[at], b[at + 1]]))
}

fn u32_be(b: &[u8], at: usize) -> i64 {
    i64::from(u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]))
}

/// `parseFaceMetrics(fd, offset)`: `Err` is a read that throws, `Ok(None)` a
/// face that is not sfnt or lacks the tables.
fn parse_face_metrics(file: &fs::File, offset: i64) -> Result<Option<FaceVerticalMetrics>, Thrown> {
    let Some(tables) = read_table_dir(file, offset)? else {
        return Ok(None);
    };
    // head 54B / hhea 36B / OS/2 <= ~100B: bounded targeted reads, like the name index
    let head = read_table(file, &tables, "head", 512)?;
    let hhea = read_table(file, &tables, "hhea", 512)?;
    let (Some(head), Some(hhea)) = (
        head.filter(|h| h.len() >= 20),
        hhea.filter(|h| h.len() >= 10),
    ) else {
        return Ok(None);
    };
    let units_per_em = u16_be(&head, 18);
    if units_per_em == 0 {
        return Ok(None);
    }
    let os2 = read_table(file, &tables, "OS/2", 512)?;
    let len = os2.as_ref().map_or(0, Vec::len);
    let at = |ok: bool, f: &dyn Fn(&[u8]) -> i64| match (&os2, ok) {
        (Some(t), true) => Some(f(t)),
        _ => None,
    };
    let has_typo = len >= 74;
    let has_win = len >= 78;
    Ok(Some(FaceVerticalMetrics {
        units_per_em,
        hhea_ascender: i16_be(&hhea, 4),
        hhea_descender: i16_be(&hhea, 6),
        hhea_line_gap: i16_be(&hhea, 8),
        typo_ascender: at(has_typo, &|t| i16_be(t, 68)),
        typo_descender: at(has_typo, &|t| i16_be(t, 70)),
        typo_line_gap: at(has_typo, &|t| i16_be(t, 72)),
        win_ascent: at(has_win, &|t| u16_be(t, 74)),
        win_descent: at(has_win, &|t| u16_be(t, 76)),
        use_typo_metrics: len >= 64 && os2.as_ref().is_some_and(|t| u16_be(t, 62) & 0x80 != 0),
        x_avg_char_width: at(len >= 4, &|t| i16_be(t, 2)),
        code_page_range1: at(len >= 82, &|t| u32_be(t, 78)),
    }))
}

fn number(x: i64) -> JsonValue {
    JsonValue::Number(x as f64)
}

fn nullable(x: Option<i64>) -> JsonValue {
    x.map_or(JsonValue::Null, number)
}

/// `m` of a cache entry as the TypeScript writes it
fn metrics_json(m: &FaceVerticalMetrics) -> JsonValue {
    let mut o = JsObject::new();
    o.set("unitsPerEm", number(m.units_per_em));
    o.set("hheaAscender", number(m.hhea_ascender));
    o.set("hheaDescender", number(m.hhea_descender));
    o.set("hheaLineGap", number(m.hhea_line_gap));
    o.set("typoAscender", nullable(m.typo_ascender));
    o.set("typoDescender", nullable(m.typo_descender));
    o.set("typoLineGap", nullable(m.typo_line_gap));
    o.set("winAscent", nullable(m.win_ascent));
    o.set("winDescent", nullable(m.win_descent));
    o.set("useTypoMetrics", JsonValue::Bool(m.use_typo_metrics));
    o.set("xAvgCharWidth", nullable(m.x_avg_char_width));
    o.set("codePageRange1", nullable(m.code_page_range1));
    JsonValue::Object(o)
}

/// The `m` of a persisted entry back into metrics; `None` when it is not what
/// `metrics_json` writes.
fn metrics_of(m: &JsonValue) -> Option<FaceVerticalMetrics> {
    let JsonValue::Object(o) = m else {
        return None;
    };
    let int = |key: &str| match o.get(key) {
        Some(JsonValue::Number(x)) if x.fract() == 0.0 => Some(*x as i64),
        _ => None,
    };
    let opt = |key: &str| match o.get(key) {
        Some(JsonValue::Null) => Some(None),
        Some(JsonValue::Number(x)) if x.fract() == 0.0 => Some(Some(*x as i64)),
        _ => None,
    };
    Some(FaceVerticalMetrics {
        units_per_em: int("unitsPerEm")?,
        hhea_ascender: int("hheaAscender")?,
        hhea_descender: int("hheaDescender")?,
        hhea_line_gap: int("hheaLineGap")?,
        typo_ascender: opt("typoAscender")?,
        typo_descender: opt("typoDescender")?,
        typo_line_gap: opt("typoLineGap")?,
        win_ascent: opt("winAscent")?,
        win_descent: opt("winDescent")?,
        use_typo_metrics: matches!(o.get("useTypoMetrics"), Some(JsonValue::Bool(true))),
        x_avg_char_width: opt("xAvgCharWidth")?,
        code_page_range1: opt("codePageRange1")?,
    })
}

/// What `cache[key]` is: an own entry, or what `Object.prototype` answers for
/// the one lower-case name it has (`constructor`: a function, truthy, with
/// no `path`).
enum Hit {
    Own(JsonValue),
    Inherited,
    None,
}

/// `persisted`: the cache object, or the array the file held (which
/// `JSON.stringify` writes back with its elements and without the properties
/// set on it).
struct Persisted {
    entries: JsObject<JsonValue>,
    array: Option<JsonValue>,
}

impl Persisted {
    fn hit(&self, key: &str) -> Hit {
        match self.entries.get(key) {
            // a falsy entry is no hit: `hit && cacheValid(hit)`, `if (hit)`
            Some(entry) if entry.truthy() => Hit::Own(entry.clone()),
            Some(_) => Hit::None,
            None if key == "constructor" => Hit::Inherited,
            None => Hit::None,
        }
    }

    /// `delete cache[key]`
    fn delete(&mut self, key: &str) {
        let kept: JsObject<JsonValue> = self
            .entries
            .entries()
            .into_iter()
            .filter(|(k, _)| *k != key)
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect();
        self.entries = kept;
    }

    fn json(&self) -> String {
        if let Some(array) = &self.array {
            json_stringify(array)
        } else {
            json_stringify(&JsonValue::Object(self.entries.clone()))
        }
    }
}

/// `cacheValid(entry)`
fn cache_valid(entry: &JsonValue) -> bool {
    // entries written before the OS/2 fields were read lack them
    if let Some(m) = entry.get("m")
        && m.truthy()
        && !matches!(&*m, JsonValue::Object(o) if o.get("codePageRange1").is_some())
    {
        return false;
    }
    let Some(path) = entry.get("path") else {
        return false;
    };
    let JsonValue::String(path) = &*path else {
        return false;
    };
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let st = StatInfo::of(&meta);
    let same = |key: &str, value: f64| matches!(entry.get(key).as_deref(), Some(JsonValue::Number(x)) if *x == value);
    same("mtimeMs", st.mtime_ms) && same("size", st.size as f64)
}

/// The module state of `metrics.ts`.
pub struct MetricsCache {
    cache_file: Option<String>,
    persisted: Option<Persisted>,
    misses: HashSet<String>,
    misses_generation: u64,
}

impl MetricsCache {
    /// the state the module starts in: `fonts` supplies `fontDirsGeneration()`
    pub fn new(fonts: &FontScan) -> Self {
        MetricsCache {
            cache_file: None,
            persisted: None,
            misses: HashSet::new(),
            misses_generation: fonts.font_dirs_generation(),
        }
    }

    /// `configureMetricsCache(dir)`: point the persistent cache at a directory
    /// (e.g. Electron userData); optional.
    pub fn configure_metrics_cache(&mut self, dir: &str) {
        self.cache_file = Some(join(&[dir, "font-vertical-metrics.json"]));
        self.persisted = None;
        self.misses.clear();
    }

    /// `loadCache()`
    fn load_cache(&mut self) -> &mut Persisted {
        if self.persisted.is_none() {
            let mut persisted = Persisted {
                entries: JsObject::new(),
                array: None,
            };
            if let Some(file) = &self.cache_file {
                // absent or corrupt cache: rebuild lazily
                if let Ok(bytes) = fs::read(file) {
                    let text = String::from_utf8_lossy(&bytes);
                    match json_parse(&text) {
                        Ok(JsonValue::Object(entries)) => persisted.entries = entries,
                        Ok(array @ JsonValue::Array(_)) => persisted.array = Some(array),
                        _ => {}
                    }
                }
            }
            self.persisted = Some(persisted);
        }
        self.persisted.as_mut().expect("the cache was just loaded")
    }

    /// `saveCache()`: the cache is an optimization; queries still work without it
    fn save_cache(&self) {
        let (Some(file), Some(persisted)) = (&self.cache_file, &self.persisted) else {
            return;
        };
        if fs::create_dir_all(dirname(file)).is_err() {
            return;
        }
        let _ = fs::write(file, persisted.json());
    }

    /// `familyVerticalMetrics(family)`: vertical metrics of the installed
    /// family's Regular-ish face, or `None` when the family is not installed
    /// (exact normalized-name match only). Results persist across runs keyed
    /// by font path+mtime+size; missing families are only cached per process.
    pub fn family_vertical_metrics(
        &mut self,
        fonts: &mut FontScan,
        family: &str,
    ) -> Option<FaceVerticalMetrics> {
        let key = norm(family);
        if key.is_empty() {
            return None;
        }
        // a family missing before the app's own font folders were named may be there now
        if self.misses_generation != fonts.font_dirs_generation() {
            self.misses.clear();
            self.misses_generation = fonts.font_dirs_generation();
        }
        if self.misses.contains(&key) {
            return None;
        }
        let hit = self.load_cache().hit(&key);
        if let Hit::Own(entry) = &hit
            && cache_valid(entry)
            && let Some(m) = entry.get("m")
        {
            // a null `m` is a family known to be uninstalled; anything else is metrics
            if matches!(&*m, JsonValue::Null) {
                return None;
            }
            if let Some(found) = metrics_of(&m) {
                return Some(found);
            }
        }

        // the Word editor's lookup: the app's own font folders count (configureExtraFontDirs)
        let index = fonts.app_font_index();
        let face: Option<FaceRef> = index
            .by_family
            .get(&key)
            .filter(|candidates| !candidates.is_empty())
            .and_then(|candidates| {
                let mut sorted: Vec<&FaceRef> =
                    candidates.iter().map(|&at| &index.faces[at]).collect();
                sorted.sort_by_key(|f| std::cmp::Reverse(style_score(f, &[])));
                sorted.first().map(|f| (*f).clone())
            });
        let Some(face) = face else {
            self.misses.insert(key.clone());
            if !matches!(hit, Hit::None) {
                self.load_cache().delete(&key);
                self.save_cache();
            }
            return None;
        };

        let mut metrics: Option<FaceVerticalMetrics> = None;
        let mut st: Option<StatInfo> = None;
        let mut parsed = false;
        // a transient stat/open/read failure writes no cache and is retried next call
        if let Ok(meta) = fs::metadata(&face.path) {
            st = Some(StatInfo::of(&meta));
            if let Ok(file) = fs::File::open(&face.path) {
                // a None here is deterministic (non-sfnt face / missing tables) and
                // safe to persist; thrown reads are transient and are not
                if let Ok(found) = parse_face_metrics(&file, face.offset) {
                    metrics = found;
                    parsed = true;
                }
            }
        }
        if let (Some(st), true) = (st, parsed) {
            let mut entry = JsObject::new();
            entry.set("path", JsonValue::String(face.path.clone()));
            entry.set("offset", number(face.offset));
            entry.set("mtimeMs", JsonValue::Number(st.mtime_ms));
            entry.set("size", JsonValue::Number(st.size as f64));
            entry.set("m", metrics.as_ref().map_or(JsonValue::Null, metrics_json));
            self.load_cache().entries.set(key, JsonValue::Object(entry));
            self.save_cache();
        }
        metrics
    }
}
