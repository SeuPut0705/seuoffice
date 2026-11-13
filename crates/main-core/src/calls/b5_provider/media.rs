//! Part `media` of group `b5-provider` (tools/main-diff/groups/b5-provider/media.ts):
//! `packages/ai-provider/src/media-protocols.ts`.
//!
//! `tldts` has no Rust: the comparison answers `getDomain` from one tiny table
//! on both sides ([`fake_domain`]; the real list is engine-waiting).

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Map, Value, json};

use super::super::{Answer, Context, arg};
use super::world::{Sink, call_error, drive};
use crate::packages::ai_provider::fetch::{AiFetch, AiFetchState};
use crate::packages::ai_provider::media_protocols::{
    AiMediaProviderConfig, AnalyzeMediaInput, GenerateImageInput, MediaBlob,
    analyze_media_with_provider, base64_to_bytes, bytes_to_base64, generate_image_with_provider,
    sniff_image_mime, test_media_provider,
};
use crate::packages::ai_provider::task::{JsError, Rt, Signal};

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn hex_bytes(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `blobOf(spec)`: the bytes of `hex` followed by `pad` bytes of 0x61
fn blob_of(v: &Value) -> MediaBlob {
    let mut bytes = hex_bytes(v.get("hex").and_then(Value::as_str).unwrap_or_default());
    let pad = v.get("pad").and_then(Value::as_u64).unwrap_or(0) as usize;
    bytes.resize(bytes.len() + pad, 0x61);
    MediaBlob {
        bytes,
        mime: v
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        name: v.get("name").and_then(Value::as_str).map(str::to_owned),
    }
}

fn blobs_of(v: Option<&Value>) -> Option<Vec<MediaBlob>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(blob_of).collect())
}

/// `configOf(o)`
fn config_of(o: &Value) -> AiMediaProviderConfig {
    let c = o.get("config");
    let field = |k: &str| c.and_then(|c| c.get(k)).and_then(Value::as_str);
    AiMediaProviderConfig {
        api_key: field("apiKey").unwrap_or("sk-test").to_owned(),
        base_url: field("baseUrl").map(str::to_owned),
        image_model: field("imageModel").unwrap_or_default().to_owned(),
        analysis_model: field("analysisModel").unwrap_or_default().to_owned(),
    }
}

/// `blobAnswer(blob)`: `{ mime, length, hex }`, `hex` the first 256 bytes
fn blob_answer(blob: &MediaBlob) -> Value {
    json!({
        "mime": blob.mime,
        "length": blob.bytes.len(),
        "hex": hex_of(&blob.bytes[..blob.bytes.len().min(256)]),
    })
}

/// `getDomain(host, { allowPrivateDomains: true })` of the comparison's fake
/// `tldts`: an IP address or a name of one label has no domain; `co.uk` and
/// `github.io` are suffixes; any other name's suffix is its last label.
fn fake_domain(host: &str) -> Option<String> {
    let parts: Vec<&str> = host.split('.').collect();
    let is_ip = parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if is_ip || host.contains(':') || host.starts_with('[') {
        return None;
    }
    let lower = host.to_ascii_lowercase();
    let labels: Vec<&str> = lower.split('.').collect();
    let tail = labels[labels.len().saturating_sub(2)..].join(".");
    let suffix = if tail == "co.uk" || tail == "github.io" {
        2
    } else {
        1
    };
    if labels.len() <= suffix {
        return None;
    }
    Some(labels[labels.len() - (suffix + 1)..].join("."))
}

/// A call in the world, over the module state a fresh process has.
fn run<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Option<Signal>, AiFetch, Value) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    let no_signal = o.get("noSignal").and_then(Value::as_bool) == Some(true);
    let out = drive(world.as_ref(), cx, move |rt, signal, _sink: Sink| {
        let fx: AiFetch = Rc::new(RefCell::new(AiFetchState::default()));
        body(rt, (!no_signal).then_some(signal), fx, o)
    })?;
    match out {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(call_error(&e)),
    }
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "media-protocols.bytesToBase64" => Ok(Some(Value::String(bytes_to_base64(&hex_bytes(
            &s(args, 0),
        ))))),
        "media-protocols.base64ToBytes" => {
            Ok(Some(Value::String(hex_of(&base64_to_bytes(&s(args, 0))))))
        }
        "media-protocols.sniffImageMime" => {
            let fallback = arg(args, 1)
                .and_then(Value::as_str)
                .unwrap_or("image/png")
                .to_owned();
            Ok(Some(Value::String(sniff_image_mime(
                &hex_bytes(&s(args, 0)),
                &fallback,
            ))))
        }
        "media-protocols.generateImageWithProvider" => {
            run(args, cx, |rt, signal, fx, o| async move {
                let provider = o
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let config = config_of(&o);
                let input = o.get("input");
                let field = |k: &str| input.and_then(|i| i.get(k));
                let image = GenerateImageInput {
                    prompt: field("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    aspect_ratio: field("aspectRatio")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    references: blobs_of(field("references")),
                    transparent: field("transparent").and_then(Value::as_bool),
                };
                let blob = generate_image_with_provider(
                    &rt,
                    &fx,
                    &provider,
                    &config,
                    &image,
                    signal.as_ref(),
                    &fake_domain,
                )
                .await?;
                Ok(blob_answer(&blob))
            })
        }
        "media-protocols.analyzeMediaWithProvider" => {
            run(args, cx, |rt, signal, fx, o| async move {
                let provider = o
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let config = config_of(&o);
                let input = o.get("input");
                let analysis = AnalyzeMediaInput {
                    media: blobs_of(input.and_then(|i| i.get("media"))).unwrap_or_default(),
                    requirements: input
                        .and_then(|i| i.get("requirements"))
                        .and_then(Value::as_str)
                        .unwrap_or("describe it")
                        .to_owned(),
                };
                let text = analyze_media_with_provider(
                    &rt,
                    &fx,
                    &provider,
                    &config,
                    &analysis,
                    signal.as_ref(),
                )
                .await?;
                Ok(Value::String(text))
            })
        }
        "media-protocols.testMediaProvider" => run(args, cx, |rt, signal, fx, o| async move {
            let provider = o
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let config = config_of(&o);
            let result = test_media_provider(&rt, &fx, &provider, &config, signal.as_ref()).await;
            let mut out = Map::new();
            out.insert("ok".into(), Value::Bool(result.ok));
            if let Some(error) = result.error {
                out.insert("error".into(), Value::String(error));
            }
            Ok(Value::Object(out))
        }),
        _ => return None,
    })
}
