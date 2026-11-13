//! JavaScript primitives, reproduced bit for bit.
//!
//! The TypeScript engines lean on the exact behaviour of `parseInt`, `Number`,
//! `Math.round`, number formatting and regular expressions. A port that
//! approximates them differs on real documents, so every such operation goes
//! through this crate and nowhere else.

mod atob;
mod date;
mod date_iso;
mod date_parse;
mod json;
mod json_print;
mod json_value;
mod map;
mod math;
mod node_buffer_base64;
pub mod node_path;
mod number;
mod object;
mod random;
mod regex;
mod replace;
mod search;
mod sha1;
mod sort;
mod space;
mod string;
mod uri;
mod uri_encode;
mod value;
#[doc(hidden)]
pub mod wire;

pub use atob::{InvalidCharacterError, atob};
pub use date::utc_date_parts;
pub use date_iso::to_iso_string;
pub use date_parse::date_parse;
pub use json::{JsNum, json_to_string};
pub use json_print::{
    json_quote, json_quote_slice, json_stringify, json_stringify_pretty, json_value_from_serde,
    json_value_to_serde,
};
pub use json_value::{
    JSON_MAX_DEPTH, JsTypeError, JsonSyntaxError, JsonValue, Primitive, json_parse,
    string_from_char_code, text_decoder_decode, to_primitive, to_property_key,
};
pub use map::JsMap;
pub use math::{
    math_atan2, math_cos, math_hypot, math_max, math_min, math_pow, math_sign, math_sin, math_tan,
    number_truthy,
};
pub use node_buffer_base64::buffer_from_base64;
pub use number::{
    Radix, math_round, number_to_string, parse_float, parse_int, to_int32, to_number,
    to_string_radix16,
};
pub use object::{JsObject, Slot, array_index, camel, camel_len, inherited_string};
pub use random::{math_random, random_uuid};
pub use regex::{
    BACKTRACK_LIMIT, JsMatch, JsMatches, JsRegex, RegexError, RegexLimit, RegexSyntaxError,
    TryJsRegex,
};
pub use replace::{
    get_substitution, replace_first, replace_first_string, slice_utf16, string_less_than,
};
pub use search::{
    index_of, last_index_of, prefix_utf16, regex_escape, replace_first_with, try_replace_first_with,
};
pub use sha1::sha1_hex;
pub use sort::sort_by_number;
pub use space::{is_js_space, trim, trim_start};
pub use string::{pad_start, truthy};
pub use uri::{UriError, base64, decode_uri_component};
pub use uri_encode::encode_uri_component;
pub use value::{value_to_string, value_truthy};

/// For the code [`js_object!`] writes.
#[doc(hidden)]
pub use serde;
