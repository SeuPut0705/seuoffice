//! The part writers of the write side (slice `parts`): patch.ts's part builders
//! and scrubs, style-upsert.ts, remove-parts.ts, resource-cleanup.ts,
//! zip-splice.ts and the write side of doc-properties.ts. A "zip" is a
//! `ooxml_pkg::Package`; everything that throws in the TypeScript returns
//! `Err(message)` here.

use std::fmt::Display;

use jscompat::{RegexLimit, TryJsRegex};

pub mod comments;
pub mod hf_parts;
pub mod markup;
pub mod rels;
pub mod remove_parts;
pub mod resource_cleanup;
pub mod scrub;
pub mod settings;
pub mod style_upsert;
pub mod text_patch;
pub mod zip_splice;

/// What a thrown `Error` or a regex search stopped at its bound becomes for a caller: the message.
pub(crate) fn thrown(error: impl Display) -> String {
    error.to_string()
}

/// `text.replace(regex, () => replacement)` of a regex without the `g` flag.
pub(crate) fn replace_first(
    regex: &TryJsRegex,
    text: &str,
    replacement: &str,
) -> Result<String, RegexLimit> {
    let Some(found) = regex.try_exec(text)? else {
        return Ok(text.to_owned());
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..found.start()]);
    out.push_str(replacement);
    out.push_str(&text[found.end()..]);
    Ok(out)
}
