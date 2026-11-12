//! `apps/pdf/src/shared/font-classes.ts`: font look-alike classification
//! shared by the save side and the on-screen draft. The names the table keys
//! match are NFKC, lower case, with spaces, `-`, `_` and `,` removed.

use super::font_locate::nfkc;
use jscompat::{JsRegex, is_js_space, js_regex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontScript {
    Ko,
    Ja,
    Zh,
    Latin,
}

impl FontScript {
    pub fn as_str(self) -> &'static str {
        match self {
            FontScript::Ko => "ko",
            FontScript::Ja => "ja",
            FontScript::Zh => "zh",
            FontScript::Latin => "latin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontStyleClass {
    Serif,
    Sans,
    Mono,
    Brush,
}

impl FontStyleClass {
    pub fn as_str(self) -> &'static str {
        match self {
            FontStyleClass::Serif => "serif",
            FontStyleClass::Sans => "sans",
            FontStyleClass::Mono => "mono",
            FontStyleClass::Brush => "brush",
        }
    }
}

/// `FontClass`: unknown parts stay `None`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FontClass {
    pub script: Option<FontScript>,
    pub style: Option<FontStyleClass>,
    pub bold: bool,
    pub italic: bool,
}

/// Font names arrive as raw bytes: a PDF name is a byte string, and Korean
/// producers write the face name in CP949. UTF-8 first, then CP949 (WHATWG
/// `euc-kr`), else Latin-1: both decoders strict.
pub fn decode_font_name(bytes: &[u8]) -> String {
    // new TextDecoder('utf-8', { fatal: true }).decode drops a leading byte order mark
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.strip_prefix('\u{feff}').unwrap_or(text).to_owned();
    }
    if let Some(text) =
        encoding_rs::EUC_KR.decode_without_bom_handling_and_without_replacement(bytes)
    {
        return text.into_owned();
    }
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// A name read as one char per byte (pdf.js names) back through [`decode_font_name`]
pub fn redecode_byte_string(name: &str) -> String {
    if !js_regex!(r"[\u0080-\u00FF]").test(name) || js_regex!(r"[\u0100-\uFFFF]").test(name) {
        return name.to_owned();
    }
    // every code unit is at most 0xFF here
    let bytes: Vec<u8> = name.chars().map(|c| u32::from(c) as u8).collect();
    decode_font_name(&bytes)
}

fn hangul() -> &'static JsRegex {
    js_regex!(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")
}
fn kana() -> &'static JsRegex {
    js_regex!(r"[\u3040-\u30FF\uFF66-\uFF9F]")
}
fn han() -> &'static JsRegex {
    js_regex!(r"[\u3400-\u9FFF\uF900-\uFAFF]")
}

fn ko_brush() -> &'static JsRegex {
    js_regex!(r"\uAD81\uC11C|\uAD81\uCCB4|gungsuh|gungseo|gungso|gungche")
}
fn ko_serif() -> &'static JsRegex {
    js_regex!(
        r"\uBA85\uC870|\uBC14\uD0D5|myeongjo|myungjo|batang|serif(cjk)?kr|sourcehanserifk|unbatang|applemyungjo"
    )
}
fn ko_sans() -> &'static JsRegex {
    js_regex!(
        r"\uACE0\uB515|\uB3CB\uC6C0|\uAD74\uB9BC|\uD5E4\uB4DC\uB77C\uC778|dotum|dodum|gulim|malgun|gothic|headline|sans(cjk)?kr|sourcehansansk|pretendard|spoqa|undotum|nanumsquare|nanumbarun"
    )
}
/// Korean by name alone even without a style word (HY/HCR/KoPub/Nanum families)
fn ko_name() -> &'static JsRegex {
    js_regex!(
        r"^hy[a-z]|^hcr|^han(batang|dotum)|kopub|nanum|gowun|malgun|batang|dotum|dodum|gulim|gungsuh|myeongjo|myungjo|applesdgothic|applemyungjo|(serif|sans)(cjk)?kr|sourcehan(sans|serif)k"
    )
}

fn ja_serif() -> &'static JsRegex {
    js_regex!(r"\u660E\u671D|mincho|ryumin|kozmin")
}
fn ja_name() -> &'static JsRegex {
    js_regex!(
        r"\u660E\u671D|\u30B4\u30B7\u30C3\u30AF|mincho|yugothic|msgothic|mspgothic|msuigothic|meiryo|hiragino(?!sansgb)|kozuka|kozmin|kozgo|ryumin|gothicbbb|ipa(ex|p)?(gothic|mincho)|(serif|sans)(cjk)?jp|takao|osaka"
    )
}

fn zh_brush() -> &'static JsRegex {
    js_regex!(r"kai|\u6977")
}
fn zh_serif() -> &'static JsRegex {
    js_regex!(r"song|sung|ming|simsun|\u5B8B|\u660E|serif|\u4EFF\u5B8B")
}
// Whole-name families and anchored stems only: a bare "sung"/"ming" would claim
// Latin names such as Samsung Sans or Gaming
fn zh_name() -> &'static JsRegex {
    js_regex!(
        r"simsun|simhei|songti|stsong|stheiti|stkaiti|stfangsong|heiti|kaiti|fangsong|yahei|jhenghei|pingfang|dengxian|mingliu|^ming|^song|^fz|adobe(song|ming|heiti|kaiti|fangsong)|hiraginosansgb|sourcehan(sans|serif)(sc|tc|cn|tw|hk)|(serif|sans)cjk(sc|tc|hk)|(serif|sans)(sc|tc|hk)$|[\u3400-\u9FFF]"
    )
}

fn latin_mono() -> &'static JsRegex {
    js_regex!(r"courier|mono|consolas|menlo|lucidaconsole|typewriter")
}
fn latin_sans() -> &'static JsRegex {
    js_regex!(
        r"sans|arial|helvetica|verdana|tahoma|segoe|calibri|futura|frutiger|myriad|univers|gill|franklin|trebuchet|lato|roboto|opensans|gothic"
    )
}
fn latin_serif() -> &'static JsRegex {
    js_regex!(
        r"serif|times|georgia|garamond|palatino|baskerville|caslon|charter|bookman|bookantiqua|century|cambria|roman|minion|didot|bodoni|constantia|tinos"
    )
}

fn bold_re() -> &'static JsRegex {
    js_regex!(r"bold|black|heavy")
}
fn italic_re() -> &'static JsRegex {
    js_regex!(r"italic|oblique")
}

/// Classify by the face name (subset tag stripped). Unknown parts stay `None`
/// so other evidence (PANOSE, PDF flags) can fill them.
pub fn classify_font_name(name: &str) -> FontClass {
    let stripped = js_regex!(r"^[A-Z]{6}\+").replace_all(name, |_| String::new());
    let key: String = nfkc(&stripped)
        .to_lowercase()
        .chars()
        .filter(|&c| !(is_js_space(c) || c == '-' || c == '_' || c == ','))
        .collect();
    let bold = bold_re().test(&key);
    let italic = italic_re().test(&key);
    if hangul().test(&key) || ko_name().test(&key) {
        let style = if ko_brush().test(&key) {
            Some(FontStyleClass::Brush)
        } else if ko_serif().test(&key) {
            Some(FontStyleClass::Serif)
        } else if ko_sans().test(&key) {
            Some(FontStyleClass::Sans)
        } else {
            None
        };
        return FontClass {
            script: Some(FontScript::Ko),
            style,
            bold,
            italic,
        };
    }
    if kana().test(&key) || ja_name().test(&key) {
        return FontClass {
            script: Some(FontScript::Ja),
            style: Some(if ja_serif().test(&key) {
                FontStyleClass::Serif
            } else {
                FontStyleClass::Sans
            }),
            bold,
            italic,
        };
    }
    if zh_name().test(&key) {
        let style = if zh_brush().test(&key) {
            FontStyleClass::Brush
        } else if zh_serif().test(&key) {
            FontStyleClass::Serif
        } else {
            FontStyleClass::Sans
        };
        return FontClass {
            script: Some(FontScript::Zh),
            style: Some(style),
            bold,
            italic,
        };
    }
    if !js_regex!(r"[a-z]").test(&key) {
        return FontClass {
            script: None,
            style: None,
            bold,
            italic,
        };
    }
    // A latin name: sans before serif ("Microsoft Sans Serif"), mono first of all
    let style = if latin_mono().test(&key) {
        Some(FontStyleClass::Mono)
    } else if latin_sans().test(&key) {
        Some(FontStyleClass::Sans)
    } else if latin_serif().test(&key) {
        Some(FontStyleClass::Serif)
    } else {
        None
    };
    FontClass {
        script: style.map(|_| FontScript::Latin),
        style,
        bold,
        italic,
    }
}

/// Script the stand-in must belong to: the text forces it when the document's
/// face cannot be from a script that draws it (Hangul needs a Korean face,
/// kana a Japanese one); otherwise the document face's script wins.
pub fn stand_in_script(face_script: Option<FontScript>, drawn: &str) -> FontScript {
    if hangul().test(drawn) {
        return FontScript::Ko;
    }
    if kana().test(drawn) {
        return if face_script == Some(FontScript::Ko) {
            FontScript::Ko
        } else {
            FontScript::Ja
        };
    }
    if let Some(script) = face_script {
        return script;
    }
    if han().test(drawn) {
        FontScript::Zh
    } else {
        FontScript::Latin
    }
}

/// `LOOKALIKE_FAMILIES[script][style]`: installed look-alikes, most faithful first
pub fn lookalike_families(script: FontScript, style: FontStyleClass) -> &'static [&'static str] {
    use FontScript::{Ja, Ko, Latin, Zh};
    use FontStyleClass::{Brush, Mono, Sans, Serif};
    match (script, style) {
        (Ko, Serif) => &[
            "HCR Batang",
            "Batang",
            "AppleMyungjo",
            "Noto Serif CJK KR",
            "Noto Serif KR",
            "Source Han Serif K",
            "NanumMyeongjo",
            "UnBatang",
        ],
        (Ko, Sans) => &[
            "HCR Dotum",
            "Malgun Gothic",
            "Dotum",
            "Gulim",
            "Apple SD Gothic Neo",
            "Noto Sans CJK KR",
            "Noto Sans KR",
            "Source Han Sans K",
            "NanumGothic",
            "UnDotum",
        ],
        (Ko, Brush) => &[
            "Gungsuh",
            "HCR Batang",
            "Batang",
            "AppleMyungjo",
            "Noto Serif CJK KR",
        ],
        (Ko, Mono) => &[
            "GulimChe",
            "DotumChe",
            "Malgun Gothic",
            "Apple SD Gothic Neo",
            "Noto Sans CJK KR",
        ],
        (Ja, Serif) => &[
            "Yu Mincho",
            "MS Mincho",
            "Hiragino Mincho ProN",
            "Noto Serif CJK JP",
            "Noto Serif JP",
        ],
        (Ja, Sans) => &[
            "Yu Gothic",
            "Meiryo",
            "MS Gothic",
            "Hiragino Sans",
            "Hiragino Kaku Gothic ProN",
            "Noto Sans CJK JP",
            "Noto Sans JP",
        ],
        (Ja, Brush) => &[
            "Yu Mincho",
            "MS Mincho",
            "Hiragino Mincho ProN",
            "Noto Serif CJK JP",
        ],
        (Ja, Mono) => &["MS Gothic", "Yu Gothic", "Noto Sans CJK JP"],
        (Zh, Serif) => &[
            "SimSun",
            "Songti SC",
            "STSong",
            "Noto Serif CJK SC",
            "Noto Serif SC",
        ],
        (Zh, Sans) => &[
            "Microsoft YaHei",
            "PingFang SC",
            "SimHei",
            "Noto Sans CJK SC",
            "Noto Sans SC",
        ],
        (Zh, Brush) => &["KaiTi", "Kaiti SC", "STKaiti", "SimSun", "Songti SC"],
        (Zh, Mono) => &[
            "SimSun",
            "Microsoft YaHei",
            "PingFang SC",
            "Noto Sans CJK SC",
        ],
        (Latin, Serif) => &[
            "Times New Roman",
            "Liberation Serif",
            "Tinos",
            "Nimbus Roman",
            "Times",
            "Georgia",
            "DejaVu Serif",
        ],
        (Latin, Sans) => &[
            "Arial",
            "Helvetica",
            "Liberation Sans",
            "Arimo",
            "Nimbus Sans",
            "Segoe UI",
            "DejaVu Sans",
        ],
        (Latin, Mono) => &[
            "Courier New",
            "Liberation Mono",
            "Cousine",
            "Nimbus Mono PS",
            "Courier",
            "Consolas",
            "Menlo",
            "DejaVu Sans Mono",
        ],
        (Latin, Brush) => &["Times New Roman", "Liberation Serif", "Times", "Georgia"],
    }
}
