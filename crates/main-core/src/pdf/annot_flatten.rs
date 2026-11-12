//! `apps/pdf/src/main/annot-flatten.ts`: bake annotations into page content
//! for a Save As copy, through PDFium's page flatten.

use super::pdfium::{Pdfium, PdfiumError, save_doc, with_document};

/// `FPDFPage_Flatten` result codes: 0 failed, 1 flattened, 2 nothing to do
const FLATTEN_FAILED: i32 = 0;

pub fn flatten_annots_bytes<M: Pdfium + ?Sized>(
    m: &mut M,
    bytes: &[u8],
) -> Result<Vec<u8>, PdfiumError> {
    with_document(m, bytes, None, |m, doc| {
        let page_count = m.fpdf_get_page_count(doc);
        let mut changed = false;
        for page_index in 0..page_count {
            let page = m.fpdf_load_page(doc, page_index);
            if page == 0 {
                return Err(PdfiumError::new(format!(
                    "could not load page {}",
                    page_index + 1
                )));
            }
            let result = (|| {
                // A page without annotations has nothing to flatten and must not be
                // rewritten: the untouched pages keep their original content streams.
                if m.fpdf_page_get_annot_count(page) == 0 {
                    return Ok(());
                }
                if m.fpdf_page_flatten(page, 0) == FLATTEN_FAILED {
                    return Err(PdfiumError::new(format!(
                        "could not flatten annotations on page {}",
                        page_index + 1
                    )));
                }
                changed = true;
                Ok(())
            })();
            m.fpdf_close_page(page);
            result?;
        }
        if changed {
            save_doc(m, doc)
        } else {
            Ok(bytes.to_vec())
        }
    })
}
