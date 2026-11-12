//! A search that passes `BACKTRACK_LIMIT` on a wasm32 target refuses with
//! `RegexLimit` where an unbounded stack would trap the module. Built for
//! `wasm32-wasip1` and run by `limit_wasm.mjs`; exits 0 on the refusal.

use std::process::ExitCode;

use jscompat::TryJsRegex;

fn main() -> ExitCode {
    let length = std::env::args()
        .nth(1)
        .and_then(|length| length.parse().ok())
        .unwrap_or(25_000_000);
    // a tag whose attributes run on: each character keeps entries on the stack
    let tag = TryJsRegex::new(r#"<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>"#, "").unwrap();
    let text = format!("<{}", "a".repeat(length));
    match tag.try_test(&text) {
        Ok(found) => {
            println!("{length} characters: answered {found}");
            ExitCode::FAILURE
        }
        Err(limit) => {
            println!("{length} characters: refused, {limit}");
            ExitCode::SUCCESS
        }
    }
}
