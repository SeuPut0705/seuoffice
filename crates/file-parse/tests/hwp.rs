//! `hwpToText`, `hwpMemosOf` and `checkedHwpBytes` over the tracked Hangul files and
//! hostile bytes. `hwp-expected.json` holds what `packages/file-parse/src/hwp.ts` answered
//! under Node 22 for the same input, error name and message or value.
#![cfg(feature = "hwp")]

use std::fs;
use std::path::Path;

use file_parse::hwp::{checked_hwp_bytes, hwp_memos_of, hwp_to_text};
use serde_json::Value;

const OLE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

fn expected() -> Value {
    serde_json::from_str(include_str!("hwp-expected.json")).expect("hwp-expected.json")
}

fn tracked(path: &str) -> Vec<u8> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    fs::read(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn fixture(name: &str) -> Vec<u8> {
    // the answers were taken from Node in Korea: memo dates in +09:00, whatever
    // zone this machine is in (the first offset set holds for the whole run)
    let _ = rhwp::model::memo_time::set_local_offset(|_| Some(9 * 3600));
    tracked(&format!("apps/hwp/tests/fixtures/{name}"))
}

/// What the TypeScript answered, as a Rust result: `ok` is a value, `err` is `[name, message]`.
fn answer(want: &Value) -> Result<Value, String> {
    match (want.get("ok"), want.get("err")) {
        (Some(value), None) => Ok(value.clone()),
        (None, Some(error)) => Err(error[1].as_str().expect("message").to_owned()),
        _ => panic!("neither ok nor err: {want}"),
    }
}

fn hostile(name: &str) -> Vec<u8> {
    let memo = fixture("memo.hwp");
    let memox = fixture("memo.hwpx");
    match name {
        "empty" => Vec::new(),
        "one byte P" => vec![0x50],
        "PK header only" => [&[0x50, 0x4b, 3, 4][..], &[0; 10]].concat(),
        "ole signature, zeros" => [&OLE[..], &[0; 504]].concat(),
        "memo.hwp cut at 512" => memo[..512].to_vec(),
        "memo.hwp cut at 1000" => memo[..1000].to_vec(),
        "memo.hwp minus one" => memo[..memo.len() - 1].to_vec(),
        "hwp3 signature" => [&b"HWP Document File"[..], &[0; 100]].concat(),
        "text" => b"hello world".to_vec(),
        "memo.hwpx cut" => memox[..2000].to_vec(),
        "memo.hwp" => memo,
        "memo.hwpx" => memox,
        other => panic!("unknown input {other}"),
    }
}

#[test]
fn corpus_text_is_what_node_answered() {
    let expected = expected();
    let corpus = expected["corpus"].as_object().expect("corpus");
    assert_eq!(corpus.len(), 39);
    for (path, want) in corpus {
        let got = hwp_to_text(&tracked(path)).map(Value::String);
        assert_eq!(got, answer(want), "{path}");
    }
}

#[test]
fn hostile_text_is_what_node_answered() {
    let expected = expected();
    let mut seen = 0;
    for (key, want) in expected["hostile"].as_object().expect("hostile") {
        let Some(name) = key.strip_prefix("text:") else {
            continue;
        };
        assert_eq!(
            hwp_to_text(&hostile(name)).map(Value::String),
            answer(want),
            "{name}"
        );
        seen += 1;
    }
    assert_eq!(seen, 10);
}

#[test]
fn memos_are_what_node_answered() {
    let expected = expected();
    let mut seen = 0;
    for (key, want) in expected["hostile"].as_object().expect("hostile") {
        let Some(name) = key.strip_prefix("memos:") else {
            continue;
        };
        assert_eq!(
            hwp_memos_of(&hostile(name)).map(Value::Array),
            answer(want),
            "{name}"
        );
        seen += 1;
    }
    assert_eq!(seen, 12);
}

#[test]
fn checked_bytes_are_what_node_answered() {
    let expected = expected();
    let mut seen = 0;
    for (key, want) in expected["hostile"].as_object().expect("hostile") {
        let Some(rest) = key.strip_prefix("checked:") else {
            continue;
        };
        let (ext, name) = rest.split_once(':').expect("ext:name");
        let bytes = hostile(name);
        let got = checked_hwp_bytes(&bytes, ext).map(|same| {
            assert!(std::ptr::eq(same, bytes.as_slice()));
            Value::String("same".to_owned())
        });
        assert_eq!(got, answer(want), "{key}");
        seen += 1;
    }
    assert_eq!(seen, 60);
}
