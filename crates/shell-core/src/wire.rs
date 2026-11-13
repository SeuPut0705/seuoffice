//! The wire form of [`IpcValue`] (the stage 3 shell contract, section 2):
//! one JSON header and the byte buffers it points at. The bridge's
//! `crates/shell/bridge/wire.ts` is the same codec in TypeScript; the two
//! must agree byte for byte, which tools/ipc-diff checks on every case.
//!
//! In the header, plain JSON stands for itself and a tagged object (key `$`)
//! for what JSON cannot hold:
//!
//! | value                                  | header                                  |
//! | -------------------------------------- | --------------------------------------- |
//! | `undefined`                            | `{"$":"u"}`                             |
//! | bytes                                  | `{"$":"b","k":"u8"\|"ab","i":n}`        |
//! | a date                                 | `{"$":"d","v":ms}` (`ms` as a number)   |
//! | `NaN`, `Infinity`, `-Infinity`, `-0`   | `{"$":"n","v":"NaN"}` and so on         |
//! | an object with an own key `$`          | `{"$":"o","v":{…}}`                     |
//!
//! A frame (the raw body of a Tauri request, one message of a view's output
//! stream) is the header's UTF-8 length as a little-endian u32, the header,
//! the buffer count as a u32, then each buffer as its u32 length and bytes.

use serde_json::{Map, Number, Value};
use shell_contract::{BytesKind, IpcValue};

/// A header the codec refuses: the renderer side sent something it does not
/// write, or a frame was cut
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireError(pub String);

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn bad(what: impl Into<String>) -> WireError {
    WireError(what.into())
}

/// Writes values into headers, collecting their bytes into one buffer list,
/// so a frame holding several values (a reply's id and value, an event's
/// channel and arguments) shares one list
#[derive(Default)]
pub struct Encoder {
    pub buffers: Vec<Vec<u8>>,
}

fn tag(kind: &str, rest: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut map = Map::new();
    map.insert("$".into(), Value::String(kind.into()));
    for (key, value) in rest {
        map.insert(key.into(), value);
    }
    Value::Object(map)
}

/// A number as JSON when JSON holds it, else the tag of the four it does not
fn number(x: f64) -> Value {
    let special = if x.is_nan() {
        "NaN"
    } else if x == f64::INFINITY {
        "Infinity"
    } else if x == f64::NEG_INFINITY {
        "-Infinity"
    } else if x == 0.0 && x.is_sign_negative() {
        "-0"
    } else {
        // an integer is written without a fraction, as JSON.stringify writes it
        const SAFE: f64 = 9_007_199_254_740_991.0;
        if x.fract() == 0.0 && x.abs() <= SAFE {
            return Value::Number(Number::from(x as i64));
        }
        return Value::Number(Number::from_f64(x).expect("finite"));
    };
    tag("n", [("v", Value::String(special.into()))])
}

impl Encoder {
    pub fn value(&mut self, value: &IpcValue) -> Value {
        match value {
            IpcValue::Undefined => tag("u", []),
            IpcValue::Null => Value::Null,
            IpcValue::Bool(b) => Value::Bool(*b),
            IpcValue::Number(x) => number(*x),
            IpcValue::String(s) => Value::String(s.clone()),
            IpcValue::Bytes(kind, bytes) => {
                let index = self.buffers.len();
                self.buffers.push(bytes.clone());
                let k = match kind {
                    BytesKind::Uint8Array => "u8",
                    BytesKind::ArrayBuffer => "ab",
                };
                tag(
                    "b",
                    [
                        ("k", Value::String(k.into())),
                        ("i", Value::Number(Number::from(index))),
                    ],
                )
            }
            IpcValue::Date(ms) => tag("d", [("v", number(*ms))]),
            IpcValue::Array(items) => Value::Array(items.iter().map(|v| self.value(v)).collect()),
            IpcValue::Object(entries) => {
                let map: Map<String, Value> = entries
                    .iter()
                    .map(|(k, v)| (k.clone(), self.value(v)))
                    .collect();
                if entries.iter().any(|(k, _)| k == "$") {
                    tag("o", [("v", Value::Object(map))])
                } else {
                    Value::Object(map)
                }
            }
        }
    }

    pub fn values(&mut self, values: &[IpcValue]) -> Value {
        Value::Array(values.iter().map(|v| self.value(v)).collect())
    }
}

/// One value and its buffers
pub fn encode(value: &IpcValue) -> (Value, Vec<Vec<u8>>) {
    let mut e = Encoder::default();
    let header = e.value(value);
    (header, e.buffers)
}

fn decode_number(header: &Value) -> Result<f64, WireError> {
    match header {
        Value::Number(n) => n.as_f64().ok_or_else(|| bad("a number out of range")),
        Value::Object(map) if map.get("$") == Some(&Value::String("n".into())) => {
            match map.get("v").and_then(Value::as_str) {
                Some("NaN") => Ok(f64::NAN),
                Some("Infinity") => Ok(f64::INFINITY),
                Some("-Infinity") => Ok(f64::NEG_INFINITY),
                Some("-0") => Ok(-0.0),
                other => Err(bad(format!("no such number tag: {other:?}"))),
            }
        }
        other => Err(bad(format!("not a number: {other}"))),
    }
}

/// Reads one header back; `buffers` are the frame's
pub fn decode(header: &Value, buffers: &[Vec<u8>]) -> Result<IpcValue, WireError> {
    Ok(match header {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(_) => IpcValue::Number(decode_number(header)?),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(
            items
                .iter()
                .map(|v| decode(v, buffers))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(map) => match map.get("$") {
            None => object(map, buffers)?,
            Some(Value::String(kind)) => match kind.as_str() {
                "u" => IpcValue::Undefined,
                "n" => IpcValue::Number(decode_number(header)?),
                "d" => IpcValue::Date(decode_number(
                    map.get("v").ok_or_else(|| bad("a date without v"))?,
                )?),
                "b" => {
                    let kind = match map.get("k").and_then(Value::as_str) {
                        Some("u8") => BytesKind::Uint8Array,
                        Some("ab") => BytesKind::ArrayBuffer,
                        other => return Err(bad(format!("no such bytes kind: {other:?}"))),
                    };
                    let index = map
                        .get("i")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| bad("bytes without an index"))?;
                    let bytes = buffers
                        .get(index as usize)
                        .ok_or_else(|| bad(format!("no buffer {index}")))?;
                    IpcValue::Bytes(kind, bytes.clone())
                }
                "o" => match map.get("v") {
                    Some(Value::Object(inner)) => object(inner, buffers)?,
                    _ => return Err(bad("an escaped object without v")),
                },
                other => return Err(bad(format!("no such tag: {other}"))),
            },
            Some(other) => return Err(bad(format!("a tag that is not a string: {other}"))),
        },
    })
}

fn object(map: &Map<String, Value>, buffers: &[Vec<u8>]) -> Result<IpcValue, WireError> {
    Ok(IpcValue::Object(
        map.iter()
            .map(|(k, v)| Ok((k.clone(), decode(v, buffers)?)))
            .collect::<Result<_, WireError>>()?,
    ))
}

/// A list header (arguments) back to values
pub fn decode_list(header: &Value, buffers: &[Vec<u8>]) -> Result<Vec<IpcValue>, WireError> {
    match decode(header, buffers)? {
        IpcValue::Array(items) => Ok(items),
        _ => Err(bad("arguments that are not a list")),
    }
}

fn put_u32(out: &mut Vec<u8>, n: usize) {
    let n = u32::try_from(n).expect("a frame part over 4 GiB");
    out.extend_from_slice(&n.to_le_bytes());
}

/// The frame of one header and its buffers
pub fn frame(header: &Value, buffers: &[Vec<u8>]) -> Vec<u8> {
    let text = header.to_string();
    let size = 8 + text.len() + buffers.iter().map(|b| 4 + b.len()).sum::<usize>();
    let mut out = Vec::with_capacity(size);
    put_u32(&mut out, text.len());
    out.extend_from_slice(text.as_bytes());
    put_u32(&mut out, buffers.len());
    for b in buffers {
        put_u32(&mut out, b.len());
        out.extend_from_slice(b);
    }
    out
}

/// Reads a frame front to back
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.bytes.len());
        let end = end.ok_or_else(|| bad("a cut frame"))?;
        let part = &self.bytes[self.at..end];
        self.at = end;
        Ok(part)
    }

    fn u32(&mut self) -> Result<usize, WireError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    }
}

/// A frame back to its header and buffers
pub fn unframe(bytes: &[u8]) -> Result<(Value, Vec<Vec<u8>>), WireError> {
    let mut r = Reader { bytes, at: 0 };
    let len = r.u32()?;
    let header: Value = serde_json::from_slice(r.take(len)?).map_err(|e| bad(e.to_string()))?;
    let count = r.u32()?;
    let mut buffers = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        let n = r.u32()?;
        buffers.push(r.take(n)?.to_vec());
    }
    if r.at != bytes.len() {
        return Err(bad("bytes after the last buffer"));
    }
    Ok((header, buffers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_kind() -> IpcValue {
        IpcValue::Object(vec![
            ("u".into(), IpcValue::Undefined),
            ("n".into(), IpcValue::Null),
            ("t".into(), IpcValue::Bool(true)),
            ("int".into(), IpcValue::Number(42.0)),
            ("frac".into(), IpcValue::Number(0.1)),
            ("big".into(), IpcValue::Number(1e300)),
            ("nan".into(), IpcValue::Number(f64::NAN)),
            ("inf".into(), IpcValue::Number(f64::INFINITY)),
            ("ninf".into(), IpcValue::Number(f64::NEG_INFINITY)),
            ("nzero".into(), IpcValue::Number(-0.0)),
            ("s".into(), IpcValue::String("한글 \u{1F600}".into())),
            (
                "u8".into(),
                IpcValue::Bytes(BytesKind::Uint8Array, vec![0, 1, 255]),
            ),
            ("ab".into(), IpcValue::Bytes(BytesKind::ArrayBuffer, vec![])),
            ("date".into(), IpcValue::Date(1_794_452_400_000.0)),
            ("bad-date".into(), IpcValue::Date(f64::NAN)),
            (
                "list".into(),
                IpcValue::Array(vec![IpcValue::Undefined, IpcValue::Number(1.0)]),
            ),
            (
                "dollar".into(),
                IpcValue::Object(vec![
                    ("$".into(), IpcValue::String("u".into())),
                    ("z".into(), IpcValue::Null),
                    ("a".into(), IpcValue::Null),
                ]),
            ),
        ])
    }

    /// NaN != NaN, so values are compared through their headers
    fn same(a: &IpcValue, b: &IpcValue) -> bool {
        let (ha, ba) = encode(a);
        let (hb, bb) = encode(b);
        ha == hb && ba == bb
    }

    #[test]
    fn every_kind_survives_a_frame() {
        let value = every_kind();
        let (header, buffers) = encode(&value);
        let bytes = frame(&header, &buffers);
        let (h2, b2) = unframe(&bytes).unwrap();
        let back = decode(&h2, &b2).unwrap();
        assert!(same(&value, &back), "{back:?}");
        // -0 stays -0, not 0
        let IpcValue::Object(entries) = back else {
            panic!()
        };
        let nzero = &entries.iter().find(|(k, _)| k == "nzero").unwrap().1;
        assert!(matches!(nzero, IpcValue::Number(x) if *x == 0.0 && x.is_sign_negative()));
    }

    /// The same text `JSON.stringify` writes for the same value through
    /// bridge/wire.ts (its test holds this line too)
    #[test]
    fn header_text_is_the_contract_s() {
        let (header, buffers) = encode(&every_kind());
        assert_eq!(
            header.to_string(),
            r#"{"u":{"$":"u"},"n":null,"t":true,"int":42,"frac":0.1,"big":1e+300,"nan":{"$":"n","v":"NaN"},"inf":{"$":"n","v":"Infinity"},"ninf":{"$":"n","v":"-Infinity"},"nzero":{"$":"n","v":"-0"},"s":"한글 😀","u8":{"$":"b","k":"u8","i":0},"ab":{"$":"b","k":"ab","i":1},"date":{"$":"d","v":1794452400000},"bad-date":{"$":"d","v":{"$":"n","v":"NaN"}},"list":[{"$":"u"},1],"dollar":{"$":"o","v":{"$":"u","z":null,"a":null}}}"#
        );
        assert_eq!(buffers, vec![vec![0, 1, 255], vec![]]);
    }

    #[test]
    fn refuses_what_it_does_not_write() {
        for text in [
            r#"{"$":"m"}"#,
            r#"{"$":"b","k":"u8","i":3}"#,
            r#"{"$":"b","k":"f32","i":0}"#,
            r#"{"$":"n","v":"1"}"#,
            r#"{"$":1}"#,
        ] {
            let header: Value = serde_json::from_str(text).unwrap();
            assert!(decode(&header, &[]).is_err(), "{text}");
        }
    }

    #[test]
    fn refuses_a_cut_frame() {
        let bytes = frame(&Value::Array(vec![]), &[vec![1, 2, 3]]);
        for cut in 0..bytes.len() {
            assert!(unframe(&bytes[..cut]).is_err(), "cut at {cut}");
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(unframe(&longer).is_err());
    }
}
