//! `apps/pdf/src/main/image-edit.ts`: content-stream image edits of a PDF.
//!
//! PDFium (wasm) and `nativeImage` are not ported yet (batch E), so only the
//! judgment around them moves: matching a rectangle to an image object, the
//! matrices and transforms an edit asks for, the order of the edits of a
//! page, what is skipped and why, and the read-back checks. Every call of
//! PDFium sits behind [`ImagePdf`]; the caller keeps `chainPdfium`,
//! `loadPdfium`, `withDocument` and `saveDoc` (it saves when
//! [`ImageEditsOutcome::changed`] says so, and keeps `renderImagePng` and
//! `renderPagePreviewPng`, which are bitmap work around PDFium calls).
//! `decodeImage` is split: `nativeImage` is the caller's, the un-premultiply
//! loop is [`unpremultiply_bgra`].

use jscompat::{math_max, math_round, number_to_string};

/// `FPDF_PAGEOBJ_TEXT`
pub const FPDF_PAGEOBJ_TEXT: i32 = 1;
/// `FPDF_PAGEOBJ_IMAGE`
pub const FPDF_PAGEOBJ_IMAGE: i32 = 3;

/// `SHARED_TEMPLATE_IMAGE_REASON` of `form-text.ts`
pub const SHARED_TEMPLATE_IMAGE_REASON: &str =
    "the image lives in a template that is drawn more than once";

/// `Rect`: left, bottom, right, top in page space.
pub type Rect = [f64; 4];

/// Bounds travel renderer to main unchanged, so matching is tight; the
/// tolerance only absorbs float32 round-trips.
pub const MATCH_TOL: f64 = 2.0;

/// `PageObj`, as far as the module reads it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageObj {
    pub index: i32,
    pub kind: i32,
}

/// `ImageObj`: an image object, page-owned or drawn inside a Form XObject
/// (bounds in page space). `in_form` is `chain.length > 0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageObj {
    pub obj: u32,
    /// page object index; for template images, their top-level ancestor's
    pub index: i32,
    pub bounds: Rect,
    pub in_form: bool,
}

/// `matchImage(objects, rect)`: the closest candidate within the tolerance
/// wins; its position in `objects`.
pub fn match_image(objects: &[ImageObj], rect: &Rect) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut best_d = f64::INFINITY;
    for (at, o) in objects.iter().enumerate() {
        let d = math_max(
            math_max(
                math_max((o.bounds[0] - rect[0]).abs(), (o.bounds[1] - rect[1]).abs()),
                (o.bounds[2] - rect[2]).abs(),
            ),
            (o.bounds[3] - rect[3]).abs(),
        );
        if d <= MATCH_TOL && d < best_d {
            best = Some(at);
            best_d = d;
        }
    }
    best
}

/// `firstTextIndex(objects)`
pub fn first_text_index(objects: &[PageObj]) -> Option<i32> {
    objects
        .iter()
        .find(|o| o.kind == FPDF_PAGEOBJ_TEXT)
        .map(|o| o.index)
}

/// `imageMatrix(rect, rotate)`: content matrix for a footprint rect,
/// counter-rotated against the page's display rotation so the image shows
/// upright.
pub fn image_matrix(rect: &Rect, rotate: f64) -> [f64; 6] {
    let [x1, y1, x2, y2] = *rect;
    let w = x2 - x1;
    let h = y2 - y1;
    let turn = ((rotate % 360.0) + 360.0) % 360.0;
    if turn == 90.0 {
        [0.0, h, -w, 0.0, x2, y1]
    } else if turn == 180.0 {
        [-w, 0.0, 0.0, -h, x2, y2]
    } else if turn == 270.0 {
        [0.0, -h, w, 0.0, x1, y2]
    } else {
        [w, 0.0, 0.0, h, x1, y1]
    }
}

/// `QUARTER_TURN_MATS`: screen-clockwise quarter turns as PDF user-space
/// matrices (y-up flips handedness).
const QUARTER_TURN_MATS: [[f64; 4]; 4] = [
    [1.0, 0.0, 0.0, 1.0],
    [0.0, -1.0, 1.0, 0.0],
    [-1.0, 0.0, 0.0, -1.0],
    [0.0, 1.0, -1.0, 0.0],
];

/// `applyImageGeometry(m, obj, bounds, rect, quarterTurns)`: the
/// `FPDFPageObj_Transform` calls it makes, in order, as `[a, b, c, d, e, f]`.
/// An optional center rotation, then the axis-aligned map of the old bounds
/// onto the final rect. A fractional `quarterTurns` finds no matrix and the
/// destructuring throws, as the `Err` says.
pub fn image_geometry_transforms(
    bounds: &Rect,
    rect: &Rect,
    quarter_turns: Option<f64>,
) -> Result<Vec<[f64; 6]>, String> {
    let mut out = Vec::new();
    let [mut ox1, mut oy1, mut ox2, mut oy2] = *bounds;
    let turns = ((quarter_turns.unwrap_or(0.0) % 4.0) + 4.0) % 4.0;
    // `if (turns)`: zero and NaN skip the rotation
    if turns != 0.0 && !turns.is_nan() {
        let cx = (ox1 + ox2) / 2.0;
        let cy = (oy1 + oy2) / 2.0;
        if turns.fract() != 0.0 || turns >= 4.0 {
            return Err(
                "undefined is not iterable (cannot read property Symbol(Symbol.iterator))"
                    .to_owned(),
            );
        }
        let [a, b, c, d] = QUARTER_TURN_MATS[turns as usize];
        out.push([a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy]);
        if turns % 2.0 == 1.0 {
            let w = ox2 - ox1;
            let h = oy2 - oy1;
            ox1 = cx - h / 2.0;
            oy1 = cy - w / 2.0;
            ox2 = cx + h / 2.0;
            oy2 = cy + w / 2.0;
        }
    }
    let [nx1, ny1, nx2, ny2] = *rect;
    let ow = ox2 - ox1;
    let oh = oy2 - oy1;
    if ow > 1e-6 && oh > 1e-6 && (nx1 != ox1 || ny1 != oy1 || nx2 != ox2 || ny2 != oy2) {
        let sx = (nx2 - nx1) / ow;
        let sy = (ny2 - ny1) / oh;
        // Post-multiplied axis-aligned map old bounds -> new rect
        out.push([sx, 0.0, 0.0, sy, nx1 - sx * ox1, ny1 - sy * oy1]);
    }
    Ok(out)
}

/// The loop of `decodeImage`: `toBitmap()` hands back premultiplied BGRA;
/// un-premultiply so translucent pixels keep their color once PDFium
/// separates them into image and soft mask.
pub fn unpremultiply_bgra(mut bgra: Vec<u8>) -> Vec<u8> {
    let mut i = 0;
    while i < bgra.len() {
        let a = bgra.get(i + 3).copied().unwrap_or(0);
        if a > 0 && a < 255 {
            for k in 0..3 {
                let value = math_round(f64::from(bgra[i + k]) * 255.0 / f64::from(a));
                bgra[i + k] = value.min(255.0) as u8;
            }
        }
        i += 4;
    }
    bgra
}

/// What `decodeImage` answers: a PNG/JPEG as straight-alpha BGRA (PDFium
/// splits alpha into a soft mask itself).
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedImage {
    pub width: f64,
    pub height: f64,
    pub bgra: Vec<u8>,
}

/// `decodeImage(b64)` after `nativeImage.createFromBuffer`: `is_empty` is
/// `img.isEmpty()`, `size` is `img.getSize()` and `bitmap` is `img.toBitmap()`.
pub fn decode_image(
    is_empty: bool,
    size: (f64, f64),
    bitmap: Vec<u8>,
) -> Result<DecodedImage, String> {
    if is_empty {
        return Err("could not decode the image data".to_owned());
    }
    Ok(DecodedImage {
        width: size.0,
        height: size.1,
        bgra: unpremultiply_bgra(bitmap),
    })
}

/// What an edit asks for (`ImageEditInput['kind']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    InsertImage,
    TransformImage,
    ReplaceImage,
    /// anything else
    DeleteImage,
}

/// `ImageEditInput`, as far as the judgment reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageEditInput {
    pub kind: EditKind,
    pub page_index: f64,
    pub old_rect: Rect,
    pub rect: Rect,
    /// `'belowText'` or `'aboveText'`; a given layer is moved to
    pub layer: Option<String>,
    pub quarter_turns: Option<f64>,
    /// the page's display rotation an inserted image is counter-rotated against
    pub rotate: Option<f64>,
}

/// `ImageEditFailure`
#[derive(Debug, Clone, PartialEq)]
pub struct SkippedImageEdit {
    pub edit_index: usize,
    pub page_index: f64,
    pub reason: String,
}

/// What `applyImageEdits` leaves for the caller: save when `changed`.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageEditsOutcome {
    pub changed: bool,
    pub skipped: Vec<SkippedImageEdit>,
}

/// `PageImageRef`
#[derive(Debug, Clone, PartialEq)]
pub struct PageImageRef {
    pub page_index: i32,
    pub rect: Rect,
    pub above_text: bool,
}

/// The PDFium calls the module makes, at the grain of the TypeScript. A page
/// is a handle (`0` for none). Each `Err` is an `Error` thrown, by its message.
pub trait ImagePdf {
    /// `FPDF_GetPageCount(doc)`
    fn page_count(&mut self) -> i32;
    /// `FPDF_LoadPage(doc, pageIndex)`
    fn load_page(&mut self, page_index: f64) -> u32;
    /// `FPDF_ClosePage(page)`
    fn close_page(&mut self, page: u32);
    /// `FPDFPage_GenerateContent(page)`
    fn generate_content(&mut self, page: u32) -> bool;
    /// `collectObjects(m, page)`
    fn collect_objects(&mut self, page: u32) -> Vec<PageObj>;
    /// `collectImages(m, page)`
    fn collect_images(&mut self, page: u32) -> Vec<ImageObj>;
    /// `formDrawTree(bytes)`, loaded once per document
    fn form_draw_tree(&mut self);
    /// `chainIsExclusive(tree, pageIndex, img.ordinals)`
    fn chain_is_exclusive(&mut self, page_index: f64, img: &ImageObj) -> bool;
    /// `liftOutOfForms(m, page, obj, chain)`
    fn lift_out_of_forms(&mut self, page: u32, img: &ImageObj);
    /// `FPDFPage_RemoveObject(page, obj)`
    fn remove_object(&mut self, page: u32, obj: u32) -> bool;
    /// `FPDFPageObj_Destroy(obj)`
    fn destroy_object(&mut self, obj: u32);
    /// `FPDFPage_InsertObject(page, obj)`
    fn insert_object(&mut self, page: u32, obj: u32);
    /// whether `_FPDFPage_InsertObjectAtIndex` exists in this build
    fn has_insert_object_at_index(&self) -> bool;
    /// `FPDFPage_InsertObjectAtIndex(page, obj, index)`
    fn insert_object_at_index(&mut self, page: u32, obj: u32, index: i32) -> bool;
    /// `FPDFPageObj_Transform(obj, a, b, c, d, e, f)`
    fn transform(&mut self, obj: u32, matrix: [f64; 6]);
    /// the first half of `insertImage`: decode, bitmap, a new image object
    /// with its matrix; answers the object
    fn new_image_object(&mut self, edit: &ImageEditInput) -> Result<u32, String>;
    /// the middle of `replaceImage`: decode, bitmap, `FPDFImageObj_SetBitmap`
    fn replace_bitmap(&mut self, page: u32, obj: u32, edit: &ImageEditInput) -> Result<(), String>;
}

/// `resolveImage` guard: the lazily loaded exclusivity census of a document.
struct Guard {
    tree_loaded: bool,
    page_index: f64,
}

/// `formExclusivity(bytes)` for one guarded lookup.
fn exclusive<H: ImagePdf>(host: &mut H, guard: &mut Guard, img: &ImageObj) -> bool {
    if !img.in_form {
        return true;
    }
    if !guard.tree_loaded {
        host.form_draw_tree();
        guard.tree_loaded = true;
    }
    host.chain_is_exclusive(guard.page_index, img)
}

/// `resolveImage(m, page, rect, guard)`: locate the image under `rect`; a
/// template image is lifted to page level first so the page-owned ops apply
/// unchanged. Without a guard the lift is unconditional.
fn resolve_image<H: ImagePdf>(
    host: &mut H,
    page: u32,
    rect: &Rect,
    guard: Option<&mut Guard>,
) -> Result<ImageObj, String> {
    let images = host.collect_images(page);
    let Some(at) = match_image(&images, rect) else {
        return Err("the image could not be located on the page".to_owned());
    };
    let mut target = images[at];
    if target.in_form {
        if let Some(guard) = guard {
            if !exclusive(host, guard, &target) {
                return Err(SHARED_TEMPLATE_IMAGE_REASON.to_owned());
            }
        }
        host.lift_out_of_forms(page, &target);
        target.in_form = false;
    }
    Ok(target)
}

/// `moveToLayer(m, page, obj, layer)`: remove and reinsert; the page owns it
/// again after.
fn move_to_layer<H: ImagePdf>(
    host: &mut H,
    page: u32,
    obj: u32,
    layer: &str,
) -> Result<(), String> {
    if !host.remove_object(page, obj) {
        return Err("FPDFPage_RemoveObject failed".to_owned());
    }
    let text_index = if layer == "belowText" {
        let objects = host.collect_objects(page);
        first_text_index(&objects)
    } else {
        None
    };
    match text_index {
        Some(index) if host.has_insert_object_at_index() => {
            if !host.insert_object_at_index(page, obj, index) {
                // The object is already off the page here: re-attach it
                // (topmost) instead of destroying it, or a skipped layer change
                // would silently delete page content
                host.insert_object(page, obj);
                return Err("FPDFPage_InsertObjectAtIndex failed".to_owned());
            }
        }
        _ => host.insert_object(page, obj),
    }
    Ok(())
}

fn apply_geometry<H: ImagePdf>(
    host: &mut H,
    obj: u32,
    bounds: &Rect,
    edit: &ImageEditInput,
) -> Result<(), String> {
    for matrix in image_geometry_transforms(bounds, &edit.rect, edit.quarter_turns)? {
        host.transform(obj, matrix);
    }
    Ok(())
}

fn insert_image<H: ImagePdf>(host: &mut H, page: u32, edit: &ImageEditInput) -> Result<(), String> {
    let img_obj = host.new_image_object(edit)?;
    let text_index = if edit.layer.as_deref() == Some("belowText") {
        let objects = host.collect_objects(page);
        first_text_index(&objects)
    } else {
        None
    };
    match text_index {
        Some(index) if host.has_insert_object_at_index() => {
            if !host.insert_object_at_index(page, img_obj, index) {
                host.destroy_object(img_obj);
                return Err("FPDFPage_InsertObjectAtIndex failed".to_owned());
            }
        }
        _ => host.insert_object(page, img_obj),
    }
    Ok(())
}

fn transform_image<H: ImagePdf>(
    host: &mut H,
    page: u32,
    edit: &ImageEditInput,
    guard: &mut Guard,
) -> Result<(), String> {
    let target = resolve_image(host, page, &edit.old_rect, Some(guard))?;
    // Layer move first: it is the only part that can fail, so a skipped edit is
    // reported before any geometry has been touched
    if let Some(layer) = edit.layer.as_deref().filter(|l| !l.is_empty()) {
        move_to_layer(host, page, target.obj, layer)?;
    }
    apply_geometry(host, target.obj, &target.bounds, edit)
}

fn replace_image<H: ImagePdf>(
    host: &mut H,
    page: u32,
    edit: &ImageEditInput,
    guard: &mut Guard,
) -> Result<(), String> {
    let target = resolve_image(host, page, &edit.old_rect, Some(guard))?;
    if let Some(layer) = edit.layer.as_deref().filter(|l| !l.is_empty()) {
        move_to_layer(host, page, target.obj, layer)?;
    }
    host.replace_bitmap(page, target.obj, edit)?;
    apply_geometry(host, target.obj, &target.bounds, edit)
}

fn delete_image<H: ImagePdf>(
    host: &mut H,
    page: u32,
    edit: &ImageEditInput,
    guard: &mut Guard,
) -> Result<(), String> {
    let target = resolve_image(host, page, &edit.old_rect, Some(guard))?;
    if !host.remove_object(page, target.obj) {
        return Err("FPDFPage_RemoveObject failed".to_owned());
    }
    host.destroy_object(target.obj);
    Ok(())
}

/// `x` of a `Map` key: SameValueZero
fn same_key(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// `applyImageEdits(bytes, edits)` inside `withDocument`: apply content-stream
/// image ops, fail-soft per edit. `Err` is what the TypeScript throws out of
/// it (a page that cannot be loaded or regenerated); the caller saves the
/// document when the outcome is `changed`.
pub fn apply_image_edits<H: ImagePdf>(
    host: &mut H,
    edits: &[ImageEditInput],
) -> Result<ImageEditsOutcome, String> {
    let mut skipped: Vec<SkippedImageEdit> = Vec::new();
    let page_count = host.page_count();
    let mut by_page: Vec<(f64, Vec<usize>)> = Vec::new();
    for (edit_index, edit) in edits.iter().enumerate() {
        if edit.page_index < 0.0 || edit.page_index >= f64::from(page_count) {
            skipped.push(SkippedImageEdit {
                edit_index,
                page_index: edit.page_index,
                reason: "page does not exist".to_owned(),
            });
            continue;
        }
        match by_page
            .iter_mut()
            .find(|(key, _)| same_key(*key, edit.page_index))
        {
            Some((_, list)) => list.push(edit_index),
            None => by_page.push((edit.page_index, vec![edit_index])),
        }
    }
    let mut applied_total = 0usize;
    let mut tree_loaded = false;
    for (page_index, page_edits) in by_page {
        let page = host.load_page(page_index);
        if page == 0 {
            return Err(format!(
                "could not load page {}",
                number_to_string(page_index + 1.0)
            ));
        }
        let mut applied = 0usize;
        let mut guard = Guard {
            tree_loaded,
            page_index,
        };
        // Objects are re-collected inside each op: every mutation shifts indices
        for edit_index in page_edits {
            let edit = &edits[edit_index];
            let done = match edit.kind {
                EditKind::InsertImage => insert_image(host, page, edit),
                EditKind::TransformImage => transform_image(host, page, edit, &mut guard),
                EditKind::ReplaceImage => replace_image(host, page, edit, &mut guard),
                EditKind::DeleteImage => delete_image(host, page, edit, &mut guard),
            };
            match done {
                Ok(()) => applied += 1,
                Err(reason) => skipped.push(SkippedImageEdit {
                    edit_index,
                    page_index,
                    reason,
                }),
            }
        }
        tree_loaded = guard.tree_loaded;
        if applied > 0 && !host.generate_content(page) {
            host.close_page(page);
            return Err(format!(
                "could not regenerate page {}",
                number_to_string(page_index + 1.0)
            ));
        }
        applied_total += applied;
        host.close_page(page);
    }
    Ok(ImageEditsOutcome {
        changed: applied_total > 0,
        skipped,
    })
}

/// `listPageImages(bytes)` inside `withDocument`: every page's content-stream
/// images (rect and z-band relative to text).
pub fn list_page_images<H: ImagePdf>(host: &mut H) -> Vec<PageImageRef> {
    let mut out = Vec::new();
    let page_count = host.page_count();
    for page_index in 0..page_count {
        let page = host.load_page(f64::from(page_index));
        if page == 0 {
            continue;
        }
        let objects = host.collect_objects(page);
        let text_index = first_text_index(&objects);
        for o in host.collect_images(page) {
            // Sub-3pt objects are decoration/artifacts; not worth an edit target
            if o.bounds[2] - o.bounds[0] < 3.0 || o.bounds[3] - o.bounds[1] < 3.0 {
                continue;
            }
            out.push(PageImageRef {
                page_index,
                rect: o.bounds,
                above_text: text_index.is_some_and(|text| o.index > text),
            });
        }
        host.close_page(page);
    }
    out
}

/// `verifyImageEdits(bytes, edits)` inside `withDocument`: read-back
/// verification on the final saved bytes. Inserts and transforms must be
/// findable at their target rect. Answers `(pageIndex, reason)` pairs.
pub fn verify_image_edits<H: ImagePdf>(host: &mut H, edits: &[(f64, Rect)]) -> Vec<(f64, String)> {
    let mut failures: Vec<(f64, String)> = Vec::new();
    let page_count = host.page_count();
    let mut by_page: Vec<(f64, Vec<Rect>)> = Vec::new();
    for (page_index, rect) in edits {
        if *page_index < 0.0 || *page_index >= f64::from(page_count) {
            failures.push((*page_index, "page missing from saved output".to_owned()));
            continue;
        }
        match by_page
            .iter_mut()
            .find(|(key, _)| same_key(*key, *page_index))
        {
            Some((_, rects)) => rects.push(*rect),
            None => by_page.push((*page_index, vec![*rect])),
        }
    }
    for (page_index, rects) in by_page {
        let page = host.load_page(page_index);
        if page == 0 {
            for _ in &rects {
                failures.push((page_index, "page unreadable in saved output".to_owned()));
            }
            continue;
        }
        let objects = host.collect_images(page);
        for rect in &rects {
            if match_image(&objects, rect).is_none() {
                failures.push((page_index, "image missing from saved output".to_owned()));
            }
        }
        host.close_page(page);
    }
    failures
}
