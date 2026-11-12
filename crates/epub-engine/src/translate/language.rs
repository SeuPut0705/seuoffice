//! `translate/language.ts`: the default target language of a book translation
//! (spec 8): the UI language, or English when the book is already in the UI
//! language. The book's language is its first `dc:language`; a book that names
//! none (or only `und`) gets pdf-structure's script-based guess from its text.

use crate::pdf_structure::{
    LANGUAGE_SAMPLE_CHARS, TranslationMode, default_target_language, guess_language_from_text,
    primary,
};
use crate::translate::units::{EPUB_METADATA_PAGE, EpubTranslationUnit};

/// `epubBookLanguage`: the book's language: the first named `dc:language`,
/// else the guess from `sample_text`.
pub fn epub_book_language(languages: &[String], sample_text: &[u16]) -> Option<String> {
    let named = languages
        .iter()
        .map(|l| jscompat::trim(l))
        .find(|l| !l.is_empty() && primary(l) != "und");
    match named {
        Some(named) => Some(named.to_owned()),
        None => guess_language_from_text(sample_text).map(str::to_owned),
    }
}

/// `defaultEpubTargetLanguage`: the default target: the UI language
/// (normalized to one of the 21), or English when the book's language has the
/// same primary subtag. Easy mode: the UI language, whatever the book's language.
pub fn default_epub_target_language(
    ui_language: &str,
    book_languages: &[String],
    sample_text: &[u16],
    mode: TranslationMode,
) -> &'static str {
    // with no text to guess from, the PDF rule gives the normalized UI language
    let ui = default_target_language(ui_language, &[], TranslationMode::Translate);
    if mode == TranslationMode::Easy {
        return ui;
    }
    match epub_book_language(book_languages, sample_text) {
        Some(book) if primary(&book) == primary(ui) => "en",
        _ => ui,
    }
}

/// `epubSampleText`: the chapter text of the units, in order, up to the
/// guess's sample size.
pub fn epub_sample_text(units: &[EpubTranslationUnit]) -> Vec<u16> {
    let mut parts: Vec<&[u16]> = Vec::new();
    let mut length = 0;
    for unit in units {
        if unit.page == EPUB_METADATA_PAGE {
            continue;
        }
        parts.push(&unit.plain_text);
        length += unit.plain_text.len() + 1;
        if length >= LANGUAGE_SAMPLE_CHARS {
            break;
        }
    }
    parts.join(&0x0A_u16)
}
