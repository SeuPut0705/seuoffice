//! `pptxPackage.*`: zip.ts of the slides engine.

use ooxml_pkg::DeclaredPart;
use pptx_engine::zip::{self, PackageArchive};
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, required, value};

/// The archive of `args.parts`, `[name, text]` pairs, with the text under
/// `args.textPart` last: what the TypeScript builds through the private
/// constructor.
fn archive(text: &str, args: &Value) -> Result<PackageArchive, String> {
    let mut parts: Vec<(String, Vec<u8>)> = arg::<Vec<(String, String)>>(args, "parts")?
        .unwrap_or_default()
        .into_iter()
        .map(|(name, text)| (name, text.into_bytes()))
        .collect();
    if let Some(name) = arg::<String>(args, "textPart")? {
        parts.push((name, text.as_bytes().to_vec()));
    }
    Ok(PackageArchive::from_parts(parts, "gate".to_owned()))
}

#[derive(Serialize)]
struct Opened<'a> {
    entries: Vec<(&'a str, &'a [u8])>,
    #[serde(rename = "originalHash")]
    original_hash: &'a str,
}

/// `[name, dir, declared size or null]` per file of `zip.files`, in key order.
fn declared(args: &Value) -> Result<(), String> {
    let files: Vec<(String, bool, Option<f64>)> = required(args, "files")?;
    let mut object = jscompat::JsObject::new();
    for (name, dir, size) in files {
        object.set(name, (dir, size));
    }
    let parts: Vec<DeclaredPart<'_>> = object
        .entries()
        .into_iter()
        .filter(|(_, (dir, _))| !dir)
        .map(|(name, (_, size))| DeclaredPart {
            name,
            usize: size.unwrap_or(0.0),
        })
        .collect();
    zip::assert_zip_within_limits(&parts)
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let path = || required::<String>(args, "path");
    match function {
        "open" => {
            let bytes: Vec<u8> = required(args, "bytes")?;
            let opened = PackageArchive::open(&bytes)?;
            value(Opened {
                entries: opened
                    .entries()
                    .iter()
                    .map(|(name, bytes)| (name, bytes.as_slice()))
                    .collect(),
                original_hash: opened.original_hash(),
            })
        }
        "has" => value(archive(text, args)?.has(&path()?)),
        "readText" => value(archive(text, args)?.read_text(&path()?)),
        "readBytes" => value(archive(text, args)?.read_bytes(&path()?)),
        "readRels" => value(archive(text, args)?.read_rels(&path()?)?),
        "readPresentation" => value(archive(text, args)?.read_presentation()?),
        "resolveSlideChain" => value(archive(text, args)?.resolve_slide_chain(&path()?)?),
        "relsPathFor" => value(zip::rels_path_for(text)),
        "resolveTarget" => value(zip::resolve_target(
            &required::<String>(args, "base")?,
            text,
        )),
        "assertZipWithinLimits" => declared(args).map(|()| None),
        _ => Err(format!("no function pptxPackage.{function}")),
    }
}
