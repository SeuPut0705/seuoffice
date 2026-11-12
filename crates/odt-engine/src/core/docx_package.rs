//! `core/docx-package.ts`: assembles the bridge docx from an
//! `OdfToOoxmlContext` and reads parts of an edited docx. The bridge docx
//! opens with the docx engine's `parseDocx`; its body elements are exactly
//! `ctx.map.elements[*].xml`, in order, followed by the final section
//! properties.
//!
//! The zip is written by `ooxml_pkg::write::generate` (JSZip's writer, DEFLATE
//! at the default level). JSZip stamps each entry with the clock: `now` is
//! that instant (`now.ms`, a time value; JSZip writes UTC fields).

use jscompat::{js_regex, math_round, parse_float, trim};
use ooxml_pkg::{Package, decode_text, read_entries};

use super::HostNow;
use super::convert::{DocxPartData, OdfToOoxmlContext};
use super::errors::OdtError;
use super::xml::escape_xml_attr;

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";

/// `BRIDGE_DOCUMENT_NAMESPACES`: namespaces declared on the bridge document root.
pub const BRIDGE_DOCUMENT_NAMESPACES: [&str; 6] = [
    "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"",
    "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
    "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"",
    "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"",
    "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"",
    "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\"",
];

/// `MEDIA_TYPES[ext]`
fn media_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpeg" | "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        "emf" => "image/x-emf",
        "wmf" => "image/x-wmf",
        _ => return None,
    })
}

/// `defaultSectPr`: `w:sectPr` for the default page layout of the ODT (A4
/// portrait when none).
pub fn default_sect_pr(ctx: &OdfToOoxmlContext) -> String {
    let styles = &ctx.doc.styles;
    let master = styles
        .master_page("Standard")
        .or_else(|| styles.master_pages.first().cloned());
    let layout = master
        .as_ref()
        .and_then(|m| m.page_layout_name.as_deref().filter(|n| !n.is_empty()))
        .and_then(|name| styles.page_layout(name));
    let props = layout
        .as_ref()
        .and_then(|l| l.properties.get("style:page-layout-properties"));
    let get = |key: &str| props.and_then(|p| p.get(key)).map(String::as_str);
    let tw = |v: Option<&str>, d: f64| -> f64 {
        let Some(v) = v.filter(|v| !v.is_empty()) else {
            return d;
        };
        let Some(m) = js_regex!(r"^([-+]?\d*\.?\d+)(cm|mm|in|pt)$").exec(trim(v)) else {
            return d;
        };
        let n = parse_float(m.get(1).unwrap_or(""));
        let f = match m.get(2) {
            Some("cm") => 1440.0 / 2.54,
            Some("mm") => 1440.0 / 25.4,
            Some("in") => 1440.0,
            _ => 20.0,
        };
        math_round(n * f)
    };
    let num = jscompat::number_to_string;
    let w = tw(get("fo:page-width"), 11906.0);
    let h = tw(get("fo:page-height"), 16838.0);
    let orient = if get("style:print-orientation") == Some("landscape") {
        " w:orient=\"landscape\""
    } else {
        ""
    };
    format!(
        "<w:sectPr><w:pgSz w:w=\"{}\" w:h=\"{}\"{orient}/>\
         <w:pgMar w:top=\"{}\" w:right=\"{}\" \
         w:bottom=\"{}\" w:left=\"{}\" \
         w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/></w:sectPr>",
        num(w),
        num(h),
        num(tw(get("fo:margin-top"), 1440.0)),
        num(tw(get("fo:margin-right"), 1440.0)),
        num(tw(get("fo:margin-bottom"), 1440.0)),
        num(tw(get("fo:margin-left"), 1440.0)),
    )
}

/// `bridgeDocumentXml`: the word/document.xml of the bridge docx.
pub fn bridge_document_xml(ctx: &OdfToOoxmlContext) -> String {
    let mut ns: Vec<&str> = BRIDGE_DOCUMENT_NAMESPACES.to_vec();
    ns.extend(ctx.docx.namespaces.iter().map(String::as_str));
    let ns = ns.join(" ");
    let body: String = ctx.map.elements.iter().map(|e| e.xml.as_str()).collect();
    let sect = match &ctx.docx.sect_pr {
        Some(sect) => sect.clone(),
        None => default_sect_pr(ctx),
    };
    format!("{XML_DECL}<w:document {ns}><w:body>{body}{sect}</w:body></w:document>")
}

/// `buildBridgeDocx`: builds the bridge docx bytes from everything the
/// converters accumulated.
pub fn build_bridge_docx(ctx: &OdfToOoxmlContext, now: HostNow) -> Result<Vec<u8>, OdtError> {
    let mut overrides: Vec<(String, String)> = vec![
        (
            "/word/document.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
                .to_owned(),
        ),
        (
            "/word/styles.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml".to_owned(),
        ),
        (
            "/word/numbering.xml".to_owned(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"
                .to_owned(),
        ),
    ];
    // an insertion-ordered set
    let mut defaults: Vec<String> = vec!["rels".to_owned(), "xml".to_owned()];
    for part in &ctx.docx.parts {
        if let Some(content_type) = part.content_type.as_deref().filter(|c| !c.is_empty()) {
            overrides.push((format!("/{}", part.path), content_type.to_owned()));
        } else {
            let ext = js_regex!(r"\.([A-Za-z0-9]+)$")
                .exec(&part.path)
                .and_then(|m| m.get(1))
                .map(|e| e.to_lowercase());
            if let Some(ext) = ext {
                if media_type(&ext).is_some() && !defaults.contains(&ext) {
                    defaults.push(ext);
                }
            }
        }
    }
    let default_xml: String = defaults
        .iter()
        .map(|ext| match ext.as_str() {
            "rels" => "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>".to_owned(),
            "xml" => "<Default Extension=\"xml\" ContentType=\"application/xml\"/>".to_owned(),
            other => format!(
                "<Default Extension=\"{other}\" ContentType=\"{}\"/>",
                media_type(other).unwrap_or("")
            ),
        })
        .collect();
    let overrides_xml: String = overrides
        .iter()
        .map(|(name, kind)| {
            format!(
                "<Override PartName=\"{}\" ContentType=\"{kind}\"/>",
                escape_xml_attr(name)
            )
        })
        .collect();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    files.push((
        "[Content_Types].xml".to_owned(),
        format!(
            "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">{default_xml}{overrides_xml}</Types>"
        )
        .into_bytes(),
    ));
    let core_rel = if ctx.docx.parts.iter().any(|p| p.path == "docProps/core.xml") {
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>"
    } else {
        ""
    };
    files.push((
        "_rels/.rels".to_owned(),
        format!(
            "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>{core_rel}</Relationships>"
        )
        .into_bytes(),
    ));
    let mut rels: Vec<String> = vec![
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>".to_owned(),
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>".to_owned(),
    ];
    for r in &ctx.docx.relationships {
        rels.push(format!(
            "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"{}/>",
            escape_xml_attr(&r.id),
            escape_xml_attr(&r.r#type),
            escape_xml_attr(&r.target),
            if r.external {
                " TargetMode=\"External\""
            } else {
                ""
            }
        ));
    }
    files.push((
        "word/_rels/document.xml.rels".to_owned(),
        format!(
            "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>",
            rels.concat()
        )
        .into_bytes(),
    ));
    let doc_defaults = if ctx.docx.doc_defaults.is_empty() {
        "<w:docDefaults><w:rPrDefault><w:rPr/></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>"
    } else {
        ctx.docx.doc_defaults.as_str()
    };
    files.push((
        "word/styles.xml".to_owned(),
        format!(
            "{XML_DECL}<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">{doc_defaults}{}</w:styles>",
            ctx.docx.styles.concat()
        )
        .into_bytes(),
    ));
    files.push((
        "word/numbering.xml".to_owned(),
        format!(
            "{XML_DECL}<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">{}{}</w:numbering>",
            ctx.docx.abstract_nums.concat(),
            ctx.docx.nums.concat()
        )
        .into_bytes(),
    ));
    files.push((
        "word/document.xml".to_owned(),
        bridge_document_xml(ctx).into_bytes(),
    ));
    for part in &ctx.docx.parts {
        let bytes = match &part.data {
            DocxPartData::Text(text) => text.clone().into_bytes(),
            DocxPartData::Bytes(bytes) => bytes.clone(),
        };
        files.push((part.path.clone(), bytes));
    }
    let package = Package::from_parts(files);
    ooxml_pkg::write::generate(&package, now.ms).map_err(|e| OdtError::thrown(e.to_string()))
}

/// What JSZip throws for bytes with no end of central directory.
const JSZIP_NOT_A_ZIP: &str = "Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html";

/// `readDocxPart`: reads one part of a docx as text (`None` when missing).
pub fn read_docx_part(bytes: &[u8], path: &str) -> Result<Option<String>, OdtError> {
    let entries = read_entries(bytes).map_err(|e| {
        let text = e.to_string();
        if text.contains("EOCD") {
            OdtError::thrown(JSZIP_NOT_A_ZIP)
        } else {
            OdtError::thrown(text)
        }
    })?;
    // a later entry of the same name replaces the earlier one, as in JSZip
    let found = entries
        .iter()
        .rev()
        .find(|entry| !entry.is_dir && entry.raw_name == path.as_bytes());
    match found {
        None => Ok(None),
        Some(entry) => match &entry.content {
            Ok(content) => Ok(Some(decode_text(content).into_owned())),
            Err(reason) => Err(OdtError::thrown(reason.clone())),
        },
    }
}
