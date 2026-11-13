//! `apps/docs/src/main/lazy-media.ts`: the pictures of a large document stay
//! in the file on disk and are served by URL from there; a save swaps the
//! placeholders back for the original bytes.
//!
//! The module's `sources` map is a [`LazyMedia`] value. Electron's `protocol`
//! stays with the caller: it asks [`register_lazy_media_protocol`] whether to
//! register and answers each request as [`LazyMedia::answer`] says. The zip
//! library (`@seuoffice/docx-engine/zip-splice`: `openZipFile`, `slimDocx`,
//! `lazyMediaHashesIn`, `materializeDocx`, `readZipEntries`) is not ported
//! yet; the module calls it through [`ZipLibrary`]. `parseLazyMediaUrl` and
//! `isLazyMediaPart` of `packages/docx-engine/src/lazy-media.ts` are copied
//! here as the two private functions below.
//!
//! One thing of the TypeScript cannot happen here: a file-backed zip's `read`
//! refuses once its source moved to memory meanwhile, which needs a save to
//! land between two awaits of one request.

use std::cell::RefCell;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::rc::Rc;

use flate2::read::DeflateDecoder;
use jscompat::{JsMap, decode_uri_component, js_regex};
use sha2::{Digest, Sha256};

use super::byte_handoff::ByteHandoffs;
use super::lazy_media_inline::LAZY_MEDIA_SCHEME;
use crate::node_fs::{node_error, node_error_fd};
use crate::packages::electron_utils::print_window::JsError;
use crate::packages::electron_utils::renderer_scheme::docx_media_scheme_privilege;
use crate::packages::electron_utils::template_font_response::template_font_response;
use crate::shell::recent_files::StatInfo;

/// documents carrying at least this much browser-decodable media open lazily
const LAZY_MEDIA_MIN_BYTES: u64 = 1024 * 1024;

/// Max lazy-media part path chars served from the source archive.
const MAX_LAZY_PART_CHARS: usize = 512;

/// `ZipEntry`, as far as the module reads one.
#[derive(Debug, Clone, PartialEq)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub csize: u64,
    pub uncompressed_size: u64,
    /// first byte of the (compressed) data inside the archive
    pub data_offset: u64,
}

/// `ByteSource.read(offset, length)`
pub trait ZipRead {
    fn read(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, JsError>;
}

/// The entry table of a zip, shared between the cache and its readers.
pub type ZipEntries = Rc<JsMap<ZipEntry>>;

/// `ZipFile`
pub struct ZipFile {
    pub size: u64,
    pub entries: ZipEntries,
    pub reader: Box<dyn ZipRead>,
}

/// A zip handed around the way the promise of one is.
pub type SharedZip = Rc<RefCell<ZipFile>>;

/// What `materializeDocx` asks for: the zip behind a hash, `None` when there
/// is none. The library passes itself back, since the answer may need it.
pub type ZipSourceOf<'a> =
    dyn FnMut(&mut dyn ZipLibrary, &str) -> Result<Option<SharedZip>, JsError> + 'a;

/// The functions of `@seuoffice/docx-engine/zip-splice` the module calls.
pub trait ZipLibrary {
    /// `openZipFile(path)`
    fn open_zip_file(&mut self, path: &str) -> Result<ZipFile, JsError>;
    /// `zip.close()`
    fn close_zip_file(&mut self, zip: ZipFile);
    /// `readZipEntries(bufferSource(bytes))`
    fn read_zip_entries(&mut self, bytes: &[u8]) -> Result<Vec<ZipEntry>, JsError>;
    /// `slimDocx(zip, hash, minBytes)`: the slim document's bytes, or `None`
    fn slim_docx(
        &mut self,
        zip: &ZipFile,
        hash: &str,
        min_bytes: u64,
    ) -> Result<Option<Vec<u8>>, JsError>;
    /// `lazyMediaHashesIn(bytes)`
    fn lazy_media_hashes_in(&mut self, bytes: &[u8]) -> Result<Vec<String>, JsError>;
    /// `materializeDocx(bytes, getZip)`
    fn materialize_docx(
        &mut self,
        bytes: &[u8],
        get_zip: &mut ZipSourceOf<'_>,
    ) -> Result<Vec<u8>, JsError>;
}

/// `isLazyMediaPart(partPath)`: pictures Chromium decodes itself.
fn is_lazy_media_part(part_path: &str) -> bool {
    js_regex!(
        r"^word\/media\/[\x21-\x7e]+\.(?:png|jpe?g|gif|bmp|webp|svg)$",
        "i"
    )
    .test(part_path)
}

/// `parseLazyMediaUrl(url)`
fn parse_lazy_media_url(url: &str) -> Option<(String, String)> {
    let found = js_regex!(r"^seuoffice-docx-media://([0-9a-f]{64})/(.+)$").exec(url)?;
    let hash = found.get(1)?.to_owned();
    let mut segments: Vec<String> = Vec::new();
    for segment in found.get(2)?.split('/') {
        segments.push(decode_uri_component(segment).ok()?);
    }
    let part_path = segments.join("/");
    if part_path.encode_utf16().count() > MAX_LAZY_PART_CHARS || part_path.contains('\0') {
        return None;
    }
    if part_path.split('/').any(|segment| segment == "..") {
        return None;
    }
    Some((hash, part_path))
}

/// `MIME`
fn mime_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

struct Table {
    size: u64,
    mtime_ms: f64,
    entries: ZipEntries,
}

/// `Source`
struct Source {
    path: String,
    owners: Vec<f64>,
    table: Option<Table>,
    /// the plain document once the file on disk is encrypted and cannot be served
    bytes: Option<Rc<Vec<u8>>>,
    /// entry table parsed from exactly `bytes`
    mem_table: Option<ZipEntries>,
}

struct BytesReader(Rc<Vec<u8>>);

impl ZipRead for BytesReader {
    /// `buf.subarray(offset, offset + length)`
    fn read(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, JsError> {
        let len = self.0.len() as u64;
        let start = offset.min(len);
        let end = offset.saturating_add(length).min(len).max(start);
        Ok(self.0[start as usize..end as usize].to_vec())
    }
}

struct FileReader {
    path: String,
}

impl ZipRead for FileReader {
    /// `readRange(path, offset, length)`
    fn read(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, JsError> {
        let mut file =
            fs::File::open(&self.path).map_err(|e| node_error(&e, "open", &self.path))?;
        let mut buf = vec![0u8; length as usize];
        let mut done = 0usize;
        while (done as u64) < length {
            file.seek(SeekFrom::Start(offset + done as u64))
                .map_err(|e| node_error_fd(&e, "read"))?;
            let read = file
                .read(&mut buf[done..])
                .map_err(|e| node_error_fd(&e, "read"))?;
            if read == 0 {
                return Err(JsError::plain("lazy media: source file truncated"));
            }
            done += read;
        }
        Ok(buf)
    }
}

/// `sha256File(path)`: `Err` is a read stream that failed.
fn sha256_file(path: &str) -> Result<String, JsError> {
    let mut file = fs::File::open(path).map_err(|e| node_error(&e, "open", path))?;
    let mut hash = Sha256::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|e| node_error_fd(&e, "read"))?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The document `openLazyDocx` made slim.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedLazyDocx {
    pub bytes: Vec<u8>,
    pub hash: String,
}

/// What `materializeLazyDocx` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializedDocx {
    pub bytes: Vec<u8>,
    pub hashes: Vec<String>,
}

/// A picture served by URL.
#[derive(Debug, Clone, PartialEq)]
pub struct LazyMediaBody {
    pub body: Vec<u8>,
    pub mime: String,
}

/// The `Response` of the protocol handler.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// `registerLazyMediaProtocol(templateFontsDir)`, up to the `protocol.handle`
/// call: whether the caller registers the handler (`false` when the scheme
/// is already handled). `Err` is the error it throws.
pub fn register_lazy_media_protocol(is_handled: &mut dyn FnMut() -> bool) -> Result<bool, JsError> {
    if docx_media_scheme_privilege().scheme != LAZY_MEDIA_SCHEME {
        return Err(JsError::plain(
            "lazy media scheme privilege registered under another name",
        ));
    }
    Ok(!is_handled())
}

/// `sources`: original-file sha256 to where its media lives.
#[derive(Default)]
pub struct LazyMedia {
    sources: JsMap<Source>,
}

impl LazyMedia {
    pub fn new() -> Self {
        Self::default()
    }

    fn register_source(&mut self, hash: &str, path: &str, wc_id: f64) {
        match self.sources.get_mut(hash) {
            Some(source) => {
                if source.path != path {
                    source.table = None;
                }
                source.path = path.to_owned();
                if !source.owners.contains(&wc_id) {
                    source.owners.push(wc_id);
                }
            }
            None => self.sources.set(
                hash,
                Source {
                    path: path.to_owned(),
                    owners: vec![wc_id],
                    table: None,
                    bytes: None,
                    mem_table: None,
                },
            ),
        }
    }

    /// `openLazyDocx(filePath, wcId)`: the document with its pictures replaced
    /// by placeholders, or `None` when the file should be read whole (small
    /// media, encrypted container, odd zip).
    pub fn open_lazy_docx(
        &mut self,
        lib: &mut dyn ZipLibrary,
        file_path: &str,
        wc_id: f64,
    ) -> Option<OpenedLazyDocx> {
        let zip = lib.open_zip_file(file_path).ok()?;
        let opened = (|| -> Option<OpenedLazyDocx> {
            let mut media = 0u64;
            for entry in zip.entries.values() {
                if is_lazy_media_part(&entry.name) {
                    media += entry.uncompressed_size;
                }
            }
            if media < LAZY_MEDIA_MIN_BYTES {
                return None;
            }
            let hash = sha256_file(file_path).ok()?;
            let slim = lib.slim_docx(&zip, &hash, LAZY_MEDIA_MIN_BYTES).ok()??;
            self.register_source(&hash, file_path, wc_id);
            Some(OpenedLazyDocx { bytes: slim, hash })
        })();
        lib.close_zip_file(zip);
        opened
    }

    /// `adoptLazyMediaHashes(bytes, filePath, wcId)`: a recovery copy names
    /// the hash its placeholders were cut under.
    pub fn adopt_lazy_media_hashes(
        &mut self,
        lib: &mut dyn ZipLibrary,
        bytes: &[u8],
        file_path: &str,
        wc_id: f64,
    ) {
        // not a plain zip: nothing lazy in it
        if let Ok(hashes) = lib.lazy_media_hashes_in(bytes) {
            for hash in hashes {
                self.register_source(&hash, file_path, wc_id);
            }
        }
    }

    /// `moveLazyMediaSource(oldPath, newPath)`: the file behind these pictures
    /// moved on disk.
    pub fn move_lazy_media_source(&mut self, old_path: &str, new_path: &str) {
        for source in self.sources.values_mut() {
            if source.path != old_path {
                continue;
            }
            source.path = new_path.to_owned();
            source.table = None;
        }
    }

    /// `forgetLazyMediaOwner(wcId)`
    pub fn forget_lazy_media_owner(&mut self, wc_id: f64) {
        for source in self.sources.values_mut() {
            source.owners.retain(|owner| *owner != wc_id);
        }
        let gone: Vec<String> = self
            .sources
            .iter()
            .filter(|(_, source)| source.owners.is_empty())
            .map(|(hash, _)| hash.to_owned())
            .collect();
        for hash in gone {
            self.sources.delete(&hash);
        }
    }

    /// `entriesOf(source)`: `None` when the source file is gone.
    fn entries_of(
        &mut self,
        lib: &mut dyn ZipLibrary,
        hash: &str,
    ) -> Result<Option<ZipEntries>, JsError> {
        let Some(source) = self.sources.get(hash) else {
            return Ok(None);
        };
        let path = source.path.clone();
        let Ok(meta) = fs::metadata(&path) else {
            return Ok(None);
        };
        let info = StatInfo::of(&meta);
        if let Some(table) = &source.table {
            if table.size == info.size && table.mtime_ms == info.mtime_ms {
                return Ok(Some(Rc::clone(&table.entries)));
            }
        }
        let zip = lib.open_zip_file(&path)?;
        let entries = Rc::clone(&zip.entries);
        // an encrypted save may have switched the source to memory meanwhile
        if let Some(source) = self.sources.get_mut(hash) {
            if source.bytes.is_none() {
                source.table = Some(Table {
                    size: info.size,
                    mtime_ms: info.mtime_ms,
                    entries: Rc::clone(&entries),
                });
            }
        }
        lib.close_zip_file(zip);
        Ok(Some(entries))
    }

    /// `sourceZip(hash)`
    fn source_zip(
        &mut self,
        lib: &mut dyn ZipLibrary,
        hash: &str,
    ) -> Result<Option<SharedZip>, JsError> {
        if let Some(bytes) = self.sources.get(hash).and_then(|s| s.bytes.clone()) {
            let cached = self.sources.get(hash).and_then(|s| s.mem_table.clone());
            let entries = match cached {
                Some(entries) => entries,
                None => {
                    let mut table = JsMap::new();
                    for entry in lib.read_zip_entries(&bytes)? {
                        table.set(entry.name.clone(), entry);
                    }
                    let table = Rc::new(table);
                    if let Some(source) = self.sources.get_mut(hash) {
                        source.mem_table = Some(Rc::clone(&table));
                    }
                    table
                }
            };
            return Ok(Some(Rc::new(RefCell::new(ZipFile {
                size: bytes.len() as u64,
                entries,
                reader: Box::new(BytesReader(bytes)),
            }))));
        }
        let has_source = self.sources.has(hash);
        let entries = if has_source {
            self.entries_of(lib, hash)?
        } else {
            None
        };
        let (true, Some(entries)) = (has_source, entries) else {
            return Ok(None);
        };
        let path = self
            .sources
            .get(hash)
            .map(|s| s.path.clone())
            .unwrap_or_default();
        let size = fs::metadata(&path)
            .map_err(|e| node_error(&e, "stat", &path))?
            .len();
        Ok(Some(Rc::new(RefCell::new(ZipFile {
            size,
            entries,
            reader: Box::new(FileReader { path }),
        }))))
    }

    /// `materializeLazyDocx(bytes)`: saved bytes with lazy placeholders
    /// swapped back for the original media, plus the hashes those
    /// placeholders named.
    pub fn materialize_lazy_docx(
        &mut self,
        lib: &mut dyn ZipLibrary,
        bytes: &[u8],
    ) -> Result<MaterializedDocx, JsError> {
        let mut hashes: Vec<String> = Vec::new();
        for hash in lib.lazy_media_hashes_in(bytes).unwrap_or_default() {
            if !hashes.contains(&hash) {
                hashes.push(hash);
            }
        }
        if hashes.is_empty() {
            return Ok(MaterializedDocx {
                bytes: bytes.to_vec(),
                hashes,
            });
        }
        let mut opened: JsMap<Result<Option<SharedZip>, JsError>> = JsMap::new();
        let full = lib.materialize_docx(bytes, &mut |lib, hash| {
            if opened.get(hash).is_none() {
                let zip = self.source_zip(lib, hash);
                opened.set(hash, zip);
            }
            match opened.get(hash) {
                Some(Ok(zip)) => Ok(zip.clone()),
                Some(Err(error)) => Err(error.clone()),
                None => Ok(None),
            }
        })?;
        Ok(MaterializedDocx {
            bytes: full,
            hashes,
        })
    }

    /// `pointLazyMediaAt(hashes, filePath, wcId, plain)`: after a save landed
    /// a full copy at `filePath`, serve those hashes from it; an encrypted
    /// save passes the plain bytes instead.
    pub fn point_lazy_media_at(
        &mut self,
        hashes: &[String],
        file_path: &str,
        wc_id: f64,
        plain: Option<&[u8]>,
    ) {
        for hash in hashes {
            self.register_source(hash, file_path, wc_id);
            if let Some(source) = self.sources.get_mut(hash) {
                source.bytes = plain.map(|bytes| Rc::new(bytes.to_vec()));
                source.table = None;
                source.mem_table = None;
            }
        }
    }

    /// `readLazyMedia(url)`: the picture behind a lazy URL, or `None` when it
    /// is not served (any more).
    pub fn read_lazy_media(
        &mut self,
        lib: &mut dyn ZipLibrary,
        url: &str,
    ) -> Result<Option<LazyMediaBody>, JsError> {
        let Some((hash, part_path)) = parse_lazy_media_url(url) else {
            return Ok(None);
        };
        if !is_lazy_media_part(&part_path) {
            return Ok(None);
        }
        let zip = self.source_zip(lib, &hash)?;
        let Some(zip) = zip else {
            return Ok(None);
        };
        let entry = zip.borrow().entries.get(&part_path).cloned();
        let Some(entry) = entry else {
            return Ok(None);
        };
        if entry.method != 0 && entry.method != 8 {
            return Ok(None);
        }
        let raw = zip
            .borrow_mut()
            .reader
            .read(entry.data_offset, entry.csize)?;
        let ext = part_path.rsplit('.').next().unwrap_or("").to_lowercase();
        let body = if entry.method == 0 {
            raw
        } else {
            // `inflateRawSync(raw)`
            let mut out = Vec::new();
            DeflateDecoder::new(raw.as_slice())
                .read_to_end(&mut out)
                .map_err(|e| JsError::plain(e.to_string()))?;
            out
        };
        Ok(Some(LazyMediaBody {
            body,
            mime: mime_of(&ext)
                .unwrap_or("application/octet-stream")
                .to_owned(),
        }))
    }

    /// The handler `registerLazyMediaProtocol` installs, for one request URL:
    /// a handed-off buffer, a template font, a picture, else 404.
    pub fn answer(
        &mut self,
        lib: &mut dyn ZipLibrary,
        handoffs: &mut ByteHandoffs<Vec<u8>>,
        url: &str,
        template_fonts_dir: &str,
    ) -> Result<MediaAnswer, JsError> {
        if let Some(handed) = handoffs.take_handoff(url) {
            return Ok(MediaAnswer {
                status: 200,
                headers: vec![
                    (
                        "Content-Type".to_owned(),
                        "application/octet-stream".to_owned(),
                    ),
                    ("Content-Length".to_owned(), handed.len().to_string()),
                    ("Access-Control-Allow-Origin".to_owned(), "*".to_owned()),
                ],
                body: handed,
            });
        }
        if let Some(font) = template_font_response(url, template_fonts_dir, &mut |path| {
            fs::read(path).map_err(|_| ())
        }) {
            return Ok(MediaAnswer {
                status: font.status,
                headers: font.headers,
                body: font.body,
            });
        }
        match self.read_lazy_media(lib, url)? {
            None => Ok(MediaAnswer {
                status: 404,
                headers: Vec::new(),
                body: Vec::new(),
            }),
            Some(media) => Ok(MediaAnswer {
                status: 200,
                headers: vec![("Content-Type".to_owned(), media.mime)],
                body: media.body,
            }),
        }
    }
}
