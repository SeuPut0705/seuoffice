//! `apps/pdf/src/main/annot-delete.ts`: remove saved markup annotations from
//! the file bytes, over the [`Pdfium`] surface the caller owns.

use super::pdfium::{
    Pdfium, PdfiumError, heap_f32, heap_set, int_arg, save_doc, subarray, with_document,
};
use jscompat::{math_max, math_min};

/// `AnnotDeleteInput` (`shared/ipc.ts`). Numbers stay doubles: the
/// TypeScript holds whatever number the renderer sent.
#[derive(Debug, Clone, PartialEq)]
pub struct AnnotDeleteInput {
    pub page_index: f64,
    /// PDF object number
    pub obj_num: f64,
    /// a `MarkupType`, `note` or `polygon`
    pub subtype: String,
    pub rect: [f64; 4],
    pub contents: Option<String>,
}

/// `SUBTYPE_CODE[subtype]`; `undefined` (`None`) for a name the table lacks
fn subtype_code(subtype: &str) -> Option<i32> {
    match subtype {
        "highlight" => Some(9),
        "underline" => Some(10),
        "squiggly" => Some(11),
        "strikeout" => Some(12),
        "note" => Some(1),
        "polygon" => Some(7),
        _ => None,
    }
}

/// Match tolerance for the rect fallback (float32 round-trips only; rects travel unchanged)
const RECT_TOL: f64 = 2.0;

fn annot_rect<M: Pdfium + ?Sized>(m: &mut M, annot: u32) -> Option<[f64; 4]> {
    // FS_RECTF: four float32 {left, top, right, bottom}
    let ptr = m.malloc(16);
    let out = if m.fpdf_annot_get_rect(annot, ptr) == 0 {
        None
    } else {
        let at = ptr >> 2;
        Some([
            heap_f32(m, at),
            heap_f32(m, at + 1),
            heap_f32(m, at + 2),
            heap_f32(m, at + 3),
        ])
    };
    m.free(ptr);
    out
}

fn norm(r: &[f64; 4]) -> [f64; 4] {
    [
        math_min(r[0], r[2]),
        math_min(r[1], r[3]),
        math_max(r[0], r[2]),
        math_max(r[1], r[3]),
    ]
}

fn rects_close(a: &[f64; 4], b: &[f64; 4]) -> bool {
    // FS_RECTF is {left, top, right, bottom} while our rects are [x1,y1,x2,y2] with
    // y1 < y2: compare the normalized bounds
    let na = norm(a);
    let nb = norm(b);
    let mut worst = f64::NEG_INFINITY;
    for i in 0..4 {
        worst = math_max(worst, (na[i] - nb[i]).abs());
    }
    worst <= RECT_TOL
}

/// /Contents of an annotation, as UTF-16 units (`''` when absent)
fn annot_contents<M: Pdfium + ?Sized>(m: &mut M, annot: u32) -> Result<Vec<u16>, PdfiumError> {
    let key_bytes = b"Contents\0";
    let key = m.malloc(key_bytes.len() as u32);
    let result = (|| {
        heap_set(m, key, key_bytes)?;
        let len = m.fpdf_annot_get_string_value(annot, key, 0, 0);
        if len <= 2 {
            return Ok(Vec::new());
        }
        let buf = m.malloc(len as u32);
        m.fpdf_annot_get_string_value(annot, key, buf, len as u32);
        let bytes = subarray(m.heap(), u64::from(buf), u64::from(buf) + len as u64 - 2);
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        m.free(buf);
        Ok(units)
    })();
    m.free(key);
    result
}

/// Top-left anchors within tolerance
fn corners_close(a: &[f64; 4], b: &[f64; 4]) -> bool {
    (math_min(a[0], a[2]) - math_min(b[0], b[2])).abs() <= RECT_TOL
        && (math_max(a[1], a[3]) - math_max(b[1], b[3])).abs() <= RECT_TOL
}

/// All identity fields of `d` match this annotation.
fn annot_matches<M: Pdfium + ?Sized>(
    m: &mut M,
    annot: u32,
    d: &AnnotDeleteInput,
) -> Result<bool, PdfiumError> {
    if Some(m.fpdf_annot_get_subtype(annot)) != subtype_code(&d.subtype) {
        return Ok(false);
    }
    let Some(rect) = annot_rect(m, annot) else {
        return Ok(false);
    };
    let close = if d.subtype == "note" {
        corners_close(&rect, &d.rect)
    } else {
        rects_close(&rect, &d.rect)
    };
    if !close {
        return Ok(false);
    }
    match &d.contents {
        None => Ok(true),
        Some(contents) => {
            let found = annot_contents(m, annot)?;
            Ok(found.iter().copied().eq(contents.encode_utf16()))
        }
    }
}

/// Remove by object number only when all stable identity fields still match.
fn remove_by_obj_num<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    d: &AnnotDeleteInput,
) -> Result<bool, PdfiumError> {
    let annot = m.epdf_page_get_annot_by_object_number(page, int_arg(d.obj_num));
    if annot == 0 {
        return Ok(false);
    }
    let ok = annot_matches(m, annot, d)?;
    m.fpdf_page_close_annot(annot);
    Ok(ok && m.epdf_page_remove_annot_by_object_number(page, int_arg(d.obj_num)) != 0)
}

/// Fallback: scan the page for an annotation with the same identity fields
fn remove_by_match<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    d: &AnnotDeleteInput,
) -> Result<bool, PdfiumError> {
    let count = m.fpdf_page_get_annot_count(page);
    for i in 0..count {
        let annot = m.fpdf_page_get_annot(page, i);
        if annot == 0 {
            continue;
        }
        let ok = annot_matches(m, annot, d)?;
        m.fpdf_page_close_annot(annot);
        if ok {
            return Ok(m.fpdf_page_remove_annot(page, i) != 0);
        }
    }
    Ok(false)
}

/// `new Map<number, ...>` keys: SameValueZero
fn same_value_zero(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// Remove saved markup annotations from the file bytes (in memory). Runs before every
/// other save stage so the object numbers still address the on-disk file; unmatched
/// entries are skipped fail-soft.
pub fn apply_annot_deletes<M: Pdfium + ?Sized>(
    m: &mut M,
    bytes: &[u8],
    deletes: &[AnnotDeleteInput],
) -> Result<Vec<u8>, PdfiumError> {
    with_document(m, bytes, None, |m, doc| {
        let page_count = f64::from(m.fpdf_get_page_count(doc));
        let mut by_page: Vec<(f64, Vec<&AnnotDeleteInput>)> = Vec::new();
        for d in deletes {
            if d.page_index < 0.0 || d.page_index >= page_count {
                continue;
            }
            match by_page
                .iter_mut()
                .find(|(key, _)| same_value_zero(*key, d.page_index))
            {
                Some((_, list)) => list.push(d),
                None => by_page.push((d.page_index, vec![d])),
            }
        }
        let mut removed = 0;
        for (page_index, list) in &by_page {
            let page = m.fpdf_load_page(doc, int_arg(*page_index));
            if page == 0 {
                continue;
            }
            let result = (|| -> Result<(), PdfiumError> {
                for d in list {
                    if remove_by_obj_num(m, page, d)? || remove_by_match(m, page, d)? {
                        removed += 1;
                    }
                }
                Ok(())
            })();
            m.fpdf_close_page(page);
            result?;
        }
        if removed > 0 {
            save_doc(m, doc)
        } else {
            Ok(bytes.to_vec())
        }
    })
}

/// Remove annotations on an already-loaded page for the live preview.
pub fn remove_matching_annots<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    deletes: &[AnnotDeleteInput],
) -> Result<(), PdfiumError> {
    for d in deletes {
        if !remove_by_obj_num(m, page, d)? {
            remove_by_match(m, page, d)?;
        }
    }
    Ok(())
}
