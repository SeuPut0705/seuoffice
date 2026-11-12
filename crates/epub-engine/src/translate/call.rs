//! `translate/call.ts`: batching and the model call of the book translation
//! (spec 8): one batch in, one result per unit out, in order.
//!
//! Each unit is sent in the block notation. A unit that comes back with
//! placeholders that do not match its own (`checkNotation`), empty, or not at
//! all is sent again, together with the other such units of the batch, up to
//! `EPUB_TRANSLATION_MAX_RESENDS` times; after that it stays in the source
//! language and is recorded as failed with the reason. Units that came back
//! right are not sent again.
//!
//! As in the PDF call: when no answer of the batch could be read at all, the
//! call fails with `JobUnitFailure` (nothing is stored, resuming sends the
//! batch again), and run errors from `send` (rate limit, signed out, ...) go
//! to the job engine untouched.
//!
//! The call was async over a `send` that awaits the model; `send` is a
//! synchronous function here, and the abort signal a function that answers
//! the reason it was aborted for. What the TypeScript imports from
//! `@seuoffice/pdf-structure` and nothing else is in this file too, each item
//! naming its source.

use std::collections::HashMap;

use jscompat::{js_regex, number_to_string};
use serde_json::Value;

use crate::notation::{NotationContext, NotationError, notation_plain_text, parse_block_notation};
use crate::pdf_structure::{TranslationBlockKey, TranslationMode};
use crate::translate::prompt::{EpubTranslationRequestBlock, build_epub_translation_request};
use crate::translate::units::EpubTranslationUnit;
use crate::utf16::{trim, units};
use crate::xml_positions_types::Thrown;

// ── pdf-structure/src/translate/call.ts and batch.ts ──

/// `TRANSLATION_MAX_RESENDS`
pub const TRANSLATION_MAX_RESENDS: f64 = 2.0;
/// `TRANSLATION_BATCH_TOKENS`: source tokens per batch
pub const TRANSLATION_BATCH_TOKENS: f64 = 2_500.0;
/// `BLOCK_OVERHEAD_TOKENS`: tokens of JSON around one block in the request
pub const BLOCK_OVERHEAD_TOKENS: f64 = 8.0;

/// `estimateTokens`: a rough token count of a text, rounded up.
pub fn estimate_tokens(text: &[u16]) -> f64 {
    let (mut cjk, mut other, mut ascii) = (0.0_f64, 0.0_f64, 0.0_f64);
    for unit in char::decode_utf16(text.iter().copied()) {
        match unit {
            Ok(ch) if (ch as u32) < 0x80 => ascii += 1.0,
            Ok(ch)
                if js_regex!(
                    r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]",
                    "u"
                )
                .test(ch.encode_utf8(&mut [0; 4])) =>
            {
                cjk += 1.0;
            }
            // a lone surrogate is one character above U+007F that no script claims
            _ => other += 1.0,
        }
    }
    (cjk + other / 2.0 + ascii / 4.0).ceil()
}

/// `TranslationJobItem<B>`: a block with its key in the store.
#[derive(Debug, Clone, PartialEq)]
pub struct TranslationJobItem<B> {
    pub block: B,
    pub key: TranslationBlockKey,
}

/// `TranslationBlockResult`: the result for one block of a batch, in the
/// batch's order.
#[derive(Debug, Clone, PartialEq)]
pub enum TranslationBlockResult {
    Translated {
        text: Vec<u16>,
    },
    /// the block stays in the source language
    Failed {
        reason: String,
    },
}

/// `JobUnitFailure`: thrown by a caller's model call when the call itself
/// worked but the unit cannot be used. The unit is recorded as failed with
/// `reason`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobUnitFailure {
    pub reason: String,
}

impl JobUnitFailure {
    /// `unit failed: ${reason}`
    pub fn message(&self) -> String {
        format!("unit failed: {}", self.reason)
    }
}

/// `TranslationModelRequest`: one model call's request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationModelRequest {
    pub system: String,
    pub prompt: String,
    /// target language code
    pub lang: String,
    /// 0 for the first send, then 1, 2 for the resends
    pub attempt: usize,
    /// 'easy' for an easy explanation's call; absent for a plain translation
    pub easy: bool,
}

// ── pdf-structure/src/translate/prompt.ts ──

/// `translationsOf`: id to text from one parsed value, or `None` when it is
/// not a translation answer.
fn translations_of(value: &Value) -> Option<HashMap<String, Vec<u16>>> {
    let list = match value {
        Value::Array(_) => Some(value),
        Value::Object(object) => object.get("translations"),
        _ => None,
    };
    let mut out: HashMap<String, Vec<u16>> = HashMap::new();
    match list {
        Some(Value::Array(entries)) => {
            for entry in entries {
                let Value::Object(entry) = entry else {
                    continue;
                };
                let id = match entry.get("id") {
                    Some(Value::String(id)) => id.clone(),
                    Some(Value::Number(id)) => number_to_string(id.as_f64().unwrap_or(f64::NAN)),
                    _ => continue,
                };
                if let Some(Value::String(text)) = entry.get("text") {
                    out.insert(id, units(text));
                }
            }
            if value.is_array() && out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Some(Value::Object(object)) => {
            for (id, text) in object {
                if let Value::String(text) = text {
                    out.insert(id.clone(), units(text));
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// `matchingEnd`: the end of the JSON value starting at `start` ('{' or
/// '['), or `None`.
fn matching_end(text: &str, start: usize) -> Option<usize> {
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut chars = text[start..].char_indices();
    while let Some((at, ch)) = chars.next() {
        if in_string {
            if ch == '\\' {
                chars.next();
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.pop() != Some(ch) {
                    return None;
                }
                if stack.is_empty() {
                    return Some(start + at);
                }
            }
            _ => {}
        }
    }
    None
}

/// `parseTranslationOutput`: block id to translated text from a model answer,
/// or `None` when the answer holds no translation JSON. Text around the JSON
/// (chatter, code fences, stray braces) is skipped: every '{' or '[' is tried
/// in turn until one starts a value of the expected shape.
///
/// `serde_json` reads JSON to 128 levels and refuses a lone surrogate escape
/// and a number past f64 (`1e999`), where `JSON.parse` reads all three (the
/// number as Infinity): a value that deep, with such an escape or number, is
/// skipped here and read there.
pub fn parse_translation_output(output: &str) -> Option<HashMap<String, Vec<u16>>> {
    for (at, ch) in output.char_indices() {
        if ch != '{' && ch != '[' {
            continue;
        }
        let Some(end) = matching_end(output, at) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&output[at..=end]) else {
            continue;
        };
        if let Some(found) = translations_of(&value) {
            return Some(found);
        }
    }
    None
}

// ── translate/call.ts ──

/// `EPUB_TRANSLATION_MAX_RESENDS`: times a batch's wrong units are sent again
/// (spec 8: up to two, as for PDF)
pub const EPUB_TRANSLATION_MAX_RESENDS: f64 = TRANSLATION_MAX_RESENDS;

/// what the model call needs of a unit (`EpubTranslationCallUnit`)
pub trait EpubCallUnit {
    fn text(&self) -> &[u16];
    fn context(&self) -> &NotationContext;
}

impl EpubCallUnit for EpubTranslationUnit {
    fn text(&self) -> &[u16] {
        &self.text
    }

    fn context(&self) -> &NotationContext {
        &self.context
    }
}

/// `epubUnitTokens`: tokens one unit adds to a batch: its notation text plus
/// the JSON around it.
pub fn epub_unit_tokens(unit: &impl EpubCallUnit) -> f64 {
    estimate_tokens(unit.text()) + BLOCK_OVERHEAD_TOKENS
}

/// `batchEpubTranslationItems`: cut units into batches in order (the `batch`
/// of the translation job). A batch closes before the unit that would take it
/// over the budget; a unit over the budget on its own goes alone. `max_tokens`
/// is `BatchOptions.maxTokens`.
pub fn batch_epub_translation_items<B: EpubCallUnit>(
    items: &[TranslationJobItem<B>],
    max_tokens: Option<f64>,
) -> Result<Vec<Vec<&TranslationJobItem<B>>>, Thrown> {
    let max = max_tokens.unwrap_or(TRANSLATION_BATCH_TOKENS);
    if !max.is_finite() || max <= 0.0 {
        return Err(Thrown::new(
            "RangeError",
            format!(
                "epub translation batch: invalid token budget {}",
                number_to_string(max)
            ),
        ));
    }
    let mut batches = Vec::new();
    let mut current: Vec<&TranslationJobItem<B>> = Vec::new();
    let mut used = 0.0;
    for item in items {
        let tokens = epub_unit_tokens(&item.block);
        if !current.is_empty() && used + tokens > max {
            batches.push(std::mem::take(&mut current));
            used = 0.0;
        }
        current.push(item);
        used += tokens;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    Ok(batches)
}

/// `Checked`
enum Checked {
    Ok(Vec<u16>),
    /// `placeholder-mismatch` or `empty-translation`
    Failed(&'static str),
}

/// `checkTranslation`
fn check_translation(unit: &impl EpubCallUnit, answer: &[u16]) -> Result<Checked, Thrown> {
    let text = trim(answer);
    let tree = match parse_block_notation(text, unit.context()) {
        Ok(tree) => tree,
        Err(NotationError::Invalid(_)) => return Ok(Checked::Failed("placeholder-mismatch")),
        Err(NotationError::Thrown(thrown)) => return Err(thrown),
    };
    if trim(&notation_plain_text(&tree)?).is_empty() {
        return Ok(Checked::Failed("empty-translation"));
    }
    Ok(Checked::Ok(text.to_vec()))
}

/// What a call of the model call fails with.
#[derive(Debug, PartialEq)]
pub enum CallFailure<E> {
    /// no answer of the batch could be read at all
    JobUnitFailure(JobUnitFailure),
    /// a run error of `send`, or the reason of the abort, untouched
    Run(E),
    /// what the TypeScript throws
    Thrown(Thrown),
}

impl<E> From<Thrown> for CallFailure<E> {
    fn from(error: Thrown) -> Self {
        Self::Thrown(error)
    }
}

/// `createEpubTranslationModelCall`: the `callModel` of the book translation
/// job. `send` gets the PDF request shape (system, prompt, lang, attempt, and
/// `easy` for an easy explanation) with the EPUB instruction.
pub struct EpubTranslationModelCall<S> {
    lang: String,
    send: S,
    max_resends: usize,
    easy: bool,
}

/// `createEpubTranslationModelCall(o)`: `max_resends` is
/// `TranslationModelCallOptions.maxResends`, `mode` its `mode`.
pub fn create_epub_translation_model_call<S>(
    lang: &str,
    send: S,
    max_resends: Option<f64>,
    mode: TranslationMode,
) -> Result<EpubTranslationModelCall<S>, Thrown> {
    let max = max_resends.unwrap_or(EPUB_TRANSLATION_MAX_RESENDS);
    if max.fract() != 0.0 || max < 0.0 || !max.is_finite() {
        return Err(Thrown::new(
            "RangeError",
            format!(
                "epub translation: invalid resend count {}",
                number_to_string(max)
            ),
        ));
    }
    Ok(EpubTranslationModelCall {
        lang: lang.to_owned(),
        send,
        max_resends: max as usize,
        easy: mode == TranslationMode::Easy,
    })
}

impl<S> EpubTranslationModelCall<S> {
    /// One batch: `aborted` answers the reason of the abort once the signal is
    /// aborted (`if (signal.aborted) throw signal.reason`).
    pub fn call<B, E>(
        &mut self,
        batch: &[&TranslationJobItem<B>],
        aborted: &dyn Fn() -> Option<E>,
    ) -> Result<Vec<TranslationBlockResult>, CallFailure<E>>
    where
        B: EpubCallUnit,
        S: FnMut(&TranslationModelRequest) -> Result<String, E>,
    {
        let mut results: Vec<Option<TranslationBlockResult>> = batch.iter().map(|_| None).collect();
        let mut reasons: Vec<String> = batch
            .iter()
            .map(|_| "missing-translation".to_owned())
            .collect();
        let mut pending: Vec<usize> = (0..batch.len()).collect();
        let mut any_parsed = false;
        let mut attempt = 0;
        while attempt <= self.max_resends && !pending.is_empty() {
            if let Some(reason) = aborted() {
                return Err(CallFailure::Run(reason));
            }
            let mode = if self.easy {
                TranslationMode::Easy
            } else {
                TranslationMode::Translate
            };
            let request = build_epub_translation_request(
                &self.lang,
                &pending
                    .iter()
                    .map(|&i| EpubTranslationRequestBlock {
                        id: units(&(i + 1).to_string()),
                        text: batch[i].block.text().to_vec(),
                    })
                    .collect::<Vec<_>>(),
                mode,
            );
            let answer = (self.send)(&TranslationModelRequest {
                system: request.system,
                prompt: request.prompt,
                lang: self.lang.clone(),
                attempt,
                easy: self.easy,
            })
            .map_err(CallFailure::Run)?;
            attempt += 1;
            let Some(parsed) = parse_translation_output(&answer) else {
                continue;
            };
            any_parsed = true;
            let mut still = Vec::new();
            for &i in &pending {
                let Some(text) = parsed.get(&(i + 1).to_string()) else {
                    reasons[i] = "missing-translation".to_owned();
                    still.push(i);
                    continue;
                };
                match check_translation(&batch[i].block, text)? {
                    Checked::Failed(reason) => {
                        reasons[i] = reason.to_owned();
                        still.push(i);
                    }
                    Checked::Ok(text) => {
                        results[i] = Some(TranslationBlockResult::Translated { text })
                    }
                }
            }
            pending = still;
        }
        if !any_parsed {
            return Err(CallFailure::JobUnitFailure(JobUnitFailure {
                reason: "unparseable-response".to_owned(),
            }));
        }
        Ok(results
            .into_iter()
            .zip(reasons)
            .map(|(result, reason)| result.unwrap_or(TranslationBlockResult::Failed { reason }))
            .collect())
    }
}
