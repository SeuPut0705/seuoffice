//! Every case of `xml-answers.json` was run through the TypeScript on Node 22
//! (`tools/epub-diff/xml-fixture.ts` writes it); the port must answer the same
//! value, or the same error name and message, key for key and in the same
//! order. Only cases that need no step of the host are in it: the gate runs the
//! rest, with parse5.
#![cfg(feature = "book")]

use epub_engine::book_call::call;
use serde_json::{Value, json};

/// What `book_call` answers only with the feature `book-translate`.
const TRANSLATION: [&str; 6] = [
    "epubTranslationUnits",
    "buildTranslatedEpub",
    "parseTranslationOutput",
    "estimateTokens",
    "batchEpubTranslationItems",
    "createEpubTranslationModelCall",
];

fn from_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut bits, mut count) = (0u32, 0);
    for byte in text.bytes().filter(|&byte| byte != b'=') {
        bits = bits << 6 | ALPHABET.iter().position(|&c| c == byte).unwrap() as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// The zip gate appends the host's own text to "cannot be inflated".
fn without_host_text(mut outcome: Value) -> Value {
    if let Some(message) = outcome
        .pointer_mut("/error/message")
        .filter(|message| message.is_string())
    {
        let text = message.as_str().unwrap().to_owned();
        if let Some(at) = text.find("cannot be inflated:") {
            *message = json!(&text[..at + "cannot be inflated:".len()]);
        }
    }
    outcome
}

#[test]
fn replays_the_answers_of_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("xml-answers.json")).unwrap();
    assert!(cases.len() > 1000);
    let mut failures = Vec::new();
    for case in &cases {
        let function = case["fn"].as_str().unwrap();
        if !cfg!(feature = "book-translate") && TRANSLATION.contains(&function) {
            continue;
        }
        let label = case["label"].as_str().unwrap();
        let bytes = case["bytesBase64"]
            .as_str()
            .map(from_base64)
            .unwrap_or_default();
        let actual = match call(
            function,
            case["text"].as_str().unwrap(),
            &bytes,
            &case["args"],
        ) {
            Ok(value) => json!({ "value": value }),
            Err((name, message)) => json!({ "error": { "name": name, "message": message } }),
        };
        let (actual, expected) = (
            serde_json::to_string(&without_host_text(actual)).unwrap(),
            serde_json::to_string(&without_host_text(case["expected"].clone())).unwrap(),
        );
        if actual != expected {
            // both answers from where they first differ, with the text before it
            let at = actual
                .bytes()
                .zip(expected.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(0)
                .saturating_sub(60);
            let from = |text: &str| {
                let mut at = at.min(text.len());
                while !text.is_char_boundary(at) {
                    at -= 1;
                }
                text[at..].chars().take(400).collect::<String>()
            };
            failures.push(format!(
                "{function} {label}\n  rust: {}\n  node: {}",
                from(&actual),
                from(&expected)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
