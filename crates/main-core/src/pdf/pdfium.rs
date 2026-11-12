//! The Emscripten module surface of `Pdfium` in `apps/pdf/src/main/text-edit.ts`
//! (raw `FPDF_*` exports plus heap access), as far as the modules of batch 4
//! call it, with `withDocument` and `saveDoc` of the same file.
//!
//! The TypeScript reaches the wasm instance through `loadPdfium()` and queues
//! its work behind `chainPdfium`. Here the caller owns the instance (a
//! `&mut dyn Pdfium`) and the queue is the borrow: one operation at a time.
//! Every pointer and handle is a `u32` of the instance's memory; a pointer
//! into the heap indexes `heap()`, which is `HEAPU8` (and, through the
//! helpers below, `HEAPF32` and `HEAPF64` over the same bytes).

use jscompat::to_int32;

/// What the modules throw: `new Error(message)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfiumError(pub String);

impl PdfiumError {
    pub fn new(message: impl Into<String>) -> Self {
        PdfiumError(message.into())
    }
}

/// The calls of `Pdfium` that the batch-4 modules make, named as the exports
/// without the leading underscore and in snake case.
pub trait Pdfium {
    /// `HEAPU8`
    fn heap(&self) -> &[u8];
    fn heap_mut(&mut self) -> &mut [u8];
    fn malloc(&mut self, size: u32) -> u32;
    fn free(&mut self, ptr: u32);

    fn pdfium_ext_open_file_writer(&mut self) -> u32;
    fn pdfium_ext_save_as_copy(&mut self, doc: u32, writer: u32) -> i32;
    fn pdfium_ext_get_file_writer_size(&mut self, writer: u32) -> u32;
    fn pdfium_ext_get_file_writer_data(&mut self, writer: u32, buf: u32, size: u32) -> i32;
    fn pdfium_ext_close_file_writer(&mut self, writer: u32);

    fn fpdf_load_mem_document(&mut self, ptr: u32, size: u32, password: u32) -> u32;
    fn fpdf_close_document(&mut self, doc: u32);
    fn fpdf_load_page(&mut self, doc: u32, index: i32) -> u32;
    fn fpdf_close_page(&mut self, page: u32);
    fn fpdf_get_page_count(&mut self, doc: u32) -> i32;
    fn fpdf_get_page_width_f(&mut self, page: u32) -> f64;
    fn fpdf_get_page_height_f(&mut self, page: u32) -> f64;
    fn fpdf_get_meta_text(&mut self, doc: u32, tag: u32, buffer: u32, buffer_len: u32) -> i32;

    fn fpdf_text_load_page(&mut self, page: u32) -> u32;
    fn fpdf_text_close_page(&mut self, text_page: u32);
    fn fpdf_text_count_chars(&mut self, text_page: u32) -> i32;
    fn fpdf_text_get_text(&mut self, text_page: u32, start: i32, count: i32, buffer: u32) -> i32;
    fn fpdf_text_get_char_origin(&mut self, text_page: u32, index: i32, x: u32, y: u32) -> i32;
    fn fpdf_text_get_font_size(&mut self, text_page: u32, index: i32) -> f64;
    fn fpdf_text_is_generated(&mut self, text_page: u32, index: i32) -> i32;
    fn fpdf_text_get_unicode(&mut self, text_page: u32, index: i32) -> i32;

    fn fpdf_bitmap_create(&mut self, width: i32, height: i32, alpha: i32) -> u32;
    fn fpdf_bitmap_destroy(&mut self, bitmap: u32);
    fn fpdf_bitmap_fill_rect(
        &mut self,
        bitmap: u32,
        left: i32,
        top: i32,
        width: i32,
        height: i32,
        color: u32,
    );
    fn fpdf_bitmap_get_buffer(&mut self, bitmap: u32) -> u32;
    fn fpdf_bitmap_get_stride(&mut self, bitmap: u32) -> i32;
    #[allow(clippy::too_many_arguments)]
    fn fpdf_render_page_bitmap(
        &mut self,
        bitmap: u32,
        page: u32,
        start_x: i32,
        start_y: i32,
        size_x: i32,
        size_y: i32,
        rotate: i32,
        flags: i32,
    );

    fn fpdf_page_count_objects(&mut self, page: u32) -> i32;
    fn fpdf_page_get_object(&mut self, page: u32, index: i32) -> u32;
    fn fpdf_page_insert_object(&mut self, page: u32, obj: u32);
    fn fpdf_page_generate_content(&mut self, page: u32) -> i32;
    fn fpdf_page_obj_get_type(&mut self, obj: u32) -> i32;
    fn fpdf_form_obj_count_objects(&mut self, form: u32) -> i32;
    fn fpdf_form_obj_get_object(&mut self, form: u32, index: i32) -> u32;
    fn fpdf_page_obj_destroy(&mut self, obj: u32);
    fn fpdf_page_obj_get_bounds(&mut self, obj: u32, l: u32, b: u32, r: u32, t: u32) -> i32;
    fn fpdf_image_obj_get_image_data_raw(&mut self, obj: u32, buffer: u32, buflen: u32) -> u32;
    fn fpdf_page_obj_set_fill_color(&mut self, obj: u32, r: i32, g: i32, b: i32, a: i32) -> i32;
    fn fpdf_page_obj_create_new_rect(&mut self, x: f64, y: f64, width: f64, height: f64) -> u32;
    fn fpdf_path_set_draw_mode(&mut self, path: u32, fill_mode: i32, stroke: i32) -> i32;

    fn fpdf_page_get_annot_count(&mut self, page: u32) -> i32;
    fn fpdf_page_flatten(&mut self, page: u32, flags: i32) -> i32;
    fn fpdf_page_get_annot(&mut self, page: u32, index: i32) -> u32;
    fn fpdf_page_close_annot(&mut self, annot: u32);
    fn fpdf_page_remove_annot(&mut self, page: u32, index: i32) -> i32;
    fn fpdf_page_create_annot(&mut self, page: u32, subtype: i32) -> u32;
    fn fpdf_annot_set_rect(&mut self, annot: u32, rect: u32) -> i32;
    fn epdf_annot_set_color(&mut self, annot: u32, kind: i32, r: i32, g: i32, b: i32) -> i32;
    fn fpdf_annot_get_subtype(&mut self, annot: u32) -> i32;
    fn fpdf_annot_get_rect(&mut self, annot: u32, rect: u32) -> i32;
    fn fpdf_annot_get_string_value(
        &mut self,
        annot: u32,
        key: u32,
        buffer: u32,
        buflen: u32,
    ) -> i32;
    fn epdf_page_get_annot_by_object_number(&mut self, page: u32, obj_num: i32) -> u32;
    fn epdf_page_remove_annot_by_object_number(&mut self, page: u32, obj_num: i32) -> i32;
    fn epdf_annot_apply_redaction(&mut self, page: u32, annot: u32) -> i32;
}

/// `HEAPU8.subarray(start, end)`: both ends clamped to the heap.
pub fn subarray(heap: &[u8], start: u64, end: u64) -> &[u8] {
    let len = heap.len();
    let start = (start.min(len as u64)) as usize;
    let end = (end.min(len as u64) as usize).max(start);
    &heap[start..end]
}

/// `HEAPU8.set(data, at)`: a RangeError where the data does not fit.
pub fn heap_set<M: Pdfium + ?Sized>(m: &mut M, at: u32, data: &[u8]) -> Result<(), PdfiumError> {
    let at = at as usize;
    if at + data.len() > m.heap().len() {
        return Err(PdfiumError::new("offset is out of bounds"));
    }
    m.heap_mut()[at..at + data.len()].copy_from_slice(data);
    Ok(())
}

/// `HEAPF32[index]`: `undefined` (NaN once used) past the heap.
pub fn heap_f32<M: Pdfium + ?Sized>(m: &M, index: u32) -> f64 {
    let at = index as usize * 4;
    match m.heap().get(at..at + 4) {
        Some(b) => f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        None => f64::NAN,
    }
}

/// `HEAPF32[index] = value` (the value rounds to float32).
pub fn heap_set_f32<M: Pdfium + ?Sized>(m: &mut M, index: u32, value: f64) {
    let at = index as usize * 4;
    if let Some(b) = m.heap_mut().get_mut(at..at + 4) {
        b.copy_from_slice(&(value as f32).to_le_bytes());
    }
}

/// `HEAPF64[index]`
pub fn heap_f64<M: Pdfium + ?Sized>(m: &M, index: u32) -> f64 {
    let at = index as usize * 8;
    match m.heap().get(at..at + 8) {
        Some(b) => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]),
        None => f64::NAN,
    }
}

/// `Buffer.toString('utf16le')`: whole pairs only, a lone surrogate unit
/// reads as U+FFFD (the text is written as UTF-8 afterwards).
pub fn utf16le_to_string(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// `FPDF_LoadPage`'s `index` argument: a wasm `int` parameter takes `ToInt32`.
pub fn int_arg(value: f64) -> i32 {
    to_int32(value)
}

/// `withDocument(m, bytes, fn, password)`
pub fn with_document<M: Pdfium + ?Sized, T>(
    m: &mut M,
    bytes: &[u8],
    password: Option<&str>,
    f: impl FnOnce(&mut M, u32) -> Result<T, PdfiumError>,
) -> Result<T, PdfiumError> {
    let doc_ptr = m.malloc(bytes.len() as u32);
    heap_set(m, doc_ptr, bytes)?;
    let mut pw_ptr = 0;
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        let pw = password.as_bytes();
        pw_ptr = m.malloc(pw.len() as u32 + 1);
        heap_set(m, pw_ptr, pw)?;
        let end = pw_ptr as usize + pw.len();
        if let Some(byte) = m.heap_mut().get_mut(end) {
            *byte = 0;
        }
    }
    let doc = m.fpdf_load_mem_document(doc_ptr, bytes.len() as u32, pw_ptr);
    if pw_ptr != 0 {
        m.free(pw_ptr);
    }
    if doc == 0 {
        m.free(doc_ptr);
        return Err(PdfiumError::new("PDFium could not load the document"));
    }
    let result = f(m, doc);
    m.fpdf_close_document(doc);
    m.free(doc_ptr);
    result
}

/// `saveDoc(m, doc)`
pub fn save_doc<M: Pdfium + ?Sized>(m: &mut M, doc: u32) -> Result<Vec<u8>, PdfiumError> {
    let writer = m.pdfium_ext_open_file_writer();
    let result = (|| {
        if m.pdfium_ext_save_as_copy(doc, writer) == 0 {
            return Err(PdfiumError::new("PDFium SaveAsCopy failed"));
        }
        let size = m.pdfium_ext_get_file_writer_size(writer);
        let buf = m.malloc(size);
        m.pdfium_ext_get_file_writer_data(writer, buf, size);
        let out = subarray(m.heap(), u64::from(buf), u64::from(buf) + u64::from(size)).to_vec();
        m.free(buf);
        Ok(out)
    })();
    m.pdfium_ext_close_file_writer(writer);
    result
}
