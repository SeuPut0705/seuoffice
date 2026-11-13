//! `apps/shell/src/main/projects/cloud-files.ts`: which files of a project
//! folder are "not on this PC" (spec 5.8).
//!
//! A cloud-only file (OneDrive Files On-Demand, other cloud-filter providers,
//! offline storage) is downloaded the moment its content is opened, so it must
//! be judged without opening it. On Windows the judgement comes from the
//! attribute word the directory listing already carries; nothing here opens,
//! reads, pins or unpins a file. Elsewhere the attributes are not available and
//! callers fall back to the known sync-folder rule ([`is_under_known_sync_folder`]).
//!
//! What the TypeScript takes from the process is passed in:
//!
//! - `process.platform` is a `platform: &str` of the options;
//! - `process.env` is a [`JsObject<String>`] (a key that is not there is
//!   `undefined`);
//! - `os.homedir()` is `os_home_dir` of [`SyncFolderOptions`];
//! - the program that lists a folder is a [`ListingRun`], which the caller
//!   implements with `execFile` (see its doc), and the reader built on it is a
//!   [`PowerShellAttributeReader`].
//!
//! Promises are plain calls: a rejection is an `Err`.

use jscompat::node_path::{posix, win32};
use jscompat::{JsMap, JsObject, base64, js_regex, to_int32, to_number, truthy};

use crate::packages::ai_provider::subscription_process::{windows_system_dir, windows_system_tool};

pub const FILE_ATTRIBUTE_OFFLINE: i32 = 0x1000;
pub const FILE_ATTRIBUTE_RECALL_ON_OPEN: i32 = 0x40000;
pub const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: i32 = 0x400000;
/// Any one of these bits means the content is not on this PC
pub const CLOUD_ONLY_ATTRIBUTES: i32 =
    FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

/// `CloudFileVerdict`
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CloudFileVerdict {
    #[serde(rename = "cloud-only")]
    CloudOnly,
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "unknown")]
    Unknown,
}

/// `DirectoryAttributes`: entry name to attribute word, or `None` (null) when
/// the directory could not be listed. The attribute words are numbers of the
/// listing's output: whole numbers up to 2^53 - 1.
pub type DirectoryAttributes = Option<JsMap<f64>>;

/// An `Error` the listing run, the reader or the parser throws (`error.message`)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingFailure(pub String);

/// `AttributeReader`: lists the given directories (absolute paths) in one go.
/// `Ok` has one entry per asked directory; a directory missing from it counts
/// as unlisted. `Err` is a rejection of the listing as a whole.
pub trait AttributeReader {
    fn read(
        &mut self,
        dirs: &[String],
        timeout_ms: f64,
    ) -> Result<JsMap<DirectoryAttributes>, ListingFailure>;
}

/// The options of a [`ListingRun`]
#[derive(Debug, Clone, Copy)]
pub struct ListingRunOptions<'a> {
    pub cwd: &'a str,
    pub env: &'a JsObject<String>,
    pub timeout_ms: f64,
    pub input: &'a str,
}

/// `ListingRun`: starts one program and answers its standard output.
///
/// The caller implements it as `execFileListing` of the TypeScript does: the
/// program is started by `file` with `args` and `options.cwd` / `options.env`,
/// without a shell, hidden, killed after `options.timeout_ms`, its standard
/// output read as UTF-8 up to [`MAX_LISTING_BYTES`] (more fails the run), and
/// `options.input` written to its standard input as UTF-8 and closed. A
/// program that fails, times out, or cannot start is an `Err`.
pub trait ListingRun {
    fn run(
        &mut self,
        file: &str,
        args: &[String],
        options: &ListingRunOptions<'_>,
    ) -> Result<String, ListingFailure>;
}

/// `DetectOptions`, without the reader (it is passed beside the options) and
/// the environment (only the reader reads it)
#[derive(Debug, Clone, Copy)]
pub struct DetectOptions<'a> {
    /// `process.platform` where the TypeScript's `platform` is left out
    pub platform: &'a str,
    pub timeout_ms: Option<f64>,
}

pub const DEFAULT_LISTING_TIMEOUT_MS: f64 = 20_000.0;
/// Room for several hundred thousand entries; a bigger listing fails as a whole
pub const MAX_LISTING_BYTES: u64 = 64 * 1024 * 1024;

/// `isCloudOnlyAttributes(attributes)`
pub fn is_cloud_only_attributes(attributes: f64) -> bool {
    if !attributes.is_finite() || attributes.trunc() != attributes || attributes < 0.0 {
        return false;
    }
    (to_int32(attributes) & CLOUD_ONLY_ATTRIBUTES) != 0
}

/// `POWERSHELL_LISTING_SCRIPT`: the PowerShell program behind the Windows
/// reader. It is a constant: the directories arrive on standard input, one per
/// line, as UTF-8, so no path is ever part of a command line.
/// `DirectoryInfo.GetFileSystemInfos` enumerates the directory
/// (FindFirstFile/FindNextFile) and each entry's attributes come from that
/// enumeration; no file is opened and `Refresh` is never called.
///
/// Output, UTF-8, one record per line (Windows names cannot hold tabs or line
/// breaks): `D<TAB>i` starts directory i, `F<TAB>attributes<TAB>name` is one of
/// its entries, `E<TAB>i` says directory i could not be listed, and `END` says
/// the whole input was handled.
pub const POWERSHELL_LISTING_SCRIPT: &str = concat!(
    r#"$ErrorActionPreference = 'Stop'"#,
    "\n",
    r#"$ProgressPreference = 'SilentlyContinue'"#,
    "\n",
    r#"$utf8 = New-Object System.Text.UTF8Encoding $false"#,
    "\n",
    r#"$reader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8"#,
    "\n",
    r#"$writer = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8"#,
    "\n",
    r#"$index = 0"#,
    "\n",
    r#"while ($null -ne ($line = $reader.ReadLine())) {"#,
    "\n",
    r#"  try {"#,
    "\n",
    r#"    if ($line.Length -eq 0) { throw "empty" }"#,
    "\n",
    r#"    $entries = ([System.IO.DirectoryInfo]::new($line)).GetFileSystemInfos()"#,
    "\n",
    r#"    $writer.WriteLine("D`t$index")"#,
    "\n",
    r#"    foreach ($entry in $entries) {"#,
    "\n",
    r#"      $writer.WriteLine("F`t" + [int]$entry.Attributes + "`t" + $entry.Name)"#,
    "\n",
    r#"    }"#,
    "\n",
    r#"  } catch {"#,
    "\n",
    r#"    $writer.WriteLine("E`t$index")"#,
    "\n",
    r#"  }"#,
    "\n",
    r#"  $index++"#,
    "\n",
    r#"}"#,
    "\n",
    r#"$writer.WriteLine('END')"#,
    "\n",
    r#"$writer.Flush()"#,
);

/// `Number.isSafeInteger(value)`
fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value && value.abs() <= 9_007_199_254_740_991.0
}

/// `parseAttributeListing(stdout, dirs)`: reads the listing program's output;
/// `Err` when it is incomplete or malformed
pub fn parse_attribute_listing(
    stdout: &str,
    dirs: &[String],
) -> Result<JsMap<DirectoryAttributes>, ListingFailure> {
    let mut out: JsMap<DirectoryAttributes> = JsMap::new();
    for dir in dirs {
        out.set(dir.clone(), None);
    }
    // The directory whose map the following entry lines fill. The map is the
    // one `out` holds for it: `D` and `E` are the only lines that set `out`,
    // and each of them also sets this.
    let mut current: Option<String> = None;
    let mut finished = false;
    let dir_at = |field: &str| -> Result<String, ListingFailure> {
        let index = if js_regex!(r"^\d+$").test(field) {
            to_number(field)
        } else {
            -1.0
        };
        if index < 0.0 || index >= dirs.len() as f64 {
            return Err(ListingFailure(format!(
                "unexpected directory index {field}"
            )));
        }
        Ok(dirs[index as usize].clone())
    };
    for line in js_regex!(r"\r?\n").split(stdout) {
        if line.is_empty() {
            continue;
        }
        if finished {
            return Err(ListingFailure("output after END".to_string()));
        }
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[0] {
            "D" => {
                let dir = dir_at(fields.get(1).copied().unwrap_or(""))?;
                current = Some(dir.clone());
                out.set(dir, Some(JsMap::new()));
            }
            "E" => {
                current = None;
                out.set(dir_at(fields.get(1).copied().unwrap_or(""))?, None);
            }
            "F" => {
                let field = fields.get(1).copied().unwrap_or("");
                let attributes = if js_regex!(r"^\d+$").test(field) {
                    to_number(field)
                } else {
                    f64::NAN
                };
                if current.is_none() || fields.len() != 3 || !is_safe_integer(attributes) {
                    return Err(ListingFailure("unexpected entry line".to_string()));
                }
                if let Some(Some(entries)) = current.as_deref().and_then(|dir| out.get_mut(dir)) {
                    entries.set(fields[2], attributes);
                }
            }
            "END" => finished = true,
            _ => return Err(ListingFailure("unexpected listing line".to_string())),
        }
    }
    if !finished {
        return Err(ListingFailure("listing did not finish".to_string()));
    }
    Ok(out)
}

/// `createPowerShellAttributeReader(deps)`: the Windows attribute reader, one
/// Windows PowerShell for the whole batch, started by full path from the system
/// folder, without a shell, hidden, with a timeout. A failure is an `Err`,
/// which detection turns into 'unknown'.
pub struct PowerShellAttributeReader<R> {
    env: JsObject<String>,
    run: R,
    encoded: String,
}

impl<R: ListingRun> PowerShellAttributeReader<R> {
    /// `deps.env ?? process.env` is `env`; `deps.run ?? execFileListing` is `run`
    pub fn new(env: JsObject<String>, run: R) -> Self {
        let bytes: Vec<u8> = POWERSHELL_LISTING_SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        PowerShellAttributeReader {
            env,
            run,
            encoded: base64(&bytes),
        }
    }
}

impl<R: ListingRun> AttributeReader for PowerShellAttributeReader<R> {
    fn read(
        &mut self,
        dirs: &[String],
        timeout_ms: f64,
    ) -> Result<JsMap<DirectoryAttributes>, ListingFailure> {
        let env = |key: &str| self.env.get(key).cloned();
        let file = windows_system_tool(&env, &["WindowsPowerShell", "v1.0", "powershell.exe"]);
        let args = [
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-EncodedCommand".to_string(),
            self.encoded.clone(),
        ];
        let cwd = windows_system_dir(&env);
        let input = format!("{}\n", dirs.join("\n"));
        let stdout = self.run.run(
            &file,
            &args,
            &ListingRunOptions {
                cwd: &cwd,
                env: &self.env,
                timeout_ms,
                input: &input,
            },
        )?;
        parse_attribute_listing(&stdout, dirs)
    }
}

/// Drive-absolute (`C:\…`) or UNC (`\\server\share\…`); root-relative and relative paths are not
fn is_windows_absolute(path: &str) -> bool {
    js_regex!(r"^[A-Za-z]:[\\/]").test(path)
        || js_regex!(r"^[\\/]{2}[^\\/]+[\\/]+[^\\/]+").test(path)
}

/// Line breaks cannot be carried by the listing protocol (and are not valid in Windows names)
fn has_line_break(path: &str) -> bool {
    js_regex!(r"[\r\n]").test(path)
}

fn lookup_entry(entries: &JsMap<f64>, name: &str) -> Option<f64> {
    if let Some(exact) = entries.get(name) {
        return Some(*exact);
    }
    let folded = name.to_lowercase();
    let mut found: Option<f64> = None;
    let mut matches = 0;
    for (entry, attributes) in entries.iter() {
        if entry.to_lowercase() != folded {
            continue;
        }
        matches += 1;
        found = Some(*attributes);
    }
    if matches == 1 { found } else { None }
}

/// `detectCloudOnlyFiles(paths, options)`: judges each path: 'cloud-only',
/// 'local', or 'unknown' when it could not be told (not Windows, the listing
/// failed or timed out, the file is not in its directory's listing). Every
/// distinct parent directory is listed once, in a single program run for the
/// whole call.
pub fn detect_cloud_only_files(
    paths: &[String],
    options: &DetectOptions<'_>,
    reader: &mut dyn AttributeReader,
) -> JsMap<CloudFileVerdict> {
    let mut out: JsMap<CloudFileVerdict> = JsMap::new();
    for path in paths {
        out.set(path.clone(), CloudFileVerdict::Unknown);
    }
    if options.platform != "win32" {
        return out;
    }

    let mut dirs: Vec<String> = Vec::new();
    let mut dir_by_key: JsMap<String> = JsMap::new();
    let mut wanted: Vec<(String, String, String)> = Vec::new();
    for path in paths {
        if !is_windows_absolute(path) || has_line_break(path) {
            continue;
        }
        let normalized = win32::normalize(path);
        let name = win32::basename(&normalized, None);
        if name.is_empty() {
            continue;
        }
        let parent = win32::dirname(&normalized);
        let key = parent.to_lowercase();
        let dir = match dir_by_key.get(&key) {
            Some(dir) => dir.clone(),
            None => {
                dir_by_key.set(key, parent.clone());
                dirs.push(parent.clone());
                parent
            }
        };
        wanted.push((path.clone(), dir, name));
    }
    if dirs.is_empty() {
        return out;
    }

    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_LISTING_TIMEOUT_MS);
    let Ok(listings) = reader.read(&dirs, timeout_ms) else {
        return out;
    };
    for (path, dir, name) in wanted {
        let Some(Some(entries)) = listings.get(&dir) else {
            continue;
        };
        let Some(attributes) = lookup_entry(entries, &name) else {
            continue;
        };
        out.set(
            path,
            if is_cloud_only_attributes(attributes) {
                CloudFileVerdict::CloudOnly
            } else {
                CloudFileVerdict::Local
            },
        );
    }
    out
}

/// `SyncFolderOptions`
#[derive(Debug, Clone, Copy)]
pub struct SyncFolderOptions<'a> {
    /// `process.platform` where the TypeScript's `platform` is left out
    pub platform: &'a str,
    /// The user's home folder; where it is `None`, `USERPROFILE` on Windows, else `HOME`, else the OS home
    pub home_dir: Option<&'a str>,
    /// `os.homedir()`
    pub os_home_dir: &'a str,
    /// More sync roots found by other means (e.g. a drive found by its volume label)
    pub extra_roots: &'a [String],
}

const ONEDRIVE_ENV_KEYS: [&str; 3] = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];

/// Top-level folders of the Google Drive for desktop streaming drive (any drive
/// letter), in English and Korean. A path whose first folder under a drive root
/// is one of these is taken as being on that drive.
const GOOGLE_DRIVE_STREAM_TOP: [&str; 7] = [
    "my drive",
    "내 드라이브",
    "shared drives",
    "공유 드라이브",
    "other computers",
    "다른 컴퓨터",
    ".shortcut-targets-by-id",
];

/// `pathApi(platform).normalize`
fn normalize_for(platform: &str, path: &str) -> String {
    if platform == "win32" {
        win32::normalize(path)
    } else {
        posix::normalize(path)
    }
}

/// `pathApi(platform).parse(path).root`
fn root_for(platform: &str, path: &str) -> String {
    if platform == "win32" {
        win32::parse(path).root
    } else {
        posix::parse(path).root
    }
}

/// `pathApi(platform).sep`
fn sep_for(platform: &str) -> &'static str {
    if platform == "win32" {
        win32::SEP
    } else {
        posix::SEP
    }
}

fn is_absolute_for(platform: &str, path: &str) -> bool {
    if platform == "win32" {
        is_windows_absolute(path)
    } else {
        posix::is_absolute(path)
    }
}

/// Normalized, without trailing separators (except a root), case-folded where the file system is
fn comparable(platform: &str, path: &str) -> String {
    let mut normalized = normalize_for(platform, path);
    let root = root_for(platform, &normalized);
    // `root` is the start of `normalized`, so the byte lengths order as the UTF-16 lengths
    while normalized.len() > root.len() && normalized.ends_with(['\\', '/']) {
        normalized.pop();
    }
    if platform == "win32" || platform == "darwin" {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn is_inside(platform: &str, path: &str, root: &str) -> bool {
    let p = comparable(platform, path);
    let r = comparable(platform, root);
    if p == r {
        return true;
    }
    let sep = sep_for(platform);
    if r.ends_with(sep) {
        p.starts_with(&r)
    } else {
        p.starts_with(&format!("{r}{sep}"))
    }
}

fn default_home(platform: &str, env: &JsObject<String>, os_home_dir: &str) -> String {
    let profile = if platform == "win32" {
        env.get("USERPROFILE")
    } else {
        env.get("HOME")
    };
    match truthy(profile.map(String::as_str)) {
        Some(profile) if is_absolute_for(platform, profile) => profile.to_string(),
        _ => os_home_dir.to_string(),
    }
}

/// `knownSyncFolders(env, options)`: concrete sync roots: the OneDrive folders
/// named by the environment, and on Windows the Google Drive for desktop mirror
/// folder (`<home>\My Drive`) and the older Backup and Sync folder
/// (`<home>\Google Drive`), plus `extraRoots`. Pattern rules (the Google Drive
/// streaming drive, macOS cloud storage) are not listed here;
/// [`is_under_known_sync_folder`] applies them.
pub fn known_sync_folders(env: &JsObject<String>, options: &SyncFolderOptions<'_>) -> Vec<String> {
    let platform = options.platform;
    let mut candidates: Vec<String> = Vec::new();
    for key in ONEDRIVE_ENV_KEYS {
        if let Some(value) = truthy(env.get(key).map(String::as_str)) {
            candidates.push(value.to_string());
        }
    }
    if platform == "win32" {
        let home = match options.home_dir {
            Some(home) => home.to_string(),
            None => default_home(platform, env, options.os_home_dir),
        };
        if is_absolute_for(platform, &home) {
            candidates.push(win32::join(&[&home, "My Drive"]));
            candidates.push(win32::join(&[&home, "Google Drive"]));
        }
    }
    candidates.extend(options.extra_roots.iter().cloned());

    let mut roots: Vec<String> = Vec::new();
    let mut seen: JsMap<()> = JsMap::new();
    for candidate in candidates {
        if !is_absolute_for(platform, &candidate) {
            continue;
        }
        let key = comparable(platform, &candidate);
        if seen.has(&key) {
            continue;
        }
        seen.set(key, ());
        roots.push(candidate);
    }
    roots
}

/// `isOnGoogleDriveStream(path, platform)`: on the Google Drive for desktop
/// streaming drive (Windows), judged by the path alone
pub fn is_on_google_drive_stream(path: &str, platform: &str) -> bool {
    if platform != "win32" || !js_regex!(r"^[A-Za-z]:[\\/]").test(path) {
        return false;
    }
    let normalized = win32::normalize(path);
    // the path starts with a drive letter, a colon and a separator
    let top = normalized
        .get(3..)
        .and_then(|rest| rest.split('\\').next())
        .unwrap_or("");
    GOOGLE_DRIVE_STREAM_TOP.contains(&top.to_lowercase().as_str())
}

/// macOS: File Provider folders of Google Drive and OneDrive, and the older Google Drive mount
fn is_mac_cloud_storage(path: &str, home: &str) -> bool {
    let p = comparable("darwin", path);
    if js_regex!(r"^\/volumes\/googledrive(-[^/]+)?(\/|$)").test(&p) {
        return true;
    }
    let storage = format!(
        "{}/",
        comparable("darwin", &posix::join(&[home, "Library", "CloudStorage"]))
    );
    if !p.starts_with(&storage) {
        return false;
    }
    let top = p[storage.len()..].split('/').next().unwrap_or("");
    top.starts_with("googledrive-") || top.starts_with("onedrive")
}

/// `isUnderKnownSyncFolder(path, env, options)`: the fallback for PCs where
/// attributes cannot be read: is this path (file or folder) inside a known
/// sync folder? Comparison ignores case on Windows and macOS. Rules: the
/// OneDrive / OneDriveConsumer / OneDriveCommercial folders; Google Drive for
/// desktop's mirror folder and streaming drive on Windows; the Google Drive and
/// OneDrive folders under `~/Library/CloudStorage` and the `/Volumes/GoogleDrive`
/// mount on macOS; `extraRoots`.
pub fn is_under_known_sync_folder(
    path: &str,
    env: &JsObject<String>,
    options: &SyncFolderOptions<'_>,
) -> bool {
    let platform = options.platform;
    if !is_absolute_for(platform, path) {
        return false;
    }
    if known_sync_folders(env, options)
        .iter()
        .any(|root| is_inside(platform, path, root))
    {
        return true;
    }
    if platform == "win32" {
        return is_on_google_drive_stream(path, platform);
    }
    if platform == "darwin" {
        let home = match options.home_dir {
            Some(home) => home.to_string(),
            None => default_home(platform, env, options.os_home_dir),
        };
        return is_mac_cloud_storage(path, &home);
    }
    false
}

/// `DetectOptions & SyncFolderOptions`: the options of [`resolve_cloud_only`]
#[derive(Debug, Clone, Copy)]
pub struct ResolveOptions<'a> {
    pub platform: &'a str,
    pub timeout_ms: Option<f64>,
    pub home_dir: Option<&'a str>,
    pub os_home_dir: &'a str,
    pub extra_roots: &'a [String],
}

/// `resolveCloudOnly(paths, options)`: the decision callers act on: true means
/// "treat as not on this PC" (index the name only, ask before reading).
/// Attributes decide where they could be read; 'unknown' falls back to the
/// sync-folder rule. A 'local' answer on the Google Drive streaming drive is
/// not trusted: that drive is not a cloud-filter provider and may not mark
/// streamed files, so reading could download them. `env` is `options.env ??
/// process.env`.
pub fn resolve_cloud_only(
    paths: &[String],
    env: &JsObject<String>,
    options: &ResolveOptions<'_>,
    reader: &mut dyn AttributeReader,
) -> JsMap<bool> {
    let platform = options.platform;
    let verdicts = detect_cloud_only_files(
        paths,
        &DetectOptions {
            platform,
            timeout_ms: options.timeout_ms,
        },
        reader,
    );
    let sync = SyncFolderOptions {
        platform,
        home_dir: options.home_dir,
        os_home_dir: options.os_home_dir,
        extra_roots: options.extra_roots,
    };
    let mut out: JsMap<bool> = JsMap::new();
    for (path, verdict) in verdicts.iter() {
        if *verdict == CloudFileVerdict::CloudOnly || is_on_google_drive_stream(path, platform) {
            out.set(path, true);
        } else if *verdict == CloudFileVerdict::Local {
            out.set(path, false);
        } else {
            out.set(path, is_under_known_sync_folder(path, env, &sync));
        }
    }
    out
}
