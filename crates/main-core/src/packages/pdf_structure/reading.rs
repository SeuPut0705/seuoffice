//! `packages/pdf-structure/src/store/reading.ts`: the entries of the reading
//! assistant in the result store (reading-assist spec 5.2): passage cards, AI
//! highlight runs and their blocks, and insights. Types and shape checks only;
//! `store.rs` reads and writes them. A shape check reads a parsed JSON value
//! ([`JsonValue`]); an entry prints as the TypeScript's literal writes it.

use jscompat::{JsObject, JsonValue, js_regex};

use super::highlight_run_id::normalize_label_name;
use super::keys::TranslationBlockKey;

// ---- JSON values the checks read ----

/// `isRecord(v)`: an object that is not an array
pub(crate) fn record(value: Option<&JsonValue>) -> Option<&JsObject<JsonValue>> {
    match value {
        Some(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

/// `isNum(v)`: a finite number
pub(crate) fn num(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `isStr(v)`
pub(crate) fn string(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) => Some(text),
        _ => None,
    }
}

/// `v === undefined || isStr(v)`
pub(crate) fn opt_string(value: Option<&JsonValue>) -> bool {
    value.is_none() || string(value).is_some()
}

/// `SEGMENT.test(value)`: letters, digits, `-` and `_` only, 1 to 128 of them
pub(crate) fn is_segment_str(value: &str) -> bool {
    js_regex!(r"^[A-Za-z0-9_-]{1,128}$").test(value)
}

/// `isSegment(v)`: a key used as a path segment
pub fn is_segment(value: Option<&JsonValue>) -> bool {
    string(value).is_some_and(is_segment_str)
}

/// `Number.isInteger(v) && v >= 1`
fn page(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() && x.trunc() == *x && *x >= 1.0 => Some(*x),
        _ => None,
    }
}

/// `isNum(v) && v >= 0 && v <= 1`
fn unit(value: Option<&JsonValue>) -> Option<f64> {
    num(value).filter(|x| *x >= 0.0 && *x <= 1.0)
}

fn array(value: Option<&JsonValue>) -> Option<&Vec<JsonValue>> {
    match value {
        Some(JsonValue::Array(items)) => Some(items),
        _ => None,
    }
}

fn number_value(x: f64) -> JsonValue {
    JsonValue::Number(x)
}

fn string_value(text: &str) -> JsonValue {
    JsonValue::String(text.to_owned())
}

/// an object written with its keys in this order
pub(crate) fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

/// `{ pageFingerprint, textHash, occurrence }`
pub(crate) fn key_value(key: &TranslationBlockKey) -> JsonValue {
    object(vec![
        ("pageFingerprint", string_value(&key.page_fingerprint)),
        ("textHash", string_value(&key.text_hash)),
        ("occurrence", number_value(key.occurrence)),
    ])
}

// ---- entry types ----

/// `PassageCard['kind']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassageKind {
    Explain,
    Translate,
}

impl PassageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PassageKind::Explain => "explain",
            PassageKind::Translate => "translate",
        }
    }
}

/// `PassageCard`: an AI explanation or translation of a selected passage,
/// kept beside the page
#[derive(Debug, Clone, PartialEq)]
pub struct PassageCard {
    /// random, unique per document; a path segment
    pub id: String,
    pub kind: PassageKind,
    /// 1-based original page at creation
    pub page: f64,
    pub page_fingerprint: String,
    /// PDF user space
    pub quads: Vec<Vec<f64>>,
    /// the selected text
    pub excerpt: String,
    pub passage_hash: String,
    /// translate only: target language code
    pub lang: Option<String>,
    /// the answer
    pub text: String,
    pub provider: String,
    pub model: String,
    pub created_at: f64,
    /// last write; the newer card wins when a migration meets an existing one
    pub saved_at: f64,
    /// only after a PDF save that contained the note succeeded
    pub saved_as_note: bool,
}

impl PassageCard {
    /// the card as `asPassageCard` builds it
    pub fn to_value(&self) -> JsonValue {
        let mut entries = vec![
            ("id", string_value(&self.id)),
            ("kind", string_value(self.kind.as_str())),
            ("page", number_value(self.page)),
            ("pageFingerprint", string_value(&self.page_fingerprint)),
            (
                "quads",
                JsonValue::Array(
                    self.quads
                        .iter()
                        .map(|q| JsonValue::Array(q.iter().map(|x| number_value(*x)).collect()))
                        .collect(),
                ),
            ),
            ("excerpt", string_value(&self.excerpt)),
            ("passageHash", string_value(&self.passage_hash)),
            ("text", string_value(&self.text)),
            ("provider", string_value(&self.provider)),
            ("model", string_value(&self.model)),
            ("createdAt", number_value(self.created_at)),
            ("savedAt", number_value(self.saved_at)),
        ];
        if let Some(lang) = &self.lang {
            entries.push(("lang", string_value(lang)));
        }
        if self.saved_as_note {
            entries.push(("savedAsNote", JsonValue::Bool(true)));
        }
        object(entries)
    }
}

/// `PassageCardInput`: what a caller writes; the store stamps `savedAt`.
/// `saved_as_note` is `Some(flag)` where the caller wrote the field (only
/// `true` is a card).
#[derive(Debug, Clone, PartialEq)]
pub struct PassageCardInput {
    pub id: String,
    pub kind: PassageKind,
    pub page: f64,
    pub page_fingerprint: String,
    pub quads: Vec<Vec<f64>>,
    pub excerpt: String,
    pub passage_hash: String,
    pub lang: Option<String>,
    pub text: String,
    pub provider: String,
    pub model: String,
    pub created_at: f64,
    pub saved_as_note: Option<bool>,
}

impl PassageCardInput {
    /// `{ ...card, savedAt }`
    pub(crate) fn with_saved_at(&self, saved_at: f64) -> JsonValue {
        let mut entries = vec![
            ("id", string_value(&self.id)),
            ("kind", string_value(self.kind.as_str())),
            ("page", number_value(self.page)),
            ("pageFingerprint", string_value(&self.page_fingerprint)),
            (
                "quads",
                JsonValue::Array(
                    self.quads
                        .iter()
                        .map(|q| JsonValue::Array(q.iter().map(|x| number_value(*x)).collect()))
                        .collect(),
                ),
            ),
            ("excerpt", string_value(&self.excerpt)),
            ("passageHash", string_value(&self.passage_hash)),
        ];
        if let Some(lang) = &self.lang {
            entries.push(("lang", string_value(lang)));
        }
        entries.extend([
            ("text", string_value(&self.text)),
            ("provider", string_value(&self.provider)),
            ("model", string_value(&self.model)),
            ("createdAt", number_value(self.created_at)),
        ]);
        if let Some(flag) = self.saved_as_note {
            entries.push(("savedAsNote", JsonValue::Bool(flag)));
        }
        entries.push(("savedAt", number_value(saved_at)));
        object(entries)
    }
}

/// `HIGHLIGHT_PRESET_IDS`
pub const HIGHLIGHT_PRESET_IDS: [&str; 4] = ["research", "contract", "textbook", "custom"];

/// `HIGHLIGHT_MAX_LABELS`: labels per run
pub const HIGHLIGHT_MAX_LABELS: usize = 5;

/// `HighlightLabel`
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightLabel {
    pub id: String,
    pub name: String,
    /// rgb, each 0-1
    pub color: [f64; 3],
}

/// `HighlightRun`: a preset and its labels over the pages the person chose
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightRun {
    /// hash of presetId + the ordered label names; a path segment
    pub run_id: String,
    pub preset_id: String,
    /// 1..=`HIGHLIGHT_MAX_LABELS`
    pub labels: Vec<HighlightLabel>,
    /// 1-based original pages the person chose
    pub pages: Vec<f64>,
    pub provider: String,
    pub model: String,
    pub created_at: f64,
}

impl HighlightRun {
    /// the run as `asHighlightRun` builds it
    pub fn to_value(&self) -> JsonValue {
        object(vec![
            ("runId", string_value(&self.run_id)),
            ("presetId", string_value(&self.preset_id)),
            (
                "labels",
                JsonValue::Array(
                    self.labels
                        .iter()
                        .map(|l| {
                            object(vec![
                                ("id", string_value(&l.id)),
                                ("name", string_value(&l.name)),
                                (
                                    "color",
                                    JsonValue::Array(
                                        l.color.iter().map(|x| number_value(*x)).collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "pages",
                JsonValue::Array(self.pages.iter().map(|x| number_value(*x)).collect()),
            ),
            ("provider", string_value(&self.provider)),
            ("model", string_value(&self.model)),
            ("createdAt", number_value(self.created_at)),
        ])
    }
}

/// `HighlightSuggestionState`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HighlightSuggestionState {
    Pending,
    Accepted,
    Dismissed,
}

impl HighlightSuggestionState {
    pub fn as_str(self) -> &'static str {
        match self {
            HighlightSuggestionState::Pending => "pending",
            HighlightSuggestionState::Accepted => "accepted",
            HighlightSuggestionState::Dismissed => "dismissed",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "pending" => Some(HighlightSuggestionState::Pending),
            "accepted" => Some(HighlightSuggestionState::Accepted),
            "dismissed" => Some(HighlightSuggestionState::Dismissed),
            _ => None,
        }
    }
}

/// `HighlightSuggestion`
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightSuggestion {
    pub id: String,
    pub label_id: String,
    pub quote: String,
    pub state: HighlightSuggestionState,
}

impl HighlightSuggestion {
    fn to_value(&self) -> JsonValue {
        object(vec![
            ("id", string_value(&self.id)),
            ("labelId", string_value(&self.label_id)),
            ("quote", string_value(&self.quote)),
            ("state", string_value(self.state.as_str())),
        ])
    }
}

/// `HighlightBlockEntry['status']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HighlightBlockStatus {
    Done,
    Failed,
}

impl HighlightBlockStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            HighlightBlockStatus::Done => "done",
            HighlightBlockStatus::Failed => "failed",
        }
    }
}

/// `HighlightBlockEntry`: the suggestions for one text block; keyed like a
/// translation block
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightBlockEntry {
    pub key: TranslationBlockKey,
    pub status: HighlightBlockStatus,
    pub suggestions: Vec<HighlightSuggestion>,
    pub saved_at: f64,
}

impl HighlightBlockEntry {
    /// the entry as `asHighlightBlock` builds it
    pub fn to_value(&self) -> JsonValue {
        object(vec![
            ("key", key_value(&self.key)),
            ("status", string_value(self.status.as_str())),
            (
                "suggestions",
                JsonValue::Array(self.suggestions.iter().map(|s| s.to_value()).collect()),
            ),
            ("savedAt", number_value(self.saved_at)),
        ])
    }
}

/// `HighlightBlockInput`: what a caller writes; the store stamps `savedAt`
#[derive(Debug, Clone, PartialEq)]
pub struct HighlightBlockInput {
    pub key: TranslationBlockKey,
    pub status: HighlightBlockStatus,
    pub suggestions: Vec<HighlightSuggestion>,
}

impl HighlightBlockInput {
    /// `{ ...block, savedAt }`
    pub(crate) fn with_saved_at(&self, saved_at: f64) -> JsonValue {
        object(vec![
            ("key", key_value(&self.key)),
            ("status", string_value(self.status.as_str())),
            (
                "suggestions",
                JsonValue::Array(self.suggestions.iter().map(|s| s.to_value()).collect()),
            ),
            ("savedAt", number_value(saved_at)),
        ])
    }
}

/// a term of an insights entry
#[derive(Debug, Clone, PartialEq)]
pub struct InsightsTerm {
    pub term: String,
    pub meaning: String,
    pub page: f64,
}

/// `InsightsEntry`: the document overview in one language
#[derive(Debug, Clone, PartialEq)]
pub struct InsightsEntry {
    pub lang: String,
    pub summary3: [String; 3],
    pub summary: String,
    pub terms: Vec<InsightsTerm>,
    pub provider: String,
    pub model: String,
    pub created_at: f64,
    /// every page whose text was sent
    pub page_fingerprints: Vec<String>,
}

impl InsightsEntry {
    /// the entry as `asInsights` builds it
    pub fn to_value(&self) -> JsonValue {
        object(vec![
            ("lang", string_value(&self.lang)),
            (
                "summary3",
                JsonValue::Array(self.summary3.iter().map(|s| string_value(s)).collect()),
            ),
            ("summary", string_value(&self.summary)),
            (
                "terms",
                JsonValue::Array(
                    self.terms
                        .iter()
                        .map(|t| {
                            object(vec![
                                ("term", string_value(&t.term)),
                                ("meaning", string_value(&t.meaning)),
                                ("page", number_value(t.page)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("provider", string_value(&self.provider)),
            ("model", string_value(&self.model)),
            ("createdAt", number_value(self.created_at)),
            (
                "pageFingerprints",
                JsonValue::Array(
                    self.page_fingerprints
                        .iter()
                        .map(|s| string_value(s))
                        .collect(),
                ),
            ),
        ])
    }
}

// ---- shape checks ----

/// `asPassageCard(raw)`: a card as written or read, or `None` when it does
/// not have the shape
pub fn as_passage_card(raw: Option<&JsonValue>) -> Option<PassageCard> {
    let r = record(raw)?;
    let id = string(r.get("id")).filter(|s| is_segment_str(s))?;
    let kind = match string(r.get("kind")) {
        Some("explain") => PassageKind::Explain,
        Some("translate") => PassageKind::Translate,
        _ => return None,
    };
    let page_number = page(r.get("page"))?;
    let page_fingerprint = string(r.get("pageFingerprint")).filter(|s| is_segment_str(s))?;
    let raw_quads = array(r.get("quads"))?;
    let mut quads = Vec::with_capacity(raw_quads.len());
    for q in raw_quads {
        let JsonValue::Array(items) = q else {
            return None;
        };
        let mut quad = Vec::with_capacity(items.len());
        for x in items {
            quad.push(num(Some(x))?);
        }
        quads.push(quad);
    }
    let excerpt = string(r.get("excerpt"))?;
    let passage_hash = string(r.get("passageHash"))?;
    let text = string(r.get("text"))?;
    let provider = string(r.get("provider"))?;
    let model = string(r.get("model"))?;
    let created_at = num(r.get("createdAt"))?;
    let saved_at = num(r.get("savedAt"))?;
    let lang = r.get("lang");
    if kind == PassageKind::Translate {
        if !is_segment(lang) {
            return None;
        }
    } else if lang.is_some() && !is_segment(lang) {
        return None;
    }
    let saved_as_note = r.get("savedAsNote");
    if saved_as_note.is_some() && saved_as_note != Some(&JsonValue::Bool(true)) {
        return None;
    }
    Some(PassageCard {
        id: id.to_owned(),
        kind,
        page: page_number,
        page_fingerprint: page_fingerprint.to_owned(),
        quads,
        excerpt: excerpt.to_owned(),
        passage_hash: passage_hash.to_owned(),
        lang: string(lang).map(str::to_owned),
        text: text.to_owned(),
        provider: provider.to_owned(),
        model: model.to_owned(),
        created_at,
        saved_at,
        saved_as_note: saved_as_note == Some(&JsonValue::Bool(true)),
    })
}

/// `asHighlightRun(raw)`: a run as written or read, or `None` when it does
/// not have the shape
pub fn as_highlight_run(raw: Option<&JsonValue>) -> Option<HighlightRun> {
    let r = record(raw)?;
    let run_id = string(r.get("runId")).filter(|s| is_segment_str(s))?;
    let preset_id = string(r.get("presetId")).filter(|s| HIGHLIGHT_PRESET_IDS.contains(s))?;
    let raw_labels = array(r.get("labels"))?;
    if raw_labels.is_empty() || raw_labels.len() > HIGHLIGHT_MAX_LABELS {
        return None;
    }
    let mut labels = Vec::with_capacity(raw_labels.len());
    let mut names: Vec<String> = Vec::new();
    for l in raw_labels {
        let l = record(Some(l))?;
        let id = string(l.get("id")).filter(|s| !s.is_empty())?;
        let label_name = string(l.get("name"))?;
        let color = array(l.get("color")).filter(|c| c.len() == 3)?;
        let mut rgb = [0.0; 3];
        for (slot, component) in rgb.iter_mut().zip(color) {
            *slot = unit(Some(component))?;
        }
        // a name counts as the run id counts it; an empty or repeated one is no category
        let name = normalize_label_name(label_name);
        if name.is_empty() || names.contains(&name) {
            return None;
        }
        names.push(name);
        labels.push(HighlightLabel {
            id: id.to_owned(),
            name: label_name.to_owned(),
            color: rgb,
        });
    }
    let raw_pages = array(r.get("pages"))?;
    let mut pages = Vec::with_capacity(raw_pages.len());
    for p in raw_pages {
        pages.push(page(Some(p))?);
    }
    let provider = string(r.get("provider"))?;
    let model = string(r.get("model"))?;
    let created_at = num(r.get("createdAt"))?;
    Some(HighlightRun {
        run_id: run_id.to_owned(),
        preset_id: preset_id.to_owned(),
        labels,
        pages,
        provider: provider.to_owned(),
        model: model.to_owned(),
        created_at,
    })
}

/// `sameKey(k, expect)`
fn same_key(k: Option<&JsonValue>, expect: &TranslationBlockKey) -> bool {
    let Some(k) = record(k) else {
        return false;
    };
    string(k.get("pageFingerprint")) == Some(expect.page_fingerprint.as_str())
        && string(k.get("textHash")) == Some(expect.text_hash.as_str())
        && matches!(k.get("occurrence"), Some(JsonValue::Number(x)) if *x == expect.occurrence)
}

/// `asHighlightBlock(raw, expect)`: a highlight block stored under `expect`,
/// or `None` when it does not have the shape
pub fn as_highlight_block(
    raw: Option<&JsonValue>,
    expect: &TranslationBlockKey,
) -> Option<HighlightBlockEntry> {
    let r = record(raw)?;
    if !same_key(r.get("key"), expect) {
        return None;
    }
    let saved_at = num(r.get("savedAt"))?;
    let status = match string(r.get("status")) {
        Some("done") => HighlightBlockStatus::Done,
        Some("failed") => HighlightBlockStatus::Failed,
        _ => return None,
    };
    let mut suggestions = Vec::new();
    for s in array(r.get("suggestions"))? {
        let s = record(Some(s))?;
        let id = string(s.get("id"))?;
        let label_id = string(s.get("labelId"))?;
        let quote = string(s.get("quote"))?;
        let state = HighlightSuggestionState::parse(string(s.get("state"))?)?;
        suggestions.push(HighlightSuggestion {
            id: id.to_owned(),
            label_id: label_id.to_owned(),
            quote: quote.to_owned(),
            state,
        });
    }
    Some(HighlightBlockEntry {
        key: expect.clone(),
        status,
        suggestions,
        saved_at,
    })
}

/// `asInsights(raw)`: an insights entry as written or read, or `None` when
/// it does not have the shape
pub fn as_insights(raw: Option<&JsonValue>) -> Option<InsightsEntry> {
    let r = record(raw)?;
    let lang = string(r.get("lang")).filter(|s| is_segment_str(s))?;
    let summary = string(r.get("summary"))?;
    let summary3 = array(r.get("summary3")).filter(|items| items.len() == 3)?;
    let mut parts = Vec::with_capacity(3);
    for item in summary3 {
        parts.push(string(Some(item))?.to_owned());
    }
    let mut terms = Vec::new();
    for term in array(r.get("terms"))? {
        let term = record(Some(term))?;
        terms.push(InsightsTerm {
            term: string(term.get("term"))?.to_owned(),
            meaning: string(term.get("meaning"))?.to_owned(),
            page: page(term.get("page"))?,
        });
    }
    let provider = string(r.get("provider"))?;
    let model = string(r.get("model"))?;
    let created_at = num(r.get("createdAt"))?;
    let mut page_fingerprints = Vec::new();
    for fp in array(r.get("pageFingerprints"))? {
        if !is_segment(Some(fp)) {
            return None;
        }
        page_fingerprints.push(string(Some(fp))?.to_owned());
    }
    let mut parts = parts.into_iter();
    Some(InsightsEntry {
        lang: lang.to_owned(),
        summary3: [parts.next()?, parts.next()?, parts.next()?],
        summary: summary.to_owned(),
        terms,
        provider: provider.to_owned(),
        model: model.to_owned(),
        created_at,
        page_fingerprints,
    })
}
