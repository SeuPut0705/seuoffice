//! Byte-exact scanner for the main document part
//! (packages/docx-engine/src/scan.ts).
//!
//! The whole part is never re-serialized: that would change untouched bytes
//! (attribute order, self-closing forms, entity forms). The scanner locates the
//! exact range of every top-level element of `<w:body>`, so that a save can
//! splice new fragments while copying untouched elements as original slices.

use std::fmt;

use ooxml_xml::{Tag, opaque_end, tag_at};

/// A top-level element of the body. `start..end` is a byte range of the part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BodyElement<'a> {
    pub name: &'a str,
    pub start: usize,
    pub end: usize,
}

/// A comment, CDATA section, processing instruction or declaration inside the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpaqueRegion {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyScan<'a> {
    pub elements: Vec<BodyElement<'a>>,
    pub opaque_regions: Vec<OpaqueRegion>,
    /// From the first top-level element's start to the last one's end; the
    /// body content range when the body has no element.
    pub inner_start: usize,
    pub inner_end: usize,
    pub body_content_start: usize,
    pub body_content_end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanError<'a> {
    UnexpectedClosingTag { name: &'a str },
    NoBody,
}

impl fmt::Display for ScanError<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedClosingTag { name } => {
                write!(f, "unexpected closing tag </{name}> at body level")
            }
            Self::NoBody => f.write_str("document.xml has no <w:body> element"),
        }
    }
}

impl std::error::Error for ScanError<'_> {}

/// A CDATA section directly inside one of these is document text, not an
/// opaque region (`TEXT_ELEMENTS` of scan.ts).
const CDATA_IS_TEXT_IN: [&str; 6] = [
    "w:t",
    "w:delText",
    "w:instrText",
    "w:delInstrText",
    "a:t",
    "m:t",
];

pub fn scan_body(document_xml: &str) -> Result<BodyScan<'_>, ScanError<'_>> {
    let mut elements = Vec::new();
    let mut opaque_regions = Vec::new();
    let mut cursor = 0;
    let mut body_content_start = None;
    let mut body_content_end = None;
    let mut in_body = false;
    let mut open: Vec<Tag<'_>> = Vec::new();

    while let Some(found) = document_xml[cursor..].find('<') {
        let start = cursor + found;
        if let Some(end) = opaque_end(document_xml, start) {
            let text_cdata = document_xml[start..].starts_with("<![CDATA[")
                && open
                    .last()
                    .is_some_and(|parent| CDATA_IS_TEXT_IN.contains(&parent.name));
            if body_content_start.is_some() && !text_cdata {
                opaque_regions.push(OpaqueRegion { start, end });
            }
            cursor = end;
            continue;
        }
        let tag = tag_at(document_xml, start);
        cursor = tag.end;

        if !in_body {
            if !tag.closing && tag.name == "w:body" {
                body_content_start.get_or_insert(tag.end);
                if !tag.self_closing {
                    in_body = true;
                } else {
                    body_content_end.get_or_insert(tag.end);
                }
            }
            continue;
        }

        if open.is_empty() && tag.closing && tag.name == "w:body" {
            body_content_end = Some(start);
            in_body = false;
            continue;
        }

        if tag.closing {
            // the name of a closing tag is not matched against the open element
            let Some(opening) = open.pop() else {
                return Err(ScanError::UnexpectedClosingTag { name: tag.name });
            };
            if open.is_empty() {
                elements.push(BodyElement {
                    name: opening.name,
                    start: opening.start,
                    end: tag.end,
                });
            }
        } else if tag.self_closing {
            if open.is_empty() {
                elements.push(BodyElement {
                    name: tag.name,
                    start: tag.start,
                    end: tag.end,
                });
            }
        } else {
            open.push(tag);
        }
    }

    let body_content_start = body_content_start.ok_or(ScanError::NoBody)?;
    let body_content_end = body_content_end.unwrap_or(document_xml.len());
    opaque_regions
        .retain(|region| region.start >= body_content_start && region.end <= body_content_end);
    let (inner_start, inner_end) = match (elements.first(), elements.last()) {
        (Some(first), Some(last)) => (first.start, last.end),
        _ => (body_content_start, body_content_end),
    };
    Ok(BodyScan {
        elements,
        opaque_regions,
        inner_start,
        inner_end,
        body_content_start,
        body_content_end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slices<'a>(xml: &'a str, scan: &BodyScan<'_>) -> Vec<&'a str> {
        scan.elements
            .iter()
            .map(|element| &xml[element.start..element.end])
            .collect()
    }

    #[test]
    fn top_level_elements_are_exact_slices_of_the_part() {
        let xml = "<w:document><w:body><w:p>\u{1F600}</w:p><w:tbl a=\">\"/><w:sectPr/></w:body></w:document>";
        let scan = scan_body(xml).unwrap();
        assert_eq!(
            slices(xml, &scan),
            ["<w:p>\u{1F600}</w:p>", "<w:tbl a=\">\"/>", "<w:sectPr/>"]
        );
        assert_eq!(
            scan.elements
                .iter()
                .map(|element| element.name)
                .collect::<Vec<_>>(),
            ["w:p", "w:tbl", "w:sectPr"]
        );
        assert_eq!(
            &xml[scan.inner_start..scan.inner_end],
            &xml[scan.body_content_start..scan.body_content_end]
        );
        assert_eq!(&xml[scan.body_content_end..], "</w:body></w:document>");
    }

    #[test]
    fn nested_elements_are_not_reported() {
        let xml = "<w:document><w:body><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/></w:body></w:document>";
        let scan = scan_body(xml).unwrap();
        assert_eq!(
            slices(xml, &scan),
            ["<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>", "<w:p/>"]
        );
    }

    #[test]
    fn opaque_regions_are_those_inside_the_body_except_text_cdata() {
        let xml = "<!-- before --><w:document><w:body><!-- c --><w:p><w:r><w:t><![CDATA[x]]></w:t><![CDATA[y]]></w:r></w:p><?pi?></w:body><!-- after --></w:document>";
        let scan = scan_body(xml).unwrap();
        let regions: Vec<&str> = scan
            .opaque_regions
            .iter()
            .map(|region| &xml[region.start..region.end])
            .collect();
        assert_eq!(regions, ["<!-- c -->", "<![CDATA[y]]>", "<?pi?>"]);
        assert_eq!(scan.elements.len(), 1);
    }

    #[test]
    fn a_comment_that_looks_like_markup_is_skipped() {
        let xml =
            "<w:document><w:body><!-- <w:p>fake</w:p> </w:body> --><w:p/></w:body></w:document>";
        assert_eq!(slices(xml, &scan_body(xml).unwrap()), ["<w:p/>"]);
    }

    #[test]
    fn an_element_spans_to_whatever_closing_tag_closes_it() {
        let xml = "<w:document><w:body><w:p><w:r></w:p></w:r><w:p/></w:body></w:document>";
        assert_eq!(
            slices(xml, &scan_body(xml).unwrap()),
            ["<w:p><w:r></w:p></w:r>", "<w:p/>"]
        );
    }

    #[test]
    fn scanning_continues_into_later_bodies() {
        let xml =
            "<w:document><w:body><w:p>1</w:p></w:body><w:body><w:p>2</w:p></w:body></w:document>";
        let scan = scan_body(xml).unwrap();
        assert_eq!(slices(xml, &scan), ["<w:p>1</w:p>", "<w:p>2</w:p>"]);
        assert_eq!(scan.inner_end, scan.elements[1].end);
    }

    #[test]
    fn the_content_range_runs_from_the_first_body_to_the_last() {
        let xml =
            "<w:document><w:body><w:p>1</w:p></w:body><w:body><w:p>2</w:p></w:body></w:document>";
        let scan = scan_body(xml).unwrap();
        assert_eq!(&xml[..scan.body_content_start], "<w:document><w:body>");
        assert_eq!(&xml[scan.body_content_end..], "</w:body></w:document>");
    }

    #[test]
    fn a_self_closing_body_fixes_the_start_but_not_the_end() {
        let xml = "<w:document><w:body/><w:body><w:p/></w:body></w:document>";
        let scan = scan_body(xml).unwrap();
        assert_eq!(&xml[..scan.body_content_start], "<w:document><w:body/>");
        assert_eq!(&xml[scan.body_content_end..], "</w:body></w:document>");

        let empty = "<w:document><w:body/></w:document>";
        let scan = scan_body(empty).unwrap();
        assert!(scan.elements.is_empty());
        assert_eq!((scan.inner_start, scan.inner_end), (21, 21));
    }

    #[test]
    fn a_body_without_elements_reports_its_content_range() {
        let xml = "<w:document><w:body> text </w:body></w:document>";
        let scan = scan_body(xml).unwrap();
        assert!(scan.elements.is_empty());
        assert_eq!(&xml[scan.inner_start..scan.inner_end], " text ");
    }

    #[test]
    fn an_unclosed_body_ends_with_the_part_and_drops_the_open_element() {
        let xml = "<w:document><w:body><w:p/><w:tbl>";
        let scan = scan_body(xml).unwrap();
        assert_eq!(slices(xml, &scan), ["<w:p/>"]);
        assert_eq!(scan.body_content_end, xml.len());
    }

    #[test]
    fn a_closing_tag_with_nothing_open_is_an_error_naming_the_tag() {
        let error = scan_body("<w:document><w:body></w:p></w:body></w:document>").unwrap_err();
        assert_eq!(
            error.to_string(),
            "unexpected closing tag </w:p> at body level"
        );
    }

    #[test]
    fn the_body_closing_tag_below_an_open_element_closes_that_element() {
        let xml = "<w:document><w:body><w:p></w:body><w:r/></w:p></w:body></w:document>";
        assert_eq!(
            scan_body(xml),
            Err(ScanError::UnexpectedClosingTag { name: "w:p" })
        );
    }

    #[test]
    fn a_part_without_a_body_is_an_error() {
        for xml in [
            "",
            "<w:document><w:p/></w:document>",
            "<w:document><w:bodyPr/><W:BODY/></w:document>",
        ] {
            let error = scan_body(xml).unwrap_err();
            assert_eq!(
                error.to_string(),
                "document.xml has no <w:body> element",
                "{xml}"
            );
        }
    }
}
