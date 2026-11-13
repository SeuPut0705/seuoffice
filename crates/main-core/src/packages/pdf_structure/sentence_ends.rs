//! `packages/pdf-structure/src/store/sentence-ends.ts`: sentence boundaries
//! kept beside a translated block (spec §6.1). An offset is a UTF-16 index
//! into the plain text made by `runsText`; the two lists come together or
//! not at all.

use jscompat::JsonValue;

/// `SentenceEnds`: the two optional fields of a translation block entry
#[derive(Debug, Clone, PartialEq)]
pub struct SentenceEnds {
    /// where each source sentence ends: offsets into the plain text of the source runs
    pub source_sentence_ends: Vec<f64>,
    /// where each translated sentence ends: offsets into the plain text of the translated runs
    pub sentence_ends: Vec<f64>,
}

/// `Number.isSafeInteger(x)`
fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0
}

/// `validSentenceEnds(ends, length)`: `ends` has the shape of a
/// sentence-end list: at least two integers, each greater than zero and
/// greater than the one before; with `length`, the last value must also equal
/// it. `ends` is `None` where the value is `undefined`.
pub fn valid_sentence_ends(ends: Option<&JsonValue>, length: Option<f64>) -> Option<Vec<f64>> {
    let Some(JsonValue::Array(items)) = ends else {
        return None;
    };
    if items.len() < 2 {
        return None;
    }
    let mut previous = 0.0;
    let mut out = Vec::with_capacity(items.len());
    for end in items {
        let JsonValue::Number(end) = end else {
            return None;
        };
        if !is_safe_integer(*end) || *end <= previous {
            return None;
        }
        previous = *end;
        out.push(*end);
    }
    match length {
        Some(length) if previous != length => None,
        _ => Some(out),
    }
}

/// `sentenceEndsPair(source, ends, translatedLength)`: the pair as a
/// translated block may keep it, or `None` when it may not
pub fn sentence_ends_pair(
    source_sentence_ends: Option<&JsonValue>,
    sentence_ends: Option<&JsonValue>,
    translated_length: f64,
) -> Option<SentenceEnds> {
    let source = valid_sentence_ends(source_sentence_ends, None)?;
    let ends = valid_sentence_ends(sentence_ends, Some(translated_length))?;
    if source.len() != ends.len() {
        return None;
    }
    Some(SentenceEnds {
        source_sentence_ends: source,
        sentence_ends: ends,
    })
}
