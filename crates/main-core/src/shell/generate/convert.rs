//! `apps/shell/src/main/generate/convert.ts`: conversions without AI (8.6):
//! one material of a fixed type becomes a new document, with no AI and no
//! plan usage anywhere on the way.
//!
//! The source is read ONLY through the redaction-aware reader
//! ([`FileParser`]); a mark the reader cannot process fails the read, and then
//! nothing is converted and the reason is shown. The engines the conversions
//! stand on are not held by this crate (`@seuoffice/file-parse`,
//! `@seuoffice/xmind-engine`, `@seuoffice/pptx-engine`, `@seuoffice/pptx-ops`,
//! and the outline reader of `apps/shell/src/main/mcp/pptx-outline.ts`):
//! [`ConvertEngines`] is the seam, and the judgment around them is here.
//! Promises are plain calls; a rejection is a [`Failure`].

use encoding_rs::{UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1252};
use jscompat::{js_regex, trim};

use super::generate_api::{ConvertKind, ConvertProblem, convert_target};
use super::materials::{FileParser, FileStat};
use crate::packages::electron_utils::generate_handoff::GenerateConvertTarget;
use crate::shell::renderer_disposal::Failure;

/// What a conversion hands to the new tab.
#[derive(Debug, Clone, PartialEq)]
pub enum ConvertedContent {
    /// markdown text for a new markdown tab
    MindmapToMarkdown { markdown: String },
    /// a whole new deck (blank deck + the outline's ops), for a new slides tab
    MindmapToSlides { deck: Vec<u8>, slide_count: usize },
    /// outline text the map editor reads into a new map
    MarkdownToMindmap { outline: String },
}

impl ConvertedContent {
    pub fn kind(&self) -> ConvertKind {
        match self {
            ConvertedContent::MindmapToMarkdown { .. } => ConvertKind::MindmapToMarkdown,
            ConvertedContent::MindmapToSlides { .. } => ConvertKind::MindmapToSlides,
            ConvertedContent::MarkdownToMindmap { .. } => ConvertKind::MarkdownToMindmap,
        }
    }

    /// `content.target`: the editor the result opens in
    pub fn target(&self) -> GenerateConvertTarget {
        convert_target(self.kind())
    }
}

/// What "make" opens for a conversion: the content, and where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct ConvertedDocument {
    /// unique per press of "make"
    pub id: String,
    pub content: ConvertedContent,
    /// the one material read
    pub sources: Vec<String>,
    pub created_at: f64,
}

pub type ConvertResult = Result<ConvertedContent, ConvertProblem>;

/// a topic of the map engine, the parts this module reads
#[derive(Debug, Clone, PartialEq, Default)]
pub struct XmindTopic {
    /// absent when the title is not a string
    pub title: Option<String>,
    /// `children.attached` when it is an array, else empty
    pub attached: Vec<XmindTopic>,
}

/// What `runTxn(opened, { ops: [op], isolation: 'atomic' })` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct OpOutcome {
    pub applied: bool,
    /// `result.failures?.[0]?.error`
    pub first_failure_error: Option<String>,
}

/// The engines of the conversions. Each call may throw: a [`Failure`].
pub trait ConvertEngines: FileParser {
    /// the slides `parsePptxOutline('markdown', ...)` makes
    type Slides;
    /// one op of `@seuoffice/pptx-ops`
    type Op;
    /// the opened deck
    type Deck;

    /// `OUTLINE_KIND_MARKS.boundary` and `OUTLINE_KIND_MARKS.relationship`
    fn not_topic_marks(&self) -> [String; 2];
    /// `outlineToSheets(outline, { untitled })[0].rootTopic`
    fn first_sheet_root(&mut self, outline: &str, untitled: &str) -> Result<XmindTopic, Failure>;
    /// `createXmindDocumentFromOutline(text, { untitled })`
    fn create_xmind_document_from_outline(
        &mut self,
        text: &str,
        untitled: &str,
    ) -> Result<(), Failure>;
    /// `parsePptxOutline('markdown', text)`
    fn parse_markdown_outline(&mut self, markdown: &str) -> Result<Self::Slides, Failure>;
    /// `slides.length`
    fn slide_count(&self, slides: &Self::Slides) -> usize;
    /// `MAX_OUTLINE_SLIDES`
    fn max_outline_slides(&self) -> usize;
    /// `outlineToOps(slides)`
    fn outline_to_ops(&mut self, slides: &Self::Slides) -> Result<Vec<Self::Op>, Failure>;
    /// `openPptx(await createBlankPptx())`
    fn open_blank_deck(&mut self) -> Result<Self::Deck, Failure>;
    /// `runTxn(opened, { ops: [op], isolation: 'atomic' })`
    fn apply_op(&mut self, deck: &mut Self::Deck, op: &Self::Op) -> Result<OpOutcome, Failure>;
    /// `op.op`
    fn op_name(&self, op: &Self::Op) -> String;
    /// `savePptx(opened)`
    fn save_deck(&mut self, deck: Self::Deck) -> Result<Vec<u8>, Failure>;
}

/// `parseFileToText`'s message for a mark it could not process (RedactionMarkError)
const REDACTION_FAILURE: &str = "Redaction marks in this file could not be processed";

/// Read the source through the redaction-aware reader; never a partial read.
fn read_source<E: ConvertEngines>(engines: &mut E, path: &str) -> Result<String, ConvertProblem> {
    let parsed = match engines.parse_file_to_text(path) {
        Ok(parsed) => parsed,
        Err(_) => return Err(ConvertProblem::Unreadable),
    };
    if !parsed.ok {
        // `REDACTION_FAILURE.test(parsed.error ?? '')`
        return Err(
            if parsed
                .error
                .as_deref()
                .unwrap_or("")
                .starts_with(REDACTION_FAILURE)
            {
                ConvertProblem::Redaction
            } else {
                ConvertProblem::Unreadable
            },
        );
    }
    match (parsed.kind.as_deref(), parsed.text) {
        (Some("text"), Some(text)) => Ok(text),
        _ => Err(ConvertProblem::Unreadable),
    }
}

/// Why a conversion stopped
enum Stop {
    TooManySlides,
    Failed,
}

impl From<Failure> for Stop {
    fn from(_: Failure) -> Self {
        Stop::Failed
    }
}

fn build_content<E: ConvertEngines>(
    engines: &mut E,
    kind: ConvertKind,
    text: String,
    untitled: &str,
) -> Result<ConvertedContent, Stop> {
    match kind {
        ConvertKind::MindmapToMarkdown => {
            Ok(ConvertedContent::MindmapToMarkdown { markdown: text })
        }
        ConvertKind::MindmapToSlides => {
            let slides = map_outline_to_slides(engines, &text, untitled)?;
            let slide_count = engines.slide_count(&slides);
            if slide_count > engines.max_outline_slides() {
                return Err(Stop::TooManySlides);
            }
            let ops = engines.outline_to_ops(&slides)?;
            let deck = build_deck(engines, &ops)?;
            Ok(ConvertedContent::MindmapToSlides { deck, slide_count })
        }
        ConvertKind::MarkdownToMindmap => {
            // the map editor builds the map from this text; building it here first
            // means a text the engine cannot take never opens a tab
            engines.create_xmind_document_from_outline(&text, untitled)?;
            Ok(ConvertedContent::MarkdownToMindmap { outline: text })
        }
    }
}

/// Run one conversion. Nothing opens here; the caller opens the new tab with the content.
pub fn convert_source<E: ConvertEngines>(
    engines: &mut E,
    kind: ConvertKind,
    path: &str,
    untitled: &str,
) -> ConvertResult {
    let text = read_source(engines, path)?;
    match build_content(engines, kind, text, untitled) {
        Ok(content) => Ok(content),
        Err(Stop::TooManySlides) => Err(ConvertProblem::TooManySlides),
        Err(Stop::Failed) => Err(ConvertProblem::Failed),
    }
}

// ---- map to PPT skeleton ----

/// The outline as the map editor's outline text, back into a tree with the
/// engine's reader. Boundary titles and relationship texts are left out
/// first: they say something about topics but are none.
fn first_sheet_root<E: ConvertEngines>(
    engines: &mut E,
    outline: &str,
    untitled: &str,
) -> Result<XmindTopic, Failure> {
    let not_topic = engines.not_topic_marks();
    let item_re = js_regex!(r"^[ ]*- (.*)$", "");
    let kept: Vec<&str> = outline
        .split('\n')
        .filter(|line| match item_re.exec(line) {
            None => true,
            Some(item) => {
                let text = item.get(1).unwrap_or("");
                !not_topic
                    .iter()
                    .any(|mark| text.starts_with(&format!("{mark} ")))
            }
        })
        .collect();
    engines.first_sheet_root(&kept.join("\n"), untitled)
}

fn title_of(topic: &XmindTopic) -> String {
    match &topic.title {
        Some(title) => {
            trim(&js_regex!(r"\s+", "g").replace_all(title, |_| " ".to_owned())).to_owned()
        }
        None => String::new(),
    }
}

/// The slides of the map's first sheet, in the form the outline to slides
/// parser reads: `# ` starts a slide (the central topic, then each main
/// branch) and `- ` lines two spaces deeper per level are its bullets.
pub fn map_outline_to_slides_markdown<E: ConvertEngines>(
    engines: &mut E,
    outline: &str,
    untitled: &str,
) -> Result<String, Failure> {
    let root = first_sheet_root(engines, outline, untitled)?;
    let mut lines: Vec<String> = vec![format!("# {}", title_of(&root))];
    for branch in &root.attached {
        lines.push(String::new());
        lines.push(format!("# {}", title_of(branch)));
        // depth-first without recursion; the engine bounds the depth anyway
        let mut pending: Vec<(&XmindTopic, usize)> = branch
            .attached
            .iter()
            .map(|topic| (topic, 0))
            .rev()
            .collect();
        while let Some((topic, level)) = pending.pop() {
            lines.push(format!("{}- {}", "  ".repeat(level), title_of(topic)));
            for below in topic.attached.iter().rev() {
                pending.push((below, level + 1));
            }
        }
    }
    Ok(format!("{}\n", lines.join("\n")))
}

/// The slides the existing outline parser makes of the map's first sheet.
pub fn map_outline_to_slides<E: ConvertEngines>(
    engines: &mut E,
    outline: &str,
    untitled: &str,
) -> Result<E::Slides, Failure> {
    let markdown = map_outline_to_slides_markdown(engines, outline, untitled)?;
    engines.parse_markdown_outline(&markdown)
}

/// A new deck: the blank deck with the ops applied one at a time (the
/// executor checks a batch against the deck before it, so a slide added
/// earlier in the list would not exist yet for later ops). Throws when an op
/// does not apply.
pub fn build_deck<E: ConvertEngines>(engines: &mut E, ops: &[E::Op]) -> Result<Vec<u8>, Failure> {
    let mut opened = engines.open_blank_deck()?;
    for op in ops {
        let result = engines.apply_op(&mut opened, op)?;
        if !result.applied {
            return Err(Failure(match result.first_failure_error {
                Some(error) => error,
                None => format!("{} did not apply", engines.op_name(op)),
            }));
        }
    }
    engines.save_deck(opened)
}

// ---- the notice for a markdown source with withheld spans ----

/// The file's own text, decoded the way the reader decodes a text file.
fn decode_text(bytes: &[u8]) -> Option<String> {
    let at = |i: usize| bytes.get(i).copied();
    // UTF-32BE (00 00 FE FF) is not UTF-16BE (FE FF) and must not fall through
    // to UTF-8 / windows-1252. UTF-32LE is the UTF-16LE BOM plus two NULs.
    if at(0) == Some(0) && at(1) == Some(0) && at(2) == Some(0xfe) && at(3) == Some(0xff) {
        return None;
    }
    if at(0) == Some(0xff) && at(1) == Some(0xfe) {
        if at(2) == Some(0) && at(3) == Some(0) {
            return None;
        }
        return Some(UTF_16LE.decode_with_bom_removal(&bytes[2..]).0.into_owned());
    }
    if at(0) == Some(0xfe) && at(1) == Some(0xff) {
        return Some(UTF_16BE.decode_with_bom_removal(&bytes[2..]).0.into_owned());
    }
    let bom = at(0) == Some(0xef) && at(1) == Some(0xbb) && at(2) == Some(0xbf);
    let payload = if bom { &bytes[3..] } else { bytes };
    // a fatal TextDecoder drops one more byte order mark of its own
    let inner = payload.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(payload);
    match UTF_8.decode_without_bom_handling_and_without_replacement(inner) {
        Some(text) => Some(text.into_owned()),
        None => Some(
            WINDOWS_1252
                .decode_without_bom_handling(payload)
                .0
                .into_owned(),
        ),
    }
}

/// yes/no answers by path + size + mtime; never text
#[derive(Debug, Default)]
pub struct NoticeCache {
    entries: Vec<(String, bool)>,
}

const NOTICE_CACHE_MAX: usize = 32;

impl NoticeCache {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `NoticeDeps`: the reads of one question. A call that rejects is a [`Failure`].
pub trait NoticeHost: FileParser {
    fn stat(&mut self, path: &str) -> Result<FileStat, Failure>;
    fn read_bytes(&mut self, path: &str) -> Result<Vec<u8>, Failure>;
    /// `deps.parse` or `deps.readBytes` was given: the cache is not used
    fn injected_reader(&self) -> bool;
}

/// Whether converting this markdown file carries withheld spans over as their
/// labels (8.6's notice): the reader's text differs from the file's own text.
/// The mark parsing is the reader's; this only compares. False when the file
/// cannot be read at all (it is then not offered as material).
pub fn markdown_redaction_notice<H: NoticeHost>(
    host: &mut H,
    cache: &mut NoticeCache,
    path: &str,
) -> bool {
    let mut key: Option<String> = None;
    if !host.injected_reader() {
        match host.stat(path) {
            Ok(st) => {
                key = Some(format!(
                    "{}|{}|{}",
                    path,
                    jscompat::number_to_string(st.size),
                    st.mtime_ms
                        .map_or("undefined".to_owned(), jscompat::number_to_string)
                ));
            }
            Err(_) => return false,
        }
        if let Some((_, cached)) = cache.entries.iter().find(|(k, _)| Some(k) == key.as_ref()) {
            return *cached;
        }
    }
    let parsed = match host.parse_file_to_text(path) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    let own = match host.read_bytes(path) {
        Ok(bytes) => decode_text(&bytes),
        Err(_) => return false,
    };
    let (true, Some(text), Some(own)) = (parsed.ok, parsed.text, own) else {
        return false;
    };
    let notice = text != own;
    if let Some(key) = key {
        cache.entries.push((key, notice));
        if cache.entries.len() > NOTICE_CACHE_MAX {
            cache.entries.remove(0);
        }
    }
    notice
}
