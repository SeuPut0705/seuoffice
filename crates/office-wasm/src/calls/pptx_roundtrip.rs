//! `pptxRoundtrip.*`: a model value of the slides engine as the binding sends
//! it (what `JSON.stringify` writes of the TypeScript's), read as the Rust
//! model and written again. The binding of `@seuoffice/pptx-engine` crosses a
//! deck, a slide or an element this way on every call that takes one, so the
//! two must be the same text (crates/pptx-engine/C2-PLAN.md).

use pptx_engine::types::{Slide, SlideDeck, SlideElement};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{Returned, value};

fn again<T: DeserializeOwned + serde::Serialize>(text: &str) -> Returned {
    let read: T = serde_json::from_str(text).map_err(|error| format!("TypeError: {error}"))?;
    value(read)
}

pub fn dispatch(function: &str, text: &str, _args: &Value) -> Returned {
    match function {
        "deck" => again::<SlideDeck>(text),
        "slide" => again::<Slide>(text),
        "element" => again::<SlideElement>(text),
        _ => Err(format!("unknown function {function}")),
    }
}
