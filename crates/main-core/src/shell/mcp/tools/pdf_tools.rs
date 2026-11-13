//! `apps/shell/src/main/mcp/tools/pdf-tools.ts`: PDF reading. The registry's
//! `pdf` family exposes read-only MCP access (`mcp.read`, no session, no
//! generation): the pdf app is a viewer, so an agent reads a PDF's text layer
//! directly from disk through the same main-process pdfium the editor uses.
//! Like read_docx, this is headless and always registered. Read-only is the
//! final design: MCP does not drive the pdf editor.
//!
//! `readPdfText(bytes, options)` of the TypeScript loads the pdfium instance
//! and queues its work behind it. Its judgment is ported (`pdf::read_text::
//! read_pdf_text`, generic over the `Pdfium` trait) but the instance belongs
//! to the host, so the tool reaches it through a [`PdfTextReader`]: the host
//! implements it by running `read_pdf_text` on its instance. The comparison
//! (calls/b5_mcp/tools_docs.rs) drives the tool with a scripted reader, not
//! the scripted PDFium of `calls/b4_pdf`, whose fake is private to that group.

use std::rc::Rc;

use jscompat::node_path::host::{basename, extname, is_absolute};
use jscompat::{JsonValue, js_regex, number_to_string, to_number, trim};

use super::session_tools::{js_object, string_or_empty};
use crate::packages::zod::z;
use crate::pdf::generated_output::exists_sync;
use crate::pdf::node_io::read_file_bytes;
use crate::pdf::pdfium::PdfiumError;
use crate::pdf::read_text::{PdfTextDoc, ReadPdfTextOptions};
use crate::shell::mcp::mcp_server::McpToolDefinition;

/// `PDF_EXT`
const PDF_EXT: &str = ".pdf";
/// `MAX_TOTAL_CHARS`: hard cap on returned text so one huge PDF cannot flood
/// the agent's context
const MAX_TOTAL_CHARS: f64 = 80_000.0;

/// `readPdfText(bytes, options)`: read-only text extraction of a whole PDF
/// file. `Err` is the message of what it throws.
pub trait PdfTextReader {
    fn read_pdf_text(
        &self,
        bytes: &[u8],
        options: &ReadPdfTextOptions,
    ) -> Result<PdfTextDoc, PdfiumError>;
}

/// `parsePageList(spec, pageCount)`: parse a 1-based page list like "3" or
/// "1-5,8" into sorted unique pages. Throws a guided error instead of silently
/// reading nothing.
pub fn parse_page_list(spec: &str, page_count: f64) -> Result<Vec<f64>, String> {
    let mut pages: Vec<f64> = Vec::new();
    for part in spec.split(',') {
        let trimmed = trim(part);
        if trimmed.is_empty() {
            continue;
        }
        let Some(range) = js_regex!(r"^(\d+)(?:\s*-\s*(\d+))?$").exec(trimmed) else {
            return Err(format!(
                "invalid page \"{trimmed}\" — use \"3\" or \"1-5,8\""
            ));
        };
        let from = to_number(range.get(1).unwrap_or(""));
        let to = match range.get(2) {
            None => from,
            Some(to) => to_number(to),
        };
        if to < from {
            return Err(format!(
                "invalid page range \"{trimmed}\" — end must not precede start"
            ));
        }
        let mut p = from;
        while p <= to {
            if p < 1.0 || p > page_count {
                return Err(format!(
                    "page {} is out of range (1-{})",
                    number_to_string(p),
                    number_to_string(page_count)
                ));
            }
            if !pages.contains(&p) {
                pages.push(p);
            }
            p += 1.0;
        }
    }
    if pages.is_empty() {
        return Err("pages must list at least one page, e.g. \"1-5,8\"".to_owned());
    }
    pages.sort_by(|a, b| a.total_cmp(b));
    Ok(pages)
}

/// `createPdfTools()`: `read_pdf`, over the host's text reader
pub fn create_pdf_tools<'h>(reader: Rc<dyn PdfTextReader + 'h>) -> Vec<McpToolDefinition<'h>> {
    vec![McpToolDefinition {
        name: "read_pdf".to_owned(),
        description: concat!(
            "Read a PDF file: page count, metadata (title/author), and per-page text with page size. ",
            "Text is extracted in content order, so complex multi-column layouts may scramble the ",
            "reading order. Scanned pages have no text layer and come back with empty text and ",
            "hasTextLayer:false. Large documents are capped; use `pages` for a bounded read."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("path", z::string().describe("absolute path to a .pdf file")),
            (
                "pages",
                z::string().optional().describe(
                    "1-based pages to read, e.g. \"3\" or \"1-5,8\"; default is the whole document",
                ),
            ),
        ])),
        handler: Box::new(move |args: JsonValue| {
            let file_path = string_or_empty(&args, "path")?;
            if !is_absolute(&file_path) {
                return Err("path must be absolute".to_owned());
            }
            if extname(&file_path).to_lowercase() != PDF_EXT {
                return Err("path must point to a .pdf file".to_owned());
            }
            if !exists_sync(&file_path) {
                return Err(format!("file not found: {file_path}"));
            }

            let bytes = read_file_bytes(&file_path).map_err(|e| e.message)?;
            // Probe with a zero budget: it opens the document (which is also what
            // surfaces an encrypted or corrupt file as a clean tool error), reports
            // the page count, and extracts no page text. The span cannot be resolved
            // before the count is known, so the calls stay separate.
            let probe = reader
                .read_pdf_text(
                    &bytes,
                    &ReadPdfTextOptions {
                        char_budget: Some(0.0),
                        ..Default::default()
                    },
                )
                .map_err(|_| "could not open the PDF — it may be encrypted or corrupt".to_owned())?;
            let page_count = f64::from(probe.page_count);

            let spec = match args.get("pages").as_deref() {
                Some(JsonValue::String(pages)) => trim(pages).to_owned(),
                _ => String::new(),
            };
            let wanted = if spec.is_empty() {
                None
            } else {
                Some(parse_page_list(&spec, page_count)?)
            };

            // only the requested pages are extracted, so pages the caller never
            // asked for neither spend the budget nor count as truncation
            let doc = reader
                .read_pdf_text(
                    &bytes,
                    &ReadPdfTextOptions {
                        pages: wanted,
                        char_budget: Some(MAX_TOTAL_CHARS),
                        ..Default::default()
                    },
                )
                .map_err(|e| e.0)?;

            let mut info = Vec::new();
            if let Some(title) = &doc.title {
                info.push(("title", JsonValue::String(title.clone())));
            }
            if let Some(author) = &doc.author {
                info.push(("author", JsonValue::String(author.clone())));
            }
            let pages = doc
                .pages
                .iter()
                .map(|page| {
                    js_object(vec![
                        ("page", JsonValue::Number(page.page)),
                        ("widthPt", JsonValue::Number(page.width_pt)),
                        ("heightPt", JsonValue::Number(page.height_pt)),
                        ("chars", JsonValue::Number(f64::from(page.chars))),
                        ("text", JsonValue::String(page.text.clone())),
                        ("hasTextLayer", JsonValue::Bool(page.has_text_layer)),
                    ])
                })
                .collect();
            Ok(Some(js_object(vec![
                ("path", JsonValue::String(file_path.clone())),
                ("name", JsonValue::String(basename(&file_path, None))),
                ("pageCount", JsonValue::Number(f64::from(doc.page_count))),
                ("info", js_object(info)),
                ("pages", JsonValue::Array(pages)),
                ("truncated", JsonValue::Bool(doc.truncated)),
            ])))
        }),
    }]
}
