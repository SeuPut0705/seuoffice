//! JavaScript primitives, reproduced bit for bit.
//!
//! The TypeScript engines lean on the exact behaviour of `parseInt`, `Number`,
//! `Math.round`, number formatting and regular expressions. A port that
//! approximates them differs on real documents, so every such operation goes
//! through this crate and nowhere else.

mod json;
mod number;
mod regex;
mod space;
mod string;

pub use json::JsNum;
pub use number::{
    Radix, math_round, number_to_string, parse_float, parse_int, to_int32, to_number,
    to_string_radix16,
};
pub use regex::{JsMatch, JsRegex, RegexSyntaxError};
pub use space::{is_js_space, trim, trim_start};
pub use string::{pad_start, truthy};
