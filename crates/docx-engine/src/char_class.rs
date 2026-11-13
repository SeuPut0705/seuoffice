//! char-class.ts: the one character classification every Word-layout rule
//! reads. A class is the vocabulary (Word's single-byte / double-byte split,
//! East Asian script membership, the gaps autospace pads).

use jscompat::js_regex;
use serde::Serialize;

/// `CharClass`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CharClass {
    Han,
    Kana,
    Hangul,
    Bopomofo,
    CjkPunct,
    CjkSymbol,
    Fullwidth,
    #[serde(rename = "halfwidthEA")]
    HalfwidthEa,
    IdeographicSpace,
    LatinLetter,
    Digit,
    AsciiPunct,
    Space,
    Nbsp,
    Tab,
    Other,
}

/// `charClass`
pub fn char_class(cp: u32) -> CharClass {
    use CharClass::*;
    if cp < 0x80 {
        return match cp {
            0x20 => Space,
            0x09 => Tab,
            0x30..=0x39 => Digit,
            0x41..=0x5a | 0x61..=0x7a => LatinLetter,
            0x21..=0x7e => AsciiPunct,
            _ => Other,
        };
    }
    if cp == 0xa0 {
        return Nbsp;
    }
    if cp < 0x1100 {
        // Latin-1 Supplement / Extended letters, minus the multiply and divide signs
        return if (0xc0..=0x24f).contains(&cp) && cp != 0xd7 && cp != 0xf7 {
            LatinLetter
        } else {
            Other
        };
    }
    match cp {
        0x1100..=0x11ff => Hangul,
        // Kangxi / CJK radicals, ideographic description
        0x2e80..=0x2fff => Han,
        0x3000 => IdeographicSpace,
        0x3005 | 0x3007 | 0x3021..=0x3029 => Han,
        0x3001..=0x3004 | 0x3006 | 0x3008..=0x3020 | 0x302a..=0x303f | 0x30fb => CjkPunct,
        0x3040..=0x30fa | 0x30fc..=0x30ff => Kana,
        0x3100..=0x312f => Bopomofo,
        0x3130..=0x318f => Hangul,
        // kanbun
        0x3190..=0x319f => CjkSymbol,
        0x31a0..=0x31bf => Bopomofo,
        // CJK strokes
        0x31c0..=0x31ef => CjkSymbol,
        0x31f0..=0x31ff => Kana,
        // enclosed letters and months, compatibility
        0x3200..=0x33ff => CjkSymbol,
        0x3400..=0x4dbf => Han,
        // Yijing hexagrams
        0x4dc0..=0x4dff => CjkSymbol,
        0x4e00..=0x9fff => Han,
        0xa960..=0xa97f | 0xac00..=0xd7ff => Hangul,
        0xf900..=0xfaff => Han,
        0xff00..=0xff60 | 0xffe0..=0xffe6 => Fullwidth,
        0xff61..=0xffdc | 0xffe8..=0xffee => HalfwidthEa,
        0x20000..=0x3ffff => Han,
        _ => Other,
    }
}

/// `isEastAsianChar`: the scripts, their punctuation, symbols and width forms
fn is_east_asian_char(cp: u32) -> bool {
    use CharClass::*;
    matches!(
        char_class(cp),
        Han | Kana
            | Hangul
            | Bopomofo
            | CjkPunct
            | CjkSymbol
            | Fullwidth
            | HalfwidthEa
            | IdeographicSpace
    )
}

/// `isDoubleByteChar`: an East Asian character of full-width advance
pub fn is_double_byte_char(cp: u32) -> bool {
    is_east_asian_char(cp) && char_class(cp) != CharClass::HalfwidthEa
}

/// `isEastAsianLangTag`: zh / ja / ko, or ja / zh only without `korean`
pub fn is_east_asian_lang_tag(tag: Option<&str>, korean: bool) -> bool {
    let Some(tag) = tag.filter(|tag| !tag.is_empty()) else {
        return false;
    };
    if korean {
        js_regex!(r"^(?:ja|zh|ko)(?:[-_]|$)", "i").test(tag)
    } else {
        js_regex!(r"^(?:ja|zh)(?:[-_]|$)", "i").test(tag)
    }
}
