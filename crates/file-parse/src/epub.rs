//! `packages/file-parse/src/epub.ts`: a book to plain text.
//!
//! `epubToText` was async over the engine's `openEpub` and `book.readText`;
//! here both are synchronous. An `Err` holds the message of the `Error` the
//! TypeScript throws (or of the error an engine step throws).

use epub_engine::open::{EPUB_ZIP_LIMITS, EpubOpenResult, open_epub};
use epub_engine::text::extract_chapter_text;
use epub_engine::types::EpubRefusalReason;

/// What each refusal tells the reader (spec 3), in the order the engine checks.
fn refusal_message(reason: EpubRefusalReason) -> &'static str {
    match reason {
        EpubRefusalReason::TooLarge => "Cannot read EPUB: the file is too large to unpack safely",
        EpubRefusalReason::Damaged => "Cannot read EPUB: the file is damaged",
        EpubRefusalReason::NotEpub => "Cannot read EPUB: not an EPUB file, or a damaged one",
        EpubRefusalReason::Drm => {
            "Copy-protected EPUB: the book is protected by DRM and cannot be read; open it in the app of the store it was bought from"
        }
    }
}

/// `epubToText`: every spine item's text in spine order, headings as `#`
/// lines, a blank line between chapters (the engine's chapter text; a chapter
/// that is not well-formed XML is read with an HTML parser there). The engine
/// runs the zip gate before it inflates anything. Fails for a book that does
/// not open: refused by the gate, not an EPUB, or copy-protected.
///
/// A chapter whose bytes are not valid text is left out behind a marker rather
/// than handed on as replacement characters, and a book with no chapter that
/// decodes is refused: garbled text never reaches the index or a model.
pub fn epub_to_text(bytes: &[u8]) -> Result<String, String> {
    let book = match open_epub(bytes, &EPUB_ZIP_LIMITS) {
        EpubOpenResult::Opened(book) => book,
        EpubOpenResult::Refused { reason, detail } => {
            return Err(format!("{} ({detail})", refusal_message(reason)));
        }
    };
    let mut parts: Vec<String> = Vec::new();
    let mut decoded = 0;
    for item in &book.info.spine.items {
        let Some(source) = book.read_text(&item.path)? else {
            continue;
        };
        if !source.valid {
            parts.push(format!(
                "[Chapter {} ({}) left out: its bytes are not valid {} text]",
                item.index + 1,
                item.path,
                source.encoding.label()
            ));
            continue;
        }
        decoded += 1;
        let text = extract_chapter_text(&source.text).map_err(|error| error.message)?;
        if !text.is_empty() {
            parts.push(text);
        }
    }
    if decoded == 0 {
        return Err(
            "Cannot read EPUB: no chapter decodes as text (the book may be copy-protected)"
                .to_owned(),
        );
    }
    Ok(parts.join("\n\n"))
}
