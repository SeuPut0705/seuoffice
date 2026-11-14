//! What the book translation of `packages/epub-engine/src/translate` imports
//! from `@seuoffice/pdf-structure` (and the one function it takes from
//! `packages/i18n`), and nothing else. Each item names its source.

use jscompat::{js_regex, trim};
use sha2::{Digest, Sha256};

use crate::utf16::lossy;

// ── packages/i18n/src/index.ts ──

/// `LANGS`: the UI languages.
pub const LANGS: [&str; 2] = ["en", "ko"];

/// `isLang` of `packages/i18n/src/index.ts`.
pub fn is_lang(value: &str) -> bool {
    LANGS.contains(&value)
}

/// `normalizeLang` of `packages/i18n/src/index.ts`: the one place a language
/// value from outside becomes a UI language. Korean ('ko', 'ko-KR', 'ko_KR') is
/// Korean; every other value, and none, is English.
pub fn normalize_lang(raw: Option<&str>) -> &'static str {
    let value = raw.map(|raw| trim(raw).to_lowercase());
    match value {
        Some(value) if value == "ko" || value.starts_with("ko-") || value.starts_with("ko_") => {
            "ko"
        }
        _ => "en",
    }
}

// ── pdf-structure/src/store/job-keys.ts ──

/// `TranslationMode`: a plain translation, or an easy explanation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TranslationMode {
    #[default]
    Translate,
    Easy,
}

// ── pdf-structure/src/translate/prompt.ts ──

/// `TranslationRequest`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationRequest {
    pub system: String,
    pub prompt: String,
}

// ── pdf-structure/src/translate/language.ts ──

/// `TARGETS` of `translate/language.ts`: the languages a document can be
/// translated into, in the order they are offered (`TRANSLATION_LANGUAGES`).
pub const TRANSLATION_LANGUAGES: [&str; 21] = [
    "zh", "en", "ja", "ko", "fr", "de", "es", "th", "id", "ru", "ar", "pt", "it", "pl", "cs", "nl",
    "ms", "he", "hi", "zh-TW", "vi",
];

/// `isTranslationLanguage`
pub fn is_translation_language(code: &str) -> bool {
    TRANSLATION_LANGUAGES.contains(&code)
}

/// `translationLanguageOf`: a raw language tag ('zh-Hans', 'pt-BR', 'ko_KR') as
/// a target language; English when it names none of them.
pub fn translation_language_of(raw: Option<&str>) -> &'static str {
    let value = raw.map(|raw| trim(raw).to_lowercase());
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return "en";
    };
    // traditional-script Chinese variants must win over the generic 'zh' prefix
    if js_regex!(r"^zh[-_](tw|hk|mo|hant)").test(&value) {
        return "zh-TW";
    }
    for lang in TRANSLATION_LANGUAGES {
        if lang == "en" || lang == "zh-TW" {
            continue;
        }
        if value == lang
            || value
                .strip_prefix(lang)
                .is_some_and(|rest| rest.starts_with('-') || rest.starts_with('_'))
        {
            return lang;
        }
    }
    // 'in' and 'iw' are the legacy ISO codes for Indonesian and Hebrew
    if js_regex!(r"^in\b").test(&value) || js_regex!(r"^in[-_]").test(&value) {
        return "id";
    }
    if js_regex!(r"^iw\b").test(&value) || js_regex!(r"^iw[-_]").test(&value) {
        return "he";
    }
    "en"
}

/// `LANGUAGE_NAMES`, by language.
fn language_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "zh" => "Simplified Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "th" => "Thai",
        "id" => "Indonesian",
        "ru" => "Russian",
        "ar" => "Arabic",
        "pt" => "Portuguese",
        "it" => "Italian",
        "pl" => "Polish",
        "cs" => "Czech",
        "nl" => "Dutch",
        "ms" => "Malay",
        "he" => "Hebrew",
        "hi" => "Hindi",
        "zh-TW" => "Traditional Chinese",
        "vi" => "Vietnamese",
        _ => return None,
    })
}

/// `translationLanguageName`: English name of a target language; the code
/// itself when unknown.
pub fn translation_language_name(code: &str) -> String {
    language_name(code).unwrap_or(code).to_owned()
}

/// `primary` of `translate/language.ts`: the first subtag, in lower case.
pub fn primary(tag: &str) -> String {
    tag.to_lowercase()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// `defaultTargetLanguage`: default target for a document whose text is
/// `document_text`; easy mode: the UI language, whatever the document's language.
pub fn default_target_language(
    ui_language: &str,
    document_text: &[u16],
    mode: TranslationMode,
) -> &'static str {
    let ui = translation_language_of(Some(ui_language));
    if mode == TranslationMode::Easy {
        return ui;
    }
    match guess_language_from_text(document_text) {
        Some(doc) if primary(doc) == primary(ui) => "en",
        _ => ui,
    }
}

// ── pdf-structure/src/epub/language.ts ──

/// weighted letter count below which the text is too thin to guess from
const MIN_LANGUAGE_SCORE: f64 = 20.0;
/// weight of one Han / Kana / Hangul character against one letter of an alphabet
const CJK_WEIGHT: f64 = 2.0;
/// share of kana in Han + kana from which Han text reads as Japanese, not Chinese
const KANA_SHARE_FOR_JA: f64 = 0.1;
/// `LANGUAGE_SAMPLE_CHARS`: characters of body text sampled for the guess
pub const LANGUAGE_SAMPLE_CHARS: usize = 100_000;

/// `SCRIPT_LANGUAGES`: alphabetic and abugida scripts, by language, in the order
/// the guess reads them. A match counts one code point; a lone surrogate is no
/// script, as U+FFFD, which the text is read with here, is none.
fn script_count(index: usize, sample: &str) -> usize {
    let regex = match index {
        0 => js_regex!(r"\p{Script=Latin}", "gu"),
        1 => js_regex!(r"\p{Script=Cyrillic}", "gu"),
        2 => js_regex!(r"\p{Script=Greek}", "gu"),
        3 => js_regex!(r"\p{Script=Arabic}", "gu"),
        4 => js_regex!(r"\p{Script=Hebrew}", "gu"),
        5 => js_regex!(r"\p{Script=Devanagari}", "gu"),
        6 => js_regex!(r"\p{Script=Bengali}", "gu"),
        7 => js_regex!(r"\p{Script=Gurmukhi}", "gu"),
        8 => js_regex!(r"\p{Script=Gujarati}", "gu"),
        9 => js_regex!(r"\p{Script=Tamil}", "gu"),
        10 => js_regex!(r"\p{Script=Telugu}", "gu"),
        11 => js_regex!(r"\p{Script=Kannada}", "gu"),
        12 => js_regex!(r"\p{Script=Malayalam}", "gu"),
        13 => js_regex!(r"\p{Script=Sinhala}", "gu"),
        14 => js_regex!(r"\p{Script=Thai}", "gu"),
        15 => js_regex!(r"\p{Script=Lao}", "gu"),
        16 => js_regex!(r"\p{Script=Khmer}", "gu"),
        17 => js_regex!(r"\p{Script=Myanmar}", "gu"),
        18 => js_regex!(r"\p{Script=Georgian}", "gu"),
        19 => js_regex!(r"\p{Script=Armenian}", "gu"),
        _ => js_regex!(r"\p{Script=Ethiopic}", "gu"),
    };
    regex.find_iter(sample).count()
}

const SCRIPT_LANGUAGES: [&str; 21] = [
    "en", "ru", "el", "ar", "he", "hi", "bn", "pa", "gu", "ta", "te", "kn", "ml", "si", "th", "lo",
    "km", "my", "ka", "hy", "am",
];

/// `guessLanguageFromText`: language of the dominant script, or `None` when the
/// text is too thin.
pub fn guess_language_from_text(text: &[u16]) -> Option<&'static str> {
    let sample = lossy(&text[..text.len().min(LANGUAGE_SAMPLE_CHARS)]);
    let mut scores: Vec<(&'static str, f64)> = SCRIPT_LANGUAGES
        .iter()
        .enumerate()
        .map(|(index, &lang)| (lang, script_count(index, &sample) as f64))
        .collect();
    let hangul = js_regex!(r"\p{Script=Hangul}", "gu")
        .find_iter(&sample)
        .count();
    scores.push(("ko", hangul as f64 * CJK_WEIGHT));
    let kana = js_regex!(r"[\p{Script=Hiragana}\p{Script=Katakana}]", "gu")
        .find_iter(&sample)
        .count() as f64;
    let han = js_regex!(r"\p{Script=Han}", "gu")
        .find_iter(&sample)
        .count() as f64;
    if kana > 0.0 && kana / (kana + han) >= KANA_SHARE_FOR_JA {
        scores.push(("ja", (kana + han) * CJK_WEIGHT));
    } else {
        scores.push(("zh", han * CJK_WEIGHT));
    }
    let mut best = None;
    let mut best_score = 0.0;
    for (lang, score) in scores {
        if score > best_score {
            best = Some(lang);
            best_score = score;
        }
    }
    if best_score >= MIN_LANGUAGE_SCORE {
        best
    } else {
        None
    }
}

// ── pdf-structure/src/translate/style.ts ──

/// How long one entry of an easy explanation may get, as a multiple of its
/// source sentence.
pub const EASY_LENGTH_FACTOR: u32 = 2;

/// `translationStyleLines`: the writing rules for translating into `lang`, as
/// lines of the system prompt.
pub fn translation_style_lines(lang: &str) -> Vec<String> {
    let name = translation_language_name(lang);
    let mut lines = vec![
        "How the translation should read:".to_owned(),
        format!("- Phrase it the way a skilled {name} writer would phrase this text from scratch. Rebuild each sentence in the word order and structure natural to {name}; do not follow the source word order or keep constructions that only read as translated."),
        "- Keep every claim, number, unit, condition, qualifier and hedge (such as \"may\", \"about\", \"at most\", \"unless\"). Do not summarize, explain, soften, strengthen or add anything.".to_owned(),
        "- Keep citation markers such as [5, 2] or (Smith et al., 2020) and the numbers of figures, tables, equations, sections, clauses and articles as they are.".to_owned(),
        format!("- Terms: use the term that {name} texts in the same field actually use. When readers might not recognize that term on its own, add the source term in parentheses the first time it appears in a block, and not again."),
        format!("- Keep names of people, organizations, products, models, datasets and standards, and abbreviations, as in the source, unless {name} has a well-established name for them."),
        format!("- Headings: a block that is a heading (a short title, often numbered) becomes a short title: a noun phrase with no sentence ending and no final period. Keep a leading number such as \"3.1\" or \"Article 4\". Use the conventional {name} names for the standard parts of a document (abstract, introduction, conclusion, references, appendix, table of contents, definitions and the like)."),
        format!("- Captions: translate label words such as \"Figure\" or \"Table\" into their usual {name} form and keep the number."),
        "- Keep the register and tone of the source: formal stays formal and casual stays casual. In fiction, keep each character's voice in dialogue.".to_owned(),
        "- The text may come from any kind of document (a contract, a report, a notice, a manual, a textbook, a novel, an academic article, \u{2026}); do not assume one.".to_owned(),
    ];
    if lang == "ko" {
        lines.extend(KOREAN_LINES.iter().map(|&line| line.to_owned()));
    }
    lines
}

/// the extra rules for Korean (spec 3.2), in Korean
const KOREAN_LINES: &[&str] = &[
    "",
    "한국어로 옮길 때:",
    "- 문장 끝은 원문의 성격에 맞춘다. 논문, 보고서, 계약서, 법령, 책의 본문처럼 딱딱한 글은 \"~한다\"체로, 안내문, 편지, 말하듯 쓴 글은 \"~합니다\"체로 쓴다. 한 문서 안에서 섞지 않는다. 소설의 대사는 원문의 말투를 따른다.",
    "- 번역투를 쓰지 않는다. \"~에 있어서\", \"~를 통하여\", \"~하는 것이 가능하다\"(→ \"~할 수 있다\"), \"~되어진다\", \"~에 의해 ~된다\", 없어도 되는 \"~들\", \"~적인\"을 잇달아 쓰기, 문장마다 \"또한\"으로 시작하기, \"그것\"을 자꾸 쓰기를 피한다.",
    "- 명사로 굳힌 표현은 동사로 푼다. 예: \"새 방식의 적용은 속도의 향상을 가져온다\" → \"새 방식을 적용하면 속도가 빨라진다\".",
    "- 능동형으로 쓴다. 수동형은 능동형이 어색할 때만 쓴다.",
    "- 주어는 필요할 때만 쓴다. \"우리는\", \"본 연구는\", \"당사는\"을 문장마다 붙이지 않는다.",
    "- 명사 앞에 길게 늘어진 꾸밈말은 절로 끊고, 말하려는 핵심은 문장 끝에 둔다.",
];

/// `easyStyleLines`: the writing rules of an easy explanation into `lang`. They
/// replace `translation_style_lines`; Korean adds rules in Korean.
pub fn easy_style_lines(lang: &str) -> Vec<String> {
    let name = translation_language_name(lang);
    let mut lines = vec![
        "How the easy version should read:".to_owned(),
        "- Accuracy comes first. Make the words and the sentences easier, never the facts. Keep every claim, number, unit, condition, qualifier and hedge (such as \"may\", \"about\", \"at most\", \"unless\") and every name. Do not state anything more surely or more widely than the source does. Add no facts from outside the text and no opinions.".to_owned(),
        format!("- Use everyday {name} words and short sentences. Turn each source sentence into one or two short sentences, three at most."),
        "- Explain hard words. The first time a technical term or a hard word appears in a block, explain it briefly in plain words, in parentheses or in a short clause. Do not explain it again in that block.".to_owned(),
        "- When the reader cannot follow without it, add a short note on the reason (\"why\") or the assumption the source passes over without saying. Add nothing else.".to_owned(),
        "- Turn abstract wording into concrete wording: say who does what, and what happens.".to_owned(),
        format!("- Keep names of people, organizations, places, products and standards, and abbreviations, as in the source, unless {name} has a well-established name for them. The first time one appears, say briefly what it is."),
        "- Headings: a block that is a heading (a short title, often numbered) becomes a short, plain title: a noun phrase with no sentence ending and no final period. Keep a leading number such as \"3.1\" or \"Article 4\".".to_owned(),
        "- Keep reference marks and the numbers of figures, tables, sections, clauses and articles as they are.".to_owned(),
        "- No filler: do not open sentences with phrases such as \"in simple terms\" or \"that is\", ask the reader no questions, and use no emoji and no exclamation marks.".to_owned(),
        format!("- Make an easy version even when the source is already in {name}: say it again in plainer {name}."),
        format!("- Keep the easy version of one source sentence within about {EASY_LENGTH_FACTOR} times that sentence's length."),
        "- The text may come from any kind of document (a contract, a report, a notice, a manual, a textbook, a novel, an academic article, \u{2026}); do not assume one.".to_owned(),
    ];
    if lang == "ko" {
        lines.extend(KOREAN_EASY_LINES.iter().map(|&line| line.to_owned()));
    }
    lines
}

/// the extra rules of a Korean easy explanation, in Korean
const KOREAN_EASY_LINES: &[&str] = &[
    "",
    "한국어로 쉽게 풀어 쓸 때:",
    "- 문장 끝은 모두 \"~습니다\"체로 쓴다. 원문이 딱딱한 글이어도 그렇다. 제목만 문장 끝 없이 이름 꼴로 쓴다.",
    "- 어려운 한자어 대신 쉬운 우리말을 쓴다. 예: \"상이하다\" → \"다르다\", \"증가하다\" → \"늘어나다\".",
    "- 번역투와 딱딱한 표현을 쓰지 않는다. \"~에 있어서\", \"~를 통하여\", \"~되어진다\", \"~에 의해 ~된다\" 대신 \"누가 무엇을 한다\"로 쓴다.",
    "- 명사로 굳힌 표현은 동사로 푼다. 예: \"새 방식의 적용은 속도의 향상을 가져온다\" → \"새 방식을 쓰면 더 빨라집니다\".",
];

// ── pdf-structure/src/tree/types.ts, tree/inline.ts ──

/// `InlineRun`: inline content of a block.
#[derive(Debug, Clone, PartialEq)]
pub enum InlineRun {
    /// plain text with the marks the IR carries (bold / italic / link)
    Text {
        text: Vec<u16>,
        bold: bool,
        italic: bool,
        href: Option<String>,
    },
    /// body marker of a footnote; `id` matches a FootnoteDef.id in the tree
    FootnoteRef { id: String, marker: Option<String> },
    /// inline formula
    Math { latex: Vec<u16> },
    /// intentional line break inside one paragraph
    LineBreak,
}

impl InlineRun {
    /// A run of plain text.
    pub fn text(text: Vec<u16>) -> Self {
        Self::Text {
            text,
            bold: false,
            italic: false,
            href: None,
        }
    }
}

/// `runsText`: plain text of runs (markers and math omitted, line breaks as '\n').
/// Math is written as its LaTeX.
pub fn runs_text(runs: &[InlineRun]) -> Vec<u16> {
    let mut s = Vec::new();
    for run in runs {
        match run {
            InlineRun::Text { text, .. } => s.extend_from_slice(text),
            InlineRun::LineBreak => s.push(0x0A),
            InlineRun::Math { latex } => s.extend_from_slice(latex),
            InlineRun::FootnoteRef { .. } => {}
        }
    }
    s
}

// ── the language ──

/// `text.normalize('NFC')`. A lone surrogate stays where it is, and stops a
/// mark from composing with what comes before it, as it does in JavaScript.
pub fn nfc(text: &[u16]) -> Vec<u16> {
    let normalizer = icu_normalizer::ComposingNormalizerBorrowed::new_nfc();
    let mut out = Vec::with_capacity(text.len());
    let mut run = String::new();
    for piece in char::decode_utf16(text.iter().copied()) {
        match piece {
            Ok(c) => run.push(c),
            Err(lone) => {
                out.extend(normalizer.normalize(&run).encode_utf16());
                run.clear();
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    out.extend(normalizer.normalize(&run).encode_utf16());
    out
}

// ── pdf-structure/src/tree/hash.ts ──

/// `sha256Hex` of bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `sha256Hex` of a string: the bytes `TextEncoder` writes, where a lone
/// surrogate is U+FFFD.
pub fn sha256_hex_text(text: &[u16]) -> String {
    sha256_hex(lossy(text).as_bytes())
}

// ── pdf-structure/src/store/keys.ts ──

/// `TranslationBlockKey`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationBlockKey {
    /// fingerprint of the page the block starts on
    pub page_fingerprint: String,
    /// SHA-256 hex of the normalized source text
    pub text_hash: String,
    /// 0-based index of this hash among the blocks of that page
    pub occurrence: usize,
}

// ── pdf-structure/src/store/store.ts ──

/// `MigrateInput`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateInput {
    /// hash of the file bytes before the in-app save
    pub old_doc_hash: String,
    /// hash of the saved file bytes
    pub new_doc_hash: String,
    /// page fingerprints of the saved document, any order
    pub page_fingerprints: Vec<String>,
    /// When given, only the translation blocks with one of these keys move.
    pub keep_block_keys: Option<Vec<TranslationBlockKey>>,
}
