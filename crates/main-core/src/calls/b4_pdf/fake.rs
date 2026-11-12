//! A scripted PDFium for the comparison: the instance both sides of
//! `tools/main-diff/groups/b4-pdf.ts` drive. The world is JSON (see the
//! TypeScript `FakePdfium` of that file, which this mirrors line by line);
//! every call is recorded as one line `Name(arg,...)=result`.

use crate::pdf::pdfium::Pdfium;
use jscompat::number_to_string;
use serde_json::Value;

fn n(x: impl Into<f64>) -> String {
    number_to_string(x.into())
}

fn s(x: &str) -> String {
    serde_json::to_string(x).expect("a string prints")
}

fn f32r(x: f64) -> f64 {
    f64::from(x as f32)
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn rect4(v: Option<&Value>) -> Option<[f64; 4]> {
    let a = v?.as_array()?;
    if a.len() != 4 {
        return None;
    }
    Some([
        a[0].as_f64()?,
        a[1].as_f64()?,
        a[2].as_f64()?,
        a[3].as_f64()?,
    ])
}

fn hex_bytes(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

struct Annot {
    page: usize,
    obj_num: i32,
    subtype: i32,
    rect: Option<[f64; 4]>,
    contents: Option<String>,
    remove_fail: bool,
    null: bool,
}

struct Obj {
    ty: i32,
    bounds: Option<[f64; 4]>,
    data: Vec<u8>,
    children: Vec<usize>,
    null: bool,
}

struct Bitmap {
    w: i32,
    h: i32,
    stride: i32,
    ptr: u32,
}

pub struct FakePdfium {
    world: Value,
    heap: Vec<u8>,
    next: u32,
    malloc_count: u32,
    load_calls: u32,
    pub log: Vec<String>,
    annots: Vec<Annot>,
    live: Vec<Vec<usize>>,
    objs: Vec<Obj>,
    page_objs: Vec<Vec<usize>>,
    bitmaps: Vec<Bitmap>,
    rects_made: u32,
    saved: Vec<u8>,
}

const OBJ_BASE: u32 = 2_000_000;
const ANNOT_BASE: u32 = 100_000;

impl FakePdfium {
    pub fn new(world: &Value) -> Self {
        let mut me = FakePdfium {
            world: world.clone(),
            heap: vec![0; 1 << 22],
            next: 16,
            malloc_count: 0,
            load_calls: 0,
            log: Vec::new(),
            annots: Vec::new(),
            live: Vec::new(),
            objs: Vec::new(),
            page_objs: Vec::new(),
            bitmaps: Vec::new(),
            rects_made: 0,
            saved: Vec::new(),
        };
        let pages: Vec<Value> = world
            .get("pages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (p, page) in pages.iter().enumerate() {
            let mut live = Vec::new();
            for a in page
                .get("annots")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                live.push(me.annots.len());
                me.annots.push(Annot {
                    page: p,
                    obj_num: num(a, "objNum").unwrap_or(0.0) as i32,
                    subtype: num(a, "subtype").unwrap_or(0.0) as i32,
                    rect: rect4(a.get("rect")),
                    contents: a.get("contents").and_then(Value::as_str).map(str::to_owned),
                    remove_fail: flag(a, "removeFail"),
                    null: flag(a, "annotNull"),
                });
            }
            me.live.push(live);
            let mut top = Vec::new();
            for o in page
                .get("objects")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = me.add_obj(o);
                top.push(id);
            }
            me.page_objs.push(top);
        }
        me
    }

    fn add_obj(&mut self, o: &Value) -> usize {
        // an alias is an object that sits in two places
        if let Some(alias) = num(o, "alias") {
            return alias as usize;
        }
        let id = self.objs.len();
        self.objs.push(Obj {
            ty: num(o, "type").unwrap_or(0.0) as i32,
            bounds: rect4(o.get("bounds")),
            data: o
                .get("data")
                .and_then(Value::as_str)
                .map(hex_bytes)
                .unwrap_or_default(),
            children: Vec::new(),
            null: flag(o, "null"),
        });
        let kids: Vec<Value> = o
            .get("children")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let ids: Vec<usize> = kids.iter().map(|k| self.add_obj(k)).collect();
        self.objs[id].children = ids;
        id
    }

    fn page_spec(&self, page: usize) -> Value {
        self.world
            .get("pages")
            .and_then(|p| p.get(page))
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn page_of(handle: u32) -> usize {
        handle.saturating_sub(1000) as usize
    }

    fn rec(&mut self, name: &str, args: &[String], ret: Option<String>) {
        let mut line = format!("{name}({})", args.join(","));
        if let Some(ret) = ret {
            line.push('=');
            line.push_str(&ret);
        }
        self.log.push(line);
    }

    fn cstr(&self, ptr: u32) -> String {
        let start = ptr as usize;
        let mut end = start;
        while end < self.heap.len() && self.heap[end] != 0 {
            end += 1;
        }
        String::from_utf8_lossy(&self.heap[start.min(self.heap.len())..end]).into_owned()
    }

    fn put_f32(&mut self, ptr: u32, x: f64) {
        let at = ptr as usize;
        self.heap[at..at + 4].copy_from_slice(&(x as f32).to_le_bytes());
    }

    fn get_f32(&self, ptr: u32) -> f64 {
        let at = ptr as usize;
        f64::from(f32::from_le_bytes([
            self.heap[at],
            self.heap[at + 1],
            self.heap[at + 2],
            self.heap[at + 3],
        ]))
    }

    fn put_f64(&mut self, ptr: u32, x: f64) {
        let at = ptr as usize;
        self.heap[at..at + 8].copy_from_slice(&x.to_le_bytes());
    }

    fn alloc(&mut self, size: u32) -> u32 {
        let ptr = self.next;
        let rounded = (size.max(1) + 7) & !7;
        if u64::from(ptr) + u64::from(rounded) > self.heap.len() as u64 {
            return 0;
        }
        self.next += rounded;
        ptr
    }

    fn text_spec(&self, page: usize) -> Value {
        self.page_spec(page)
            .get("text")
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn text_units(&self, page: usize) -> Vec<u16> {
        self.text_spec(page)
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .encode_utf16()
            .collect()
    }

    fn text_count(&self, page: usize) -> i32 {
        let spec = self.text_spec(page);
        if let Some(c) = num(&spec, "count") {
            return c as i32;
        }
        if let Some(u) = spec.get("unicodes").and_then(Value::as_array) {
            return u.len() as i32;
        }
        self.text_units(page).len() as i32
    }

    fn annot_handle(idx: usize) -> u32 {
        ANNOT_BASE + idx as u32
    }

    fn annot_idx(handle: u32) -> usize {
        handle.saturating_sub(ANNOT_BASE) as usize
    }

    fn obj_idx(handle: u32) -> Option<usize> {
        handle.checked_sub(OBJ_BASE).map(|i| i as usize)
    }
}

impl Pdfium for FakePdfium {
    fn heap(&self) -> &[u8] {
        &self.heap
    }

    fn heap_mut(&mut self) -> &mut [u8] {
        &mut self.heap
    }

    fn malloc(&mut self, size: u32) -> u32 {
        self.malloc_count += 1;
        let fail = self
            .world
            .get("mallocFail")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .any(|v| v.as_u64() == Some(u64::from(self.malloc_count)))
            });
        let ptr = if fail { 0 } else { self.alloc(size) };
        self.rec("malloc", &[n(size)], Some(n(ptr)));
        ptr
    }

    fn free(&mut self, ptr: u32) {
        self.rec("free", &[n(ptr)], None);
    }

    fn pdfium_ext_open_file_writer(&mut self) -> u32 {
        self.rec("PDFiumExt_OpenFileWriter", &[], Some(n(7)));
        7
    }

    fn pdfium_ext_save_as_copy(&mut self, doc: u32, writer: u32) -> i32 {
        let r = i32::from(!flag(&self.world, "saveFail"));
        if r == 1 {
            self.saved = format!("SAVED:{}", self.log.len()).into_bytes();
        }
        self.rec("PDFiumExt_SaveAsCopy", &[n(doc), n(writer)], Some(n(r)));
        r
    }

    fn pdfium_ext_get_file_writer_size(&mut self, writer: u32) -> u32 {
        let r = self.saved.len() as u32;
        self.rec("PDFiumExt_GetFileWriterSize", &[n(writer)], Some(n(r)));
        r
    }

    fn pdfium_ext_get_file_writer_data(&mut self, writer: u32, buf: u32, size: u32) -> i32 {
        let data = self.saved.clone();
        let at = buf as usize;
        self.heap[at..at + data.len()].copy_from_slice(&data);
        self.rec(
            "PDFiumExt_GetFileWriterData",
            &[n(writer), n(buf), n(size)],
            Some(n(1)),
        );
        1
    }

    fn pdfium_ext_close_file_writer(&mut self, writer: u32) {
        self.rec("PDFiumExt_CloseFileWriter", &[n(writer)], None);
    }

    fn fpdf_load_mem_document(&mut self, ptr: u32, size: u32, password: u32) -> u32 {
        let pw = if password == 0 {
            None
        } else {
            Some(self.cstr(password))
        };
        let required = self.world.get("password").and_then(Value::as_str);
        let fail =
            flag(&self.world, "loadFail") || required.is_some_and(|r| pw.as_deref() != Some(r));
        let r = u32::from(!fail);
        let shown = s(pw.as_deref().unwrap_or("null"));
        self.rec(
            "FPDF_LoadMemDocument",
            &[n(ptr), n(size), shown],
            Some(n(r)),
        );
        r
    }

    fn fpdf_close_document(&mut self, doc: u32) {
        self.rec("FPDF_CloseDocument", &[n(doc)], None);
    }

    fn fpdf_load_page(&mut self, doc: u32, index: i32) -> u32 {
        let count = self
            .world
            .get("pages")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        self.load_calls += 1;
        let failed_now = self
            .world
            .get("loadPageFail")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .any(|v| v.as_u64() == Some(u64::from(self.load_calls)))
            });
        let ok = index >= 0
            && (index as usize) < count
            && !failed_now
            && !flag(&self.page_spec(index as usize), "loadFail");
        let r = if ok { 1000 + index as u32 } else { 0 };
        self.rec("FPDF_LoadPage", &[n(doc), n(index)], Some(n(r)));
        r
    }

    fn fpdf_close_page(&mut self, page: u32) {
        self.rec("FPDF_ClosePage", &[n(page)], None);
    }

    fn fpdf_get_page_count(&mut self, doc: u32) -> i32 {
        let r = self
            .world
            .get("pages")
            .and_then(Value::as_array)
            .map_or(0, Vec::len) as i32;
        self.rec("FPDF_GetPageCount", &[n(doc)], Some(n(r)));
        r
    }

    fn fpdf_get_page_width_f(&mut self, page: u32) -> f64 {
        let r = f32r(num(&self.page_spec(Self::page_of(page)), "w").unwrap_or(612.0));
        self.rec("FPDF_GetPageWidthF", &[n(page)], Some(n(r)));
        r
    }

    fn fpdf_get_page_height_f(&mut self, page: u32) -> f64 {
        let r = f32r(num(&self.page_spec(Self::page_of(page)), "h").unwrap_or(792.0));
        self.rec("FPDF_GetPageHeightF", &[n(page)], Some(n(r)));
        r
    }

    fn fpdf_get_meta_text(&mut self, doc: u32, tag: u32, buffer: u32, buffer_len: u32) -> i32 {
        let key = self.cstr(tag);
        let value = self
            .world
            .get("meta")
            .and_then(|m| m.get(&key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut bytes: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
        bytes.extend([0, 0]);
        let size = bytes.len() as u32;
        let mut r = size as i32;
        if buffer != 0 && buffer_len >= size {
            let at = buffer as usize;
            self.heap[at..at + bytes.len()].copy_from_slice(&bytes);
            if flag(&self.world, "metaShort") {
                r = 0;
            }
        }
        self.rec(
            "FPDF_GetMetaText",
            &[n(doc), s(&key), n(buffer), n(buffer_len)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_text_load_page(&mut self, page: u32) -> u32 {
        let none = flag(&self.page_spec(Self::page_of(page)), "noText");
        let r = if none {
            0
        } else {
            4000 + Self::page_of(page) as u32
        };
        self.rec("FPDFText_LoadPage", &[n(page)], Some(n(r)));
        r
    }

    fn fpdf_text_close_page(&mut self, text_page: u32) {
        self.rec("FPDFText_ClosePage", &[n(text_page)], None);
    }

    fn fpdf_text_count_chars(&mut self, text_page: u32) -> i32 {
        let r = self.text_count(text_page as usize - 4000);
        self.rec("FPDFText_CountChars", &[n(text_page)], Some(n(r)));
        r
    }

    fn fpdf_text_get_text(&mut self, text_page: u32, start: i32, count: i32, buffer: u32) -> i32 {
        let units = self.text_units(text_page as usize - 4000);
        let take = (count.max(0) as usize).min(units.len());
        let mut bytes: Vec<u8> = units[..take].iter().flat_map(|u| u.to_le_bytes()).collect();
        bytes.extend([0, 0]);
        let at = buffer as usize;
        self.heap[at..at + bytes.len()].copy_from_slice(&bytes);
        let r = if flag(&self.world, "getTextZero") {
            0
        } else {
            take as i32 + 1
        };
        self.rec(
            "FPDFText_GetText",
            &[n(text_page), n(start), n(count), n(buffer)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_text_get_char_origin(&mut self, text_page: u32, index: i32, x: u32, y: u32) -> i32 {
        let spec = self.text_spec(text_page as usize - 4000);
        let (ox, oy) = spec
            .get("origins")
            .and_then(Value::as_array)
            .and_then(|o| o.get(index.max(0) as usize))
            .and_then(Value::as_array)
            .map_or((0.0, 0.0), |p| {
                (
                    p.first().and_then(Value::as_f64).unwrap_or(0.0),
                    p.get(1).and_then(Value::as_f64).unwrap_or(0.0),
                )
            });
        self.put_f64(x, ox);
        self.put_f64(y, oy);
        self.rec(
            "FPDFText_GetCharOrigin",
            &[n(text_page), n(index), n(x), n(y)],
            Some(n(1)),
        );
        1
    }

    fn fpdf_text_get_font_size(&mut self, text_page: u32, index: i32) -> f64 {
        let spec = self.text_spec(text_page as usize - 4000);
        let r = f32r(
            spec.get("sizes")
                .and_then(Value::as_array)
                .and_then(|o| o.get(index.max(0) as usize))
                .and_then(Value::as_f64)
                .unwrap_or(12.0),
        );
        self.rec(
            "FPDFText_GetFontSize",
            &[n(text_page), n(index)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_text_is_generated(&mut self, text_page: u32, index: i32) -> i32 {
        let spec = self.text_spec(text_page as usize - 4000);
        let hit = spec
            .get("generated")
            .and_then(Value::as_array)
            .is_some_and(|g| g.iter().any(|v| v.as_i64() == Some(i64::from(index))));
        let r = i32::from(hit);
        self.rec(
            "FPDFText_IsGenerated",
            &[n(text_page), n(index)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_text_get_unicode(&mut self, text_page: u32, index: i32) -> i32 {
        let page = text_page as usize - 4000;
        let spec = self.text_spec(page);
        let r = match spec.get("unicodes").and_then(Value::as_array) {
            Some(u) => u
                .get(index.max(0) as usize)
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32,
            None => i32::from(
                self.text_units(page)
                    .get(index.max(0) as usize)
                    .copied()
                    .unwrap_or(0),
            ),
        };
        self.rec("FPDFText_GetUnicode", &[n(text_page), n(index)], Some(n(r)));
        r
    }

    fn fpdf_bitmap_create(&mut self, width: i32, height: i32, alpha: i32) -> u32 {
        let pad = num(&self.world, "stridePad").unwrap_or(0.0) as i32;
        let r = if flag(&self.world, "bitmapFail") {
            0
        } else {
            let stride = width * 4 + pad;
            let ptr = self.alloc((stride * height) as u32);
            self.bitmaps.push(Bitmap {
                w: width,
                h: height,
                stride,
                ptr,
            });
            8000 + self.bitmaps.len() as u32
        };
        self.rec(
            "FPDFBitmap_Create",
            &[n(width), n(height), n(alpha)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_bitmap_destroy(&mut self, bitmap: u32) {
        self.rec("FPDFBitmap_Destroy", &[n(bitmap)], None);
    }

    fn fpdf_bitmap_fill_rect(
        &mut self,
        bitmap: u32,
        left: i32,
        top: i32,
        width: i32,
        height: i32,
        color: u32,
    ) {
        let b = &self.bitmaps[bitmap as usize - 8001];
        let (stride, ptr, bw, bh) = (b.stride, b.ptr, b.w, b.h);
        let px = [
            (color & 0xff) as u8,
            ((color >> 8) & 0xff) as u8,
            ((color >> 16) & 0xff) as u8,
            ((color >> 24) & 0xff) as u8,
        ];
        for y in top.max(0)..(top + height).min(bh) {
            for x in left.max(0)..(left + width).min(bw) {
                let at = (ptr as i32 + y * stride + x * 4) as usize;
                self.heap[at..at + 4].copy_from_slice(&px);
            }
        }
        self.rec(
            "FPDFBitmap_FillRect",
            &[n(bitmap), n(left), n(top), n(width), n(height), n(color)],
            None,
        );
    }

    fn fpdf_bitmap_get_buffer(&mut self, bitmap: u32) -> u32 {
        let r = self.bitmaps[bitmap as usize - 8001].ptr;
        self.rec("FPDFBitmap_GetBuffer", &[n(bitmap)], Some(n(r)));
        r
    }

    fn fpdf_bitmap_get_stride(&mut self, bitmap: u32) -> i32 {
        let r = self.bitmaps[bitmap as usize - 8001].stride;
        self.rec("FPDFBitmap_GetStride", &[n(bitmap)], Some(n(r)));
        r
    }

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
    ) {
        let b = &self.bitmaps[bitmap as usize - 8001];
        let (stride, ptr, bw, bh) = (b.stride, b.ptr, b.w, b.h);
        let ink: Vec<Value> = self
            .page_spec(Self::page_of(page))
            .get("ink")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for r in &ink {
            let Some(a) = r.as_array() else { continue };
            let v: Vec<i32> = a.iter().map(|x| x.as_i64().unwrap_or(0) as i32).collect();
            if v.len() < 5 {
                continue;
            }
            for y in v[1].max(0)..v[3].min(bh) {
                for x in v[0].max(0)..v[2].min(bw) {
                    let at = (ptr as i32 + y * stride + x * 4) as usize;
                    let g = v[4] as u8;
                    self.heap[at..at + 4].copy_from_slice(&[g, g, g, 255]);
                }
            }
        }
        self.rec(
            "FPDF_RenderPageBitmap",
            &[
                n(bitmap),
                n(page),
                n(start_x),
                n(start_y),
                n(size_x),
                n(size_y),
                n(rotate),
                n(flags),
            ],
            None,
        );
    }

    fn fpdf_page_count_objects(&mut self, page: u32) -> i32 {
        let r = self.page_objs[Self::page_of(page)].len() as i32;
        self.rec("FPDFPage_CountObjects", &[n(page)], Some(n(r)));
        r
    }

    fn fpdf_page_get_object(&mut self, page: u32, index: i32) -> u32 {
        let r = self.page_objs[Self::page_of(page)]
            .get(index.max(0) as usize)
            .filter(|_| index >= 0)
            .map_or(0, |&id| {
                if self.objs[id].null {
                    0
                } else {
                    OBJ_BASE + id as u32
                }
            });
        self.rec("FPDFPage_GetObject", &[n(page), n(index)], Some(n(r)));
        r
    }

    fn fpdf_page_insert_object(&mut self, page: u32, obj: u32) {
        self.rec("FPDFPage_InsertObject", &[n(page), n(obj)], None);
    }

    fn fpdf_page_generate_content(&mut self, page: u32) -> i32 {
        let r = i32::from(!flag(&self.page_spec(Self::page_of(page)), "genFail"));
        self.rec("FPDFPage_GenerateContent", &[n(page)], Some(n(r)));
        r
    }

    fn fpdf_page_obj_get_type(&mut self, obj: u32) -> i32 {
        let r = Self::obj_idx(obj)
            .and_then(|i| self.objs.get(i))
            .map_or(0, |o| o.ty);
        self.rec("FPDFPageObj_GetType", &[n(obj)], Some(n(r)));
        r
    }

    fn fpdf_form_obj_count_objects(&mut self, form: u32) -> i32 {
        let r = Self::obj_idx(form)
            .and_then(|i| self.objs.get(i))
            .map_or(0, |o| o.children.len() as i32);
        self.rec("FPDFFormObj_CountObjects", &[n(form)], Some(n(r)));
        r
    }

    fn fpdf_form_obj_get_object(&mut self, form: u32, index: i32) -> u32 {
        let r = Self::obj_idx(form)
            .and_then(|i| self.objs.get(i))
            .and_then(|o| o.children.get(index.max(0) as usize).filter(|_| index >= 0))
            .map_or(0, |&id| {
                if self.objs[id].null {
                    0
                } else {
                    OBJ_BASE + id as u32
                }
            });
        self.rec("FPDFFormObj_GetObject", &[n(form), n(index)], Some(n(r)));
        r
    }

    fn fpdf_page_obj_destroy(&mut self, obj: u32) {
        self.rec("FPDFPageObj_Destroy", &[n(obj)], None);
    }

    fn fpdf_page_obj_get_bounds(&mut self, obj: u32, l: u32, b: u32, r: u32, t: u32) -> i32 {
        let bounds = Self::obj_idx(obj)
            .and_then(|i| self.objs.get(i))
            .and_then(|o| o.bounds);
        let ret = match bounds {
            Some(v) => {
                self.put_f32(l, v[0]);
                self.put_f32(b, v[1]);
                self.put_f32(r, v[2]);
                self.put_f32(t, v[3]);
                1
            }
            None => 0,
        };
        self.rec(
            "FPDFPageObj_GetBounds",
            &[n(obj), n(l), n(b), n(r), n(t)],
            Some(n(ret)),
        );
        ret
    }

    fn fpdf_image_obj_get_image_data_raw(&mut self, obj: u32, buffer: u32, buflen: u32) -> u32 {
        let data = Self::obj_idx(obj)
            .and_then(|i| self.objs.get(i))
            .map(|o| o.data.clone())
            .unwrap_or_default();
        let size = data.len() as u32;
        let mut r = size;
        if buffer != 0 && buflen >= size {
            let at = buffer as usize;
            self.heap[at..at + data.len()].copy_from_slice(&data);
            if flag(&self.world, "rawShort") {
                r = size.saturating_sub(1);
            }
        }
        self.rec(
            "FPDFImageObj_GetImageDataRaw",
            &[n(obj), n(buffer), n(buflen)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_page_obj_set_fill_color(&mut self, obj: u32, r: i32, g: i32, b: i32, a: i32) -> i32 {
        let ret = i32::from(self.world.get("blackoutFail").and_then(Value::as_str) != Some("fill"));
        self.rec(
            "FPDFPageObj_SetFillColor",
            &[n(obj), n(r), n(g), n(b), n(a)],
            Some(n(ret)),
        );
        ret
    }

    fn fpdf_page_obj_create_new_rect(&mut self, x: f64, y: f64, width: f64, height: f64) -> u32 {
        let fail = self.world.get("blackoutFail").and_then(Value::as_str) == Some("create");
        let r = if fail {
            0
        } else {
            self.rects_made += 1;
            3_000_000 + self.rects_made
        };
        self.rec(
            "FPDFPageObj_CreateNewRect",
            &[n(f32r(x)), n(f32r(y)), n(f32r(width)), n(f32r(height))],
            Some(n(r)),
        );
        r
    }

    fn fpdf_path_set_draw_mode(&mut self, path: u32, fill_mode: i32, stroke: i32) -> i32 {
        let r = i32::from(self.world.get("blackoutFail").and_then(Value::as_str) != Some("mode"));
        self.rec(
            "FPDFPath_SetDrawMode",
            &[n(path), n(fill_mode), n(stroke)],
            Some(n(r)),
        );
        r
    }

    fn fpdf_page_get_annot_count(&mut self, page: u32) -> i32 {
        let r = self.live[Self::page_of(page)].len() as i32;
        self.rec("FPDFPage_GetAnnotCount", &[n(page)], Some(n(r)));
        r
    }

    fn fpdf_page_flatten(&mut self, page: u32, flags: i32) -> i32 {
        let p = Self::page_of(page);
        let r = num(&self.page_spec(p), "flatten").unwrap_or(1.0) as i32;
        if r == 1 {
            self.live[p].clear();
        }
        self.rec("FPDFPage_Flatten", &[n(page), n(flags)], Some(n(r)));
        r
    }

    fn fpdf_page_get_annot(&mut self, page: u32, index: i32) -> u32 {
        let r = self.live[Self::page_of(page)]
            .get(index.max(0) as usize)
            .filter(|_| index >= 0)
            .map_or(0, |&idx| {
                if self.annots[idx].null {
                    0
                } else {
                    Self::annot_handle(idx)
                }
            });
        self.rec("FPDFPage_GetAnnot", &[n(page), n(index)], Some(n(r)));
        r
    }

    fn fpdf_page_close_annot(&mut self, annot: u32) {
        self.rec("FPDFPage_CloseAnnot", &[n(annot)], None);
    }

    fn fpdf_page_remove_annot(&mut self, page: u32, index: i32) -> i32 {
        let p = Self::page_of(page);
        let mut r = 0;
        if index >= 0
            && let Some(&idx) = self.live[p].get(index as usize)
            && !self.annots[idx].remove_fail
        {
            self.live[p].remove(index as usize);
            r = 1;
        }
        self.rec("FPDFPage_RemoveAnnot", &[n(page), n(index)], Some(n(r)));
        r
    }

    fn fpdf_page_create_annot(&mut self, page: u32, subtype: i32) -> u32 {
        let p = Self::page_of(page);
        let r = if flag(&self.page_spec(p), "createAnnotFail") {
            0
        } else {
            self.annots.push(Annot {
                page: p,
                obj_num: 0,
                subtype,
                rect: None,
                contents: None,
                remove_fail: false,
                null: false,
            });
            Self::annot_handle(self.annots.len() - 1)
        };
        self.rec("FPDFPage_CreateAnnot", &[n(page), n(subtype)], Some(n(r)));
        r
    }

    fn fpdf_annot_set_rect(&mut self, annot: u32, rect: u32) -> i32 {
        let vals: Vec<f64> = (0..4).map(|k| self.get_f32(rect + 4 * k)).collect();
        let page = self.annots[Self::annot_idx(annot)].page;
        let r = i32::from(!flag(&self.page_spec(page), "setRectFail"));
        self.rec(
            "FPDFAnnot_SetRect",
            &[n(annot), n(vals[0]), n(vals[1]), n(vals[2]), n(vals[3])],
            Some(n(r)),
        );
        r
    }

    fn epdf_annot_set_color(&mut self, annot: u32, kind: i32, r: i32, g: i32, b: i32) -> i32 {
        let page = self.annots[Self::annot_idx(annot)].page;
        let ret = i32::from(!flag(&self.page_spec(page), "setColorFail"));
        self.rec(
            "EPDFAnnot_SetColor",
            &[n(annot), n(kind), n(r), n(g), n(b)],
            Some(n(ret)),
        );
        ret
    }

    fn fpdf_annot_get_subtype(&mut self, annot: u32) -> i32 {
        let r = self.annots[Self::annot_idx(annot)].subtype;
        self.rec("FPDFAnnot_GetSubtype", &[n(annot)], Some(n(r)));
        r
    }

    fn fpdf_annot_get_rect(&mut self, annot: u32, rect: u32) -> i32 {
        let value = self.annots[Self::annot_idx(annot)].rect;
        let r = match value {
            Some(v) => {
                for (k, x) in v.iter().enumerate() {
                    self.put_f32(rect + 4 * k as u32, *x);
                }
                1
            }
            None => 0,
        };
        self.rec("FPDFAnnot_GetRect", &[n(annot), n(rect)], Some(n(r)));
        r
    }

    fn fpdf_annot_get_string_value(
        &mut self,
        annot: u32,
        key: u32,
        buffer: u32,
        buflen: u32,
    ) -> i32 {
        let name = self.cstr(key);
        let contents = self.annots[Self::annot_idx(annot)].contents.clone();
        let r = match (name.as_str(), contents) {
            ("Contents", Some(text)) => {
                let mut bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
                bytes.extend([0, 0]);
                if buffer != 0 && buflen as usize >= bytes.len() {
                    let at = buffer as usize;
                    self.heap[at..at + bytes.len()].copy_from_slice(&bytes);
                }
                bytes.len() as i32
            }
            _ => 0,
        };
        self.rec(
            "FPDFAnnot_GetStringValue",
            &[n(annot), s(&name), n(buffer), n(buflen)],
            Some(n(r)),
        );
        r
    }

    fn epdf_page_get_annot_by_object_number(&mut self, page: u32, obj_num: i32) -> u32 {
        let p = Self::page_of(page);
        let r = self.live[p]
            .iter()
            .find(|&&idx| self.annots[idx].obj_num == obj_num)
            .map_or(0, |&idx| Self::annot_handle(idx));
        self.rec(
            "EPDFPage_GetAnnotByObjectNumber",
            &[n(page), n(obj_num)],
            Some(n(r)),
        );
        r
    }

    fn epdf_page_remove_annot_by_object_number(&mut self, page: u32, obj_num: i32) -> i32 {
        let p = Self::page_of(page);
        let at = self.live[p]
            .iter()
            .position(|&idx| self.annots[idx].obj_num == obj_num);
        let mut r = 0;
        if let Some(at) = at
            && !self.annots[self.live[p][at]].remove_fail
        {
            self.live[p].remove(at);
            r = 1;
        }
        self.rec(
            "EPDFPage_RemoveAnnotByObjectNumber",
            &[n(page), n(obj_num)],
            Some(n(r)),
        );
        r
    }

    fn epdf_annot_apply_redaction(&mut self, page: u32, annot: u32) -> i32 {
        let r = i32::from(!flag(&self.page_spec(Self::page_of(page)), "applyFail"));
        self.rec("EPDFAnnot_ApplyRedaction", &[n(page), n(annot)], Some(n(r)));
        r
    }
}

/// The hb-subset.wasm instance of `font_subset`, scripted the same way
pub struct FakeHb {
    world: Value,
    memory: Vec<u8>,
    next: u32,
    blobs: u32,
    faces: u32,
    pub log: Vec<String>,
    result: Vec<u8>,
}

impl FakeHb {
    pub fn new(world: &Value) -> Self {
        let size = num(world, "memorySize").unwrap_or(1_048_576.0) as usize;
        FakeHb {
            world: world.clone(),
            memory: vec![0; size],
            next: 16,
            blobs: 0,
            faces: 0,
            log: Vec::new(),
            result: world
                .get("result")
                .and_then(Value::as_str)
                .map(hex_bytes)
                .unwrap_or_default(),
        }
    }

    fn rec(&mut self, name: &str, args: &[String], ret: Option<String>) {
        let mut line = format!("{name}({})", args.join(","));
        if let Some(ret) = ret {
            line.push('=');
            line.push_str(&ret);
        }
        self.log.push(line);
    }
}

impl crate::pdf::font_subset::HbSubset for FakeHb {
    fn memory(&self) -> &[u8] {
        &self.memory
    }

    fn memory_mut(&mut self) -> &mut [u8] {
        &mut self.memory
    }

    fn malloc(&mut self, size: u32) -> u32 {
        let ptr = self.next;
        self.next += (size.max(1) + 7) & !7;
        self.rec("malloc", &[n(size)], Some(n(ptr)));
        ptr
    }

    fn free(&mut self, ptr: u32) {
        self.rec("free", &[n(ptr)], None);
    }

    fn hb_blob_create(
        &mut self,
        data: u32,
        len: u32,
        mode: u32,
        user_data: u32,
        destroy: u32,
    ) -> u32 {
        self.blobs += 1;
        let r = 100 + self.blobs;
        self.rec(
            "hb_blob_create",
            &[n(data), n(len), n(mode), n(user_data), n(destroy)],
            Some(n(r)),
        );
        r
    }

    fn hb_blob_destroy(&mut self, blob: u32) {
        self.rec("hb_blob_destroy", &[n(blob)], None);
    }

    fn hb_blob_get_data(&mut self, blob: u32, len: u32) -> u32 {
        let bytes = self.result.clone();
        let ptr = self.next;
        self.next += (bytes.len().max(1) as u32 + 7) & !7;
        let at = ptr as usize;
        if at + bytes.len() <= self.memory.len() {
            self.memory[at..at + bytes.len()].copy_from_slice(&bytes);
        }
        self.rec("hb_blob_get_data", &[n(blob), n(len)], Some(n(ptr)));
        ptr
    }

    fn hb_blob_get_length(&mut self, blob: u32) -> u32 {
        let r = if flag(&self.world, "emptyResult") {
            0
        } else {
            self.result.len() as u32
        };
        self.rec("hb_blob_get_length", &[n(blob)], Some(n(r)));
        r
    }

    fn hb_face_create(&mut self, blob: u32, index: u32) -> u32 {
        self.faces += 1;
        let r = 200 + self.faces;
        self.rec("hb_face_create", &[n(blob), n(index)], Some(n(r)));
        r
    }

    fn hb_face_destroy(&mut self, face: u32) {
        self.rec("hb_face_destroy", &[n(face)], None);
    }

    fn hb_face_reference_blob(&mut self, face: u32) -> u32 {
        self.rec("hb_face_reference_blob", &[n(face)], Some(n(400)));
        400
    }

    fn hb_set_add(&mut self, set: u32, value: u32) {
        self.rec("hb_set_add", &[n(set), n(value)], None);
    }

    fn hb_set_clear(&mut self, set: u32) {
        self.rec("hb_set_clear", &[n(set)], None);
    }

    fn hb_set_invert(&mut self, set: u32) {
        self.rec("hb_set_invert", &[n(set)], None);
    }

    fn hb_subset_input_create_or_fail(&mut self) -> u32 {
        let r = if flag(&self.world, "inputFail") {
            0
        } else {
            11
        };
        self.rec("hb_subset_input_create_or_fail", &[], Some(n(r)));
        r
    }

    fn hb_subset_input_destroy(&mut self, input: u32) {
        self.rec("hb_subset_input_destroy", &[n(input)], None);
    }

    fn hb_subset_input_set(&mut self, input: u32, set_type: u32) -> u32 {
        self.rec("hb_subset_input_set", &[n(input), n(set_type)], Some(n(31)));
        31
    }

    fn hb_subset_input_unicode_set(&mut self, input: u32) -> u32 {
        self.rec("hb_subset_input_unicode_set", &[n(input)], Some(n(32)));
        32
    }

    fn hb_subset_or_fail(&mut self, face: u32, input: u32) -> u32 {
        let r = if flag(&self.world, "subsetFail") {
            0
        } else {
            300
        };
        self.rec("hb_subset_or_fail", &[n(face), n(input)], Some(n(r)));
        r
    }
}
