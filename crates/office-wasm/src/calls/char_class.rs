//! `charclass.*`: char-class.ts. The code point predicates take `args.cp`, the
//! text ones the text, `isEastAsianLangTag` `args.tag` (null for none) and
//! `args.korean` (absent for the default).

use docx_engine::char_class as cc;
use serde_json::Value;

use super::{Returned, arg, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let cp = || required::<u32>(args, "cp");
    match function {
        "charClass" => value(cc::char_class(cp()?)),
        "isHangulChar" => value(cc::is_hangul_char(cp()?)),
        "isEastAsianChar" => value(cc::is_east_asian_char(cp()?)),
        "isDoubleByteChar" => value(cc::is_double_byte_char(cp()?)),
        "isCjkLetterChar" => value(cc::is_cjk_letter_char(cp()?)),
        "isLatinAlnumChar" => value(cc::is_latin_alnum_char(cp()?)),
        "textHasEastAsian" => value(cc::text_has_east_asian(text)),
        "textHasHangulChars" => value(cc::text_has_hangul_chars(text)),
        "isEastAsianLangTag" => value(cc::is_east_asian_lang_tag(
            arg::<Option<String>>(args, "tag")?.flatten().as_deref(),
            arg::<bool>(args, "korean")?.unwrap_or(true),
        )),
        _ => Err(format!("no function {function}")),
    }
}
