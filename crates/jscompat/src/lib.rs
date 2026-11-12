//! JavaScript primitives, reproduced bit for bit.
//!
//! The TypeScript engines lean on the exact behaviour of `parseInt`, `Number`,
//! `Math.round`, number formatting and regular expressions. A port that
//! approximates them differs on real documents, so every such operation goes
//! through this crate and nowhere else.

mod json;
mod map;
mod number;
mod object;
mod regex;
mod space;
mod string;
mod uri;

pub use json::JsNum;
pub use map::JsMap;
pub use number::{
    Radix, math_round, number_to_string, parse_float, parse_int, to_int32, to_number,
    to_string_radix16,
};
pub use object::{JsObject, Slot, array_index, camel, camel_len};
pub use regex::{
    BACKTRACK_LIMIT, JsMatch, JsMatches, JsRegex, RegexError, RegexLimit, RegexSyntaxError,
    TryJsRegex,
};
pub use space::{is_js_space, trim, trim_start};
pub use string::{pad_start, truthy};
pub use uri::{UriError, base64, decode_uri_component};

/// For the code [`js_object!`] writes.
#[doc(hidden)]
pub use serde;
