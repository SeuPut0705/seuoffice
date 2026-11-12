//! `parse.*`: the internal functions of parse.ts, by their TypeScript names.
//! `breakCharOf` takes `args.attrs`, the attributes of the `w:br`; `wtText`
//! takes the text and `args.preserve`.

use std::collections::BTreeMap;

use docx_engine::parse::text;
use serde_json::Value;

use super::{Returned, required, value};

pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Returned {
    match function {
        "breakCharOf" => {
            let attrs = required::<BTreeMap<String, String>>(args, "attrs")?;
            value(
                text::break_char_of(
                    attrs.get("w:clear").map(String::as_str),
                    attrs.get("w:type").map(String::as_str),
                )
                .to_string(),
            )
        }
        "wtText" => value(text::wt_text(text_arg, required::<bool>(args, "preserve")?)),
        _ => Err(format!("no function {function}")),
    }
}
