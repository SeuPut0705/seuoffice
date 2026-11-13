//! media-insert.ts, narration.ts, chart-insert.ts and hyperlink.ts of the
//! slides engine, called as `<module>.<TypeScript name>`. A function on an
//! opened deck runs through `deck_op` (pptx_deck.rs): the input is
//! tools/pptx-diff/calls-media.ts. Media bytes are base64 arguments; `uuid`
//! is what `crypto.randomUUID()` gives a new element's a16:creationId (the
//! TypeScript side runs under `withUuid` with the same one).

use jscompat::JsNum;
use pptx_engine::chart_insert::{
    NewChartOptions, add_chart, build_chart_space_xml, write_chart_workbook,
};
use pptx_engine::deck::{OpenedPptx, reparse_deck};
use pptx_engine::hyperlink::{
    LinkTarget, decode_run_link, encode_run_link, ensure_run_link_rels, get_element_link,
    get_run_links, get_slide_links, set_element_link,
};
use pptx_engine::media_insert::{
    Model3dView, NewMediaOptions, NewModel3dOptions, add_media, add_model3d,
    ensure_default_content_type, model3d_part_of, png_pixels, set_model3d_view, solid_png,
    solid_png_raw,
};
use pptx_engine::narration::{
    NarrationAudio, add_narration, clear_narration, narration_spids, set_show_narration,
};
use pptx_engine::types::Paragraph;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, arg, required, value};

/// The `uuid` the TypeScript side runs under.
const UUID: &str = "6f1d2c3b-4a59-4687-9e0d-1c2b3a495867";

fn slide_of(args: &Value) -> Result<usize, String> {
    Ok(arg::<usize>(args, "slide")?.unwrap_or(0))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What a test writes into the archive before the call: `args.setRels` for the
/// slide rels (the deck reparsed), the same slide as the TypeScript `prepare`.
fn prepare(opened: &mut OpenedPptx, args: &Value) -> Result<(), String> {
    if let Some(rels) = arg::<String>(args, "setRels")? {
        opened
            .archive
            .entries_mut()
            .set("ppt/slides/_rels/slide1.xml.rels", rels.into_bytes());
        reparse_deck(opened)?;
    }
    Ok(())
}

fn opt_value<T: serde::Serialize>(v: Option<T>) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// `run`, then every PNG it added as its chunks and pixels: two zlibs write different bytes of
/// one image (`png_pixels`). The TypeScript side does the same (calls-media.ts).
fn pixels_of_new_pngs<T>(
    opened: &mut OpenedPptx,
    run: impl FnOnce(&mut OpenedPptx) -> Result<T, String>,
) -> Result<T, String> {
    let known = opened.archive.entries().clone();
    let result = run(opened)?;
    let changed: Vec<(String, Vec<u8>)> = opened
        .archive
        .entries()
        .iter()
        .filter(|(name, _)| !known.has(name))
        .filter_map(|(name, bytes)| png_pixels(bytes).map(|pixels| (name.to_owned(), pixels)))
        .collect();
    for (name, pixels) in changed {
        opened.archive.entries_mut().set(name, pixels);
    }
    Ok(result)
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        // ── media-insert.ts ──
        "media-insert.solidPng" => {
            let w: u32 = required(args, "w")?;
            let h: u32 = required(args, "h")?;
            let rgb: [u8; 3] = required(args, "rgb")?;
            let png = solid_png(w, h, rgb)?;
            let raw = solid_png_raw(w, h, rgb)?;
            value(json!({
                "head": hex(png.get(..33).unwrap_or_default()),
                "raw": format!("{:x}", Sha256::digest(&raw)),
                "rawLength": raw.len(),
                "tail": hex(png.get(png.len().saturating_sub(12)..).unwrap_or_default()),
            }))
        }
        "media-insert.ensureDefaultContentType" => deck_op(text, args, |opened| {
            ensure_default_content_type(
                opened,
                &required::<String>(args, "ext")?,
                &required::<String>(args, "mime")?,
            )?;
            Ok(Value::Null)
        }),
        "media-insert.addMedia" => deck_op(text, args, |opened| {
            let opts: NewMediaOptions = required(args, "opts")?;
            pixels_of_new_pngs(opened, |opened| {
                opt_value(add_media(opened, slide_of(args)?, &opts, UUID)?)
            })
        }),
        "media-insert.addModel3d" => deck_op(text, args, |opened| {
            let opts: NewModel3dOptions = required(args, "opts")?;
            pixels_of_new_pngs(opened, |opened| {
                opt_value(add_model3d(opened, slide_of(args)?, &opts, UUID)?)
            })
        }),
        "media-insert.setModel3dView" => deck_op(text, args, |opened| {
            pixels_of_new_pngs(opened, |opened| {
                let slide = slide_of(args)?;
                let id = match args.get("model") {
                    Some(Value::Bool(false)) => {
                        element_id(opened, slide, arg::<usize>(args, "element")?.unwrap_or(0))
                    }
                    _ => {
                        let model: NewModel3dOptions = required(args, "model")?;
                        add_model3d(opened, slide, &model, UUID)?.unwrap_or_default()
                    }
                };
                let view = Model3dView {
                    rot: required(args, "rot")?,
                    poster: arg(args, "poster")?,
                };
                opt_value(Some(set_model3d_view(opened, slide, &id, &view)?))
            })
        }),
        "media-insert.model3dPartOf" => value(model3d_part_of(Some(text))),

        // ── narration.ts ──
        "narration.narrationSpids" => deck_op(text, args, |opened| {
            let spids: Vec<JsNum> = opened
                .deck
                .slides
                .get(slide_of(args)?)
                .map(|s| narration_spids(s).into_iter().map(JsNum).collect())
                .unwrap_or_default();
            opt_value(Some(spids))
        }),
        "narration.clearNarration" => deck_op(text, args, |opened| {
            opt_value(Some(clear_narration(opened, slide_of(args)?)?))
        }),
        "narration.addNarration" => deck_op(text, args, |opened| {
            let audio: NarrationAudio = required(args, "audio")?;
            pixels_of_new_pngs(opened, |opened| {
                opt_value(add_narration(opened, slide_of(args)?, &audio, UUID)?)
            })
        }),
        "narration.setShowNarration" => deck_op(text, args, |opened| {
            if let Some(xml) = arg::<String>(args, "presProps")? {
                opened
                    .archive
                    .entries_mut()
                    .set("ppt/presProps.xml", xml.into_bytes());
            }
            if let Some(xml) = arg::<String>(args, "presRels")? {
                opened
                    .archive
                    .entries_mut()
                    .set("ppt/_rels/presentation.xml.rels", xml.into_bytes());
            }
            if arg::<bool>(args, "dropPresentation")? == Some(true) {
                // `entries.delete`: the others keep their order
                let kept: jscompat::JsMap<Vec<u8>> = opened
                    .archive
                    .entries()
                    .iter()
                    .filter(|(name, _)| *name != "ppt/presentation.xml")
                    .map(|(name, bytes)| (name.to_owned(), bytes.clone()))
                    .collect();
                *opened.archive.entries_mut() = kept;
            }
            set_show_narration(opened)?;
            Ok(Value::Null)
        }),

        // ── chart-insert.ts ──
        "chart-insert.buildChartSpaceXml" => {
            let opts: NewChartOptions = required(args, "opts")?;
            let r_id: Option<String> = arg(args, "externalDataRId")?;
            value(build_chart_space_xml(&opts, r_id.as_deref()))
        }
        "chart-insert.writeChartWorkbook" => deck_op(text, args, |opened| {
            let chart_path: String = required(args, "chartPath")?;
            if let Some(xml) = arg::<String>(args, "chartText")? {
                opened
                    .archive
                    .entries_mut()
                    .set(chart_path.clone(), xml.into_bytes());
            }
            if let Some(xml) = arg::<String>(args, "chartRels")? {
                let name = chart_path.rsplit('/').next().unwrap_or(&chart_path);
                opened
                    .archive
                    .entries_mut()
                    .set(format!("ppt/charts/_rels/{name}.rels"), xml.into_bytes());
            }
            for (name, bytes) in arg::<Vec<(String, String)>>(args, "entries")?.unwrap_or_default()
            {
                let bytes = jscompat::atob(&bytes).map_err(|e| e.to_string())?;
                opened.archive.entries_mut().set(name, bytes);
            }
            let opts: NewChartOptions = required(args, "opts")?;
            opt_value(Some(write_chart_workbook(opened, &chart_path, &opts)?))
        }),
        "chart-insert.addChart" => deck_op(text, args, |opened| {
            for (name, content) in
                arg::<Vec<(String, String)>>(args, "entries")?.unwrap_or_default()
            {
                opened.archive.entries_mut().set(name, content.into_bytes());
            }
            let opts: NewChartOptions = required(args, "opts")?;
            opt_value(add_chart(opened, slide_of(args)?, &opts, UUID)?)
        }),

        // ── hyperlink.ts ──
        "hyperlink.setElementLink" => deck_op(text, args, |opened| {
            prepare(opened, args)?;
            let slide = slide_of(args)?;
            let id = element_id(opened, slide, arg::<usize>(args, "element")?.unwrap_or(0));
            let target: Option<LinkTarget> = arg(args, "target")?;
            opt_value(Some(set_element_link(opened, slide, &id, target.as_ref())?))
        }),
        "hyperlink.decodeRunLink" => value(decode_run_link(text)),
        "hyperlink.encodeRunLink" => {
            let target: LinkTarget = required(args, "target")?;
            value(encode_run_link(&target))
        }
        "hyperlink.ensureRunLinkRels" => deck_op(text, args, |opened| {
            prepare(opened, args)?;
            let mut paragraphs: Vec<Paragraph> = required(args, "paragraphs")?;
            let changed = ensure_run_link_rels(opened, slide_of(args)?, &mut paragraphs);
            Ok(json!({
                "changed": changed,
                "paragraphs": serde_json::to_value(&paragraphs).map_err(|e| e.to_string())?,
            }))
        }),
        "hyperlink.getRunLinks" => deck_op(text, args, |opened| {
            prepare(opened, args)?;
            opt_value(Some(get_run_links(opened, slide_of(args)?)?))
        }),
        "hyperlink.getElementLink" => deck_op(text, args, |opened| {
            prepare(opened, args)?;
            let slide = slide_of(args)?;
            let id = element_id(opened, slide, arg::<usize>(args, "element")?.unwrap_or(0));
            opt_value(get_element_link(opened, slide, &id)?)
        }),
        "hyperlink.getSlideLinks" => deck_op(text, args, |opened| {
            prepare(opened, args)?;
            opt_value(Some(get_slide_links(opened, slide_of(args)?)?))
        }),
        _ => Err(format!("unknown function {function}")),
    }
}
