//! A search that passes `BACKTRACK_LIMIT` on a wasm32 target refuses with
//! `RegexLimit` where an unbounded stack would trap the module. Built for
//! `wasm32-wasip1` and run by `limit_wasm.mjs`; exits 0 on the refusal. It
//! prints the linear memory the search added: a wasm memory never shrinks, so
//! that is the most a browser tab holds for one such search.

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
    let before = memory_bytes();
    let answer = tag.try_test(&text);
    let (grown, all) = (memory_bytes() - before, memory_bytes());
    let memory = format!("the search grew the memory by {grown} bytes, to {all} in all");
    match answer {
        Ok(found) => {
            println!("{length} characters: answered {found}; {memory}");
            ExitCode::FAILURE
        }
        Err(limit) => {
            println!("{length} characters: refused, {limit}; {memory}");
            ExitCode::SUCCESS
        }
    }
}

/// The size of the linear memory; 0 off wasm32.
fn memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    return core::arch::wasm32::memory_size::<0>() * 65_536;
    #[cfg(not(target_arch = "wasm32"))]
    return 0;
}
