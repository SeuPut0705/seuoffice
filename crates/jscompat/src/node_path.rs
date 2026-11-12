// Port of Node.js lib/path.js (v22.22.0), https://github.com/nodejs/node,
// Copyright Joyent, Inc. and other Node contributors, MIT License.
//! Node's `path` module (`lib/path.js` of Node 22), both flavours: `posix` and
//! `win32`. `host` is the one `require('node:path')` gives on this platform.
//!
//! Node walks UTF-16 code units (`charCodeAt`, `slice`, `length`), so every
//! function here converts its arguments to code units, works on them with
//! the same indices as the JavaScript, and converts the answer back.
//!
//! Where Node reads `process.cwd()`:
//! - `posix.resolve` (and so `posix.relative`): when no argument is absolute,
//!   and for the fast path of no argument, `''` or `'.'`. On Windows hosts the
//!   cwd is first made POSIX (`\` to `/`, drive cut off).
//! - `win32.resolve` (and so `win32.relative`, `win32.toNamespacedPath`): at
//!   the end of the arguments when no drive was found, and for a drive-only
//!   path (`C:foo`) the per-drive variable `=C:` of the environment, else the
//!   cwd. On a host other than Windows the fast path writes `/` as `\`.
//!
//! The `*_from` functions take that cwd (and the drive variables) as
//! parameters; the plain ones read `std::env::current_dir()` (an unreadable
//! cwd, which makes Node throw, reads as `""` here, the relative-path case
//! the JavaScript comments call "might happen when process.cwd() fails").

type U = Vec<u16>;

const FS: i32 = 47; // '/'
const BS: i32 = 92; // '\\'
const DOT: i32 = 46;
const COLON: i32 = 58;
const QM: i32 = 63;

const IS_WINDOWS: bool = cfg!(windows);

const WINDOWS_RESERVED_NAMES: [&str; 22 + 6] = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "COM\u{b9}",
    "COM\u{b2}",
    "COM\u{b3}",
    "LPT\u{b9}",
    "LPT\u{b2}",
    "LPT\u{b3}",
];

fn u(s: &str) -> U {
    s.encode_utf16().collect()
}

fn st(p: &[u16]) -> String {
    String::from_utf16_lossy(p)
}

fn cat(parts: &[&[u16]]) -> U {
    parts.concat()
}

/// `charCodeAt`: -1 stands for NaN, which equals and orders against nothing.
fn at(p: &[u16], i: i64) -> i32 {
    if i >= 0 && (i as usize) < p.len() {
        p[i as usize] as i32
    } else {
        -1
    }
}

fn rel(i: i64, n: i64) -> i64 {
    if i < 0 { (n + i).max(0) } else { i.min(n) }
}

/// `slice(start, end)` with JavaScript's negative indices.
fn slice(p: &[u16], start: i64, end: i64) -> U {
    let n = p.len() as i64;
    let (s, e) = (rel(start, n), rel(end, n));
    if s >= e {
        U::new()
    } else {
        p[s as usize..e as usize].to_vec()
    }
}

fn slice_from(p: &[u16], start: i64) -> U {
    slice(p, start, i64::MAX)
}

fn index_of(p: &[u16], c: u16, from: i64) -> i64 {
    let mut i = from.max(0);
    while (i as usize) < p.len() {
        if p[i as usize] == c {
            return i;
        }
        i += 1;
    }
    -1
}

fn last_index_of(p: &[u16], c: u16) -> i64 {
    p.iter().rposition(|&x| x == c).map_or(-1, |i| i as i64)
}

fn lower(p: &[u16]) -> U {
    u(&st(p).to_lowercase())
}

fn upper(p: &[u16]) -> U {
    u(&st(p).to_uppercase())
}

fn is_path_separator(code: i32) -> bool {
    code == FS || code == BS
}

fn is_posix_path_separator(code: i32) -> bool {
    code == FS
}

fn is_windows_reserved_name(path: &[u16], colon_index: i64) -> bool {
    let device_part = upper(&slice(path, 0, colon_index));
    WINDOWS_RESERVED_NAMES.iter().any(|n| u(n) == device_part)
}

fn is_windows_device_root(code: i32) -> bool {
    (65..=90).contains(&code) || (97..=122).contains(&code)
}

/// Resolves . and .. elements in a path with directory names
fn normalize_string(
    path: &[u16],
    allow_above_root: bool,
    separator: u16,
    is_sep: fn(i32) -> bool,
) -> U {
    let mut res = U::new();
    let mut last_segment_length: i64 = 0;
    let mut last_slash: i64 = -1;
    let mut dots: i64 = 0;
    let mut code: i32 = 0;
    let n = path.len() as i64;
    let mut i: i64 = 0;
    while i <= n {
        if i < n {
            code = path[i as usize] as i32;
        } else if is_sep(code) {
            break;
        } else {
            code = FS;
        }

        if is_sep(code) {
            if last_slash == i - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let rl = res.len();
                if rl < 2
                    || last_segment_length != 2
                    || res[rl - 1] as i32 != DOT
                    || res[rl - 2] as i32 != DOT
                {
                    if res.len() > 2 {
                        let last_slash_index = res.len() as i64 - last_segment_length - 1;
                        if last_slash_index == -1 {
                            res = U::new();
                            last_segment_length = 0;
                        } else {
                            res = slice(&res, 0, last_slash_index);
                            last_segment_length =
                                res.len() as i64 - 1 - last_index_of(&res, separator);
                        }
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res = U::new();
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend([DOT as u16, DOT as u16]);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push(separator);
                    res.extend(slice(path, last_slash + 1, i));
                } else {
                    res = slice(path, last_slash + 1, i);
                }
                last_segment_length = i - last_slash - 1;
            }
            last_slash = i;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// What `parse` answers and `format` reads. A field that is `undefined` in
/// the object given to `format` is `""` here (they read alike there).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedPath {
    pub root: String,
    pub dir: String,
    pub base: String,
    pub ext: String,
    pub name: String,
}

fn format_ext(ext: &[u16]) -> U {
    if ext.is_empty() {
        U::new()
    } else if ext[0] as i32 == DOT {
        ext.to_vec()
    } else {
        cat(&[&[DOT as u16], ext])
    }
}

/// `_format(sep, pathObject)` after `validateObject`.
fn format_u(sep: u16, o: &ParsedPath) -> String {
    let (root, dir0, base0, name, ext) = (u(&o.root), u(&o.dir), u(&o.base), u(&o.name), u(&o.ext));
    let dir = if !dir0.is_empty() { dir0 } else { root.clone() };
    let base = if !base0.is_empty() {
        base0
    } else {
        cat(&[&name, &format_ext(&ext)])
    };
    if dir.is_empty() {
        return st(&base);
    }
    if dir == root {
        st(&cat(&[&dir, &base]))
    } else {
        st(&cat(&[&dir, &[sep], &base]))
    }
}

/// Shared by both flavours: `basename` is the same loop with `start` 0 on
/// POSIX and 2 after a drive prefix on win32, and `/` or `/` and `\` as
/// separators.
fn basename_u(path: &[u16], suffix: Option<&[u16]>, win: bool) -> U {
    let is_sep: fn(i32) -> bool = if win {
        is_path_separator
    } else {
        is_posix_path_separator
    };
    let mut start: i64 = 0;
    let mut end: i64 = -1;
    let mut matched_slash = true;

    if win && path.len() >= 2 && is_windows_device_root(at(path, 0)) && at(path, 1) == COLON {
        start = 2;
    }

    if let Some(suffix) = suffix
        && !suffix.is_empty()
        && suffix.len() <= path.len()
    {
        if suffix == path {
            return U::new();
        }
        let mut ext_idx = suffix.len() as i64 - 1;
        let mut first_non_slash_end: i64 = -1;
        let mut i = path.len() as i64 - 1;
        while i >= start {
            let code = at(path, i);
            if is_sep(code) {
                if !matched_slash {
                    start = i + 1;
                    break;
                }
            } else {
                if first_non_slash_end == -1 {
                    matched_slash = false;
                    first_non_slash_end = i + 1;
                }
                if ext_idx >= 0 {
                    if code == at(suffix, ext_idx) {
                        ext_idx -= 1;
                        if ext_idx == -1 {
                            end = i;
                        }
                    } else {
                        ext_idx = -1;
                        end = first_non_slash_end;
                    }
                }
            }
            i -= 1;
        }

        if start == end {
            end = first_non_slash_end;
        } else if end == -1 {
            end = path.len() as i64;
        }
        return slice(path, start, end);
    }
    let mut i = path.len() as i64 - 1;
    while i >= start {
        if is_sep(at(path, i)) {
            if !matched_slash {
                start = i + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        i -= 1;
    }

    if end == -1 {
        return U::new();
    }
    slice(path, start, end)
}

/// Shared like `basename_u`.
fn extname_u(path: &[u16], win: bool) -> U {
    let is_sep: fn(i32) -> bool = if win {
        is_path_separator
    } else {
        is_posix_path_separator
    };
    let mut start: i64 = 0;
    let mut start_dot: i64 = -1;
    let mut start_part: i64 = 0;
    let mut end: i64 = -1;
    let mut matched_slash = true;
    let mut pre_dot_state = 0;

    if win && path.len() >= 2 && at(path, 1) == COLON && is_windows_device_root(at(path, 0)) {
        start = 2;
        start_part = 2;
    }

    let mut i = path.len() as i64 - 1;
    while i >= start {
        let code = at(path, i);
        if is_sep(code) {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            i -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        if code == DOT {
            if start_dot == -1 {
                start_dot = i;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        i -= 1;
    }

    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return U::new();
    }
    slice(path, start_dot, end)
}

pub mod win32 {
    use super::*;

    pub const SEP: &str = "\\";
    pub const DELIMITER: &str = ";";

    /// `path.win32.resolve(...parts)`, the cwd as given and no per-drive
    /// variable.
    pub fn resolve_from(cwd: &str, parts: &[&str]) -> String {
        resolve_from_env(cwd, &|_| None, parts)
    }

    /// `drive_cwd(letter)` is `process.env['=C:']` for `letter` `C`; an empty
    /// answer reads as unset (`||`).
    pub fn resolve_from_env(
        cwd: &str,
        drive_cwd: &dyn Fn(char) -> Option<String>,
        parts: &[&str],
    ) -> String {
        let args: Vec<U> = parts.iter().map(|p| u(p)).collect();
        st(&resolve_u(&u(cwd), drive_cwd, &args))
    }

    /// Reads the cwd and the `=C:` variables from the process.
    pub fn resolve(parts: &[&str]) -> String {
        let cwd = process_cwd();
        resolve_from_env(&cwd, &process_drive_cwd, parts)
    }

    fn process_cwd() -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn process_drive_cwd(letter: char) -> Option<String> {
        std::env::var_os(format!("={letter}:")).and_then(|v| v.into_string().ok())
    }

    fn resolve_u(cwd: &[u16], drive_cwd: &dyn Fn(char) -> Option<String>, args: &[U]) -> U {
        let mut resolved_device = U::new();
        let mut resolved_tail = U::new();
        let mut resolved_absolute = false;

        for i in (-1..args.len() as i64).rev() {
            let path: U;
            if i >= 0 {
                path = args[i as usize].clone();
                // Skip empty entries
                if path.is_empty() {
                    continue;
                }
            } else if resolved_device.is_empty() {
                path = cwd.to_vec();
                // Fast path for current directory
                if args.is_empty()
                    || ((args.len() == 1 && (args[0].is_empty() || args[0] == [DOT as u16]))
                        && is_path_separator(at(&path, 0)))
                {
                    if !IS_WINDOWS {
                        return path
                            .iter()
                            .map(|&c| if c as i32 == FS { BS as u16 } else { c })
                            .collect();
                    }
                    return path;
                }
            } else {
                let letter = resolved_device[0] as u8 as char;
                let mut p = match drive_cwd(letter) {
                    Some(s) if !s.is_empty() => u(&s),
                    _ => cwd.to_vec(),
                };
                if lower(&slice(&p, 0, 2)) != lower(&resolved_device) && at(&p, 2) == BS {
                    p = cat(&[&resolved_device, &[BS as u16]]);
                }
                path = p;
            }

            let len = path.len() as i64;
            let mut root_end: i64 = 0;
            let mut device = U::new();
            let mut is_absolute = false;
            let code = at(&path, 0);

            // Try to match a root
            if len == 1 {
                if is_path_separator(code) {
                    root_end = 1;
                    is_absolute = true;
                }
            } else if is_path_separator(code) {
                is_absolute = true;
                if is_path_separator(at(&path, 1)) {
                    let mut j: i64 = 2;
                    let mut last = j;
                    while j < len && !is_path_separator(at(&path, j)) {
                        j += 1;
                    }
                    if j < len && j != last {
                        let first_part = slice(&path, last, j);
                        last = j;
                        while j < len && is_path_separator(at(&path, j)) {
                            j += 1;
                        }
                        if j < len && j != last {
                            last = j;
                            while j < len && !is_path_separator(at(&path, j)) {
                                j += 1;
                            }
                            if j == len || j != last {
                                if first_part != u(".") && first_part != u("?") {
                                    device = cat(&[
                                        &u("\\\\"),
                                        &first_part,
                                        &u("\\"),
                                        &slice(&path, last, j),
                                    ]);
                                    root_end = j;
                                } else {
                                    device = cat(&[&u("\\\\"), &first_part]);
                                    root_end = 4;
                                }
                            }
                        }
                    }
                } else {
                    root_end = 1;
                }
            } else if is_windows_device_root(code) && at(&path, 1) == COLON {
                device = slice(&path, 0, 2);
                root_end = 2;
                if len > 2 && is_path_separator(at(&path, 2)) {
                    is_absolute = true;
                    root_end = 3;
                }
            }

            if !device.is_empty() {
                if !resolved_device.is_empty() {
                    if lower(&device) != lower(&resolved_device) {
                        // This path points to another device so it is not applicable
                        continue;
                    }
                } else {
                    resolved_device = device;
                }
            }

            if resolved_absolute {
                if !resolved_device.is_empty() {
                    break;
                }
            } else {
                resolved_tail = cat(&[&slice_from(&path, root_end), &[BS as u16], &resolved_tail]);
                resolved_absolute = is_absolute;
                if is_absolute && !resolved_device.is_empty() {
                    break;
                }
            }
        }

        resolved_tail = normalize_string(
            &resolved_tail,
            !resolved_absolute,
            BS as u16,
            is_path_separator,
        );

        if resolved_absolute {
            cat(&[&resolved_device, &[BS as u16], &resolved_tail])
        } else {
            let r = cat(&[&resolved_device, &resolved_tail]);
            if r.is_empty() { u(".") } else { r }
        }
    }

    pub fn normalize(path: &str) -> String {
        st(&normalize_u(&u(path)))
    }

    fn normalize_u(path: &[u16]) -> U {
        let len = path.len() as i64;
        if len == 0 {
            return u(".");
        }
        let mut root_end: i64 = 0;
        let mut device: Option<U> = None;
        let mut is_absolute = false;
        let code = at(path, 0);

        if len == 1 {
            return if is_posix_path_separator(code) {
                u("\\")
            } else {
                path.to_vec()
            };
        }
        if is_path_separator(code) {
            is_absolute = true;
            if is_path_separator(at(path, 1)) {
                let mut j: i64 = 2;
                let mut last = j;
                while j < len && !is_path_separator(at(path, j)) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = slice(path, last, j);
                    last = j;
                    while j < len && is_path_separator(at(path, j)) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_path_separator(at(path, j)) {
                            j += 1;
                        }
                        if j == len || j != last {
                            if first_part == u(".") || first_part == u("?") {
                                // a device root (e.g. \\.\PHYSICALDRIVE0)
                                device = Some(cat(&[&u("\\\\"), &first_part]));
                                root_end = 4;
                                let colon_index = index_of(path, COLON as u16, 0);
                                // \\?\COM1: or similar reserved device paths
                                let possible_device = slice(path, 4, colon_index + 1);
                                if is_windows_reserved_name(
                                    &possible_device,
                                    possible_device.len() as i64 - 1,
                                ) {
                                    device = Some(cat(&[&u("\\\\?\\"), &possible_device]));
                                    root_end = 4 + possible_device.len() as i64;
                                }
                            } else if j == len {
                                // a UNC root only
                                return cat(&[
                                    &u("\\\\"),
                                    &first_part,
                                    &u("\\"),
                                    &slice_from(path, last),
                                    &u("\\"),
                                ]);
                            } else {
                                device = Some(cat(&[
                                    &u("\\\\"),
                                    &first_part,
                                    &u("\\"),
                                    &slice(path, last, j),
                                ]));
                                root_end = j;
                            }
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else {
            let colon_index = index_of(path, COLON as u16, 0);
            if colon_index > 0 {
                if is_windows_device_root(code) && colon_index == 1 {
                    device = Some(slice(path, 0, 2));
                    root_end = 2;
                    if len > 2 && is_path_separator(at(path, 2)) {
                        is_absolute = true;
                        root_end = 3;
                    }
                } else if is_windows_reserved_name(path, colon_index) {
                    device = Some(slice(path, 0, colon_index + 1));
                    root_end = colon_index + 1;
                }
            }
        }

        let mut tail = if root_end < len {
            normalize_string(
                &slice_from(path, root_end),
                !is_absolute,
                BS as u16,
                is_path_separator,
            )
        } else {
            U::new()
        };
        if tail.is_empty() && !is_absolute {
            tail = u(".");
        }
        if !tail.is_empty() && is_path_separator(at(path, len - 1)) {
            tail.push(BS as u16);
        }
        if !is_absolute && device.is_none() && index_of(path, COLON as u16, 0) != -1 {
            // CVE-2024-36139: the tail must not become something Windows reads as absolute
            if tail.len() >= 2 && is_windows_device_root(at(&tail, 0)) && at(&tail, 1) == COLON {
                return cat(&[&u(".\\"), &tail]);
            }
            let mut index = index_of(path, COLON as u16, 0);
            loop {
                if index == len - 1 || is_path_separator(at(path, index + 1)) {
                    return cat(&[&u(".\\"), &tail]);
                }
                index = index_of(path, COLON as u16, index + 1);
                if index == -1 {
                    break;
                }
            }
        }
        let colon_index = index_of(path, COLON as u16, 0);
        if is_windows_reserved_name(path, colon_index) {
            return cat(&[&u(".\\"), device.as_deref().unwrap_or(&[]), &tail]);
        }
        match device {
            None => {
                if is_absolute {
                    cat(&[&u("\\"), &tail])
                } else {
                    tail
                }
            }
            Some(device) => {
                if is_absolute {
                    cat(&[&device, &u("\\"), &tail])
                } else {
                    cat(&[&device, &tail])
                }
            }
        }
    }

    pub fn is_absolute(path: &str) -> bool {
        let path = u(path);
        let len = path.len() as i64;
        if len == 0 {
            return false;
        }
        let code = at(&path, 0);
        is_path_separator(code)
            || (len > 2
                && is_windows_device_root(code)
                && at(&path, 1) == COLON
                && is_path_separator(at(&path, 2)))
    }

    pub fn join(args: &[&str]) -> String {
        if args.is_empty() {
            return ".".to_string();
        }
        let path: Vec<U> = args
            .iter()
            .map(|a| u(a))
            .filter(|a| !a.is_empty())
            .collect();
        if path.is_empty() {
            return ".".to_string();
        }
        let first_part = &path[0];
        let mut joined: U = path.join(&(BS as u16));

        // Make sure that the joined path doesn't start with two slashes unless
        // the first part is clearly a UNC path.
        let mut needs_replace = true;
        let mut slash_count: i64 = 0;
        if is_path_separator(at(first_part, 0)) {
            slash_count += 1;
            let first_len = first_part.len();
            if first_len > 1 && is_path_separator(at(first_part, 1)) {
                slash_count += 1;
                if first_len > 2 {
                    if is_path_separator(at(first_part, 2)) {
                        slash_count += 1;
                    } else {
                        needs_replace = false;
                    }
                }
            }
        }
        if needs_replace {
            while slash_count < joined.len() as i64 && is_path_separator(at(&joined, slash_count)) {
                slash_count += 1;
            }
            if slash_count >= 2 {
                joined = cat(&[&u("\\"), &slice_from(&joined, slash_count)]);
            }
        }

        // Skip normalization when reserved device names are present
        let mut parts: Vec<U> = Vec::new();
        let mut part = U::new();
        let mut i = 0;
        while i < joined.len() {
            if joined[i] as i32 == BS {
                if !part.is_empty() {
                    parts.push(part);
                }
                part = U::new();
                while i + 1 < joined.len() && joined[i + 1] as i32 == BS {
                    i += 1;
                }
            } else {
                part.push(joined[i]);
            }
            i += 1;
        }
        if !part.is_empty() {
            parts.push(part);
        }

        if parts.iter().any(|p| {
            let colon_index = index_of(p, COLON as u16, 0);
            colon_index != -1 && is_windows_reserved_name(p, colon_index)
        }) {
            return st(&joined
                .iter()
                .map(|&c| if c as i32 == FS { BS as u16 } else { c })
                .collect::<U>());
        }

        st(&normalize_u(&joined))
    }

    pub fn relative_from(cwd: &str, from: &str, to: &str) -> String {
        relative_from_env(cwd, &|_| None, from, to)
    }

    pub fn relative_from_env(
        cwd: &str,
        drive_cwd: &dyn Fn(char) -> Option<String>,
        from: &str,
        to: &str,
    ) -> String {
        let cwd = u(cwd);
        st(&relative_u(
            &|p| resolve_u(&cwd, drive_cwd, &[p.to_vec()]),
            &u(from),
            &u(to),
        ))
    }

    pub fn relative(from: &str, to: &str) -> String {
        let cwd = u(&process_cwd());
        st(&relative_u(
            &|p| resolve_u(&cwd, &process_drive_cwd, &[p.to_vec()]),
            &u(from),
            &u(to),
        ))
    }

    fn relative_u(resolve: &dyn Fn(&[u16]) -> U, from: &[u16], to: &[u16]) -> U {
        if from == to {
            return U::new();
        }

        let from_orig = resolve(from);
        let to_orig = resolve(to);

        if from_orig == to_orig {
            return U::new();
        }

        let from = lower(&from_orig);
        let to = lower(&to_orig);

        if from == to {
            return U::new();
        }

        if from_orig.len() != from.len() || to_orig.len() != to.len() {
            let mut from_split: Vec<U> = from_orig
                .split(|&c| c as i32 == BS)
                .map(<[u16]>::to_vec)
                .collect();
            let mut to_split: Vec<U> = to_orig
                .split(|&c| c as i32 == BS)
                .map(<[u16]>::to_vec)
                .collect();
            if from_split.last().is_some_and(|l| l.is_empty()) {
                from_split.pop();
            }
            if to_split.last().is_some_and(|l| l.is_empty()) {
                to_split.pop();
            }

            let from_len = from_split.len();
            let to_len = to_split.len();
            let length = from_len.min(to_len);

            let mut i = 0;
            while i < length {
                if lower(&from_split[i]) != lower(&to_split[i]) {
                    break;
                }
                i += 1;
            }

            if i == 0 {
                return to_orig;
            } else if i == length {
                if to_len > length {
                    return to_split[i..].join(&(BS as u16));
                }
                if from_len > length {
                    let mut out = u("..\\").repeat(from_len - 1 - i);
                    out.extend(u(".."));
                    return out;
                }
                return U::new();
            }

            let mut out = u("..\\").repeat(from_len - i);
            out.extend(to_split[i..].join(&(BS as u16)));
            return out;
        }

        // Trim any leading backslashes
        let mut from_start: i64 = 0;
        while from_start < from.len() as i64 && at(&from, from_start) == BS {
            from_start += 1;
        }
        // Trim trailing backslashes (applicable to UNC paths only)
        let mut from_end = from.len() as i64;
        while from_end - 1 > from_start && at(&from, from_end - 1) == BS {
            from_end -= 1;
        }
        let from_len = from_end - from_start;

        let mut to_start: i64 = 0;
        while to_start < to.len() as i64 && at(&to, to_start) == BS {
            to_start += 1;
        }
        let mut to_end = to.len() as i64;
        while to_end - 1 > to_start && at(&to, to_end - 1) == BS {
            to_end -= 1;
        }
        let to_len = to_end - to_start;

        // Compare paths to find the longest common path from root
        let length = if from_len < to_len { from_len } else { to_len };
        let mut last_common_sep: i64 = -1;
        let mut i: i64 = 0;
        while i < length {
            let from_code = at(&from, from_start + i);
            if from_code != at(&to, to_start + i) {
                break;
            } else if from_code == BS {
                last_common_sep = i;
            }
            i += 1;
        }

        if i != length {
            if last_common_sep == -1 {
                return to_orig;
            }
        } else {
            if to_len > length {
                if at(&to, to_start + i) == BS {
                    return slice_from(&to_orig, to_start + i + 1);
                }
                if i == 2 {
                    return slice_from(&to_orig, to_start + i);
                }
            }
            if from_len > length {
                if at(&from, from_start + i) == BS {
                    last_common_sep = i;
                } else if i == 2 {
                    last_common_sep = 3;
                }
            }
            if last_common_sep == -1 {
                last_common_sep = 0;
            }
        }

        let mut out = U::new();
        i = from_start + last_common_sep + 1;
        while i <= from_end {
            if i == from_end || at(&from, i) == BS {
                if out.is_empty() {
                    out.extend(u(".."));
                } else {
                    out.extend(u("\\.."));
                }
            }
            i += 1;
        }

        to_start += last_common_sep;

        if !out.is_empty() {
            out.extend(slice(&to_orig, to_start, to_end));
            return out;
        }

        if at(&to_orig, to_start) == BS {
            to_start += 1;
        }
        slice(&to_orig, to_start, to_end)
    }

    pub fn to_namespaced_path(path: &str) -> String {
        to_namespaced_path_from_env(&process_cwd(), &process_drive_cwd, path)
    }

    pub fn to_namespaced_path_from(cwd: &str, path: &str) -> String {
        to_namespaced_path_from_env(cwd, &|_| None, path)
    }

    /// (a non-string argument comes back unchanged; that is the caller's)
    pub fn to_namespaced_path_from_env(
        cwd: &str,
        drive_cwd: &dyn Fn(char) -> Option<String>,
        path: &str,
    ) -> String {
        if path.is_empty() {
            return path.to_string();
        }

        let resolved_path = resolve_u(&u(cwd), drive_cwd, &[u(path)]);

        if resolved_path.len() <= 2 {
            return path.to_string();
        }

        if at(&resolved_path, 0) == BS {
            // Possible UNC root
            if at(&resolved_path, 1) == BS {
                let code = at(&resolved_path, 2);
                if code != QM && code != DOT {
                    // Matched non-long UNC root, convert the path to a long UNC path
                    return st(&cat(&[&u("\\\\?\\UNC\\"), &slice_from(&resolved_path, 2)]));
                }
            }
        } else if is_windows_device_root(at(&resolved_path, 0))
            && at(&resolved_path, 1) == COLON
            && at(&resolved_path, 2) == BS
        {
            // Matched device root, convert the path to a long UNC path
            return st(&cat(&[&u("\\\\?\\"), &resolved_path]));
        }

        st(&resolved_path)
    }

    pub fn dirname(path: &str) -> String {
        let path = u(path);
        let len = path.len() as i64;
        if len == 0 {
            return ".".to_string();
        }
        let mut root_end: i64 = -1;
        let mut offset: i64 = 0;
        let code = at(&path, 0);

        if len == 1 {
            return if is_path_separator(code) {
                st(&path)
            } else {
                ".".to_string()
            };
        }

        if is_path_separator(code) {
            root_end = 1;
            offset = 1;

            if is_path_separator(at(&path, 1)) {
                let mut j: i64 = 2;
                let mut last = j;
                while j < len && !is_path_separator(at(&path, j)) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && is_path_separator(at(&path, j)) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_path_separator(at(&path, j)) {
                            j += 1;
                        }
                        if j == len {
                            // We matched a UNC root only
                            return st(&path);
                        }
                        if j != last {
                            root_end = j + 1;
                            offset = j + 1;
                        }
                    }
                }
            }
        } else if is_windows_device_root(code) && at(&path, 1) == COLON {
            root_end = if len > 2 && is_path_separator(at(&path, 2)) {
                3
            } else {
                2
            };
            offset = root_end;
        }

        let mut end: i64 = -1;
        let mut matched_slash = true;
        let mut i = len - 1;
        while i >= offset {
            if is_path_separator(at(&path, i)) {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }

        if end == -1 {
            if root_end == -1 {
                return ".".to_string();
            }
            end = root_end;
        }
        st(&slice(&path, 0, end))
    }

    pub fn basename(path: &str, ext: Option<&str>) -> String {
        let ext = ext.map(u);
        st(&basename_u(&u(path), ext.as_deref(), true))
    }

    pub fn extname(path: &str) -> String {
        st(&extname_u(&u(path), true))
    }

    pub fn format(path_object: &ParsedPath) -> String {
        format_u(BS as u16, path_object)
    }

    pub fn parse(path: &str) -> ParsedPath {
        let path = u(path);
        let mut ret = ParsedPath::default();
        if path.is_empty() {
            return ret;
        }

        let len = path.len() as i64;
        let mut root_end: i64 = 0;
        let mut code = at(&path, 0);

        if len == 1 {
            if is_path_separator(code) {
                ret.root = st(&path);
                ret.dir = st(&path);
                return ret;
            }
            ret.base = st(&path);
            ret.name = st(&path);
            return ret;
        }
        if is_path_separator(code) {
            root_end = 1;
            if is_path_separator(at(&path, 1)) {
                let mut j: i64 = 2;
                let mut last = j;
                while j < len && !is_path_separator(at(&path, j)) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && is_path_separator(at(&path, j)) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_path_separator(at(&path, j)) {
                            j += 1;
                        }
                        if j == len {
                            root_end = j;
                        } else if j != last {
                            root_end = j + 1;
                        }
                    }
                }
            }
        } else if is_windows_device_root(code) && at(&path, 1) == COLON {
            if len <= 2 {
                ret.root = st(&path);
                ret.dir = st(&path);
                return ret;
            }
            root_end = 2;
            if is_path_separator(at(&path, 2)) {
                if len == 3 {
                    ret.root = st(&path);
                    ret.dir = st(&path);
                    return ret;
                }
                root_end = 3;
            }
        }
        if root_end > 0 {
            ret.root = st(&slice(&path, 0, root_end));
        }

        let mut start_dot: i64 = -1;
        let mut start_part = root_end;
        let mut end: i64 = -1;
        let mut matched_slash = true;
        let mut i = path.len() as i64 - 1;
        let mut pre_dot_state = 0;

        while i >= root_end {
            code = at(&path, i);
            if is_path_separator(code) {
                if !matched_slash {
                    start_part = i + 1;
                    break;
                }
                i -= 1;
                continue;
            }
            if end == -1 {
                matched_slash = false;
                end = i + 1;
            }
            if code == DOT {
                if start_dot == -1 {
                    start_dot = i;
                } else if pre_dot_state != 1 {
                    pre_dot_state = 1;
                }
            } else if start_dot != -1 {
                pre_dot_state = -1;
            }
            i -= 1;
        }

        if end != -1 {
            if start_dot == -1
                || pre_dot_state == 0
                || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
            {
                ret.base = st(&slice(&path, start_part, end));
                ret.name = ret.base.clone();
            } else {
                ret.name = st(&slice(&path, start_part, start_dot));
                ret.base = st(&slice(&path, start_part, end));
                ret.ext = st(&slice(&path, start_dot, end));
            }
        }

        if start_part > 0 && start_part != root_end {
            ret.dir = st(&slice(&path, 0, start_part - 1));
        } else {
            ret.dir = ret.root.clone();
        }

        ret
    }
}

pub mod posix {
    use super::*;

    pub const SEP: &str = "/";
    pub const DELIMITER: &str = ":";

    /// `posixCwd()`: `process.cwd()`, made POSIX on a Windows host.
    fn process_cwd() -> String {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        if IS_WINDOWS {
            let cwd: U = u(&cwd)
                .iter()
                .map(|&c| if c as i32 == BS { FS as u16 } else { c })
                .collect();
            return st(&slice_from(&cwd, index_of(&cwd, FS as u16, 0)));
        }
        cwd
    }

    /// `path.posix.resolve(...parts)` with `posixCwd()` being `cwd`.
    pub fn resolve_from(cwd: &str, parts: &[&str]) -> String {
        let args: Vec<U> = parts.iter().map(|p| u(p)).collect();
        st(&resolve_u(&u(cwd), &args))
    }

    pub fn resolve(parts: &[&str]) -> String {
        resolve_from(&process_cwd(), parts)
    }

    fn resolve_u(cwd: &[u16], args: &[U]) -> U {
        if (args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == [DOT as u16])))
            && at(cwd, 0) == FS
        {
            return cwd.to_vec();
        }
        let mut resolved_path = U::new();
        let mut resolved_absolute = false;

        let mut i = args.len() as i64 - 1;
        while i >= 0 && !resolved_absolute {
            let path = &args[i as usize];
            i -= 1;
            if path.is_empty() {
                continue;
            }
            resolved_path = cat(&[path, &[FS as u16], &resolved_path]);
            resolved_absolute = at(path, 0) == FS;
        }

        if !resolved_absolute {
            resolved_path = cat(&[cwd, &[FS as u16], &resolved_path]);
            resolved_absolute = at(cwd, 0) == FS;
        }

        resolved_path = normalize_string(
            &resolved_path,
            !resolved_absolute,
            FS as u16,
            is_posix_path_separator,
        );

        if resolved_absolute {
            return cat(&[&[FS as u16], &resolved_path]);
        }
        if !resolved_path.is_empty() {
            resolved_path
        } else {
            u(".")
        }
    }

    pub fn normalize(path: &str) -> String {
        st(&normalize_u(&u(path)))
    }

    fn normalize_u(path: &[u16]) -> U {
        if path.is_empty() {
            return u(".");
        }
        let is_absolute = at(path, 0) == FS;
        let trailing_separator = at(path, path.len() as i64 - 1) == FS;

        let mut path = normalize_string(path, !is_absolute, FS as u16, is_posix_path_separator);

        if path.is_empty() {
            if is_absolute {
                return u("/");
            }
            return if trailing_separator { u("./") } else { u(".") };
        }
        if trailing_separator {
            path.push(FS as u16);
        }
        if is_absolute {
            cat(&[&[FS as u16], &path])
        } else {
            path
        }
    }

    pub fn is_absolute(path: &str) -> bool {
        path.starts_with('/')
    }

    pub fn join(args: &[&str]) -> String {
        if args.is_empty() {
            return ".".to_string();
        }
        let path: Vec<U> = args
            .iter()
            .map(|a| u(a))
            .filter(|a| !a.is_empty())
            .collect();
        if path.is_empty() {
            return ".".to_string();
        }
        st(&normalize_u(&path.join(&(FS as u16))))
    }

    pub fn relative_from(cwd: &str, from: &str, to: &str) -> String {
        let cwd = u(cwd);
        st(&relative_u(&cwd, &u(from), &u(to)))
    }

    pub fn relative(from: &str, to: &str) -> String {
        relative_from(&process_cwd(), from, to)
    }

    fn relative_u(cwd: &[u16], from: &[u16], to: &[u16]) -> U {
        if from == to {
            return U::new();
        }

        let from = resolve_u(cwd, &[from.to_vec()]);
        let to = resolve_u(cwd, &[to.to_vec()]);

        if from == to {
            return U::new();
        }

        let from_start: i64 = 1;
        let from_end = from.len() as i64;
        let from_len = from_end - from_start;
        let to_start: i64 = 1;
        let to_len = to.len() as i64 - to_start;

        let length = if from_len < to_len { from_len } else { to_len };
        let mut last_common_sep: i64 = -1;
        let mut i: i64 = 0;
        while i < length {
            let from_code = at(&from, from_start + i);
            if from_code != at(&to, to_start + i) {
                break;
            } else if from_code == FS {
                last_common_sep = i;
            }
            i += 1;
        }
        if i == length {
            if to_len > length {
                if at(&to, to_start + i) == FS {
                    return slice_from(&to, to_start + i + 1);
                }
                if i == 0 {
                    return slice_from(&to, to_start + i);
                }
            } else if from_len > length {
                if at(&from, from_start + i) == FS {
                    last_common_sep = i;
                } else if i == 0 {
                    last_common_sep = 0;
                }
            }
        }

        let mut out = U::new();
        i = from_start + last_common_sep + 1;
        while i <= from_end {
            if i == from_end || at(&from, i) == FS {
                if out.is_empty() {
                    out.extend(u(".."));
                } else {
                    out.extend(u("/.."));
                }
            }
            i += 1;
        }

        out.extend(slice_from(&to, to_start + last_common_sep));
        out
    }

    /// A non-op on POSIX.
    pub fn to_namespaced_path(path: &str) -> String {
        path.to_string()
    }

    pub fn dirname(path: &str) -> String {
        let path = u(path);
        if path.is_empty() {
            return ".".to_string();
        }
        let has_root = at(&path, 0) == FS;
        let mut end: i64 = -1;
        let mut matched_slash = true;
        let mut i = path.len() as i64 - 1;
        while i >= 1 {
            if at(&path, i) == FS {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }

        if end == -1 {
            return if has_root {
                "/".to_string()
            } else {
                ".".to_string()
            };
        }
        if has_root && end == 1 {
            return "//".to_string();
        }
        st(&slice(&path, 0, end))
    }

    pub fn basename(path: &str, ext: Option<&str>) -> String {
        let ext = ext.map(u);
        st(&basename_u(&u(path), ext.as_deref(), false))
    }

    pub fn extname(path: &str) -> String {
        st(&extname_u(&u(path), false))
    }

    pub fn format(path_object: &ParsedPath) -> String {
        format_u(FS as u16, path_object)
    }

    pub fn parse(path: &str) -> ParsedPath {
        let path = u(path);
        let mut ret = ParsedPath::default();
        if path.is_empty() {
            return ret;
        }
        let is_absolute = at(&path, 0) == FS;
        let start: i64 = if is_absolute {
            ret.root = "/".to_string();
            1
        } else {
            0
        };
        let mut start_dot: i64 = -1;
        let mut start_part: i64 = 0;
        let mut end: i64 = -1;
        let mut matched_slash = true;
        let mut i = path.len() as i64 - 1;
        let mut pre_dot_state = 0;

        while i >= start {
            let code = at(&path, i);
            if code == FS {
                if !matched_slash {
                    start_part = i + 1;
                    break;
                }
                i -= 1;
                continue;
            }
            if end == -1 {
                matched_slash = false;
                end = i + 1;
            }
            if code == DOT {
                if start_dot == -1 {
                    start_dot = i;
                } else if pre_dot_state != 1 {
                    pre_dot_state = 1;
                }
            } else if start_dot != -1 {
                pre_dot_state = -1;
            }
            i -= 1;
        }

        if end != -1 {
            let start = if start_part == 0 && is_absolute {
                1
            } else {
                start_part
            };
            if start_dot == -1
                || pre_dot_state == 0
                || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
            {
                ret.base = st(&slice(&path, start, end));
                ret.name = ret.base.clone();
            } else {
                ret.name = st(&slice(&path, start, start_dot));
                ret.base = st(&slice(&path, start, end));
                ret.ext = st(&slice(&path, start_dot, end));
            }
        }

        if start_part > 0 {
            ret.dir = st(&slice(&path, 0, start_part - 1));
        } else if is_absolute {
            ret.dir = "/".to_string();
        }

        ret
    }
}

#[cfg(not(windows))]
pub use posix as host;
#[cfg(windows)]
pub use win32 as host;
