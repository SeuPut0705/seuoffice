//! `apps/pdf/src/main/read-text.ts`: read-only PDF text extraction on pdfium,
//! for consumers that only need the text layer. Runs on the [`Pdfium`]
//! instance the caller owns; the document is never mutated.

use super::pdfium::{
    Pdfium, PdfiumError, heap_f64, heap_set, int_arg, subarray, utf16le_to_string, with_document,
};
use jscompat::{is_js_space, js_regex, math_max, math_min, slice_utf16};

#[derive(Debug, Clone, PartialEq)]
pub struct PdfPageText {
    /// 1-based page number
    pub page: f64,
    /// page size in PDF points
    pub width_pt: f64,
    pub height_pt: f64,
    /// code units pdfium reports for this page's text layer (0 for scanned pages)
    pub chars: i32,
    /// extracted text with \n line breaks; empty when the page has no text layer
    pub text: String,
    pub has_text_layer: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfTextDoc {
    pub page_count: i32,
    /// document info dictionary entries worth showing an agent ('' entries omitted)
    pub title: Option<String>,
    pub author: Option<String>,
    pub pages: Vec<PdfPageText>,
    /// the charBudget ran out before the requested span was fully extracted
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReadPdfTextOptions {
    /// 1-based inclusive; default 1
    pub from_page: Option<f64>,
    /// 1-based inclusive; default pageCount
    pub to_page: Option<f64>,
    /// explicit 1-based pages to extract (unsorted ok); overrides fromPage/toPage
    pub pages: Option<Vec<f64>>,
    /// stop extracting once the accumulated text reaches this many chars
    pub char_budget: Option<f64>,
    /// user password for an encrypted file
    pub password: Option<String>,
}

/// Metadata read: the tag is an ASCII BYTESTRING, the value comes back UTF-16LE
/// with the byte length (NUL included) as the return value.
fn meta_text<M: Pdfium + ?Sized>(m: &mut M, doc: u32, tag: &str) -> Result<String, PdfiumError> {
    let tag_bytes: Vec<u8> = format!("{tag}\0")
        .chars()
        .map(|c| u32::from(c) as u8)
        .collect();
    let tag_ptr = m.malloc(tag_bytes.len() as u32);
    if tag_ptr == 0 {
        return Ok(String::new());
    }
    let result = (|| {
        heap_set(m, tag_ptr, &tag_bytes)?;
        let size = m.fpdf_get_meta_text(doc, tag_ptr, 0, 0);
        if size <= 2 {
            return Ok(String::new());
        }
        let buf = m.malloc(size as u32);
        if buf == 0 {
            return Ok(String::new());
        }
        let written = m.fpdf_get_meta_text(doc, tag_ptr, buf, size as u32);
        let out = if written <= 0 {
            String::new()
        } else {
            let bytes = subarray(m.heap(), u64::from(buf), u64::from(buf) + written as u64);
            js_regex!(r"\0+$").replace_all(&utf16le_to_string(bytes), |_| String::new())
        };
        m.free(buf);
        Ok(out)
    })();
    m.free(tag_ptr);
    result
}

/// whole textpage text (UTF-16LE, pdfium uses \r\n line breaks) normalized to \n
fn page_text<M: Pdfium + ?Sized>(m: &mut M, text_page: u32, count: i32) -> String {
    if count <= 0 {
        return String::new();
    }
    // pdfium writes count chars plus a UTF-16 NUL terminator
    let buf = m.malloc((count as u32 + 1) * 2);
    if buf == 0 {
        return String::new();
    }
    let written = m.fpdf_text_get_text(text_page, 0, count, buf);
    let out = if written <= 0 {
        String::new()
    } else {
        let bytes = subarray(
            m.heap(),
            u64::from(buf),
            u64::from(buf) + written as u64 * 2,
        );
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        let joined = join_same_line_breaks(m, text_page, count, &units);
        let text = String::from_utf16_lossy(&joined);
        let text = js_regex!(r"\0+$").replace_all(&text, |_| String::new());
        let text = js_regex!(r"\r\n", "g").replace_all(&text, |_| "\n".to_owned());
        let text = js_regex!(r"\r", "g").replace_all(&text, |_| "\n".to_owned());
        text.trim_end_matches(is_js_space).to_owned()
    };
    m.free(buf);
    out
}

/// pdfium starts a new line whenever a glyph begins left of where the previous one ended,
/// so PDFs that place kerned glyphs that way come back a few characters per line.
/// A generated break whose neighbours share a baseline and run left to right is dropped
/// again; a wide gap on the same line (a table cell) becomes a space.
fn join_same_line_breaks<M: Pdfium + ?Sized>(
    m: &mut M,
    text_page: u32,
    count: i32,
    text: &[u16],
) -> Vec<u16> {
    // GetText writes one UTF-16 unit per char index; bail out when that does not hold
    let trimmed = text.iter().rposition(|&u| u != 0).map_or(0, |at| at + 1);
    if trimmed as i64 != i64::from(count) {
        return text.to_vec();
    }
    let xy = m.malloc(16);
    if xy == 0 {
        return text.to_vec();
    }
    let origin = |m: &mut M, i: i32| -> (f64, f64) {
        m.fpdf_text_get_char_origin(text_page, i, xy, xy + 8);
        (heap_f64(m, xy >> 3), heap_f64(m, (xy >> 3) + 1))
    };
    let unit = |i: i32| -> Option<u16> {
        if i < 0 {
            None
        } else {
            text.get(i as usize).copied()
        }
    };
    let mut out: Vec<u16> = Vec::new();
    let mut i = 0;
    while i < count {
        let is_break = unit(i) == Some(0x0d)
            && unit(i + 1) == Some(0x0a)
            && i > 0
            && i + 2 < count
            && m.fpdf_text_is_generated(text_page, i) == 1;
        if !is_break {
            out.extend(unit(i));
            i += 1;
            continue;
        }
        let (px, py) = origin(m, i - 1);
        let (nx, ny) = origin(m, i + 2);
        let size = math_min(
            m.fpdf_text_get_font_size(text_page, i - 1),
            m.fpdf_text_get_font_size(text_page, i + 2),
        );
        if size > 0.0 && (ny - py).abs() < size * 0.3 && nx > px {
            if nx - px > size * 2.0 {
                out.push(0x20);
            }
            i += 2;
            continue;
        }
        out.push(0x0d);
        i += 1;
    }
    m.free(xy);
    out
}

/// Extract text from `bytes` (a whole PDF file). Page span is clamped to the
/// document; extraction stops early (with `truncated`) once charBudget is spent.
pub fn read_pdf_text<M: Pdfium + ?Sized>(
    m: &mut M,
    bytes: &[u8],
    options: &ReadPdfTextOptions,
) -> Result<PdfTextDoc, PdfiumError> {
    with_document(m, bytes, options.password.as_deref(), |m, doc| {
        let page_count = m.fpdf_get_page_count(doc);
        let count = f64::from(page_count);
        let from = math_max(1.0, math_min(options.from_page.unwrap_or(1.0), count));
        let to = math_max(from, math_min(options.to_page.unwrap_or(count), count));
        let wanted: Vec<f64> = match &options.pages {
            Some(pages) => {
                let mut unique: Vec<f64> = Vec::new();
                for &p in pages.iter().filter(|&&p| p >= 1.0 && p <= count) {
                    if !unique.contains(&p) {
                        unique.push(p);
                    }
                }
                unique.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                unique
            }
            None => {
                // Array.from({ length }): ToLength truncates
                let length = (to - from + 1.0).trunc().max(0.0) as usize;
                (0..length).map(|i| from + i as f64).collect()
            }
        };
        let budget = options.char_budget.unwrap_or(f64::INFINITY);

        let title = meta_text(m, doc, "Title")?;
        let author = meta_text(m, doc, "Author")?;
        let mut doc_out = PdfTextDoc {
            page_count,
            title: (!title.is_empty()).then_some(title),
            author: (!author.is_empty()).then_some(author),
            pages: Vec::new(),
            truncated: false,
        };

        let mut spent = 0.0;
        for index in wanted {
            if doc_out.truncated {
                break;
            }
            let page = m.fpdf_load_page(doc, int_arg(index - 1.0));
            if page == 0 {
                doc_out.pages.push(PdfPageText {
                    page: index,
                    width_pt: 0.0,
                    height_pt: 0.0,
                    chars: 0,
                    text: String::new(),
                    has_text_layer: false,
                });
                continue;
            }
            let width_pt = m.fpdf_get_page_width_f(page);
            let height_pt = m.fpdf_get_page_height_f(page);
            let text_page = m.fpdf_text_load_page(page);
            if text_page == 0 {
                doc_out.pages.push(PdfPageText {
                    page: index,
                    width_pt,
                    height_pt,
                    chars: 0,
                    text: String::new(),
                    has_text_layer: false,
                });
                m.fpdf_close_page(page);
                continue;
            }
            let chars = m.fpdf_text_count_chars(text_page);
            // The budget is already spent, including when it ran out exactly on the
            // previous page's boundary. This page was never read: report the
            // truncation and stop rather than emitting it as an empty page.
            if spent >= budget {
                doc_out.truncated = true;
                m.fpdf_text_close_page(text_page);
                m.fpdf_close_page(page);
                break;
            }
            let mut text = page_text(m, text_page, chars);
            let length = text.encode_utf16().count() as f64;
            if spent + length > budget {
                text = slice_utf16(&text, 0.0, Some(math_max(0.0, budget - spent)));
                doc_out.truncated = true;
            }
            spent += text.encode_utf16().count() as f64;
            doc_out.pages.push(PdfPageText {
                page: index,
                width_pt,
                height_pt,
                chars,
                text,
                has_text_layer: chars > 0,
            });
            m.fpdf_text_close_page(text_page);
            m.fpdf_close_page(page);
        }
        Ok(doc_out)
    })
}
