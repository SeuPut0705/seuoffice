//! `apps/shell/src/main/drive/drive-ai.ts`: what the editors' AI gets from
//! Drive (decision 0033): a search that lists files, and a paged read of one
//! file's text. A read downloads the file to a private temporary folder,
//! parses it with `parseFileToText` (so parts hidden from AI stay hidden,
//! decision 0016) and deletes the download. Parsed text is kept in memory for
//! a few minutes so paging does not download again.
//!
//! Every call blocks (network, disk, the parser): run it on a worker.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use jscompat::trim;

use super::client::{
    DriveClientHost, DriveError, DriveFile, FOLDER_MIME, Listing, MAX_READ_BYTES, OpenPlan,
};
use super::host::DriveShellHost;
use super::util::{Clock, slice_units, slice_utf16, system_clock};

pub const DRIVE_READ_CHUNK_CHARS: usize = 24_000;
const TEXT_CACHE_MS: u64 = 10 * 60 * 1000;
const TEXT_CACHE_MAX: usize = 4;

/// `ERROR_TEXT`: what the model reads; English, short, no file content
pub fn drive_error_text(error: DriveError) -> &'static str {
    match error {
        DriveError::NotConnected => "Google Drive is not connected.",
        DriveError::NotFound => "No such Drive file, or this account cannot see it.",
        DriveError::Forbidden => "This account may not download that Drive file.",
        DriveError::TooLarge => "The Drive file is too large to read here.",
        DriveError::RateLimit => "Google Drive asked to slow down; try again shortly.",
        DriveError::Network => "Google Drive could not be reached.",
    }
}

const UNSUPPORTED: &str = "That kind of Drive file cannot be read as text.";
const UNREADABLE: &str = "The Drive file could not be read as text.";
const FOLDER: &str = "That is a folder; search inside it with drive_search instead.";

/// `entryType(file)`: the kind a screen shows a file as
pub fn entry_type(client: &DriveClientHost, name: &str, mime_type: &str) -> &'static str {
    if mime_type == FOLDER_MIME {
        return "folder";
    }
    let (OpenPlan::Download { extension } | OpenPlan::Export { extension, .. }) =
        client.open_plan(name, mime_type)
    else {
        return "other";
    };
    match extension.as_str() {
        ".docx" => "document",
        ".xlsx" | ".xlsm" | ".xls" | ".csv" | ".tsv" => "spreadsheet",
        ".pptx" => "presentation",
        ".pdf" => "pdf",
        ".md" | ".markdown" | ".txt" | ".json" => "markdown",
        ".html" | ".htm" => "html",
        ".xmind" => "mindmap",
        ".hwp" | ".hwpx" => "hwp",
        ".epub" => "epub",
        ".drawio" | ".dio" => "diagram",
        _ => "other",
    }
}

/// `AiResult<T>`: the error is the text the model reads
pub type AiResult<T> = Result<T, String>;

/// One hit of `search`
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub modified: String,
}

/// One page of `read`
#[derive(Clone, Debug, PartialEq)]
pub struct ReadPage {
    pub name: String,
    pub text: String,
    pub total_chars: usize,
    pub offset: usize,
}

struct CachedText {
    version: String,
    name: String,
    /// UTF-16 units: the TypeScript pages by `String.prototype.slice`
    text: Arc<Vec<u16>>,
    at: u64,
}

pub struct DriveAi {
    client: DriveClientHost,
    shell: DriveShellHost,
    now: Clock,
    /// a `Map` in insertion order: a replaced key keeps its place
    texts: Mutex<Vec<(String, CachedText)>>,
}

impl DriveAi {
    pub fn new(client: DriveClientHost, shell: DriveShellHost) -> Self {
        Self::with_clock(client, shell, system_clock())
    }

    pub fn with_clock(client: DriveClientHost, shell: DriveShellHost, now: Clock) -> Self {
        DriveAi {
            client,
            shell,
            now,
            texts: Mutex::new(Vec::new()),
        }
    }

    pub fn search(&self, query: &str, limit: usize) -> AiResult<Vec<SearchHit>> {
        let text = slice_utf16(trim(query), 0, 200);
        if text.is_empty() {
            return Err("query must not be empty".into());
        }
        let page = self
            .client
            .list(&Listing::Search(text), None, Some(limit as u32))
            .map_err(|e| drive_error_text(e).to_owned())?;
        Ok(page
            .files
            .iter()
            .take(limit)
            .map(|f| SearchHit {
                id: f.id.clone(),
                name: f.name.clone(),
                kind: entry_type(&self.client, &f.name, &f.mime_type),
                modified: f.modified_time.clone(),
            })
            .collect())
    }

    /// `offset` as `Number(raw.offset) || 0`: a number that is not finite
    /// reads from the start
    pub fn read(&self, file_id: &str, offset: f64) -> AiResult<ReadPage> {
        let (name, text) = self.text(file_id)?;
        let start = if offset.is_finite() {
            offset.floor().max(0.0) as usize
        } else {
            0
        };
        Ok(ReadPage {
            name,
            text: slice_units(&text, start, start.saturating_add(DRIVE_READ_CHUNK_CHARS)),
            total_chars: text.len(),
            offset: start,
        })
    }

    fn file_of(&self, id: &str) -> AiResult<DriveFile> {
        let file = self
            .client
            .file(id)
            .map_err(|e| drive_error_text(e).to_owned())?;
        match &file.shortcut_target {
            Some(target) => self
                .client
                .file(&target.id)
                .map_err(|e| drive_error_text(e).to_owned()),
            None => Ok(file),
        }
    }

    fn text(&self, file_id: &str) -> AiResult<(String, Arc<Vec<u16>>)> {
        let file = self.file_of(file_id)?;
        if file.mime_type == FOLDER_MIME {
            return Err(FOLDER.into());
        }
        let version = format!(
            "{}|{}",
            file.md5_checksum.as_deref().unwrap_or(""),
            file.modified_time
        );
        let now = (self.now)();
        if let Some((_, cached)) = self
            .texts
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _)| *id == file.id)
            && cached.version == version
            && now.saturating_sub(cached.at) < TEXT_CACHE_MS
        {
            return Ok((cached.name.clone(), cached.text.clone()));
        }
        let plan = self.client.open_plan(&file.name, &file.mime_type);
        let (extension, got) = match &plan {
            OpenPlan::None => return Err(UNSUPPORTED.into()),
            OpenPlan::Export { mime, extension } => (
                extension,
                self.client.export(&file.id, mime, MAX_READ_BYTES),
            ),
            OpenPlan::Download { extension } => {
                (extension, self.client.download(&file.id, MAX_READ_BYTES))
            }
        };
        let bytes = got.map_err(|e| drive_error_text(e).to_owned())?;

        // the download lives only as long as the parse
        let dir = make_temp_dir("seuoffice-drive-").map_err(|_| UNREADABLE.to_owned())?;
        let parsed = (|| {
            let path = dir.join(self.client.local_file_name(&file.name, extension));
            fs::write(&path, &bytes).ok()?;
            let parsed = self.shell.parse_file_to_text(&path);
            match (parsed.ok, parsed.kind.as_deref(), parsed.text) {
                (true, Some("text"), Some(text)) => Some(text),
                _ => None,
            }
        })();
        let _ = fs::remove_dir_all(&dir);
        let text = Arc::new(
            parsed
                .ok_or_else(|| UNREADABLE.to_owned())?
                .encode_utf16()
                .collect::<Vec<u16>>(),
        );

        let mut texts = self.texts.lock().unwrap();
        let entry = CachedText {
            version,
            name: file.name.clone(),
            text: text.clone(),
            at: (self.now)(),
        };
        match texts.iter_mut().find(|(id, _)| *id == file.id) {
            Some(slot) => slot.1 = entry,
            None => texts.push((file.id.clone(), entry)),
        }
        while texts.len() > TEXT_CACHE_MAX {
            texts.remove(0);
        }
        Ok((file.name, text))
    }

    /// Forget everything read (on disconnect)
    pub fn clear(&self) {
        self.texts.lock().unwrap().clear();
    }
}

/// `mkdtemp(join(tmpdir(), prefix))`: a new folder only this process made
pub fn make_temp_dir(prefix: &str) -> std::io::Result<PathBuf> {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    loop {
        let mut random = [0u8; 6];
        getrandom::fill(&mut random).map_err(std::io::Error::other)?;
        let suffix: String = random
            .iter()
            .map(|b| CHARS[*b as usize % CHARS.len()] as char)
            .collect();
        let dir = std::env::temp_dir().join(format!("{prefix}{suffix}"));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::super::testing::{FakeClient, FakeShell};
    use super::*;

    const T1: &str = "2026-01-02T00:00:00Z";

    fn rig() -> (Arc<FakeClient>, Arc<FakeShell>, Arc<AtomicU64>, DriveAi) {
        let client = FakeClient::new();
        client.connect_as("Dana");
        let shell = FakeShell::new();
        let clock = Arc::new(AtomicU64::new(1_000));
        let now = clock.clone();
        let ai = DriveAi::with_clock(
            client.clone(),
            shell.clone(),
            Arc::new(move || now.load(Ordering::SeqCst)),
        );
        (client, shell, clock, ai)
    }

    #[test]
    fn parsed_text_is_kept_for_ten_minutes_and_only_while_the_file_is_unchanged() {
        let (client, _, clock, ai) = rig();
        client.add("f1", "a.docx", "application/x", T1, b"v1");
        ai.read("f1", 0.0).unwrap();
        ai.read("f1", 0.0).unwrap();
        assert_eq!(client.downloads.load(Ordering::SeqCst), 1);

        client.change("f1", b"v2", "2026-01-09T00:00:00Z");
        ai.read("f1", 0.0).unwrap();
        assert_eq!(
            client.downloads.load(Ordering::SeqCst),
            2,
            "the file changed"
        );

        clock.fetch_add(10 * 60 * 1000 - 1, Ordering::SeqCst);
        ai.read("f1", 0.0).unwrap();
        assert_eq!(client.downloads.load(Ordering::SeqCst), 2);
        clock.fetch_add(1, Ordering::SeqCst);
        ai.read("f1", 0.0).unwrap();
        assert_eq!(
            client.downloads.load(Ordering::SeqCst),
            3,
            "ten minutes passed"
        );
    }

    #[test]
    fn only_the_four_newest_texts_are_kept() {
        let (client, _, _, ai) = rig();
        for id in ["f1", "f2", "f3", "f4", "f5"] {
            client.add(
                id,
                &format!("{id}.docx"),
                "application/x",
                T1,
                id.as_bytes(),
            );
            ai.read(id, 0.0).unwrap();
        }
        assert_eq!(client.downloads.load(Ordering::SeqCst), 5);
        ai.read("f5", 0.0).unwrap();
        ai.read("f2", 0.0).unwrap();
        assert_eq!(
            client.downloads.load(Ordering::SeqCst),
            5,
            "the last four are cached"
        );
        ai.read("f1", 0.0).unwrap();
        assert_eq!(
            client.downloads.load(Ordering::SeqCst),
            6,
            "the oldest was dropped"
        );
    }

    #[test]
    fn a_shortcut_reads_its_target_and_an_offset_that_is_not_a_position_starts_over() {
        let (client, shell, _, ai) = rig();
        client.add("real", "real.docx", "application/x", T1, b"x");
        let mut link = client.add(
            "link",
            "link.docx",
            "application/vnd.google-apps.shortcut",
            T1,
            b"",
        );
        link.shortcut_target = Some(crate::drive::client::ShortcutTarget {
            id: "real".into(),
            mime_type: "application/x".into(),
        });
        client.files.lock().unwrap().get_mut("link").unwrap().0 = link;
        shell.parsed.lock().unwrap().text = Some("0123456789".into());
        let page = ai.read("link", 0.0).unwrap();
        assert_eq!(page.name, "real.docx");
        for offset in [f64::INFINITY, f64::NEG_INFINITY, -5.0] {
            assert_eq!(ai.read("link", offset).unwrap().offset, 0, "{offset}");
        }
        let page = ai.read("link", 4.9).unwrap();
        assert_eq!(
            (page.offset, page.text.as_str(), page.total_chars),
            (4, "456789", 10)
        );
        let past = ai.read("link", 99.0).unwrap();
        assert_eq!((past.text.as_str(), past.total_chars), ("", 10));
    }

    #[test]
    fn a_search_is_trimmed_capped_and_needs_words() {
        let (client, _, _, ai) = rig();
        assert_eq!(ai.search("  \t ", 5), Err("query must not be empty".into()));
        assert!(client.lists.lock().unwrap().is_empty());
        let _ = ai.search(&format!(" {} ", "x".repeat(300)), 5);
        let lists = client.lists.lock().unwrap().clone();
        assert_eq!(
            lists,
            vec![(Listing::Search("x".repeat(200)), None, Some(5))]
        );
    }
}
