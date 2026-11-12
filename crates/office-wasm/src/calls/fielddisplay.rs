//! `fielddisplay.<name>`: `fieldDisplayOf` of parse-fields.ts. The text is
//! the paragraph; its context is built from `args.parts` as the `resolve`
//! group builds it. `args.resolver: false` calls it without a resolver and
//! `args.styles: false` without the styles map.

use docx_engine::fields::display::field_display_of;
use serde_json::Value;

use super::resolve::with_ctx;
use super::{Returned, arg, optional};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "fieldDisplayOf" => {
            let with_styles = arg::<bool>(args, "styles")? != Some(false);
            let with_resolver = arg::<bool>(args, "resolver")? != Some(false);
            with_ctx(args, |ctx| {
                optional(field_display_of(
                    text,
                    with_styles.then_some(&ctx.styles),
                    with_resolver.then_some(ctx),
                )?)
            })
        }
        _ => Err(format!("unknown function {function}")),
    }
}
