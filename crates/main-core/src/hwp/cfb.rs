// Port of cfb 1.2.2 (SheetJS, https://github.com/SheetJS/js-cfb),
// Copyright (C) 2013-present SheetJS LLC, Apache License 2.0.
//! The part of `cfb` 1.2.2 (SheetJS, `node_modules/cfb/cfb.js`) that
//! `apps/hwp/src/main/hwp5-file.ts` uses: `CFB.read` of a buffer, `CFB.find`
//! and `CFB.write` of a container.
//!
//! The compound-file gate runs before `read` (see `hwp5_file`), so the sector
//! tables are well formed; the port still keeps the library's own reading
//! order, its quirks and its `throw`s, which come back as [`CfbError`]. Not
//! ported because no caller reaches them: zip and MIME containers, dates of
//! entries (the writer leaves them zero), `CFB.parse` options.
//!
//! One difference: a JavaScript string can hold half of a surrogate pair, a
//! Rust one cannot; an entry name that does is read with U+FFFD in its place.

use std::collections::{HashMap, HashSet};

use jscompat::{sort_by_number, string_less_than};

/// What the library throws (`new Error(message)` or a `TypeError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CfbError(pub String);

fn throw<T>(message: impl Into<String>) -> Result<T, CfbError> {
    Err(CfbError(message.into()))
}

const ENDOFCHAIN: i32 = -2;
const DIFSECT: i64 = -4;
const FATSECT: i64 = -3;
const MSSZ: usize = 64;
const HEADER_SIG: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/// One entry of the directory, as the library keeps it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    /// `type`: 0 unused, 1 storage, 2 stream, 5 root
    pub kind: u8,
    pub color: u8,
    pub l: i32,
    pub r: i32,
    pub c: i32,
    pub clsid: [u8; 16],
    pub state: i32,
    pub start: i32,
    pub size: i32,
    /// `content`; `Some` of nothing is the empty buffer, which is truthy
    pub content: Option<Vec<u8>>,
}

impl Entry {
    /// `{ name, type: 0 }`: what `writeContainer` pushes for the marker.
    pub fn unused(name: &str) -> Self {
        Entry {
            name: name.to_owned(),
            kind: 0,
            color: 0,
            l: 0,
            r: 0,
            c: 0,
            clsid: [0; 16],
            state: 0,
            start: 0,
            size: 0,
            content: None,
        }
    }
}

/// `CFB$Container`: `FullPaths` and `FileIndex`, side by side.
#[derive(Debug, Clone)]
pub struct Container {
    pub full_paths: Vec<String>,
    pub file_index: Vec<Entry>,
}

/// `Buffer.readInt32LE` where reading past the end is `NaN`, as the library's
/// own `__readInt32LE` over undefined bytes gives it.
fn read_i32(bytes: &[u8], at: usize) -> Option<i32> {
    let end = at.checked_add(4)?;
    let slice = bytes.get(at..end)?;
    Some(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `blob.chk(hexstr, field)`
fn check_field(blob: &[u8], at: usize, hexstr: &str, field: &str) -> Result<(), CfbError> {
    let want = hexstr.len() / 2;
    let end = (at + want).min(blob.len());
    let saw = hex_of(&blob[at.min(end)..end]);
    if saw != hexstr {
        return throw(format!("{field}Expected {hexstr} saw {saw}"));
    }
    Ok(())
}

/// `Buffer.toString('utf16le', 0, end)` with the NULs taken out.
fn utf16le_name(blob: &[u8], end: i64) -> String {
    let end = end.clamp(0, blob.len() as i64) as usize;
    let units: Vec<u16> = blob[..end & !1]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units).replace('\0', "")
}

/// The sector chains, by the sector each starts at. A chain is its bytes, the
/// sectors joined; `Vec::new()` is the empty array the library falls back to.
struct Chain {
    data: Vec<u8>,
}

struct SectorList {
    chains: HashMap<i64, Chain>,
    fat_addrs: Vec<i32>,
    ssz: usize,
}

/// `sectors[index]` of the library, undefined past either end.
fn sector_at<'a>(sectors: &[&'a [u8]], index: i64) -> Option<&'a [u8]> {
    usize::try_from(index)
        .ok()
        .and_then(|at| sectors.get(at).copied())
}

/// `fat_addrs[Math.floor(j * 4 / ssz)]`, then `sectors[addr]`.
fn fat_sector<'a>(sectors: &[&'a [u8]], fat_addrs: &[i32], j: i64, ssz: usize) -> Option<&'a [u8]> {
    let at = (j * 4).div_euclid(ssz as i64);
    let addr = usize::try_from(at).ok().and_then(|at| fat_addrs.get(at))?;
    sector_at(sectors, i64::from(*addr))
}

/// `sleuth_fat`: the rest of the DIFAT chain.
fn sleuth_fat(
    mut idx: i64,
    mut cnt: i64,
    sectors: &[&[u8]],
    ssz: usize,
    fat_addrs: &mut Vec<i32>,
) -> Result<(), CfbError> {
    loop {
        if idx == i64::from(ENDOFCHAIN) {
            if cnt != 0 {
                return throw("DIFAT chain shorter than expected");
            }
            return Ok(());
        }
        if idx == -1 {
            return Ok(());
        }
        let Some(sector) = sector_at(sectors, idx) else {
            return Ok(());
        };
        let m = (ssz >> 2) - 1;
        for i in 0..m {
            let Some(q) = read_i32(sector, i * 4) else {
                return throw("NaN in the DIFAT");
            };
            if q == ENDOFCHAIN {
                break;
            }
            fat_addrs.push(q);
        }
        if cnt >= 1 {
            let Some(next) = read_i32(sector, ssz - 4) else {
                return Ok(());
            };
            idx = i64::from(next);
            cnt -= 1;
        } else {
            return Ok(());
        }
    }
}

/// `get_sector_list`: the chain from `start`, its sectors joined.
fn get_sector_list(
    sectors: &[&[u8]],
    start: i64,
    fat_addrs: &[i32],
    ssz: usize,
) -> Result<Chain, CfbError> {
    let mut data = Vec::new();
    let mut j = start;
    let mut steps = 0usize;
    while j >= 0 {
        match sector_at(sectors, j) {
            Some(sector) => data.extend_from_slice(sector),
            None if data.is_empty() && steps == 0 => {}
            None => return throw("The \"list[0]\" argument must be an instance of Buffer"),
        }
        steps += 1;
        if steps > sectors.len() + 1 {
            return throw("sector chain does not end");
        }
        let jj = ((j * 4) & (ssz as i64 - 1)) as usize;
        let Some(table) = fat_sector(sectors, fat_addrs, j, ssz) else {
            break;
        };
        match read_i32(table, jj) {
            Some(next) => j = i64::from(next),
            None => break,
        }
    }
    Ok(Chain { data })
}

/// `make_sector_list`: a chain from every sector no earlier chain ran through.
fn make_sector_list(
    sectors: &[&[u8]],
    dir_start: i64,
    fat_addrs: &[i32],
    ssz: usize,
) -> Result<HashMap<i64, Chain>, CfbError> {
    let sl = sectors.len() as i64;
    let mut sector_list = HashMap::new();
    let mut chkd = vec![false; sectors.len()];
    for i in 0..sl {
        let mut k = i + dir_start;
        if k >= sl {
            k -= sl;
        }
        if k < 0 || k >= sl {
            // `chkd[k]` of a hole is undefined: the walk would start there
            return throw("a directory start outside the sectors");
        }
        if chkd[k as usize] {
            continue;
        }
        let mut seen = vec![false; sectors.len()];
        let mut data = Vec::new();
        let mut j = k;
        while j >= 0 {
            if j >= sl {
                return throw("The \"list[1]\" argument must be an instance of Buffer");
            }
            seen[j as usize] = true;
            chkd[j as usize] = true;
            data.extend_from_slice(sectors[j as usize]);
            let jj = ((j * 4) & (ssz as i64 - 1)) as usize;
            let Some(table) = fat_sector(sectors, fat_addrs, j, ssz) else {
                break;
            };
            let Some(next) = read_i32(table, jj) else {
                break;
            };
            j = i64::from(next);
            if j >= 0 && j < sl && seen[j as usize] {
                break;
            }
        }
        sector_list.insert(k, Chain { data });
    }
    Ok(sector_list)
}

/// `get_mfat_entry`: a small stream, cut from the mini stream.
fn get_mfat_entry(start: i32, size: i32, payload: &[u8], mini: Option<&[u8]>) -> Vec<u8> {
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut remaining = i64::from(size);
    let mut idx = i64::from(start);
    if let Some(mini) = mini {
        while remaining > 0 && idx >= 0 {
            let from = (idx as usize).saturating_mul(MSSZ).min(payload.len());
            let to = (idx as usize)
                .saturating_mul(MSSZ)
                .saturating_add(MSSZ)
                .min(payload.len());
            parts.push(&payload[from..to]);
            remaining -= MSSZ as i64;
            match read_i32(mini, (idx as usize).saturating_mul(4)) {
                Some(next) => idx = i64::from(next),
                None => break,
            }
        }
    }
    if parts.is_empty() {
        return Vec::new();
    }
    let mut joined: Vec<u8> = parts.concat();
    joined.truncate(usize::try_from(size.max(0)).unwrap_or(0));
    joined
}

/// `read_directory`
fn read_directory(
    dir_start: i64,
    sector_list: &mut SectorList,
    sectors: &[&[u8]],
    paths: &mut Vec<String>,
    nmfs: i32,
    file_index: &mut Vec<Entry>,
    mini: i32,
) -> Result<(), CfbError> {
    let mut minifat_store: i64 = 0;
    let pl: i64 = if paths.is_empty() { 0 } else { 2 };
    let Some(chain) = sector_list.chains.get(&dir_start) else {
        return throw("Cannot read properties of undefined (reading 'data')");
    };
    let sector = chain.data.clone();
    let mut i = 0usize;
    while i < sector.len() {
        let blob = &sector[i..(i + 128).min(sector.len())];
        let u16_at = |at: usize| -> i64 {
            blob.get(at..at + 2)
                .map_or(0, |b| i64::from(u16::from_le_bytes([b[0], b[1]])))
        };
        let i32_at = |at: usize| -> i32 { read_i32(blob, at).unwrap_or(0) };
        let namelen = u16_at(64);
        let name = utf16le_name(blob, namelen - pl);
        paths.push(name.clone());
        let kind = blob.get(66).copied().unwrap_or(0);
        let color = blob.get(67).copied().unwrap_or(0);
        let mut clsid = [0u8; 16];
        if let Some(b) = blob.get(80..96) {
            clsid.copy_from_slice(b);
        }
        let mut o = Entry {
            name,
            kind,
            color,
            l: i32_at(68),
            r: i32_at(72),
            c: i32_at(76),
            clsid,
            state: i32_at(96),
            start: i32_at(116),
            size: i32_at(120),
            content: None,
        };
        if o.size < 0 && o.start < 0 {
            o.size = 0;
            o.kind = 0;
            o.start = ENDOFCHAIN;
            o.name = String::new();
        }
        if o.kind == 5 {
            minifat_store = i64::from(o.start);
            if nmfs > 0
                && minifat_store != i64::from(ENDOFCHAIN)
                && !sector_list.chains.contains_key(&minifat_store)
            {
                return throw("Cannot set properties of undefined (setting 'name')");
            }
        } else if o.size >= 4096 {
            let start = i64::from(o.start);
            if !sector_list.chains.contains_key(&start) {
                let made =
                    get_sector_list(sectors, start, &sector_list.fat_addrs, sector_list.ssz)?;
                sector_list.chains.insert(start, made);
            }
            let data = &sector_list.chains[&start].data;
            let take = usize::try_from(o.size).unwrap_or(0).min(data.len());
            o.content = Some(data[..take].to_vec());
        } else {
            if o.size < 0 {
                o.size = 0;
            } else if minifat_store != i64::from(ENDOFCHAIN)
                && o.start != ENDOFCHAIN
                && sector_list.chains.contains_key(&minifat_store)
            {
                let payload = &sector_list.chains[&minifat_store].data;
                let mini_data = sector_list
                    .chains
                    .get(&i64::from(mini))
                    .map(|c| &c.data[..]);
                o.content = Some(get_mfat_entry(o.start, o.size, payload, mini_data));
            }
        }
        file_index.push(o);
        i += 128;
    }
    Ok(())
}

/// `build_full_paths`: the path of every entry from the tree links.
fn build_full_paths(fi: &[Entry], fp: &mut Vec<String>, paths: &[String]) -> Result<(), CfbError> {
    let pl = paths.len();
    let mut dad: Vec<i64> = (0..pl as i64).collect();
    let mut q: Vec<i64> = (0..pl as i64).collect();
    *fp = paths.to_vec();
    // `L`, `R`, `C` stay what the last turn of the first loop read
    let (mut l, mut r): (i64, i64) = (0, 0);
    let in_range = |x: i64| -> bool { x >= 0 && (x as usize) < pl };
    let mut j = 0usize;
    while j < q.len() {
        let i = q[j];
        let entry = &fi[i as usize];
        l = i64::from(entry.l);
        r = i64::from(entry.r);
        let c = i64::from(entry.c);
        if dad[i as usize] == i {
            if l != -1 {
                if !in_range(l) {
                    return throw("Cannot read properties of undefined");
                }
                if dad[l as usize] != l {
                    dad[i as usize] = dad[l as usize];
                }
            }
            if r != -1 {
                if !in_range(r) {
                    return throw("Cannot read properties of undefined");
                }
                if dad[r as usize] != r {
                    dad[i as usize] = dad[r as usize];
                }
            }
        }
        if c != -1 {
            if !in_range(c) {
                return throw("Cannot read properties of undefined");
            }
            dad[c as usize] = i;
        }
        if l != -1 && i != dad[i as usize] {
            dad[l as usize] = dad[i as usize];
            if q.iter().rposition(|&x| x == l).is_none_or(|at| at < j) {
                q.push(l);
            }
        }
        if r != -1 && i != dad[i as usize] {
            dad[r as usize] = dad[i as usize];
            if q.iter().rposition(|&x| x == r).is_none_or(|at| at < j) {
                q.push(r);
            }
        }
        j += 1;
    }
    for i in 1..pl {
        if dad[i] == i as i64 {
            if r != -1 && in_range(r) && dad[r as usize] != r {
                dad[i] = dad[r as usize];
            } else if l != -1 && in_range(l) && dad[l as usize] != l {
                dad[i] = dad[l as usize];
            }
        }
    }
    for i in 1..pl {
        if fi[i].kind == 0 {
            continue;
        }
        let mut j = i as i64;
        if j != dad[j as usize] {
            loop {
                j = dad[j as usize];
                let head = if in_range(j) {
                    fp[j as usize].clone()
                } else {
                    "undefined".to_owned()
                };
                fp[i] = format!("{head}/{}", fp[i]);
                if !(j != 0 && in_range(j) && dad[j as usize] != -1 && j != dad[j as usize]) {
                    break;
                }
            }
        }
        dad[i] = -1;
    }
    if let Some(root) = fp.first_mut() {
        root.push('/');
    }
    for i in 1..pl {
        if fi[i].kind != 2 {
            fp[i].push('/');
        }
    }
    Ok(())
}

/// `CFB.read(buffer, { type: 'buffer' })` of a file the gate passed.
pub fn read(file: &[u8]) -> Result<Container, CfbError> {
    // zip and MIME files are not OLE2: the gate refused them before this
    if file.len() < 512 {
        return throw(format!("CFB file size {} < 512", file.len()));
    }
    let blob = &file[..512];
    check_field(blob, 0, "d0cf11e0a1b11ae1", "Header Signature: ")?;
    let u16_at = |at: usize| -> i64 { i64::from(u16::from_le_bytes([blob[at], blob[at + 1]])) };
    let i32_at = |at: usize| -> i32 { read_i32(blob, at).unwrap_or(0) };
    let major = u16_at(26);
    let ssz: usize = match major {
        3 => 512,
        4 => 4096,
        other => return throw(format!("Major Version: Expected 3 or 4 saw {other}")),
    };
    let header_blob: &[u8] = if ssz == 512 {
        blob
    } else {
        &file[..ssz.min(file.len())]
    };
    // check_shifts
    let shift = u16_at(30);
    match shift {
        0x09 => {
            if major != 3 {
                return throw(format!("Sector Shift: Expected 9 saw {shift}"));
            }
        }
        0x0c => {
            if major != 4 {
                return throw(format!("Sector Shift: Expected 12 saw {shift}"));
            }
        }
        other => return throw(format!("Sector Shift: Expected 9 or 12 saw {other}")),
    }
    check_field(header_blob, 32, "0600", "Mini Sector Shift: ")?;
    check_field(header_blob, 34, "000000000000", "Reserved: ")?;
    let dir_cnt = i32_at(40);
    if major == 3 && dir_cnt != 0 {
        return throw(format!("# Directory Sectors: Expected 0 saw {dir_cnt}"));
    }
    let dir_start = i64::from(i32_at(48));
    check_field(header_blob, 56, "00100000", "Mini Stream Cutoff Size: ")?;
    let minifat_start = i32_at(60);
    let nmfs = i32_at(64);
    let difat_start = i64::from(i32_at(68));
    let difat_sec_cnt = i64::from(i32_at(72));
    let mut fat_addrs: Vec<i32> = Vec::new();
    for j in 0..109 {
        let q = i32_at(76 + j * 4);
        if q < 0 {
            break;
        }
        fat_addrs.push(q);
    }

    // sectorify
    let nsectors = file.len().div_ceil(ssz) - 1;
    let mut sectors: Vec<&[u8]> = Vec::with_capacity(nsectors);
    for i in 1..nsectors {
        sectors.push(&file[i * ssz..((i + 1) * ssz).min(file.len())]);
    }
    sectors.push(&file[(nsectors * ssz).min(file.len())..]);

    sleuth_fat(difat_start, difat_sec_cnt, &sectors, ssz, &mut fat_addrs)?;

    let chains = make_sector_list(&sectors, dir_start, &fat_addrs, ssz)?;
    if !chains.contains_key(&dir_start) {
        return throw("Cannot set properties of undefined (setting 'name')");
    }
    if nmfs > 0 && minifat_start != ENDOFCHAIN && !chains.contains_key(&i64::from(minifat_start)) {
        return throw("Cannot set properties of undefined (setting 'name')");
    }
    let first_fat = fat_addrs.first().map_or(i64::MIN, |&a| i64::from(a));
    if !chains.contains_key(&first_fat) {
        return throw("Cannot set properties of undefined (setting 'name')");
    }
    let mut sector_list = SectorList {
        chains,
        fat_addrs,
        ssz,
    };

    let mut paths: Vec<String> = Vec::new();
    let mut file_index: Vec<Entry> = Vec::new();
    read_directory(
        dir_start,
        &mut sector_list,
        &sectors,
        &mut paths,
        nmfs,
        &mut file_index,
        minifat_start,
    )?;
    let mut full_paths: Vec<String> = Vec::new();
    build_full_paths(&file_index, &mut full_paths, &paths)?;
    Ok(Container {
        full_paths,
        file_index,
    })
}

// ---- find ----

/// `x.toUpperCase()`
fn upper(text: &str) -> String {
    text.to_uppercase()
}

/// `text.replace(/[\u0001-\u0006]/g, '!')`
fn bang_controls(text: &str) -> String {
    text.chars()
        .map(|c| {
            if ('\u{1}'..='\u{6}').contains(&c) {
                '!'
            } else {
                c
            }
        })
        .collect()
}

fn has_control(text: &str) -> bool {
    text.chars().any(|c| ('\u{1}'..='\u{6}').contains(&c))
}

fn strip_nul(text: &str) -> String {
    text.replace('\0', "")
}

/// `CFB.find(cfb, path)`: the index of the entry, matched case-insensitively.
pub fn find(cfb: &Container, path: &str) -> Option<usize> {
    let uc_full: Vec<String> = cfb.full_paths.iter().map(|x| upper(x)).collect();
    let uc_paths: Vec<String> = uc_full
        .iter()
        .map(|x| {
            let y: Vec<&str> = x.split('/').collect();
            let back = if x.ends_with('/') { 2 } else { 1 };
            y.get(y.len().wrapping_sub(back))
                .copied()
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    let (k, path) = if path.starts_with('/') {
        let root = uc_full.first()?;
        let mut head: String = root.clone();
        head.pop();
        (true, format!("{head}{path}"))
    } else {
        (path.contains('/'), path.to_owned())
    };
    let uc_path = upper(&path);
    let found = if k {
        uc_full.iter().position(|x| *x == uc_path)
    } else {
        uc_paths.iter().position(|x| *x == uc_path)
    };
    if found.is_some() {
        return found;
    }
    let m = !has_control(&uc_path);
    let mut uc_path = strip_nul(&uc_path);
    if m {
        uc_path = bang_controls(&uc_path);
    }
    for w in 0..uc_full.len() {
        let full = if m {
            bang_controls(&uc_full[w])
        } else {
            uc_full[w].clone()
        };
        if strip_nul(&full) == uc_path {
            return Some(w);
        }
        let last = if m {
            bang_controls(&uc_paths[w])
        } else {
            uc_paths[w].clone()
        };
        if strip_nul(&last) == uc_path {
            return Some(w);
        }
    }
    None
}

// ---- write ----

/// `namecmp(l, r)`
fn namecmp(l: &str, r: &str) -> f64 {
    let left: Vec<&str> = l.split('/').collect();
    let right: Vec<&str> = r.split('/').collect();
    let z = left.len().min(right.len());
    for i in 0..z {
        let c = utf16_len(left[i]) as f64 - utf16_len(right[i]) as f64;
        if c != 0.0 {
            return c;
        }
        if left[i] != right[i] {
            return if string_less_than(left[i], right[i]) {
                -1.0
            } else {
                1.0
            };
        }
    }
    left.len() as f64 - right.len() as f64
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `dirname(p)`
fn dirname(p: &str) -> String {
    if let Some(head) = p.strip_suffix('/') {
        if !head.contains('/') {
            return p.to_owned();
        }
        return dirname(head);
    }
    match p.rfind('/') {
        None => p.to_owned(),
        Some(c) => p[..=c].to_owned(),
    }
}

/// `filename(p)`
fn filename(p: &str) -> String {
    if let Some(rest) = p.strip_suffix('/') {
        return filename(rest);
    }
    match p.rfind('/') {
        None => p.to_owned(),
        Some(c) => p[c + 1..].to_owned(),
    }
}

/// `String.prototype.replace("/", "")`: the first slash only
fn drop_first_slash(text: &str) -> String {
    match text.find('/') {
        Some(at) => format!("{}{}", &text[..at], &text[at + 1..]),
        None => text.to_owned(),
    }
}

/// `rebuild_cfb(cfb, f)`: puts the directory right when it is not.
fn rebuild_cfb(cfb: &mut Container, force: bool) -> Result<(), CfbError> {
    // init_cfb
    if cfb.full_paths.len() != cfb.file_index.len() {
        return throw("inconsistent CFB structure");
    }
    if cfb.full_paths.is_empty() {
        cfb.full_paths.push("Root Entry/".to_owned());
        let mut root = Entry::unused("Root Entry");
        root.kind = 5;
        cfb.file_index.push(root);
    }
    // seed_cfb: the producer's marker stream, unless it is there
    let marker = "\u{1}Sh33tJ5";
    if find(cfb, &format!("/{marker}")).is_none() {
        let mut seed = Entry::unused(marker);
        seed.kind = 2;
        seed.content = Some(vec![55, 50, 54, 50]);
        seed.size = 4;
        seed.l = 69;
        seed.r = 69;
        seed.c = 69;
        let root = cfb.full_paths[0].clone();
        cfb.file_index.push(seed);
        cfb.full_paths.push(format!("{root}{marker}"));
        return rebuild_cfb(cfb, false);
    }

    let mut gc = false;
    let mut s = false;
    let mut i = cfb.full_paths.len();
    while i > 0 {
        i -= 1;
        let file = &cfb.file_index[i];
        match file.kind {
            0 => {
                if s {
                    gc = true;
                } else {
                    cfb.file_index.pop();
                    cfb.full_paths.pop();
                }
            }
            1 | 2 | 5 => {
                s = true;
                if file.r > -1 && file.l > -1 && file.r == file.l {
                    gc = true;
                }
            }
            _ => gc = true,
        }
    }
    if !gc && !force {
        return Ok(());
    }

    let mut known: HashSet<String> = HashSet::new();
    let mut data: Vec<(String, Entry)> = Vec::new();
    for i in 0..cfb.full_paths.len() {
        known.insert(cfb.full_paths[i].clone());
        if cfb.file_index[i].kind == 0 {
            continue;
        }
        data.push((cfb.full_paths[i].clone(), cfb.file_index[i].clone()));
    }
    let mut i = 0;
    while i < data.len() {
        let mut dad = dirname(&data[i].0);
        let mut s = known.contains(&dad);
        let mut guard = 0usize;
        while !s {
            guard += 1;
            if guard > 1 << 20 {
                return throw("the directory paths do not end");
            }
            loop {
                let up = dirname(&dad);
                if !up.is_empty() && !known.contains(&up) {
                    if up == dad {
                        return throw("the directory paths do not end");
                    }
                    dad = up;
                } else {
                    break;
                }
            }
            let mut storage = Entry::unused(&drop_first_slash(&filename(&dad)));
            storage.kind = 1;
            data.push((dad.clone(), storage));
            known.insert(dad.clone());
            dad = dirname(&data[i].0);
            s = known.contains(&dad);
        }
        i += 1;
    }

    sort_by_number(&mut data, |x, y| namecmp(&x.0, &y.0));
    cfb.full_paths = Vec::with_capacity(data.len());
    cfb.file_index = Vec::with_capacity(data.len());
    for (path, entry) in data {
        cfb.full_paths.push(path);
        cfb.file_index.push(entry);
    }
    let total = cfb.file_index.len();
    for i in 0..total {
        let nm = cfb.full_paths[i].clone();
        {
            let elt = &mut cfb.file_index[i];
            elt.name = drop_first_slash(&filename(&nm));
            elt.color = 1;
            elt.l = -1;
            elt.r = -1;
            elt.c = -1;
            elt.size = elt.content.as_ref().map_or(0, |c| c.len() as i32);
            elt.start = 0;
        }
        if i == 0 {
            let elt = &mut cfb.file_index[i];
            elt.c = if total > 1 { 1 } else { -1 };
            elt.size = 0;
            elt.kind = 5;
        } else if nm.ends_with('/') {
            let mut j = i + 1;
            while j < total {
                if dirname(&cfb.full_paths[j]) == nm {
                    break;
                }
                j += 1;
            }
            let c = if j >= total { -1 } else { j as i32 };
            let up = dirname(&nm);
            let mut j = i + 1;
            while j < total {
                if dirname(&cfb.full_paths[j]) == up {
                    break;
                }
                j += 1;
            }
            let r = if j >= total { -1 } else { j as i32 };
            let elt = &mut cfb.file_index[i];
            elt.c = c;
            elt.r = r;
            elt.kind = 1;
        } else {
            let next = cfb.full_paths.get(i + 1).map_or("", String::as_str);
            let same = dirname(next) == dirname(&nm);
            let elt = &mut cfb.file_index[i];
            if same {
                elt.r = i as i32 + 1;
            }
            elt.kind = 2;
        }
    }
    Ok(())
}

/// The output buffer of `_write`, with `write_shift`. A write past the end is
/// dropped, as an index past the end of a typed array is.
struct Out {
    buf: Vec<u8>,
    l: usize,
}

impl Out {
    fn put(&mut self, at: usize, byte: u8) {
        if let Some(slot) = self.buf.get_mut(at) {
            *slot = byte;
        }
    }
    fn w1(&mut self, value: i64) {
        self.put(self.l, value as u8);
        self.l += 1;
    }
    fn w2(&mut self, value: i64) {
        self.put(self.l, value as u8);
        self.put(self.l + 1, (value >> 8) as u8);
        self.l += 2;
    }
    /// `write_shift(4, value)` and `write_shift(-4, value)`: the same bytes
    fn w4(&mut self, value: i64) {
        for k in 0..4 {
            self.put(self.l + k, (value >> (8 * k)) as u8);
        }
        self.l += 4;
    }
    fn aligned(&self, mask: usize) -> bool {
        self.l & mask == 0
    }
}

/// The state of `chainit`
struct Chaining {
    i: i64,
    t: i64,
}

impl Chaining {
    fn chainit(&mut self, o: &mut Out, w: i64) {
        self.t += w;
        while self.i < self.t - 1 {
            o.w4(self.i + 1);
            self.i += 1;
        }
        if w != 0 {
            self.i += 1;
            o.w4(i64::from(ENDOFCHAIN));
        }
    }
}

fn ceil_div(value: i64, by: i64) -> i64 {
    (value as f64 / by as f64).ceil() as i64
}

/// `CFB.write(cfb, { type: 'buffer' })` (`_write` without options)
pub fn write(cfb: &mut Container) -> Result<Vec<u8>, CfbError> {
    rebuild_cfb(cfb, false)?;
    if cfb.file_index.is_empty() {
        return throw("Cannot set properties of undefined (setting 'size')");
    }
    let (mut mini_size, mut fat_size): (i64, i64) = (0, 0);
    for file in &cfb.file_index {
        let Some(content) = &file.content else {
            continue;
        };
        let flen = content.len() as i64;
        if flen > 0 {
            if flen < 0x1000 {
                mini_size += (flen + 0x3f) >> 6;
            } else {
                fat_size += (flen + 0x01ff) >> 9;
            }
        }
    }
    let dir_cnt = (cfb.full_paths.len() as i64 + 3) >> 2;
    let mini_cnt = (mini_size + 7) >> 3;
    let mfat_cnt = (mini_size + 0x7f) >> 7;
    let fat_base = mini_cnt + fat_size + dir_cnt + mfat_cnt;
    let mut fat_cnt = (fat_base + 0x7f) >> 7;
    let difat_of = |fat_cnt: i64| -> i64 {
        if fat_cnt <= 109 {
            0
        } else {
            ceil_div(fat_cnt - 109, 0x7f)
        }
    };
    let mut difat_cnt = difat_of(fat_cnt);
    while ((fat_base + fat_cnt + difat_cnt + 0x7f) >> 7) > fat_cnt {
        fat_cnt += 1;
        difat_cnt = difat_of(fat_cnt);
    }
    let mut l = [
        1, difat_cnt, fat_cnt, mfat_cnt, dir_cnt, fat_size, mini_size, 0i64,
    ];
    cfb.file_index[0].size = (mini_size << 6) as i32;
    cfb.file_index[0].start = (l[0] + l[1] + l[2] + l[3] + l[4] + l[5]) as i32;
    l[7] = i64::from(cfb.file_index[0].start) + ((l[6] + 7) >> 3);
    let mut o = Out {
        buf: vec![0; usize::try_from(l[7] << 9).unwrap_or(0)],
        l: 0,
    };

    for byte in HEADER_SIG {
        o.w1(i64::from(byte));
    }
    for _ in 0..8 {
        o.w2(0);
    }
    o.w2(0x003e);
    o.w2(0x0003);
    o.w2(0xfffe);
    o.w2(0x0009);
    o.w2(0x0006);
    for _ in 0..3 {
        o.w2(0);
    }
    o.w4(0);
    o.w4(l[2]);
    o.w4(l[0] + l[1] + l[2] + l[3] - 1);
    o.w4(0);
    o.w4(1 << 12);
    o.w4(if l[3] != 0 {
        l[0] + l[1] + l[2] - 1
    } else {
        i64::from(ENDOFCHAIN)
    });
    o.w4(l[3]);
    o.w4(if l[1] != 0 {
        l[0] - 1
    } else {
        i64::from(ENDOFCHAIN)
    });
    o.w4(l[1]);
    let mut i: i64 = 0;
    while i < 109 {
        o.w4(if i < l[2] { l[1] + i } else { -1 });
        i += 1;
    }
    if l[1] != 0 {
        let mut t: i64 = 0;
        while t < l[1] {
            while i < 236 + t * 127 {
                o.w4(if i < l[2] { l[1] + i } else { -1 });
                i += 1;
            }
            o.w4(if t == l[1] - 1 {
                i64::from(ENDOFCHAIN)
            } else {
                t + 1
            });
            t += 1;
        }
    }
    let mut chain = Chaining { i: 0, t: 0 };
    chain.t += l[1];
    while chain.i < chain.t {
        o.w4(DIFSECT);
        chain.i += 1;
    }
    chain.t += l[2];
    while chain.i < chain.t {
        o.w4(FATSECT);
        chain.i += 1;
    }
    chain.chainit(&mut o, l[3]);
    chain.chainit(&mut o, l[4]);
    for j in 0..cfb.file_index.len() {
        let Some(content) = &cfb.file_index[j].content else {
            continue;
        };
        let flen = content.len() as i64;
        if flen < 0x1000 {
            continue;
        }
        cfb.file_index[j].start = chain.t as i32;
        chain.chainit(&mut o, (flen + 0x01ff) >> 9);
    }
    chain.chainit(&mut o, (l[6] + 7) >> 3);
    while !o.aligned(0x1ff) {
        o.w4(i64::from(ENDOFCHAIN));
    }
    chain = Chaining { i: 0, t: 0 };
    for j in 0..cfb.file_index.len() {
        let Some(content) = &cfb.file_index[j].content else {
            continue;
        };
        let flen = content.len() as i64;
        if flen == 0 || flen >= 0x1000 {
            continue;
        }
        cfb.file_index[j].start = chain.t as i32;
        chain.chainit(&mut o, (flen + 0x3f) >> 6);
    }
    while !o.aligned(0x1ff) {
        o.w4(i64::from(ENDOFCHAIN));
    }

    for i in 0..(l[4] << 2) as usize {
        let empty = cfb.full_paths.get(i).is_none_or(|nm| nm.is_empty());
        if empty {
            for _ in 0..17 {
                o.w4(0);
            }
            for _ in 0..3 {
                o.w4(-1);
            }
            for _ in 0..12 {
                o.w4(0);
            }
            continue;
        }
        let Some(file) = cfb.file_index.get_mut(i) else {
            return throw("Cannot read properties of undefined (reading 'start')");
        };
        if i == 0 {
            file.start = if file.size != 0 {
                file.start - 1
            } else {
                ENDOFCHAIN
            };
        }
        let mut units: Vec<u16> = file.name.encode_utf16().collect();
        units.truncate(32);
        let flen = 2 * (units.len() as i64 + 1);
        for k in 0..32usize {
            let unit = units.get(k).copied().unwrap_or(0);
            o.w1(i64::from(unit & 0xff));
            o.w1(i64::from(unit >> 8));
        }
        o.w2(flen);
        o.w1(i64::from(file.kind));
        o.w1(i64::from(file.color));
        o.w4(i64::from(file.l));
        o.w4(i64::from(file.r));
        o.w4(i64::from(file.c));
        for byte in file.clsid {
            o.w1(i64::from(byte));
        }
        o.w4(i64::from(file.state));
        for _ in 0..4 {
            o.w4(0);
        }
        o.w4(i64::from(file.start));
        o.w4(i64::from(file.size));
        o.w4(0);
    }
    for file in cfb.file_index.iter().skip(1) {
        if file.size >= 0x1000 {
            o.l = ((i64::from(file.start) + 1) << 9) as usize;
            let Some(content) = file.content.as_deref() else {
                return throw("Cannot read properties of undefined (reading '0')");
            };
            let take = (file.size as usize)
                .min(content.len())
                .min(o.buf.len().saturating_sub(o.l));
            let at = o.l;
            o.buf[at..at + take].copy_from_slice(&content[..take]);
            o.l += (file.size as usize + 511) & !511;
        }
    }
    for file in cfb.file_index.iter().skip(1) {
        if file.size > 0 && file.size < 0x1000 {
            let Some(content) = file.content.as_deref() else {
                return throw("Cannot read properties of undefined (reading '0')");
            };
            let take = (file.size as usize)
                .min(content.len())
                .min(o.buf.len().saturating_sub(o.l));
            let at = o.l;
            o.buf[at..at + take].copy_from_slice(&content[..take]);
            o.l += (file.size as usize + 63) & !63;
        }
    }
    Ok(o.buf)
}
