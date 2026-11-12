//! List marker text: number formats, bullets, counters
//! (packages/docx-engine/src/list-markers.ts).

use std::collections::HashSet;
use std::sync::LazyLock;

use jscompat::{JsMap, JsNum, JsRegex, js_regex, number_to_string, trim, truthy};
use serde::{Deserialize, Serialize};

use crate::numbering::{NumberingDef, NumberingLevel};
use crate::symbol_fonts::{decode_symbol_text, is_symbol_font, to_symbol_pua};

/// Word represents bullets with Symbol/Wingdings private-use characters; map
/// them to common glyphs.
fn bullet_glyph(lvl_text: &str) -> Option<&'static str> {
    match lvl_text {
        "\u{f0b7}" => Some("\u{2022}"),
        "\u{f0a7}" => Some("\u{25aa}"),
        "\u{f0d8}" => Some("\u{27a2}"),
        "\u{f076}" => Some("\u{2756}"),
        "\u{f0fc}" => Some("\u{2713}"),
        "o" => Some("\u{25e6}"),
        _ => None,
    }
}

const DEFAULT_BULLETS: [&str; 9] = [
    "\u{2022}", "\u{25e6}", "\u{25aa}", "\u{2022}", "\u{25e6}", "\u{25aa}", "\u{2022}", "\u{25e6}",
    "\u{25aa}",
];

fn from_char_code(code: f64) -> String {
    char::from_u32(code as u32)
        .map(String::from)
        .unwrap_or_default()
}

fn to_letters(raw_value: f64) -> String {
    // Word: 1..26 -> A..Z, 27 -> AA (repeated same letter, not positional notation)
    let value = raw_value.max(1.0);
    let n = ((value - 1.0) % 26.0) + 1.0;
    let repeat = ((value - 1.0) / 26.0).floor() + 1.0;
    from_char_code(64.0 + n).repeat(repeat as usize)
}

fn to_greek(value: f64, base: f64) -> String {
    if value < 1.0 {
        return number_to_string(value);
    }
    // 24-letter alphabet (no final sigma); 25 -> alpha alpha, repeated like to_letters
    let n = ((value - 1.0) % 24.0) + 1.0;
    let repeat = ((value - 1.0) / 24.0).floor() + 1.0;
    // skip the final-sigma slot between the 17th and 18th letters
    let skip = if n >= 18.0 { 1.0 } else { 0.0 };
    from_char_code(base + n - 1.0 + skip).repeat(repeat as usize)
}

const ROMAN: [(f64, &str); 13] = [
    (1000.0, "M"),
    (900.0, "CM"),
    (500.0, "D"),
    (400.0, "CD"),
    (100.0, "C"),
    (90.0, "XC"),
    (50.0, "L"),
    (40.0, "XL"),
    (10.0, "X"),
    (9.0, "IX"),
    (5.0, "V"),
    (4.0, "IV"),
    (1.0, "I"),
];

fn to_roman(value: f64) -> String {
    let mut n = value.max(1.0);
    let mut out = String::new();
    for (v, s) in ROMAN {
        while n >= v {
            out.push_str(s);
            n -= v;
        }
    }
    out
}

const CN_DIGITS: [&str; 10] = [
    "\u{96f6}", "\u{4e00}", "\u{4e8c}", "\u{4e09}", "\u{56db}", "\u{4e94}", "\u{516d}", "\u{4e03}",
    "\u{516b}", "\u{4e5d}",
];
const CN_UNITS: [&str; 4] = ["", "\u{5341}", "\u{767e}", "\u{5343}"];
const CN_LEGAL_SIMPLIFIED: [&str; 10] = [
    "\u{96f6}", "\u{58f9}", "\u{8d30}", "\u{53c1}", "\u{8086}", "\u{4f0d}", "\u{9646}", "\u{67d2}",
    "\u{634c}", "\u{7396}",
];
const CN_LEGAL_TRADITIONAL: [&str; 10] = [
    "\u{96f6}", "\u{58f9}", "\u{8cb3}", "\u{53c3}", "\u{8086}", "\u{4f0d}", "\u{9678}", "\u{67d2}",
    "\u{634c}", "\u{7396}",
];
const CN_LEGAL_UNITS: [&str; 4] = ["", "\u{62fe}", "\u{4f70}", "\u{4edf}"];

fn to_cjk_counting(
    value: f64,
    digits: &[&str; 10],
    units: &[&str; 4],
    drop_leading_one: bool,
) -> String {
    if value <= 0.0 || value > 9999.0 {
        return number_to_string(value);
    }
    if value < 10.0 {
        return digits
            .get(value as usize)
            .copied()
            .unwrap_or_default()
            .to_owned();
    }
    let zero = digits[0];
    let parts: Vec<usize> = number_to_string(value)
        .chars()
        .map(|d| d.to_digit(10).unwrap_or(0) as usize)
        .collect();
    let mut out = String::new();
    for (i, &d) in parts.iter().enumerate() {
        let unit = units.get(parts.len() - 1 - i).copied().unwrap_or_default();
        if d == 0 {
            if !out.ends_with(zero) && i < parts.len() - 1 {
                out.push_str(zero);
            }
        } else {
            out.push_str(digits.get(d).copied().unwrap_or_default());
            out.push_str(unit);
        }
    }
    let out = out.trim_end_matches(zero);
    // 10-19 drop the leading "one" digit: read as "shi x" rather than "yi shi x"
    if drop_leading_one {
        let leading = format!("{}{}", digits[1], units[1]);
        if let Some(rest) = out.strip_prefix(leading.as_str()) {
            return format!("{}{rest}", units[1]);
        }
    }
    out.to_owned()
}

/// Digit-by-digit transliteration (Word "digital" formats).
fn digit_wise(value: f64, digits: &str) -> String {
    if value < 0.0 {
        return number_to_string(value);
    }
    let table: Vec<char> = digits.chars().collect();
    number_to_string(value)
        .chars()
        .filter_map(|d| d.to_digit(10).and_then(|d| table.get(d as usize)))
        .collect()
}

/// 1..n to the nth code point of an alphabet, else the decimal fallback.
fn from_alphabet(value: f64, alphabet: &str) -> String {
    let letters: Vec<char> = alphabet.chars().collect();
    if (1.0..=letters.len() as f64).contains(&value) {
        letters
            .get(value as usize - 1)
            .map(|letter| letter.to_string())
            .unwrap_or_default()
    } else {
        number_to_string(value)
    }
}

/// Enclosed digit runs (U+2460 circled, U+2474 parenthesized, U+2488 with
/// full stop): 1..count.
fn enclosed(value: f64, base: f64, count: f64) -> String {
    if (1.0..=count).contains(&value) {
        from_char_code(base + value - 1.0)
    } else {
        number_to_string(value)
    }
}

const FW_DIGITS: &str = "０１２３４５６７８９";
const IDEOGRAPH_DIGITS: &str =
    "\u{3007}\u{4e00}\u{4e8c}\u{4e09}\u{56db}\u{4e94}\u{516d}\u{4e03}\u{516b}\u{4e5d}";
const AIUEO_FW: &str =
    "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
const AIUEO_HW: &str = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ";
const IROHA_FW: &str = "イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス";
const GANADA: &str = "가나다라마바사아자차카타파하";
const CHOSUNG: &str = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ";
const RUSSIAN_LOWER: &str = "абвгдежзиклмнопрстуфхцчшщэюя";
const HEAVENLY_STEMS: &str =
    "\u{7532}\u{4e59}\u{4e19}\u{4e01}\u{620a}\u{5df1}\u{5e9a}\u{8f9b}\u{58ec}\u{7678}";
const EARTHLY_BRANCHES: &str = "\u{5b50}\u{4e11}\u{5bc5}\u{536f}\u{8fb0}\u{5df3}\u{5348}\u{672a}\u{7533}\u{9149}\u{620c}\u{4ea5}";

const ONES: [&str; 20] = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
];
const TENS: [&str; 10] = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

fn ordinal_irregular(last: &str) -> Option<&'static str> {
    match last {
        "One" => Some("First"),
        "Two" => Some("Second"),
        "Three" => Some("Third"),
        "Five" => Some("Fifth"),
        "Eight" => Some("Eighth"),
        "Nine" => Some("Ninth"),
        "Twelve" => Some("Twelfth"),
        _ => None,
    }
}

fn ones(index: f64) -> &'static str {
    ONES.get(index as usize).copied().unwrap_or_default()
}

fn cardinal_words(value: f64) -> String {
    if !(1.0..=999_999.0).contains(&value) {
        return number_to_string(value);
    }
    if value < 20.0 {
        return ones(value).to_owned();
    }
    if value < 100.0 {
        let tens = TENS
            .get((value / 10.0).floor() as usize)
            .copied()
            .unwrap_or_default();
        let rest = value % 10.0;
        return if rest != 0.0 {
            format!("{tens}-{}", ones(rest))
        } else {
            tens.to_owned()
        };
    }
    if value < 1000.0 {
        let rest = value % 100.0;
        let tail = if rest != 0.0 {
            format!(" {}", cardinal_words(rest))
        } else {
            String::new()
        };
        return format!("{} Hundred{tail}", ones((value / 100.0).floor()));
    }
    let rest = value % 1000.0;
    let tail = if rest != 0.0 {
        format!(" {}", cardinal_words(rest))
    } else {
        String::new()
    };
    format!(
        "{} Thousand{tail}",
        cardinal_words((value / 1000.0).floor())
    )
}

fn ordinal_words(value: f64) -> String {
    let words = cardinal_words(value);
    if !js_regex!(r"[A-Za-z]$").test(&words) {
        return words;
    }
    js_regex!(r"[A-Za-z]+$").replace_all(&words, |found| {
        let last = found.as_str();
        if let Some(irregular) = ordinal_irregular(last) {
            return irregular.to_owned();
        }
        if let Some(stem) = last.strip_suffix('y') {
            return format!("{stem}ieth");
        }
        format!("{last}th")
    })
}

fn ordinal_suffix(value: f64) -> String {
    let mod100 = value % 100.0;
    let text = number_to_string(value);
    if (11.0..=13.0).contains(&mod100) {
        return format!("{text}th");
    }
    let last = value % 10.0;
    let suffix = if last == 1.0 {
        "st"
    } else if last == 2.0 {
        "nd"
    } else if last == 3.0 {
        "rd"
    } else {
        "th"
    };
    format!("{text}{suffix}")
}

/// w14 custom numFmt enumeration ("α, β, γ, ..."): comma-separated items, a
/// trailing "..." marks continuation.
pub fn custom_enum_items(format: &str) -> Option<Vec<String>> {
    let mut items: Vec<&str> = format.split(',').map(trim).collect();
    while items
        .last()
        .is_some_and(|last| js_regex!(r"^(\.{3}|\u2026)?$").test(last))
    {
        items.pop();
    }
    (items.len() >= 2 && items.iter().all(|item| !item.is_empty()))
        .then(|| items.into_iter().map(str::to_owned).collect())
}

pub fn format_number(raw_value: f64, num_fmt: &str, custom_format: Option<&str>) -> String {
    // Numbering values arrive from the file (w:start/w:val): bound once here,
    // as the TypeScript does, so a hostile 1e9 cannot loop to_roman
    let value = if raw_value.is_finite() {
        raw_value.floor().min(999_999.0)
    } else {
        0.0
    };
    if num_fmt == "custom" {
        let items = truthy(custom_format).and_then(custom_enum_items);
        // enumeration exhausted: cycle (best-effort; Word's continuation rules are undocumented)
        return match items {
            Some(items) if value >= 1.0 => items
                .get(((value - 1.0) % items.len() as f64) as usize)
                .cloned()
                .unwrap_or_default(),
            _ => number_to_string(value),
        };
    }
    match num_fmt {
        "decimalZero" => {
            if (0.0..10.0).contains(&value) {
                format!("0{}", number_to_string(value))
            } else {
                number_to_string(value)
            }
        }
        "lowerLetter" => to_letters(value).to_lowercase(),
        "upperLetter" => to_letters(value),
        "lowerRoman" => to_roman(value).to_lowercase(),
        "upperRoman" => to_roman(value),
        "lowerGreek" => to_greek(value, f64::from(0x3b1_u32)),
        "upperGreek" => to_greek(value, f64::from(0x391_u32)),
        "chineseCounting"
        | "chineseCountingThousand"
        | "japaneseCounting"
        | "taiwaneseCounting"
        | "taiwaneseCountingThousand" => to_cjk_counting(value, &CN_DIGITS, &CN_UNITS, true),
        "chineseLegalSimplified" => {
            to_cjk_counting(value, &CN_LEGAL_SIMPLIFIED, &CN_LEGAL_UNITS, false)
        }
        "ideographLegalTraditional" => {
            to_cjk_counting(value, &CN_LEGAL_TRADITIONAL, &CN_LEGAL_UNITS, false)
        }
        "ideographDigital" | "japaneseDigitalTenThousand" | "taiwaneseDigital" => {
            digit_wise(value, IDEOGRAPH_DIGITS)
        }
        "koreanDigital" => digit_wise(value, "영일이삼사오육칠팔구"),
        "koreanDigital2" => digit_wise(value, IDEOGRAPH_DIGITS),
        "decimalFullWidth" | "decimalFullWidth2" => digit_wise(value, FW_DIGITS),
        "thaiNumbers" => digit_wise(value, "๐๑๒๓๔๕๖๗๘๙"),
        "hindiNumbers" => digit_wise(value, "०१२३४५६७८९"),
        "decimalEnclosedCircle" | "decimalEnclosedCircleChinese" => {
            enclosed(value, f64::from(0x2460_u32), 20.0)
        }
        "decimalEnclosedParen" => enclosed(value, f64::from(0x2474_u32), 20.0),
        "decimalEnclosedFullstop" => enclosed(value, f64::from(0x2488_u32), 20.0),
        "ideographEnclosedCircle" => enclosed(value, f64::from(0x3280_u32), 10.0),
        "ideographTraditional" => from_alphabet(value, HEAVENLY_STEMS),
        "ideographZodiac" => from_alphabet(value, EARTHLY_BRANCHES),
        "aiueo" => from_alphabet(value, AIUEO_HW),
        "aiueoFullWidth" => from_alphabet(value, AIUEO_FW),
        "irohaFullWidth" => from_alphabet(value, IROHA_FW),
        "ganada" => from_alphabet(value, GANADA),
        "chosung" => from_alphabet(value, CHOSUNG),
        "russianLower" => from_alphabet(value, RUSSIAN_LOWER),
        "russianUpper" => from_alphabet(value, &RUSSIAN_LOWER.to_uppercase()),
        "ordinal" => ordinal_suffix(value),
        "cardinalText" => cardinal_words(value),
        "ordinalText" => ordinal_words(value),
        "numberInDash" => format!("- {} -", number_to_string(value)),
        "none" => String::new(),
        _ => number_to_string(value),
    }
}

/// w:isLgl leaves Arabic-digit formats alone and turns every other one into decimal.
const ARABIC_FORMATS: [&str; 2] = ["decimal", "decimalZero"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItemRef {
    pub num_id: Option<String>,
    pub ilvl: JsNum,
    /// The paragraph mark is a tracked deletion: Word merges it into the next
    /// paragraph, so it shows that paragraph's number without consuming one.
    #[serde(default)]
    pub deleted: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMarkerInfo {
    /// Display text (symbol glyphs decoded to Unicode).
    pub text: String,
    /// A bullet declared in a symbol-encoded font: the original glyph in
    /// U+F0xx form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_char: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pic_bullet_src: Option<String>,
    /// Literal bullet text declared in an ordinary text font.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// The item's own counter value (numbered levels only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsNum>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BulletSubstitute {
    pub glyph: &'static str,
    pub face: &'static str,
}

/// Word symbol bullets with no glyph on this platform: Liberation Sans' U+25CF
/// through a size-adjusted alias carrying the Word face's ink size.
pub fn substitute_bullet(glyph: &str) -> Option<BulletSubstitute> {
    match glyph {
        "\u{2022}" => Some(BulletSubstitute {
            glyph: "\u{25cf}",
            face: "Symbol Bullet GO",
        }),
        "\u{25cf}" => Some(BulletSubstitute {
            glyph: "\u{25cf}",
            face: "Wingdings Bullet GO",
        }),
        _ => None,
    }
}

pub static SEGOE_UI_SYMBOL_RE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(r"^segoe ui symbol$", "").expect("a pattern literal that compiles")
});

/// Bullet glyphs none of Word's common Latin text faces carry: Word draws
/// them in Segoe UI Symbol.
const SEGOE_FALLBACK_GLYPHS: [char; 12] = [
    '\u{25b8}', '\u{25b9}', '\u{25c6}', '\u{25c7}', '\u{27a2}', '\u{27a4}', '\u{2714}', '\u{2726}',
    '\u{2756}', '\u{2605}', '\u{2606}', '\u{2794}',
];

/// Whether a face lacks the glyph: glyphs only some of the common faces lack,
/// by the faces known to lack them.
fn partial_fallback(face: &str, glyph: char) -> bool {
    [
        (
            js_regex!(r"calibri|arial|times|cambria|verdana|tahoma"),
            "\u{2713}\u{2610}\u{2611}",
        ),
        (
            js_regex!(r"calibri|cambria|aptos|verdana"),
            "\u{2023}\u{25a0}\u{25ba}\u{25b2}\u{25bc}\u{2043}",
        ),
        (
            js_regex!(r"cambria"),
            "\u{25aa}\u{25ab}\u{25a1}\u{25cf}\u{25e6}",
        ),
    ]
    .iter()
    .any(|(re, set)| re.test(face) && set.contains(glyph))
}

/// The face Word substitutes when a text-font marker glyph is missing from its face.
pub fn marker_fallback_face(glyph: &str, face: &str) -> Option<&'static str> {
    let mut cps = glyph.chars();
    let (Some(cp), None) = (cps.next(), cps.next()) else {
        return None;
    };
    let f = trim(face).to_lowercase();
    if SEGOE_UI_SYMBOL_RE.test(&f) || is_symbol_font(Some(face)) {
        return None;
    }
    if SEGOE_FALLBACK_GLYPHS.contains(&cp) {
        return Some("Segoe UI Symbol");
    }
    partial_fallback(&f, cp).then_some("Segoe UI Symbol")
}

fn bullet_info(text: String, level: &NumberingLevel) -> ListMarkerInfo {
    let font = truthy(level.font.as_deref().map(trim));
    match font {
        Some(font) if is_symbol_font(Some(font)) => ListMarkerInfo {
            text,
            symbol_char: Some(to_symbol_pua(level.lvl_text())),
            symbol_font: Some(font.to_owned()),
            ..ListMarkerInfo::default()
        },
        _ => ListMarkerInfo {
            text,
            ..ListMarkerInfo::default()
        },
    }
}

/// `Math.max(0, x)`: NaN stays NaN.
fn max0(x: f64) -> f64 {
    if x.is_nan() || x > 0.0 { x } else { 0.0 }
}

fn counter(c: &[Option<f64>], index: usize) -> Option<f64> {
    c.get(index).copied().flatten()
}

fn set_counter(c: &mut Vec<Option<f64>>, index: usize, value: f64) {
    if c.len() <= index {
        c.resize(index + 1, None);
    }
    if let Some(slot) = c.get_mut(index) {
        *slot = Some(value);
    }
}

fn marker_info(
    item: &ListItemRef,
    defs: &JsMap<NumberingDef>,
    counters: &mut JsMap<Vec<Option<f64>>>,
    override_applied: &mut HashSet<String>,
) -> Option<ListMarkerInfo> {
    let def = defs.get(item.num_id.as_deref()?)?;
    let lvl = max0(item.ilvl.0);
    let level = def.levels.get(&number_to_string(lvl))?;

    if level.num_fmt() == "bullet" {
        // the lvlText of a picture bullet is a placeholder glyph, never shown
        if level.pic_bullet_id.is_some() {
            return Some(match truthy(level.pic_bullet_src.as_deref()) {
                Some(src) => ListMarkerInfo {
                    text: String::new(),
                    pic_bullet_src: Some(src.to_owned()),
                    ..ListMarkerInfo::default()
                },
                None => ListMarkerInfo {
                    text: DEFAULT_BULLETS[0].to_owned(),
                    ..ListMarkerInfo::default()
                },
            });
        }
        // symbol-encoded marker fonts (Wingdings "l" = black circle): decode by font first
        let decoded = truthy(level.font.as_deref())
            .and_then(|font| decode_symbol_text(font, level.lvl_text(), false));
        if let Some(text_font) = truthy(level.font.as_deref().map(trim))
            && !is_symbol_font(Some(text_font))
            && js_regex!(r"^[^\s\uf000-\uf0ff]+$").test(level.lvl_text())
        {
            return Some(ListMarkerInfo {
                text: level.lvl_text().to_owned(),
                font: Some(text_font.to_owned()),
                ..ListMarkerInfo::default()
            });
        }
        let glyph = decoded
            .clone()
            .or_else(|| bullet_glyph(level.lvl_text()).map(str::to_owned))
            .unwrap_or_else(|| level.lvl_text().to_owned());
        // undecodable symbol-font glyphs, private-use or empty ones fall back to the per-level default
        if glyph.is_empty()
            || js_regex!(r"[\ue000-\uf8ff]").test(&glyph)
            || (decoded.is_none() && is_symbol_font(level.font.as_deref()))
        {
            let fallback = DEFAULT_BULLETS
                .get((lvl % 9.0) as usize)
                .copied()
                .unwrap_or_default();
            return Some(bullet_info(fallback.to_owned(), level));
        }
        return Some(bullet_info(glyph, level));
    }

    let deleted = item.deleted == Some(true);
    let mut c = counters
        .get(&def.abstract_num_id)
        .cloned()
        .unwrap_or_default();
    let mut applied_copy;
    let applied: &mut HashSet<String> = if deleted {
        applied_copy = override_applied.clone();
        &mut applied_copy
    } else {
        override_applied
    };
    let lvl_index = lvl as usize;
    // Word: an item at level L instantiates untouched shallower levels at
    // their start value, so a later explicit item there increments past it
    for a in 0..lvl_index {
        if counter(&c, a).is_some() {
            continue;
        }
        let a_key = format!("{}:{a}", def.num_id);
        match def.start_overrides.get(&a.to_string()) {
            Some(start) if !applied.contains(&a_key) => {
                applied.insert(a_key);
                set_counter(&mut c, a, start.0);
            }
            _ => {
                let start = def.levels.get(&a.to_string()).map_or(1.0, |l| l.start());
                set_counter(&mut c, a, start);
            }
        }
    }
    let override_key = format!("{}:{}", def.num_id, number_to_string(lvl));
    match def.start_overrides.get(&number_to_string(lvl)) {
        Some(start) if !applied.contains(&override_key) => {
            applied.insert(override_key);
            set_counter(&mut c, lvl_index, start.0);
        }
        _ => {
            let previous = counter(&c, lvl_index).unwrap_or(level.start() - 1.0);
            set_counter(&mut c, lvl_index, previous + 1.0);
        }
    }
    c.resize(lvl_index + 1, None);
    if !deleted {
        counters.set(def.abstract_num_id.clone(), c.clone());
    }

    let marker = js_regex!(r"%(\d)", "g").replace_all(level.lvl_text(), |found| {
        let d = found.get(1).unwrap_or_default();
        let ref_lvl = d.parse::<f64>().unwrap_or(f64::NAN) - 1.0;
        let ref_def = def.levels.get(&number_to_string(ref_lvl));
        let value = if ref_lvl >= 0.0 {
            counter(&c, ref_lvl as usize)
        } else {
            None
        }
        .or(ref_def.map(|l| l.start()))
        .unwrap_or(1.0);
        let fmt = ref_def.map_or("decimal", |l| l.num_fmt());
        if *level.is_lgl == Some(true) && !ARABIC_FORMATS.contains(&fmt) {
            return number_to_string(value);
        }
        format_number(value, fmt, ref_def.and_then(|l| l.custom_format.as_deref()))
    });
    // numFmt "none" or an empty lvlText: an explicit empty marker (Word shows
    // nothing) so renderer counter fallbacks don't kick in on the null
    Some(ListMarkerInfo {
        text: marker,
        value: counter(&c, lvl_index).map(JsNum),
        ..ListMarkerInfo::default()
    })
}

/// Word numbering semantics: counters accumulate document-wide per
/// abstractNum; when a level appears, its deeper levels reset; startOverride
/// applies the first time that numId uses the level. One entry per item;
/// `None` for an item without a definition.
pub fn compute_list_marker_infos(
    items: &[ListItemRef],
    defs: &JsMap<NumberingDef>,
) -> Vec<Option<ListMarkerInfo>> {
    let mut counters = JsMap::new();
    let mut override_applied = HashSet::new();
    items
        .iter()
        .map(|item| marker_info(item, defs, &mut counters, &mut override_applied))
        .collect()
}

/// Per item: the counter value its own level shows (1 for bullets and unresolved items).
pub fn compute_list_values(items: &[ListItemRef], defs: &JsMap<NumberingDef>) -> Vec<JsNum> {
    compute_list_marker_infos(items, defs)
        .into_iter()
        .map(|m| m.and_then(|m| m.value).unwrap_or(JsNum(1.0)))
        .collect()
}

pub fn compute_list_markers(
    items: &[ListItemRef],
    defs: &JsMap<NumberingDef>,
) -> Vec<Option<String>> {
    compute_list_marker_infos(items, defs)
        .into_iter()
        .map(|m| m.map(|m| m.text))
        .collect()
}

/// Word's default tab after a numbering marker (twips, relative to the text
/// column edge): the marker-box width, or `None` when the text starts at the
/// hanging indent. See the TypeScript for the rules.
pub fn marker_tab_advance(
    marker_start: f64,
    marker_width: f64,
    text_indent: f64,
    default_tab: f64,
    custom_stops: &[f64],
) -> Option<f64> {
    let end = marker_start + marker_width;
    // `filter(...).sort((a, b) => a - b)[0]`: the smallest, the first of equals
    let first_of = |keep: &dyn Fn(f64) -> bool| {
        custom_stops
            .iter()
            .copied()
            .filter(|&s| keep(s))
            .fold(None, |best: Option<f64>, s| match best {
                Some(b) if b <= s => Some(b),
                _ => Some(s),
            })
    };
    if marker_start < text_indent && end <= text_indent {
        let inside = first_of(&|s: f64| s > end && s < text_indent);
        return inside.map(|inside| inside - marker_start);
    }
    if let Some(custom) = first_of(&|s: f64| s > end) {
        return Some(custom - marker_start);
    }
    // no default grid (w:defaultTabStop 0): the text follows the marker directly
    if default_tab.is_nan() || default_tab <= 0.0 {
        return Some(marker_width);
    }
    let floor = custom_stops.iter().copied().fold(end, js_max);
    let stop = ((floor / default_tab).floor() + 1.0) * default_tab;
    Some(stop - marker_start)
}

/// `Math.max(a, b)`: NaN wins, and +0 is larger than -0.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { b } else { a }
    } else {
        a.max(b)
    }
}
