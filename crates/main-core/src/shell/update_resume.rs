//! `apps/shell/src/main/update-resume.ts`: range-resumable installer
//! downloads. `fetch`, the progress callback, the cancellation token, the
//! stock executor and the clock are the [`ResumeEnv`] the caller supplies;
//! the timers become explicit delays the environment reports (a response or a
//! chunk that takes longer than its window is a timeout, as the timer fires).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{
    JsonValue, array_index, base64, json_parse, json_quote, number_to_string, to_number,
};
use sha2::{Digest, Sha512};

use crate::node_fs::{NodeError, node_error, node_error2};

/// progress events are noisier than the stock transform; keep the UI cadence
pub const PROGRESS_INTERVAL_MS: f64 = 250.0;
/// matches the stock httpExecutor's stalled-socket timeout
pub const STALL_TIMEOUT_MS: f64 = 60_000.0;
/// undici's fetch has no timeout and the stall watchdog only arms once a response exists
pub const RESPONSE_TIMEOUT_MS: f64 = 30_000.0;

const RESUME_DIR_NAME: &str = "resume";

/// What `onProgress` is handed
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub total: f64,
    pub delta: f64,
    pub transferred: f64,
    pub percent: f64,
}

/// One read of a response body (`for await (const chunk of streamIn)`).
pub enum BodyRead {
    /// a chunk that arrived `delay_ms` after the previous read
    Chunk { bytes: Vec<u8>, delay_ms: f64 },
    /// the stream failed with an `Error` of this message
    Error { message: String, delay_ms: f64 },
    /// the stream ended
    End { delay_ms: f64 },
}

/// `response.body`
pub trait ResponseBody {
    fn read(&mut self) -> BodyRead;
}

/// The slices of `Response` the wrapper reads.
pub struct FetchResponse {
    /// time until the response arrived
    pub delay_ms: f64,
    pub status: u16,
    /// `headers.get('etag')`
    pub etag: Option<String>,
    /// `headers.get('last-modified')`
    pub last_modified: Option<String>,
    /// `headers.get('content-length')`
    pub content_length: Option<String>,
    /// `null` for a response without a body
    pub body: Option<Box<dyn ResponseBody>>,
}

/// Everything `resumeDownload` reaches outside itself.
pub trait ResumeEnv {
    /// the stock `httpExecutor.download`
    fn fallback(&mut self, url: &str, destination: &str) -> Result<String, String>;
    /// `fetch(url, { headers, ... })`: `Err` is a rejection
    fn fetch(&mut self, url: &str, headers: &[(String, String)]) -> Result<FetchResponse, String>;
    /// `options.cancellationToken?.cancelled`
    fn cancelled(&mut self) -> bool;
    /// `options.onProgress` is set
    fn has_progress(&self) -> bool;
    /// `options.onProgress(info)`
    fn progress(&mut self, info: &Progress);
    /// `Date.now()`
    fn now(&mut self) -> f64;
}

/// `installResumeDownload`: wrap `download` only when the executor has one.
pub fn install_resume_download(executor_has_download_function: bool) -> bool {
    executor_has_download_function
}

/// `resumePaths`
struct PartPaths {
    dir: String,
    part_path: String,
    meta_path: String,
    base: String,
}

fn resume_paths(destination: &str) -> PartPaths {
    let destination_dir = dirname(destination);
    let dir = join(&[&dirname(&destination_dir), RESUME_DIR_NAME]);
    let base = basename(destination, None);
    PartPaths {
        part_path: join(&[&dir, &format!("{base}.part")]),
        meta_path: join(&[&dir, &format!("{base}.part.json")]),
        dir,
        base,
    }
}

/// `PartMeta`
#[derive(Default)]
struct PartMeta {
    if_range: Option<String>,
    sha512: Option<String>,
}

/// `readPart`: anything unproven restarts from byte 0
fn read_part(part_path: &str, meta_path: &str, sha512: &str) -> (u64, PartMeta) {
    let meta = read_part_meta(meta_path);
    if meta.sha512.as_deref() != Some(sha512) {
        // stale part for a different artifact: drop it rather than keep it around
        discard_part(part_path, meta_path);
        return (0, PartMeta::default());
    }
    match fs::metadata(part_path) {
        Ok(stat) => (stat.len(), meta),
        Err(_) => (0, PartMeta::default()),
    }
}

/// `readPartMeta`
fn read_part_meta(meta_path: &str) -> PartMeta {
    let mut meta = PartMeta::default();
    let Ok(bytes) = fs::read(meta_path) else {
        return meta;
    };
    let text = String::from_utf8_lossy(&bytes);
    let Ok(raw) = json_parse(&text) else {
        return meta;
    };
    // `raw && typeof raw === 'object'`
    match &raw {
        JsonValue::Object(object) => {
            if let Some(JsonValue::String(s)) = object.get("sha512") {
                meta.sha512 = Some(s.clone());
            }
            if let Some(JsonValue::String(s)) = object.get("ifRange") {
                meta.if_range = Some(s.clone());
            }
            meta
        }
        _ => meta,
    }
}

/// `writePartMeta`: `writeFile(metaPath, JSON.stringify(meta))`
fn write_part_meta(meta_path: &str, sha512: &str, if_range: Option<&str>) -> Result<(), NodeError> {
    let mut text = format!("{{\"sha512\":{}", json_quote(sha512));
    if let Some(v) = if_range {
        text.push_str(&format!(",\"ifRange\":{}", json_quote(v)));
    }
    text.push('}');
    fs::write(meta_path, text).map_err(|e| node_error(&e, "open", meta_path))
}

/// `pruneOtherParts`: parts of superseded versions
fn prune_other_parts(dir: &str, keep_base: &str) {
    let keep = [
        format!("{keep_base}.part"),
        format!("{keep_base}.part.json"),
    ];
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let Ok(entry) = entry else { return };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name) {
            discard_file(&join(&[dir, &name]));
        }
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `sha512Encoding`: true for 'hex', false for 'base64'
fn sha512_is_hex(sha512: &str) -> bool {
    utf16_len(sha512) == 128
        && !sha512.contains('+')
        && !sha512.contains('Z')
        && !sha512.contains('=')
}

/// `sha512Of`
fn sha512_of(file: &str, hex: bool) -> Result<String, NodeError> {
    let mut input = File::open(file).map_err(|e| node_error(&e, "open", file))?;
    let mut hash = Sha512::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = input
            .read(&mut buffer)
            .map_err(|e| node_error(&e, "read", file))?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    let digest = hash.finalize();
    Ok(if hex {
        digest.iter().map(|b| format!("{b:02x}")).collect()
    } else {
        base64(&digest)
    })
}

/// `DownloadAbortedError`
fn aborted(reason: &str) -> NodeError {
    NodeError {
        code: None,
        message: format!("resumable download aborted: {reason}"),
    }
}

fn plain(message: String) -> NodeError {
    NodeError {
        code: None,
        message,
    }
}

/// Why a request was not placed.
enum RequestError {
    /// the cancellation token fired (a `DownloadAbortedError`)
    Aborted(NodeError),
    /// `RequestFailedError` or a rejected fetch
    Failed,
}

/// `placeRequest`
fn place_request(
    env: &mut dyn ResumeEnv,
    url: &str,
    headers: &[(String, String)],
    timeout_ms: f64,
) -> Result<FetchResponse, RequestError> {
    match env.fetch(url, headers) {
        Ok(response) if response.delay_ms > timeout_ms => Err(RequestError::Failed),
        Ok(response) => Ok(response),
        Err(_) => Err(RequestError::Failed),
    }
}

/// `cancelCheck`
fn cancel_check(env: &mut dyn ResumeEnv) -> Result<(), NodeError> {
    if env.cancelled() {
        return Err(aborted("cancelled"));
    }
    Ok(())
}

/// The `headers` object: `Record<string, string>` in the order JavaScript
/// keeps it (array-index keys first, in numeric order).
fn ordered(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut indexed: Vec<(u32, &(String, String))> = headers
        .iter()
        .filter_map(|h| array_index(&h.0).map(|i| (i, h)))
        .collect();
    indexed.sort_by_key(|(i, _)| *i);
    let mut out: Vec<(String, String)> = indexed.into_iter().map(|(_, h)| h.clone()).collect();
    out.extend(
        headers
            .iter()
            .filter(|h| array_index(&h.0).is_none())
            .cloned(),
    );
    out
}

fn set_header(headers: &mut Vec<(String, String)>, key: &str, value: &str) {
    match headers.iter_mut().find(|h| h.0 == key) {
        Some(h) => h.1 = value.to_string(),
        None => headers.push((key.to_string(), value.to_string())),
    }
}

fn delete_header(headers: &mut Vec<(String, String)>, key: &str) {
    headers.retain(|h| h.0 != key);
}

/// The options of `download`: `sha512` (`None` when absent or null) and
/// `headers` as `Object.entries` lists them (`None` for a non-string value).
pub struct DownloadOptions<'a> {
    pub sha512: Option<&'a str>,
    pub headers: &'a [(String, Option<String>)],
}

/// `resumeDownload`: `Err` is what the promise rejects with.
pub fn resume_download(
    url: &str,
    destination: &str,
    options: &DownloadOptions,
    env: &mut dyn ResumeEnv,
    stall_timeout_ms: f64,
    response_timeout_ms: f64,
) -> Result<String, NodeError> {
    // without a checksum a resumed file cannot be validated: keep stock behaviour
    let expected_sha512 = match options.sha512 {
        Some(s) if !s.is_empty() => s,
        _ => return env.fallback(url, destination).map_err(plain),
    };
    let PartPaths {
        dir,
        part_path,
        meta_path,
        base,
    } = resume_paths(destination);
    let hex = sha512_is_hex(expected_sha512);

    fs::create_dir_all(&dir).map_err(|e| node_error(&e, "mkdir", &dir))?;
    prune_other_parts(&dir, &base);

    let (mut resume_from, meta) = read_part(&part_path, &meta_path, expected_sha512);
    let if_range = meta.if_range;

    let mut headers: Vec<(String, String)> = Vec::new();
    for (key, value) in options.headers {
        if let Some(value) = value {
            set_header(&mut headers, key, value);
        }
    }
    let mut headers = ordered(&headers);

    let first = (|| -> Result<FetchResponse, RequestError> {
        if resume_from > 0 {
            set_header(&mut headers, "Range", &format!("bytes={resume_from}-"));
            // If-Range guarantees the appended bytes belong to the file whose prefix
            // is on disk
            if let Some(v) = if_range.as_deref().filter(|v| !v.is_empty()) {
                set_header(&mut headers, "If-Range", v);
            }
        }
        cancel_check(env).map_err(RequestError::Aborted)?;
        place_request(env, url, &headers, response_timeout_ms)
    })();
    let mut response = match first {
        Ok(r) => r,
        Err(error) => {
            // a cancellation during the wait is a cancellation, not a placement failure
            cancel_check(env)?;
            if let RequestError::Aborted(e) = error {
                return Err(e);
            }
            // the request could not be placed at all: let the stock stack try
            return env.fallback(url, destination).map_err(plain);
        }
    };

    // a stale .part larger than the artifact: wipe and download whole
    if response.status == 416 && resume_from > 0 {
        discard_part(&part_path, &meta_path);
        resume_from = 0;
        delete_header(&mut headers, "Range");
        delete_header(&mut headers, "If-Range");
        let retry = (|| -> Result<FetchResponse, RequestError> {
            cancel_check(env).map_err(RequestError::Aborted)?;
            place_request(env, url, &headers, response_timeout_ms)
        })();
        response = match retry {
            Ok(r) => r,
            Err(error) => {
                cancel_check(env)?;
                if let RequestError::Aborted(e) = error {
                    return Err(e);
                }
                return env.fallback(url, destination).map_err(plain);
            }
        };
    }

    // a proxy 407 / captive-portal 403 lands here; the stock executor handles those
    let ok = (200..=299).contains(&response.status);
    if !ok && response.status != 206 {
        return env.fallback(url, destination).map_err(plain);
    }

    let appending = response.status == 206 && resume_from > 0;
    if !appending {
        resume_from = 0;
    }

    // record the artifact digest and the response validator for the next attempt
    let next_if_range: Option<String> = response
        .etag
        .clone()
        .or_else(|| response.last_modified.clone());
    write_part_meta(
        &meta_path,
        expected_sha512,
        next_if_range.as_deref().filter(|v| !v.is_empty()),
    )?;

    let content_length = to_number(response.content_length.as_deref().unwrap_or("0"));
    let total = resume_from as f64
        + if content_length.is_finite() {
            content_length
        } else {
            0.0
        };
    let mut transferred = resume_from as f64;
    let mut last_progress_at = 0.0f64;
    let mut report_progress =
        |env: &mut dyn ResumeEnv, delta: f64, transferred: f64, force: bool| {
            if !env.has_progress() {
                return;
            }
            let now = env.now();
            if !force && now - last_progress_at < PROGRESS_INTERVAL_MS {
                return;
            }
            last_progress_at = now;
            env.progress(&Progress {
                total,
                delta,
                transferred,
                percent: if total > 0.0 {
                    transferred / total * 100.0
                } else {
                    0.0
                },
            });
        };

    // createWriteStream(partPath, appending ? { flags: 'r+', start: resumeFrom } : {})
    let mut file_out = if appending {
        let mut f = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&part_path)
            .map_err(|e| node_error(&e, "open", &part_path))?;
        f.seek(SeekFrom::Start(resume_from))
            .map_err(|e| node_error(&e, "write", &part_path))?;
        f
    } else {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&part_path)
            .map_err(|e| node_error(&e, "open", &part_path))?
    };

    // the .part stays (what has reached the disk): the next attempt resumes
    let stall_error = || {
        aborted(&format!(
            "download stalled: no data for {} s",
            number_to_string(stall_timeout_ms / 1000.0)
        ))
    };
    let Some(mut body) = response.body.take() else {
        return Err(aborted("empty body"));
    };
    loop {
        match body.read() {
            BodyRead::Chunk { bytes, delay_ms } => {
                if delay_ms > stall_timeout_ms {
                    return Err(stall_error());
                }
                cancel_check(env)?;
                file_out
                    .write_all(&bytes)
                    .map_err(|e| node_error(&e, "write", &part_path))?;
                transferred += bytes.len() as f64;
                report_progress(env, bytes.len() as f64, transferred, false);
            }
            BodyRead::Error { message, delay_ms } => {
                if delay_ms > stall_timeout_ms {
                    return Err(stall_error());
                }
                return Err(plain(message));
            }
            BodyRead::End { delay_ms } => {
                if delay_ms > stall_timeout_ms {
                    return Err(stall_error());
                }
                break;
            }
        }
    }
    cancel_check(env)?;
    drop(file_out);
    report_progress(env, 0.0, transferred, true);

    let actual = sha512_of(&part_path, hex)?;
    if actual != expected_sha512 {
        discard_part(&part_path, &meta_path);
        return Err(plain(format!(
            "sha512 checksum mismatch, expected {expected_sha512}, got {actual} (resumed download discarded)"
        )));
    }
    discard_file(&meta_path);
    fs::rename(&part_path, destination)
        .map_err(|e| node_error2(&e, "rename", &part_path, destination))?;
    Ok(destination.to_string())
}

/// `discardPart`
fn discard_part(part_path: &str, meta_path: &str) {
    discard_file(part_path);
    discard_file(meta_path);
}

/// `discardFile`: already gone is fine, so is every other failure
fn discard_file(file_path: &str) {
    let _ = fs::remove_file(file_path);
}
