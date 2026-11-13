//! `charclass.*`: the char-class.ts functions the Rust engine reads itself
//! (the other predicates stay TypeScript only: the layout calls them per
//! character). The code point ones take `args.cp`, `isEastAsianLangTag`
//! `args.tag` (null for none) and `args.korean` (absent for the default).

use docx_engine::char_class as cc;
use serde_json::Value;

use super::{Returned, arg, required, value};

pub fn dispatch(function: &str, _text: &str, args: &Value) -> Returned {
    let cp = || required::<u32>(args, "cp");
    match function {
        "charClass" => value(cc::char_class(cp()?)),
        "isDoubleByteChar" => value(cc::is_double_byte_char(cp()?)),
        "isEastAsianLangTag" => value(cc::is_east_asian_lang_tag(
            arg::<Option<String>>(args, "tag")?.flatten().as_deref(),
            arg::<bool>(args, "korean")?.unwrap_or(true),
        )),
        _ => Err(format!("no function {function}")),
    }
}
