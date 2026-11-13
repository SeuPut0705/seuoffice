//! `apps/pdf/src/main/font-locate.ts`, which re-exports `findFontCovering`,
//! `findSystemFont` and `isTruetype` from `@seuoffice/font-metrics`
//! (`packages/font-metrics/src/font-locate.ts`). This file holds those and the
//! parts of `sfnt.ts` they stand on: the system font directory scan, the
//! per-face name-table index and the targeted table reads.
//!
//! The module-level state of the TypeScript (the font index, built on first
//! use, and the four-entry face cache) is a [`FontLocator`] the caller owns.

use jscompat::node_path::host;
use jscompat::{JsMap, is_js_space, js_regex, to_number};
use std::fs;
use std::path::Path;

use super::font_cmap::{OutOfRange, i16_at, u16_at, u32_at};

/// `process.platform`, as far as the font folders tell
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Win32,
    /// every other platform
    Other,
}

/// What `sfnt.ts` reads from the process: the platform and `homedir()`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontEnv {
    pub platform: Platform,
    pub home: String,
}

/// `s.normalize('NFKC')`
pub(crate) fn nfkc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .into_owned()
}

/// `norm` of `sfnt.ts`: NFKC, lower case, white space, `-` and `_` removed
pub fn norm(text: &str) -> String {
    nfkc(text)
        .to_lowercase()
        .chars()
        .filter(|&c| !(is_js_space(c) || c == '-' || c == '_'))
        .collect()
}

/// `readdirSync(dir)`: names in the order libuv's `scandir` gives them (sorted)
pub(crate) fn read_names(dir: &str) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Some(names)
}

/// Font asset catalogs under AssetsV2, newest catalog version first.
pub fn apple_font_asset_roots(assets_v2: &str) -> Vec<String> {
    let mut roots: Vec<(String, f64)> = Vec::new();
    let preinstalled = host::join(&[assets_v2, "PreinstalledAssetsV2/InstallWithOs"]);
    for base in [assets_v2, preinstalled.as_str()] {
        let Some(names) = read_names(base) else {
            continue;
        };
        for d in names {
            let re = js_regex!(r"^com_apple_MobileAsset_Font(\d+)$");
            if let Some(m) = re.exec(&d) {
                let digits = m.get(1).unwrap_or("");
                roots.push((host::join(&[base, &d]), to_number(digits)));
            }
        }
    }
    // Newer catalogs first; at equal version the downloaded catalog beats the preinstalled one
    roots.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    roots.into_iter().map(|(path, _)| path).collect()
}

pub(crate) fn font_dirs(env: &FontEnv) -> Vec<String> {
    match env.platform {
        Platform::Darwin => {
            let mut dirs = vec![
                "/System/Library/Fonts".to_owned(),
                "/System/Library/Fonts/Supplemental".to_owned(),
                "/Library/Fonts".to_owned(),
                host::join(&[&env.home, "Library/Fonts"]),
            ];
            dirs.extend(apple_font_asset_roots("/System/Library/AssetsV2"));
            dirs
        }
        Platform::Win32 => vec![
            "C:\\Windows\\Fonts".to_owned(),
            host::join(&[&env.home, "AppData/Local/Microsoft/Windows/Fonts"]),
        ],
        Platform::Other => vec![
            "/usr/share/fonts".to_owned(),
            "/usr/local/share/fonts".to_owned(),
            host::join(&[&env.home, ".fonts"]),
        ],
    }
}

const TTC_TAG: i64 = 0x7474_6366; // 'ttcf'
/// CFF-flavored sfnt (e.g. PingFang on recent macOS)
const OTTO_TAG: i64 = 0x4f54_544f;
const SFNT_FLAVORS: [i64; 3] = [0x0001_0000, 0x7472_7565, OTTO_TAG];

/// What a read of the TypeScript throws (a short read, a `Buffer` read past its end)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Thrown;

impl From<OutOfRange> for Thrown {
    fn from(_: OutOfRange) -> Self {
        Thrown
    }
}

/// `readAt(fd, pos, len)`: one `pread`, a short read throws
pub(crate) fn read_at(file: &fs::File, pos: i64, len: i64) -> Result<Vec<u8>, Thrown> {
    if pos < 0 || len < 0 {
        return Err(Thrown);
    }
    let mut buf = vec![0u8; len as usize];
    #[cfg(unix)]
    let n = {
        use std::os::unix::fs::FileExt;
        file.read_at(&mut buf, pos as u64)
    };
    #[cfg(windows)]
    let n = {
        use std::os::windows::fs::FileExt;
        file.seek_read(&mut buf, pos as u64)
    };
    match n {
        Ok(n) if n == buf.len() => Ok(buf),
        _ => Err(Thrown),
    }
}

/// One family-name record of a face's name table
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyNameRecord {
    pub name: String,
    pub name_id: i64,
    pub platform: i64,
    pub language: i64,
}

struct FaceNames {
    ps: Vec<String>,
    families: Vec<String>,
    subfamilies: Vec<String>,
    family_records: Vec<FamilyNameRecord>,
}

/// A family-name record that spells the face's family in English (or in the Unicode default)
pub(crate) fn is_canonical_record(platform: i64, language: i64) -> bool {
    match platform {
        0 | 3 => language == 0 || language == 0x0409,
        1 => language == 0,
        _ => false,
    }
}

fn canonical_family(names: &FaceNames) -> String {
    for record in &names.family_records {
        if is_canonical_record(record.platform, record.language) {
            return record.name.clone();
        }
    }
    names.families.first().cloned().unwrap_or_default()
}

fn parse_names(buf: &[u8]) -> Result<FaceNames, Thrown> {
    let mut out = FaceNames {
        ps: Vec::new(),
        families: Vec::new(),
        subfamilies: Vec::new(),
        family_records: Vec::new(),
    };
    let count = u16_at(buf, 2)?;
    let str_base = u16_at(buf, 4)?;
    for i in 0..count {
        let r = 6 + 12 * i;
        if r + 12 > buf.len() as i64 {
            break;
        }
        let platform = u16_at(buf, r)?;
        let encoding = u16_at(buf, r + 2)?;
        let language = u16_at(buf, r + 4)?;
        let name_id = u16_at(buf, r + 6)?;
        let is_family = name_id == 1 || name_id == 16;
        // 0: ps, 1: families, 2: subfamilies
        let list = if name_id == 6 {
            0
        } else if is_family {
            1
        } else if name_id == 2 || name_id == 17 {
            2
        } else {
            continue;
        };
        let len = u16_at(buf, r + 8)?;
        let off = str_base + u16_at(buf, r + 10)?;
        if off + len > buf.len() as i64 {
            continue;
        }
        let slice = &buf[off as usize..(off + len) as usize];
        let s: String = if platform == 0 || platform == 3 {
            // swap16() throws on an odd length
            if !slice.len().is_multiple_of(2) {
                return Err(Thrown);
            }
            let units: Vec<u16> = slice
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u16::from_be_bytes([p[0], p[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else if platform == 1 && encoding == 0 {
            slice.iter().map(|&c| char::from(c)).collect()
        } else {
            continue; // Mac-platform legacy CJK codepages: not decodable here
        };
        if s.is_empty() {
            continue;
        }
        let target = match list {
            0 => &mut out.ps,
            1 => &mut out.families,
            _ => &mut out.subfamilies,
        };
        if !target.contains(&s) {
            target.push(s.clone());
        }
        if is_family {
            out.family_records.push(FamilyNameRecord {
                name: s,
                name_id,
                platform,
                language,
            });
        }
    }
    Ok(out)
}

pub(crate) type Tables = JsMap<(i64, i64)>;

/// Table directory of the face whose offset table starts at `offset`; `None` for non-sfnt faces
pub(crate) fn read_table_dir(file: &fs::File, offset: i64) -> Result<Option<Tables>, Thrown> {
    let head = read_at(file, offset, 12)?;
    if !SFNT_FLAVORS.contains(&u32_at(&head, 0)?) {
        return Ok(None);
    }
    let num_tables = u16_at(&head, 4)?;
    if num_tables == 0 || num_tables > 64 {
        return Ok(None);
    }
    let dir = read_at(file, offset + 12, 16 * num_tables)?;
    let mut tables: Tables = JsMap::new();
    for t in 0..num_tables {
        let tag = super::font_cmap::latin1(&dir, 16 * t, 16 * t + 4);
        tables.set(tag, (u32_at(&dir, 16 * t + 8)?, u32_at(&dir, 16 * t + 12)?));
    }
    Ok(Some(tables))
}

/// Bytes of one table, bounded by `max_len`; `None` when absent or implausibly sized
pub(crate) fn read_table(
    file: &fs::File,
    tables: &Tables,
    tag: &str,
    max_len: i64,
) -> Result<Option<Vec<u8>>, Thrown> {
    let Some(&(off, len)) = tables.get(tag) else {
        return Ok(None);
    };
    if len < 2 || len > max_len {
        return Ok(None);
    }
    read_at(file, off, len).map(Some)
}

fn read_face_names(file: &fs::File, offset: i64) -> Result<Option<FaceNames>, Thrown> {
    let Some(tables) = read_table_dir(file, offset)? else {
        return Ok(None);
    };
    let name = read_table(file, &tables, "name", 1 << 20)?;
    match name {
        Some(name) if name.len() >= 6 => parse_names(&name).map(Some),
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceRef {
    pub path: String,
    /// Position of the face's offset table within the file (0 unless .ttc)
    pub offset: i64,
    /// Normalized family + subfamily text, for style ranking on family matches
    pub style: String,
    pub families: Vec<String>,
    pub canonical: String,
    pub family_records: Vec<FamilyNameRecord>,
}

/// `FontIndex`: the faces by PostScript name and by family, both in the
/// order they were first indexed. The maps hold indexes into `faces`.
#[derive(Default, Clone)]
pub struct FontIndex {
    pub(crate) faces: Vec<FaceRef>,
    pub(crate) by_ps: JsMap<usize>,
    pub(crate) by_family: JsMap<Vec<usize>>,
}

/// every font file under `dir`, `depth` levels down
pub(crate) fn font_files(dir: &str, depth: u32, out: &mut Vec<String>) {
    let Some(names) = read_names(dir) else {
        return;
    };
    for name in names {
        let full = host::join(&[dir, &name]);
        let Ok(link) = fs::symlink_metadata(&full) else {
            continue;
        };
        let (mut is_dir, mut is_file) = (link.is_dir(), link.is_file());
        if link.file_type().is_symlink() {
            match fs::metadata(&full) {
                Ok(st) => {
                    is_dir = st.is_dir();
                    is_file = st.is_file();
                }
                Err(_) => continue,
            }
        }
        if is_dir && depth > 0 {
            font_files(&full, depth - 1, out);
        } else if is_file && js_regex!(r"\.(ttf|otf|ttc|otc)$", "i").test(&name) {
            out.push(full);
        }
    }
}

/// Offsets of every face's offset table within the file (many for .ttc, `[0]` otherwise)
pub(crate) fn face_offsets(file: &fs::File) -> Result<Vec<i64>, Thrown> {
    if u32_at(&read_at(file, 0, 4)?, 0)? != TTC_TAG {
        return Ok(vec![0]);
    }
    let n = u32_at(&read_at(file, 8, 4)?, 0)?;
    if n > 64 {
        return Ok(Vec::new());
    }
    let o = read_at(file, 12, 4 * n)?;
    (0..n)
        .map(|i| u32_at(&o, 4 * i).map_err(Thrown::from))
        .collect()
}

impl FontIndex {
    pub(crate) fn index_file(&mut self, path: &str) {
        let Ok(file) = fs::File::open(path) else {
            return;
        };
        let _ = (|| -> Result<(), Thrown> {
            for offset in face_offsets(&file)? {
                let Ok(Some(names)) = read_face_names(&file, offset) else {
                    continue;
                };
                let joined: Vec<&str> = names
                    .families
                    .iter()
                    .chain(names.subfamilies.iter())
                    .map(String::as_str)
                    .collect();
                let face = FaceRef {
                    path: path.to_owned(),
                    offset,
                    style: norm(&joined.join(" ")),
                    families: names.families.clone(),
                    canonical: canonical_family(&names),
                    family_records: names.family_records.clone(),
                };
                let at = self.faces.len();
                self.faces.push(face);
                for p in &names.ps {
                    if !self.by_ps.has(&norm(p)) {
                        self.by_ps.set(norm(p), at);
                    }
                }
                for f in &names.families {
                    let k = norm(f);
                    let mut list = self.by_family.get(&k).cloned().unwrap_or_default();
                    list.push(at);
                    self.by_family.set(k, list);
                }
            }
            Ok(())
        })();
    }

    /// Index every font file under `dir`
    pub(crate) fn index_font_directory(&mut self, dir: &str) {
        let mut files = Vec::new();
        font_files(dir, 2, &mut files);
        for path in files {
            self.index_file(&path);
        }
    }
}

const REGULARISH: [&str; 4] = ["regular", "medium", "w3", "w4"];
const BOLDISH: [&str; 4] = ["bold", "semibold", "demibold", "extrabold"];

/// `styleTokens`
pub fn style_tokens(ps: &str) -> Vec<String> {
    let re = js_regex!(
        r"semibold|extrabold|demibold|demi|bold|italic|oblique|light|thin|medium|heavy|black|regular|w\d",
        "g"
    );
    let normed = norm(ps);
    re.find_iter(&normed)
        .map(|m| match m.as_str() {
            "oblique" => "italic".to_owned(),
            "demi" => "demibold".to_owned(),
            other => other.to_owned(),
        })
        .collect()
}

/// `styleScore`: token-level style score of a face against wanted tokens
pub fn style_score(face: &FaceRef, want: &[String]) -> i64 {
    let have = style_tokens(&face.style);
    let regularish: Vec<String> = REGULARISH.iter().map(|s| (*s).to_owned()).collect();
    let wanted: &[String] = if want.is_empty() { &regularish } else { want };
    let hits = want.iter().filter(|t| have.contains(t)).count() as i64;
    let boldish = |t: &str| BOLDISH.contains(&t);
    let near_weight = i64::from(
        want.iter()
            .any(|t| boldish(t.as_str()) && !have.contains(t))
            && have
                .iter()
                .any(|t| boldish(t.as_str()) && !want.contains(t)),
    );
    let extras = have
        .iter()
        .filter(|t| !wanted.contains(t) && !(near_weight != 0 && boldish(t.as_str())))
        .count() as i64;
    let regular_bonus =
        i64::from(want.is_empty() && have.iter().any(|t| REGULARISH.contains(&t.as_str())));
    hits * 4 + near_weight * 2 - extras + regular_bonus
}

/// Picks FPDFText_LoadFont's font_type: glyf faces embed as FontFile2 (TRUETYPE),
/// CFF faces as FontFile3 (TYPE1)
pub fn is_truetype(b: &[u8]) -> bool {
    b.len() >= 4 && u32_at(b, 0) != Ok(OTTO_TAG)
}

/// `buf.copy(target, target_start, source_start, source_end)` as Node's
/// `_copyActual` does it
fn buffer_copy(
    source: &[u8],
    target: &mut [u8],
    target_start: i64,
    source_start: i64,
    source_end: i64,
) -> Result<(), Thrown> {
    if target_start < 0 || source_start < 0 || source_start > source.len() as i64 || source_end < 0
    {
        return Err(Thrown);
    }
    let source_end = source_end.min(source.len() as i64);
    if target_start >= target.len() as i64 {
        return Ok(());
    }
    let mut end = source_end;
    if end - source_start > target.len() as i64 - target_start {
        end = source_start + target.len() as i64 - target_start;
    }
    let nb = end - source_start;
    if nb <= 0 {
        return Ok(());
    }
    let (t, s) = (target_start as usize, source_start as usize);
    target[t..t + nb as usize].copy_from_slice(&source[s..s + nb as usize]);
    Ok(())
}

/// Extract a single face from a ttc into a standalone sfnt
fn extract_face(buf: Vec<u8>, offset: i64) -> Result<Vec<u8>, Thrown> {
    if u32_at(&buf, 0)? != TTC_TAG {
        return Ok(buf);
    }
    let num_tables = u16_at(&buf, offset + 4)?;
    let mut total: i64 = 12 + 16 * num_tables;
    struct Entry {
        dir_pos: i64,
        t_off: i64,
        t_len: i64,
        new_off: i64,
    }
    let mut entries: Vec<Entry> = Vec::new();
    for t in 0..num_tables {
        let e = offset + 12 + 16 * t;
        let t_len = u32_at(&buf, e + 12)?;
        entries.push(Entry {
            dir_pos: e,
            t_off: u32_at(&buf, e + 8)?,
            t_len,
            new_off: total,
        });
        // (tLen + 3) & ~3 on int32
        total += i64::from((t_len + 3) as u32 as i32 & !3);
    }
    // Buffer.alloc: a negative or absurd size throws
    if !(0..=(1 << 31)).contains(&total) {
        return Err(Thrown);
    }
    let mut out = vec![0u8; total as usize];
    buffer_copy(&buf, &mut out, 0, offset, offset + 12)?;
    for (t, e) in entries.iter().enumerate() {
        let t = t as i64;
        buffer_copy(&buf, &mut out, 12 + 16 * t, e.dir_pos, e.dir_pos + 8)?;
        write_u32(&mut out, 12 + 16 * t + 8, e.new_off)?;
        write_u32(&mut out, 12 + 16 * t + 12, e.t_len)?;
        buffer_copy(&buf, &mut out, e.new_off, e.t_off, e.t_off + e.t_len)?;
    }
    Ok(out)
}

/// `writeUInt32BE(value, offset)`
fn write_u32(out: &mut [u8], offset: i64, value: i64) -> Result<(), Thrown> {
    if offset < 0 || offset as usize + 4 > out.len() {
        return Err(Thrown);
    }
    out[offset as usize..offset as usize + 4].copy_from_slice(&(value as u32).to_be_bytes());
    Ok(())
}

/// Best subtable of a standalone cmap table (offsets relative to the table start)
fn cmap_subtable(cmap: &[u8]) -> Result<Option<(i64, i64)>, Thrown> {
    let n = u16_at(cmap, 2)?;
    let mut best = None;
    for i in 0..n {
        let rec = 4 + i * 8;
        if rec + 8 > cmap.len() as i64 {
            break;
        }
        let platform = u16_at(cmap, rec)?;
        let encoding = u16_at(cmap, rec + 2)?;
        if platform != 0 && !(platform == 3 && (encoding == 1 || encoding == 10)) {
            continue;
        }
        let off = u32_at(cmap, rec + 4)?;
        if off + 4 > cmap.len() as i64 {
            continue;
        }
        let format = u16_at(cmap, off)?;
        if format == 12 {
            return Ok(Some((off, format)));
        }
        if format == 4 && best.is_none() {
            best = Some((off, format));
        }
    }
    Ok(best)
}

fn maps_codepoint(cmap: &[u8], sub: (i64, i64), cp: i64) -> Result<bool, Thrown> {
    let (o, format) = sub;
    if format == 12 {
        let groups = u32_at(cmap, o + 12)?;
        for i in 0..groups {
            let g = o + 16 + i * 12;
            if g + 12 > cmap.len() as i64 {
                return Ok(false);
            }
            if cp < u32_at(cmap, g)? {
                return Ok(false); // groups sorted ascending
            }
            if cp <= u32_at(cmap, g + 4)? {
                return Ok(u32_at(cmap, g + 8)? + (cp - u32_at(cmap, g)?) != 0);
            }
        }
        return Ok(false);
    }
    if cp > 0xffff {
        return Ok(false);
    }
    let seg_x2 = u16_at(cmap, o + 6)?;
    let ends = o + 14;
    let starts = ends + seg_x2 + 2;
    let deltas = starts + seg_x2;
    let range_offs = deltas + seg_x2;
    let mut s = 0;
    while s < seg_x2 {
        if cp > u16_at(cmap, ends + s)? {
            s += 2;
            continue;
        }
        if cp < u16_at(cmap, starts + s)? {
            return Ok(false);
        }
        let ro = u16_at(cmap, range_offs + s)?;
        if ro == 0 {
            return Ok(((cp + i16_at(cmap, deltas + s)?) & 0xffff) != 0);
        }
        let gi = u16_at(
            cmap,
            range_offs + s + ro + (cp - u16_at(cmap, starts + s)?) * 2,
        )?;
        return Ok(gi != 0 && ((gi + i16_at(cmap, deltas + s)?) & 0xffff) != 0);
    }
    Ok(false)
}

/// Color-emoji faces display in the browser but cannot embed as PDF text objects
const COLOR_FONT_TABLES: [&str; 4] = ["sbix", "COLR", "CBDT", "CBLC"];

/// The module state of `sfnt.ts` and `font-locate.ts`
pub struct FontLocator {
    env: FontEnv,
    index: Option<FontIndex>,
    face_cache: JsMap<Vec<u8>>,
}

impl FontLocator {
    pub fn new(env: FontEnv) -> Self {
        FontLocator {
            env,
            index: None,
            face_cache: JsMap::new(),
        }
    }

    /// `getFontIndex()`, built on first use
    fn font_index(&mut self) -> &FontIndex {
        if self.index.is_none() {
            let mut index = FontIndex::default();
            for dir in font_dirs(&self.env) {
                index.index_font_directory(&dir);
            }
            self.index = Some(index);
        }
        self.index.as_ref().expect("the index was just built")
    }

    /// Standalone sfnt bytes of a face (cached; extracts from .ttc); `None` when unreadable
    fn face_bytes(&mut self, face: &FaceRef) -> Option<Vec<u8>> {
        let key = format!("{}#{}", face.path, face.offset);
        if let Some(bytes) = self.face_cache.get(&key) {
            // an empty Buffer is truthy in JavaScript: any cached entry counts
            return Some(bytes.clone());
        }
        let bytes = fs::read(&face.path)
            .ok()
            .and_then(|raw| extract_face(raw, face.offset).ok())?;
        if self.face_cache.len() >= 4 {
            self.face_cache = JsMap::new();
        }
        self.face_cache.set(key, bytes.clone());
        Some(bytes)
    }

    /// Standalone sfnt bytes of the installed font best matching (psName, family):
    /// exact PostScript name first, then family with the PS name's style tokens
    /// (Regular preferred when there are none). `None` when nothing matches.
    pub fn find_system_font(&mut self, ps_name: &str, family: &str) -> Option<Vec<u8>> {
        let index = self.font_index();
        let mut face: Option<FaceRef> = if ps_name.is_empty() {
            None
        } else {
            index
                .by_ps
                .get(&norm(ps_name))
                .map(|&at| index.faces[at].clone())
        };
        if face.is_none()
            && !family.is_empty()
            && let Some(candidates) = index.by_family.get(&norm(family))
            && !candidates.is_empty()
        {
            let want = style_tokens(ps_name);
            let mut sorted: Vec<&FaceRef> = candidates.iter().map(|&at| &index.faces[at]).collect();
            sorted.sort_by_key(|f| std::cmp::Reverse(style_score(f, &want)));
            face = sorted.first().map(|f| (*f).clone());
        }
        let face = face?;
        self.face_bytes(&face)
    }

    /// First installed face whose cmap maps every drawn char of `text`, plainest style
    /// first. `None` when nothing covers the text (e.g. emoji, which only color fonts map).
    pub fn find_font_covering(&mut self, text: &str) -> Option<Vec<u8>> {
        let mut cps: Vec<i64> = Vec::new();
        for c in text.chars().filter(|c| !matches!(c, '\r' | '\n')) {
            let cp = i64::from(u32::from(c));
            if !cps.contains(&cp) {
                cps.push(cp);
            }
        }
        if cps.is_empty() {
            return None;
        }
        let index = self.font_index();
        let mut seen: Vec<String> = Vec::new();
        let mut faces: Vec<FaceRef> = Vec::new();
        let ordered = index
            .by_ps
            .values()
            .copied()
            .chain(index.by_family.values().flatten().copied());
        for at in ordered {
            let face = &index.faces[at];
            let key = format!("{}#{}", face.path, face.offset);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            faces.push(face.clone());
        }
        faces.sort_by_key(|f| std::cmp::Reverse(style_score(f, &[])));
        for face in faces {
            let Ok(file) = fs::File::open(Path::new(&face.path)) else {
                continue;
            };
            let covers = (|| -> Result<bool, Thrown> {
                let Some(tables) = read_table_dir(&file, face.offset)? else {
                    return Ok(false);
                };
                if !(tables.has("glyf") || tables.has("CFF "))
                    || COLOR_FONT_TABLES.iter().any(|t| tables.has(t))
                {
                    return Ok(false);
                }
                let Some(cmap) = read_table(&file, &tables, "cmap", 1 << 22)? else {
                    return Ok(false);
                };
                let Some(sub) = cmap_subtable(&cmap)? else {
                    return Ok(false);
                };
                for &cp in &cps {
                    if !maps_codepoint(&cmap, sub, cp)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            })()
            .unwrap_or(false);
            drop(file);
            if !covers {
                continue;
            }
            if let Some(bytes) = self.face_bytes(&face) {
                return Some(bytes);
            }
        }
        None
    }
}
