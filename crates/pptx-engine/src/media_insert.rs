//! Audio/video / 3D model insertion, media part surgery
//! (packages/pptx-engine/src/media-insert.ts).
//!
//! Video/audio: the modern PowerPoint dual-relationship form,
//!   `<a:videoFile r:link>` (2007 semantics) + `p14:media r:embed` (2010 semantics),
//!   both relationships pointing at the same embedded ppt/media/mediaN.ext part;
//!   blipFill is the poster frame.
//!
//! 3D models: am3d:model3d with a picture fallback, as PowerPoint writes them (model3d.rs).
//! Decks from before carry a plain picture whose cNvPr descr names the model part
//! (`aislides-3d:{partPath}`, [`model3d_part_of`]).
//!
//! `uuid` of the functions that mint an a16:creationId is what
//! `crypto.randomUUID()` gives `creationIdXml`; the host supplies it.

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use jscompat::{JsNum, js_regex, number_to_string, replace_first_string, to_number};
use serde::{Deserialize, Deserializer};

use crate::crc32::crc32;
use crate::deck::{OpenedPptx, append_raw_elements, replace_picture_bytes};
use crate::glb_bounds::glb_bounds;
use crate::insert::next_c_nv_pr_id;
use crate::model3d::{
    self, GLB_CONTENT_TYPE, MODEL3D_REL_TYPE, Model3dXmlOptions, model3d_xml,
    set_model3d_rotation_xml,
};
use crate::types::{EmuRect, Model3dRotation};
use crate::xml_utils::{
    creation_id_xml, escape_xml_attr, has_default_for, max_relationship_id_number,
};
use crate::zip::rels_path_for;

const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const VIDEO_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video";
const AUDIO_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio";
const MEDIA_REL_TYPE: &str = "http://schemas.microsoft.com/office/2007/relationships/media";
const P14_NS: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";
/// Fixed uri of the `<p:ext>` that hosts p14:media (ECMA/Microsoft convention)
const MEDIA_EXT_URI: &str = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}";

/// The bound on the raw size of a generated PNG, so a caller's width and
/// height cannot ask for an unbounded allocation.
const MAX_PNG_RAW: usize = 1 << 28;

/// `MEDIA_MIME[ext]`. The TypeScript reads a plain object, so `constructor`
/// and `__proto__` find an inherited value there and go on with it as a mime
/// type; here they are no entry (ledger media-mime-inherited).
fn media_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        _ => return None,
    })
}

/// A byte array that crosses JSON as base64.
fn base64_bytes<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    let text = String::deserialize(d)?;
    jscompat::atob(&text).map_err(serde::de::Error::custom)
}

/// `{ bytes, ext }` of a poster frame.
#[derive(Debug, Clone, Deserialize)]
pub struct MediaBytes {
    #[serde(deserialize_with = "base64_bytes")]
    pub bytes: Vec<u8>,
    pub ext: String,
}

// ── Solid-color PNG generation (poster frame fallback, no canvas dependency) ──

fn png_chunk(kind: &str, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind.as_bytes());
    out.extend_from_slice(data);
    let mut checked = Vec::with_capacity(4 + data.len());
    checked.extend_from_slice(kind.as_bytes());
    checked.extend_from_slice(data);
    out.extend_from_slice(&crc32(&checked).to_be_bytes());
    out
}

/// The scanlines of a w×h solid-color RGB image, each led by its filter byte 0.
pub fn solid_png_raw(w: u32, h: u32, rgb: [u8; 3]) -> Result<Vec<u8>, String> {
    let row_len = (w as usize)
        .checked_mul(3)
        .and_then(|n| n.checked_add(1))
        .ok_or("RangeError: Invalid typed array length")?;
    let total = row_len
        .checked_mul(h as usize)
        .filter(|n| *n <= MAX_PNG_RAW)
        .ok_or("RangeError: Invalid typed array length")?;
    let mut raw = Vec::with_capacity(total);
    #[allow(clippy::same_item_push)]
    for _ in 0..h {
        raw.push(0); // filter none
        for _ in 0..w {
            raw.extend_from_slice(&rgb);
        }
    }
    Ok(raw)
}

/// Generate a w×h solid-color PNG (RGB, no alpha). Used as a poster frame placeholder.
pub fn solid_png(w: u32, h: u32, rgb: [u8; 3]) -> Result<Vec<u8>, String> {
    let raw = solid_png_raw(w, h, rgb)?;
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(2); // color type RGB
    ihdr.extend_from_slice(&[0, 0, 0]);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).map_err(|e| e.to_string())?;
    let deflated = encoder.finish().map_err(|e| e.to_string())?;
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend(png_chunk("IHDR", &ihdr));
    out.extend(png_chunk("IDAT", &deflated));
    out.extend(png_chunk("IEND", &[]));
    Ok(out)
}

/// A PNG with its IDAT chunks inflated: the other chunks as they are, then the pixels. The gate
/// compares this, because two zlibs write different bytes of one image. `None` where the bytes
/// are not a PNG that this reads whole.
pub fn png_pixels(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    const SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.get(..8)? != SIGNATURE {
        return None;
    }
    let mut head: Vec<u8> = Vec::new();
    let mut idat: Vec<u8> = Vec::new();
    let mut at = 8usize;
    while at < bytes.len() {
        let length =
            u32::from_be_bytes(bytes.get(at..at.checked_add(4)?)?.try_into().ok()?) as usize;
        let end = at.checked_add(12)?.checked_add(length)?;
        if end > bytes.len() {
            return None;
        }
        if bytes.get(at + 4..at + 8)? == b"IDAT" {
            idat.extend_from_slice(bytes.get(at + 8..at + 8 + length)?);
        } else {
            head.extend_from_slice(bytes.get(at..end)?);
        }
        at = end;
    }
    if idat.is_empty() {
        return None;
    }
    let mut pixels = Vec::new();
    flate2::read::ZlibDecoder::new(idat.as_slice())
        .take(1 << 28)
        .read_to_end(&mut pixels)
        .ok()?;
    head.extend_from_slice(&pixels);
    Some(head)
}

// ── Shared part / rels surgery ─────────────────────────────────────────

/// `text.replace(needle, () => replacement)`: the first occurrence, the
/// replacement written as given.
fn replace_first_literal(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => format!("{}{replacement}{}", &text[..at], &text[at + needle.len()..]),
        None => text.to_owned(),
    }
}

pub fn ensure_default_content_type(
    opened: &mut OpenedPptx,
    ext: &str,
    mime: &str,
) -> Result<(), String> {
    let ct_path = "[Content_Types].xml";
    let Some(ct) = opened
        .archive
        .read_text(ct_path)
        .filter(|ct| !ct.is_empty())
        .map(|ct| ct.into_owned())
    else {
        return Ok(());
    };
    if !has_default_for(&ct, ext).map_err(|e| e.to_string())? {
        let dflt = format!("<Default Extension=\"{ext}\" ContentType=\"{mime}\"/>");
        let next = replace_first_literal(&ct, "</Types>", &format!("{dflt}</Types>"));
        opened.archive.entries_mut().set(ct_path, next.into_bytes());
    }
    Ok(())
}

/// New media part: ppt/media/{prefix}N.ext, numbered max + 1 across the whole media dir.
fn new_media_part(opened: &mut OpenedPptx, prefix: &str, ext: &str, bytes: &[u8]) -> String {
    let mut max_num = 0.0_f64;
    for path in opened.archive.entries().keys() {
        if let Some(m) = js_regex!(r"^ppt\/media\/[a-zA-Z]+(\d+)\.").exec(path) {
            let n = to_number(m.get(1).unwrap_or_default());
            max_num = if n > max_num { n } else { max_num };
        }
    }
    let part_path = format!(
        "ppt/media/{prefix}{}.{ext}",
        number_to_string(max_num + 1.0)
    );
    opened
        .archive
        .entries_mut()
        .set(part_path.clone(), bytes.to_vec());
    part_path
}

/// One relationship `appendRels` is asked for.
struct NewRel<'a> {
    kind: &'a str,
    target: String,
}

/// Append relationships to the slide rels; returns the assigned rIds (in order).
fn append_rels(opened: &mut OpenedPptx, slide_path: &str, rels: &[NewRel<'_>]) -> Vec<String> {
    let rels_path = rels_path_for(slide_path);
    let mut xml = opened
        .archive
        .read_text(&rels_path)
        .map(|x| x.into_owned())
        .unwrap_or_else(|| {
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned()
        });
    let mut max_rid = max_relationship_id_number(&xml);
    let mut rids = Vec::new();
    for rel in rels {
        max_rid += 1.0;
        let rid = format!("rId{}", number_to_string(max_rid));
        rids.push(rid.clone());
        // a string replacement: its `$` patterns apply to the escaped target
        xml = replace_first_string(
            &xml,
            "</Relationships>",
            &format!(
                "<Relationship Id=\"{rid}\" Type=\"{}\" Target=\"{}\"/></Relationships>",
                rel.kind,
                escape_xml_attr(&rel.target)
            ),
        );
    }
    opened
        .archive
        .entries_mut()
        .set(rels_path, xml.into_bytes());
    rids
}

/// The last path segment (`path.split('/').pop()`).
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn image_content_type(ext: &str) -> &'static str {
    if ext == "jpg" || ext == "jpeg" {
        "image/jpeg"
    } else {
        "image/png"
    }
}

fn slide_path_of(opened: &OpenedPptx, slide_index: usize) -> Option<String> {
    let slide = opened.deck.slides.get(slide_index)?;
    Some((*slide.path).clone().unwrap_or_default())
}

// ── Audio/video ────────────────────────────────────────────────────────

/// `kind` of `NewMediaOptions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewMediaKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMediaOptions {
    pub kind: NewMediaKind,
    #[serde(deserialize_with = "base64_bytes")]
    pub bytes: Vec<u8>,
    /// Lowercase extension (mp4/mov/webm/mp3/wav/m4a…)
    pub ext: String,
    /// Poster frame (defaults to a generated solid-color placeholder PNG)
    #[serde(default)]
    pub poster: Option<MediaBytes>,
    pub offset: EmuRect,
    /// cNvPr name (defaults to a filename-style name)
    #[serde(default)]
    pub name: Option<String>,
}

/// Insert audio/video: media/poster parts + dual relationships + `<p:pic>` fragment, append + reparse.
/// The new element's id; the slide is `opened.deck.slides[slide_index]`. `None`: TS null.
pub fn add_media(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &NewMediaOptions,
    uuid: &str,
) -> Result<Option<String>, String> {
    let Some(slide_path) = slide_path_of(opened, slide_index) else {
        return Ok(None);
    };
    let ext = opts.ext.to_lowercase();
    let Some(mime) = media_mime(&ext) else {
        return Ok(None);
    };

    // 1) media part + Content_Types
    let media_path = new_media_part(opened, "media", &ext, &opts.bytes);
    ensure_default_content_type(opened, &ext, mime)?;

    // 2) Poster frame part (solid color by default; square for audio, whose frame is PowerPoint's 64 pt icon)
    let default_poster;
    let poster = match &opts.poster {
        Some(p) => p,
        None => {
            default_poster = MediaBytes {
                bytes: if opts.kind == NewMediaKind::Video {
                    solid_png(16, 9, [38, 38, 44])?
                } else {
                    solid_png(16, 16, [240, 240, 244])?
                },
                ext: "png".to_owned(),
            };
            &default_poster
        }
    };
    let poster_ext = poster.ext.to_lowercase();
    let poster_path = new_media_part(opened, "image", &poster_ext, &poster.bytes);
    ensure_default_content_type(opened, &poster_ext, image_content_type(&poster_ext))?;

    // 3) Three relationships: poster image + legacy video/audio + p14 media
    let media_target = format!("../media/{}", file_name(&media_path));
    let rids = append_rels(
        opened,
        &slide_path,
        &[
            NewRel {
                kind: IMAGE_REL_TYPE,
                target: format!("../media/{}", file_name(&poster_path)),
            },
            NewRel {
                kind: if opts.kind == NewMediaKind::Video {
                    VIDEO_REL_TYPE
                } else {
                    AUDIO_REL_TYPE
                },
                target: media_target.clone(),
            },
            NewRel {
                kind: MEDIA_REL_TYPE,
                target: media_target,
            },
        ],
    );
    let rid_poster = rids.first().cloned().unwrap_or_default();
    let rid_legacy = rids.get(1).cloned().unwrap_or_default();
    let rid_media = rids.get(2).cloned().unwrap_or_default();

    // 4) <p:pic> fragment (videoFile/audioFile + p14:media extension hung on nvPr)
    let id = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(None);
        };
        next_c_nv_pr_id(slide)
    };
    let id_text = number_to_string(id);
    let video = opts.kind == NewMediaKind::Video;
    let name = match &opts.name {
        Some(n) => n.clone(),
        None => format!("{} {id_text}", if video { "Video" } else { "Audio" }),
    };
    let file_tag = if video { "a:videoFile" } else { "a:audioFile" };
    let o = opts.offset;
    let xml = format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{id_text}\" name=\"{}\">{}</p:cNvPr>\
<p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr>\
<p:nvPr><{file_tag} xmlns:r=\"{R_NS}\" r:link=\"{rid_legacy}\"/>\
<p:extLst><p:ext uri=\"{MEDIA_EXT_URI}\">\
<p14:media xmlns:p14=\"{P14_NS}\" xmlns:r=\"{R_NS}\" r:embed=\"{rid_media}\"/>\
</p:ext></p:extLst></p:nvPr></p:nvPicPr>\
<p:blipFill><a:blip r:embed=\"{rid_poster}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\
<p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        escape_xml_attr(&name),
        creation_id_xml(uuid),
        number_to_string(o.x.0),
        number_to_string(o.y.0),
        number_to_string(o.cx.0),
        number_to_string(o.cy.0),
    );

    let ids = append_raw_elements(opened, slide_index, &[xml])?;
    Ok(ids.map(|ids| ids.last().cloned().unwrap_or_default()))
}

// ── 3D models ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewModel3dOptions {
    /// glTF binary
    #[serde(deserialize_with = "base64_bytes")]
    pub bytes: Vec<u8>,
    pub ext: String,
    /// The model's rendering: the Fallback picture and am3d:raster (a placeholder when omitted)
    #[serde(default)]
    pub poster: Option<MediaBytes>,
    pub offset: EmuRect,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub rot: Option<Model3dRotation>,
}

fn emu_rect_for_model3d(r: EmuRect) -> model3d::EmuRect {
    model3d::EmuRect {
        x: r.x,
        y: r.y,
        cx: r.cx,
        cy: r.cy,
    }
}

fn rot_for_model3d(r: Model3dRotation) -> model3d::Model3dRotation {
    model3d::Model3dRotation {
        ax: r.ax,
        ay: r.ay,
        az: r.az,
    }
}

/// Insert a 3D model as PowerPoint stores it (model3d.rs). Only .glb is embedded, as PowerPoint does.
pub fn add_model3d(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &NewModel3dOptions,
    uuid: &str,
) -> Result<Option<String>, String> {
    let Some(slide_path) = slide_path_of(opened, slide_index) else {
        return Ok(None);
    };
    if opts.ext.to_lowercase() != "glb" {
        return Ok(None);
    }

    let model_path = new_media_part(opened, "model3d", "glb", &opts.bytes);
    ensure_default_content_type(opened, "glb", GLB_CONTENT_TYPE)?;
    let default_poster;
    let poster = match &opts.poster {
        Some(p) => p,
        None => {
            default_poster = MediaBytes {
                bytes: solid_png(16, 16, [58, 58, 66])?,
                ext: "png".to_owned(),
            };
            &default_poster
        }
    };
    let poster_ext = poster.ext.to_lowercase();
    let poster_path = new_media_part(opened, "image", &poster_ext, &poster.bytes);
    ensure_default_content_type(opened, &poster_ext, image_content_type(&poster_ext))?;
    let rids = append_rels(
        opened,
        &slide_path,
        &[
            NewRel {
                kind: MODEL3D_REL_TYPE,
                target: format!("../media/{}", file_name(&model_path)),
            },
            NewRel {
                kind: IMAGE_REL_TYPE,
                target: format!("../media/{}", file_name(&poster_path)),
            },
        ],
    );
    let model_r_id = rids.first().cloned().unwrap_or_default();
    let poster_r_id = rids.get(1).cloned().unwrap_or_default();

    let id = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(None);
        };
        next_c_nv_pr_id(slide)
    };
    let name = match &opts.name {
        Some(n) => n.clone(),
        None => format!("3D Model {}", number_to_string(id)),
    };
    let bounds = glb_bounds(&opts.bytes)?.map(|b| model3d::GlbBounds {
        center: b.center,
        size: b.size,
    });
    let xml = model3d_xml(
        &Model3dXmlOptions {
            id: JsNum(id),
            name: &name,
            offset: emu_rect_for_model3d(opts.offset),
            model_r_id: &model_r_id,
            poster_r_id: &poster_r_id,
            bounds,
            rot: opts.rot.map(rot_for_model3d),
        },
        uuid,
    );
    let ids = append_raw_elements(opened, slide_index, &[xml])?;
    Ok(ids.map(|ids| ids.last().cloned().unwrap_or_default()))
}

/// `view` of `setModel3dView`.
#[derive(Debug, Clone, Deserialize)]
pub struct Model3dView {
    pub rot: Model3dRotation,
    #[serde(default)]
    pub poster: Option<MediaBytes>,
}

/// Turns a 3D model to `rot` and, with `poster`, replaces its rendering (the Fallback picture
/// and am3d:raster): the editor renders the model, the engine only stores what it drew.
pub fn set_model3d_view(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
    view: &Model3dView,
) -> Result<bool, String> {
    {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(false);
        };
        let has_model = (*slide.elements)
            .as_ref()
            .and_then(|els| els.iter().find(|e| e.id() == element_id))
            .is_some_and(
                |el| matches!(el, crate::types::SlideElement::Picture(p) if (*p.model3d).is_some()),
            );
        if !has_model {
            return Ok(false);
        }
    }
    if let Some(poster) = &view.poster
        && !replace_picture_bytes(
            opened,
            slide_index,
            element_id,
            &poster.bytes,
            &poster.ext,
            false,
        )?
    {
        return Ok(false);
    }
    let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
        return Ok(false);
    };
    // the element is looked up again: the poster replacement reparsed the slide
    let Some(els) = slide.elements.as_mut() else {
        return Ok(false);
    };
    let Some(crate::types::SlideElement::Picture(pic)) =
        els.iter_mut().find(|e| e.id() == element_id)
    else {
        return Ok(false);
    };
    if let Some(anchor) = pic.anchor.as_mut() {
        let next = set_model3d_rotation_xml(&anchor.original_xml, &rot_for_model3d(view.rot));
        anchor.original_xml = next.into();
    }
    if let Some(model) = pic.model3d.as_mut() {
        model.rot = view.rot;
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// The model part of a picture placeholder written before models were stored as am3d.
pub fn model3d_part_of(descr: Option<&str>) -> Option<String> {
    let descr = descr.filter(|d| !d.is_empty())?;
    js_regex!(r"^aislides-3d:(.+)$")
        .exec(descr)
        .map(|m| m.get(1).unwrap_or_default().to_owned())
}
