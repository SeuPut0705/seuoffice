//! `apps/pdf/src/main/redaction.ts`: permanently apply redaction rectangles
//! with EmbedPDF's native redaction API, over the [`Pdfium`] instance the
//! caller owns. The checks all run before the first mutation, so an invalid
//! trailing region cannot yield a partially redacted output buffer.

use super::pdfium::{
    Pdfium, PdfiumError, heap_f32, heap_set_f32, int_arg, save_doc, subarray, with_document,
};
use jscompat::{JsonValue, json_stringify, math_max, math_min, number_to_string};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// public/fpdf_annot.h: FPDF_ANNOT_REDACT
const FPDF_ANNOT_REDACT: i32 = 28;
const FPDF_ANNOT_WIDGET: i32 = 20;
const FPDF_PAGEOBJ_IMAGE: i32 = 3;
const FPDF_PAGEOBJ_FORM: i32 = 5;
/// `PdfAnnotationColorType.OverlayColor`. Unlike /IC, /OC is flattened by
/// ApplyRedaction as the permanent post-removal fill.
const PDF_ANNOTATION_OVERLAY_COLOR: i32 = 2;

/// PDF user-space rectangle. Callers retain original page indices until the redaction copy is made.
#[derive(Debug, Clone, PartialEq)]
pub struct RedactionRegion {
    pub page_index: f64,
    pub rect: [f64; 4],
}

fn err(message: String) -> PdfiumError {
    PdfiumError(message)
}

fn intersects(a: &[f64], b: &[f64]) -> bool {
    let (al, ab, ar, at) = (
        math_min(a[0], a[2]),
        math_min(a[1], a[3]),
        math_max(a[0], a[2]),
        math_max(a[1], a[3]),
    );
    let (bl, bb, br, bt) = (
        math_min(b[0], b[2]),
        math_min(b[1], b[3]),
        math_max(b[0], b[2]),
        math_max(b[1], b[3]),
    );
    al < br && ar > bl && ab < bt && at > bb
}

fn object_bounds<M: Pdfium + ?Sized>(m: &mut M, object: u32) -> Option<[f64; 4]> {
    let left = m.malloc(4);
    let bottom = m.malloc(4);
    let right = m.malloc(4);
    let top = m.malloc(4);
    let out = if m.fpdf_page_obj_get_bounds(object, left, bottom, right, top) == 0 {
        None
    } else {
        Some([
            heap_f32(m, left >> 2),
            heap_f32(m, bottom >> 2),
            heap_f32(m, right >> 2),
            heap_f32(m, top >> 2),
        ])
    };
    m.free(left);
    m.free(bottom);
    m.free(right);
    m.free(top);
    out
}

fn image_hash<M: Pdfium + ?Sized>(m: &mut M, image: u32) -> Result<String, PdfiumError> {
    let size = m.fpdf_image_obj_get_image_data_raw(image, 0, 0);
    if size == 0 {
        return Err(err("PDFium could not inspect image data safely".to_owned()));
    }
    let ptr = m.malloc(size);
    let result = if m.fpdf_image_obj_get_image_data_raw(image, ptr, size) != size {
        Err(err("PDFium could not inspect image data safely".to_owned()))
    } else {
        let data = subarray(m.heap(), u64::from(ptr), u64::from(ptr) + u64::from(size));
        Ok(Sha256::digest(data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    };
    m.free(ptr);
    result
}

fn collect_image_hashes<M: Pdfium + ?Sized>(
    m: &mut M,
    object: u32,
    hashes: &mut HashMap<String, i32>,
    seen: &mut Vec<u32>,
) -> Result<bool, PdfiumError> {
    if object == 0 || seen.contains(&object) {
        return Ok(false);
    }
    seen.push(object);
    let kind = m.fpdf_page_obj_get_type(object);
    if kind == FPDF_PAGEOBJ_IMAGE {
        let hash = image_hash(m, object)?;
        *hashes.entry(hash).or_insert(0) += 1;
        return Ok(true);
    }
    if kind != FPDF_PAGEOBJ_FORM {
        return Ok(false);
    }
    let mut has_image = false;
    let mut i = 0;
    while i < m.fpdf_form_obj_count_objects(object) {
        let child = m.fpdf_form_obj_get_object(object, i);
        has_image = collect_image_hashes(m, child, hashes, seen)? || has_image;
        i += 1;
    }
    Ok(has_image)
}

/// Boolean-only walk of a Form XObject's children: an image anywhere inside makes
/// the form unsafe to redact through.
fn form_contains_image<M: Pdfium + ?Sized>(m: &mut M, object: u32, seen: &mut Vec<u32>) -> bool {
    if object == 0 || seen.contains(&object) {
        return false;
    }
    seen.push(object);
    let kind = m.fpdf_page_obj_get_type(object);
    if kind == FPDF_PAGEOBJ_IMAGE {
        return true;
    }
    if kind != FPDF_PAGEOBJ_FORM {
        return false;
    }
    let mut i = 0;
    while i < m.fpdf_form_obj_count_objects(object) {
        let child = m.fpdf_form_obj_get_object(object, i);
        if form_contains_image(m, child, seen) {
            return true;
        }
        i += 1;
    }
    false
}

/// One census per apply: fingerprint every image object in the document once,
/// counting content repeats so the shared-image gate can tell a private image
/// from a placed-many one.
fn census_image_hashes<M: Pdfium + ?Sized>(
    m: &mut M,
    doc: u32,
) -> Result<HashMap<String, i32>, PdfiumError> {
    let mut hashes = HashMap::new();
    let mut p = 0;
    while p < m.fpdf_get_page_count(doc) {
        let candidate = m.fpdf_load_page(doc, p);
        if candidate == 0 {
            return Err(err(format!("PDFium could not inspect page {}", p + 1)));
        }
        let result = (|| -> Result<(), PdfiumError> {
            let mut i = 0;
            while i < m.fpdf_page_count_objects(candidate) {
                let object = m.fpdf_page_get_object(candidate, i);
                collect_image_hashes(m, object, &mut hashes, &mut Vec::new())?;
                i += 1;
            }
            Ok(())
        })();
        m.fpdf_close_page(candidate);
        result?;
        p += 1;
    }
    Ok(hashes)
}

/// PDFium 2.15.1 edits a shared image stream in place. Allow a single-instance
/// image, but reject a selected shared image or an image-bearing Form XObject whose
/// child transform cannot be inspected through this API.
fn assert_image_redaction_is_safe<M: Pdfium + ?Sized>(
    m: &mut M,
    hashes: &HashMap<String, i32>,
    page: u32,
    rect: &[f64],
    page_index: f64,
) -> Result<(), PdfiumError> {
    let mut i = 0;
    while i < m.fpdf_page_count_objects(page) {
        let object = m.fpdf_page_get_object(page, i);
        let bounds = object_bounds(m, object);
        i += 1;
        let Some(bounds) = bounds else { continue };
        if object == 0 || !intersects(rect, &bounds) {
            continue;
        }
        if m.fpdf_page_obj_get_type(object) == FPDF_PAGEOBJ_IMAGE
            && hashes.get(&image_hash(m, object)?).copied().unwrap_or(0) > 1
        {
            return Err(err(format!(
                "redaction intersects a shared image on page {}; refusing unsafe image mutation",
                number_to_string(page_index + 1.0)
            )));
        }
        if m.fpdf_page_obj_get_type(object) == FPDF_PAGEOBJ_FORM
            && form_contains_image(m, object, &mut Vec::new())
        {
            return Err(err(format!(
                "redaction intersects an image Form XObject on page {}; refusing unsafe image mutation",
                number_to_string(page_index + 1.0)
            )));
        }
    }
    Ok(())
}

fn rect_at<M: Pdfium + ?Sized>(m: &M, ptr: u32) -> [f64; 4] {
    let at = ptr >> 2;
    [
        heap_f32(m, at),
        heap_f32(m, at + 1),
        heap_f32(m, at + 2),
        heap_f32(m, at + 3),
    ]
}

/// PDFium 2.15.1 removes a hit Widget annotation but can leave its AcroForm
/// field value and appearance reachable through the field tree. Refuse that
/// region until the whole field graph can be removed transactionally.
fn assert_form_redaction_is_safe<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    rect: &[f64],
    page_index: f64,
) -> Result<(), PdfiumError> {
    let page_no = number_to_string(page_index + 1.0);
    let mut i = 0;
    while i < m.fpdf_page_get_annot_count(page) {
        let annot = m.fpdf_page_get_annot(page, i);
        i += 1;
        if annot == 0 {
            return Err(err(format!(
                "PDFium could not inspect annotation on page {page_no}"
            )));
        }
        let result = (|| {
            if m.fpdf_annot_get_subtype(annot) != FPDF_ANNOT_WIDGET {
                return Ok(());
            }
            let ptr = m.malloc(16);
            let inner = if m.fpdf_annot_get_rect(annot, ptr) == 0 {
                Err(err(format!(
                    "PDFium could not inspect form field on page {page_no}"
                )))
            } else if intersects(rect, &rect_at(m, ptr)) {
                Err(err(format!(
                    "redaction intersects a form field on page {page_no}; refusing recoverable field data"
                )))
            } else {
                Ok(())
            };
            m.free(ptr);
            inner
        })();
        m.fpdf_page_close_annot(annot);
        result?;
    }
    Ok(())
}

/// Remove non-widget annotations whose alternate text, comments, or appearance
/// would otherwise remain a recoverable side channel. Widgets are preflighted and
/// rejected above because their AcroForm parent values can outlive page removal.
fn remove_hit_annotations<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    rect: &[f64],
    page_index: f64,
) -> Result<(), PdfiumError> {
    let page_no = number_to_string(page_index + 1.0);
    let mut i = m.fpdf_page_get_annot_count(page) - 1;
    while i >= 0 {
        let annot = m.fpdf_page_get_annot(page, i);
        if annot == 0 {
            return Err(err(format!(
                "PDFium could not inspect annotation on page {page_no}"
            )));
        }
        let hit = {
            let ptr = m.malloc(16);
            let inner = if m.fpdf_annot_get_rect(annot, ptr) == 0 {
                Err(err(format!(
                    "PDFium could not inspect annotation on page {page_no}"
                )))
            } else {
                Ok(intersects(rect, &rect_at(m, ptr)))
            };
            m.free(ptr);
            inner
        };
        m.fpdf_page_close_annot(annot);
        if hit? && m.fpdf_page_remove_annot(page, i) == 0 {
            return Err(err(format!(
                "PDFium could not remove annotation on page {page_no}"
            )));
        }
        i -= 1;
    }
    Ok(())
}

const MAX_FLOAT32: f64 = 3.402823466e38;

fn op_label(index: usize) -> String {
    format!("redaction {}", index + 1)
}

/// `JSON.stringify(rect) ?? String(rect)`; `None` is `undefined`
fn format_rect(rect: Option<&JsonValue>) -> String {
    match rect {
        Some(value) => json_stringify(value),
        None => "undefined".to_owned(),
    }
}

fn rect_json(rect: &[f64; 4]) -> JsonValue {
    JsonValue::Array(rect.iter().map(|&n| JsonValue::Number(n)).collect())
}

/// Shared page-index gate: integer and non-negative. Upper-bound range is checked later with pageCount.
fn check_page_index(page_index: Option<&JsonValue>, label: &str) -> Result<f64, PdfiumError> {
    let n = match page_index {
        Some(JsonValue::Number(x)) if x.is_finite() && x.fract() == 0.0 => *x,
        _ => {
            return Err(err(format!(
                "{label}: redaction page index must be an integer (got {})",
                format_rect(page_index)
            )));
        }
    };
    if n < 0.0 {
        return Err(err(format!(
            "{label}: redaction page index {} is out of range (must be >= 0)",
            number_to_string(n)
        )));
    }
    Ok(n)
}

/// Shared rectangle gate: four finite coords inside PDFium range and nonempty.
fn check_rect(
    rect: Option<&JsonValue>,
    label: &str,
    page_index: f64,
) -> Result<[f64; 4], PdfiumError> {
    let r#where = format!("{label} on page {}", number_to_string(page_index + 1.0));
    let coords: Option<Vec<f64>> = match rect {
        Some(JsonValue::Array(items)) if items.len() == 4 => items
            .iter()
            .map(|n| match n {
                JsonValue::Number(x) if x.is_finite() => Some(*x),
                _ => None,
            })
            .collect(),
        _ => None,
    };
    let Some(coords) = coords else {
        return Err(err(format!(
            "{}: redaction rectangle must contain four finite coordinates (got {})",
            r#where,
            format_rect(rect)
        )));
    };
    let [x1, y1, x2, y2] = [coords[0], coords[1], coords[2], coords[3]];
    if coords.iter().any(|n| n.abs() > MAX_FLOAT32) {
        return Err(err(format!(
            "{}: redaction rectangle is outside PDFium coordinate range (got {})",
            r#where,
            format_rect(rect)
        )));
    }
    if !(x1 != x2 && y1 != y2) {
        return Err(err(format!(
            "{}: redaction rectangle must be nonempty (got {})",
            r#where,
            format_rect(rect)
        )));
    }
    Ok([x1, y1, x2, y2])
}

/// Max redaction rects per request: prevents 100k-rect DoS on native redact.
pub const MAX_REDACTION_REGIONS: usize = 500;

pub fn validate_redaction_regions(value: &JsonValue) -> Result<Vec<RedactionRegion>, PdfiumError> {
    let JsonValue::Array(items) = value else {
        return Err(err(
            "at least one redaction rectangle is required".to_owned()
        ));
    };
    if items.is_empty() {
        return Err(err(
            "at least one redaction rectangle is required".to_owned()
        ));
    }
    if items.len() > MAX_REDACTION_REGIONS {
        return Err(err(format!(
            "too many redaction rectangles ({}, cap {})",
            items.len(),
            MAX_REDACTION_REGIONS
        )));
    }
    let mut out = Vec::with_capacity(items.len());
    for (index, region) in items.iter().enumerate() {
        let label = op_label(index);
        // `!region || typeof region !== 'object'`
        if !matches!(region, JsonValue::Object(_) | JsonValue::Array(_)) {
            return Err(err(format!(
                "{label}: invalid redaction region (got {})",
                format_rect(Some(region))
            )));
        }
        let page_index = check_page_index(region.get("pageIndex").as_deref(), &label)?;
        let rect = check_rect(region.get("rect").as_deref(), &label, page_index)?;
        out.push(RedactionRegion { page_index, rect });
    }
    Ok(out)
}

fn checked_region(
    region: &RedactionRegion,
    page_count: i32,
    index: usize,
) -> Result<[f64; 4], PdfiumError> {
    let label = op_label(index);
    let page_index = check_page_index(Some(&JsonValue::Number(region.page_index)), &label)?;
    if page_index >= f64::from(page_count) {
        return Err(err(format!(
            "{label}: redaction page index {} is out of range (pages 1-{}, got rect {})",
            number_to_string(page_index),
            page_count,
            format_rect(Some(&rect_json(&region.rect)))
        )));
    }
    let rect = rect_json(&region.rect);
    let [x1, y1, x2, y2] = check_rect(Some(&rect), &label, page_index)?;
    let left = math_min(x1, x2);
    let bottom = math_min(y1, y2);
    let right = math_max(x1, x2);
    let top = math_max(y1, y2);
    if !(right > left && top > bottom) {
        return Err(err(format!(
            "{label} on page {}: redaction rectangle must be nonempty (got {})",
            number_to_string(page_index + 1.0),
            format_rect(Some(&rect))
        )));
    }
    Ok([left, top, right, bottom])
}

/// Permanently apply every requested area using EmbedPDF's native redaction API.
/// This deliberately does not persist the temporary Redact annotations: native code
/// removes both them and intersecting annotations after deleting the covered content.
pub fn redact_pdf<M: Pdfium + ?Sized>(
    m: &mut M,
    bytes: &[u8],
    regions: &JsonValue,
) -> Result<Vec<u8>, PdfiumError> {
    let valid_regions = validate_redaction_regions(regions)?;
    with_document(m, bytes, None, |m, doc| {
        let page_count = m.fpdf_get_page_count(doc);
        // Validate the complete request before constructing a single annotation, so an
        // invalid trailing region cannot yield a partially-redacted output buffer.
        let mut checked: Vec<(&RedactionRegion, [f64; 4])> = Vec::new();
        for (index, region) in valid_regions.iter().enumerate() {
            checked.push((region, checked_region(region, page_count, index)?));
        }
        // One census for the whole apply: nothing is mutated until after it and the
        // region checks, so N rectangles cost one document walk instead of N.
        let hashes = census_image_hashes(m, doc)?;
        for (region, native_rect) in &checked {
            let page = m.fpdf_load_page(doc, int_arg(region.page_index));
            if page == 0 {
                return Err(err(format!(
                    "PDFium could not load redaction page {}",
                    number_to_string(region.page_index + 1.0)
                )));
            }
            let result = (|| {
                assert_image_redaction_is_safe(m, &hashes, page, native_rect, region.page_index)?;
                assert_form_redaction_is_safe(m, page, native_rect, region.page_index)
            })();
            m.fpdf_close_page(page);
            result?;
        }
        for (region, native_rect) in &checked {
            let page_no = number_to_string(region.page_index + 1.0);
            let page = m.fpdf_load_page(doc, int_arg(region.page_index));
            if page == 0 {
                return Err(err(format!(
                    "PDFium could not load redaction page {page_no}"
                )));
            }
            let result = redact_region(m, page, native_rect, region.page_index, &page_no);
            m.fpdf_close_page(page);
            result?;
        }
        save_doc(m, doc)
    })
}

fn redact_region<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    native_rect: &[f64; 4],
    page_index: f64,
    page_no: &str,
) -> Result<(), PdfiumError> {
    remove_hit_annotations(m, page, native_rect, page_index)?;
    let annot = m.fpdf_page_create_annot(page, FPDF_ANNOT_REDACT);
    if annot == 0 {
        return Err(err(format!(
            "PDFium could not create redaction on page {page_no}"
        )));
    }
    let result = (|| {
        let ptr = m.malloc(16);
        let styled = (|| {
            // FS_RECTF is {left, top, right, bottom}; the native implementation
            // normalizes it and uses it when QuadPoints are absent.
            for (k, &n) in native_rect.iter().enumerate() {
                heap_set_f32(m, (ptr >> 2) + k as u32, n);
            }
            if m.fpdf_annot_set_rect(annot, ptr) == 0 {
                return Err(err(format!(
                    "PDFium rejected redaction rectangle on page {page_no}"
                )));
            }
            // /OC is flattened as page content during ApplyRedaction. /IC only
            // controls the review annotation and would leave a white hole here.
            if m.epdf_annot_set_color(annot, PDF_ANNOTATION_OVERLAY_COLOR, 0, 0, 0) == 0 {
                return Err(err(format!(
                    "PDFium could not style redaction on page {page_no}"
                )));
            }
            Ok(())
        })();
        m.free(ptr);
        styled?;
        if m.epdf_annot_apply_redaction(page, annot) == 0 {
            return Err(err(format!(
                "PDFium could not apply redaction on page {page_no}"
            )));
        }
        // 2.15.1 removes image/text content correctly but its annotation overlay
        // is not painted when a Rect (rather than QuadPoints) defines the area.
        // Add the blackout to the already redacted native page before its sole
        // GenerateContent/save pass; this never serializes the pre-redaction doc.
        let [left, top, right, bottom] = *native_rect;
        let blackout = m.fpdf_page_obj_create_new_rect(left, bottom, right - left, top - bottom);
        if blackout == 0
            || m.fpdf_page_obj_set_fill_color(blackout, 0, 0, 0, 255) == 0
            || m.fpdf_path_set_draw_mode(blackout, 1, 0) == 0
        {
            if blackout != 0 {
                m.fpdf_page_obj_destroy(blackout);
            }
            return Err(err(format!(
                "PDFium could not create blackout on page {page_no}"
            )));
        }
        m.fpdf_page_insert_object(page, blackout);
        Ok(())
    })();
    m.fpdf_page_close_annot(annot);
    result?;
    if m.fpdf_page_generate_content(page) == 0 {
        return Err(err(format!(
            "PDFium could not serialize redaction on page {page_no}"
        )));
    }
    Ok(())
}
