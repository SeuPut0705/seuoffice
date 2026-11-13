//! The tag scanner under `scanBody` (packages/docx-engine/src/scan.ts).

use std::borrow::Cow;

use jscompat::trim_start;

/// One tag found by the scanner. `start..end` is a byte range of the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tag<'a> {
    pub start: usize,
    pub end: usize,
    /// Empty when the text after `<` or `</` does not start an ASCII name.
    pub name: &'a str,
    pub closing: bool,
    pub self_closing: bool,
}

/// Reads the tag whose `<` is at `start`. A `>` inside a quoted attribute value
/// does not end the tag; a tag that never ends runs to the end of the text.
pub fn tag_at(xml: &str, start: usize) -> Tag<'_> {
    let bytes = xml.as_bytes();
    let mut quote = 0u8;
    let mut end = bytes.len();
    for (index, &byte) in bytes.iter().enumerate().skip(start + 1) {
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'>' {
            end = index + 1;
            break;
        }
    }
    let text = &xml[start..end];
    let closing = text.starts_with("</");
    Tag {
        start,
        end,
        name: tag_name(text),
        closing,
        self_closing: !closing && text.ends_with("/>"),
    }
}

/// `^<\/?\s*([A-Za-z_][\w:.-]*)` with JavaScript's ASCII `\w`.
fn tag_name(text: &str) -> &str {
    let Some(rest) = text.strip_prefix('<') else {
        return "";
    };
    let rest = trim_start(rest.strip_prefix('/').unwrap_or(rest));
    let bytes = rest.as_bytes();
    if !bytes
        .first()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
    {
        return "";
    }
    let length = bytes
        .iter()
        .position(|byte| {
            !(byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-'))
        })
        .unwrap_or(bytes.len());
    &rest[..length]
}

/// End of the comment, CDATA section, processing instruction or `<!...>`
/// declaration that starts at `start`, or `None` when an ordinary tag starts
/// there. An unterminated construct runs to the end of the text.
pub fn opaque_end(xml: &str, start: usize) -> Option<usize> {
    let rest = &xml[start..];
    let closed_by = |open: &str, close: &str| {
        rest[open.len()..]
            .find(close)
            .map_or(xml.len(), |at| start + open.len() + at + close.len())
    };
    if rest.starts_with("<!--") {
        return Some(closed_by("<!--", "-->"));
    }
    if rest.starts_with("<![CDATA[") {
        return Some(closed_by("<![CDATA[", "]]>"));
    }
    if rest.starts_with("<?") {
        return Some(closed_by("<?", "?>"));
    }
    if !rest.starts_with("<!") {
        return None;
    }
    let mut quote = 0u8;
    let mut subset_depth = 0usize;
    for (index, &byte) in xml.as_bytes().iter().enumerate().skip(start + 2) {
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'[' {
            subset_depth += 1;
        } else if byte == b']' {
            subset_depth = subset_depth.saturating_sub(1);
        } else if byte == b'>' && subset_depth == 0 {
            return Some(index + 1);
        }
    }
    Some(xml.len())
}

/// `maskOpaque` of xml-utils.ts: the XML with every comment, CDATA section and
/// processing instruction blanked to spaces, the same length in bytes, so a
/// scan of the blanked text gives offsets into the original. A construct
/// with no terminator is no match and is left as it is.
pub fn mask_opaque(xml: &str) -> Cow<'_, str> {
    let mut masked: Option<String> = None;
    let (mut copied, mut at) = (0, 0);
    while let Some(found) = xml[at..].find('<') {
        let start = at + found;
        let rest = &xml[start..];
        let (open, close) = if rest.starts_with("<!--") {
            ("<!--", "-->")
        } else if rest.starts_with("<![CDATA[") {
            ("<![CDATA[", "]]>")
        } else if rest.starts_with("<?") {
            ("<?", "?>")
        } else {
            at = start + 1;
            continue;
        };
        let Some(inside) = rest[open.len()..].find(close) else {
            at = start + 1;
            continue;
        };
        let end = start + open.len() + inside + close.len();
        let out = masked.get_or_insert_with(|| String::with_capacity(xml.len()));
        out.push_str(&xml[copied..start]);
        out.extend(std::iter::repeat_n(' ', end - start));
        copied = end;
        at = end;
    }
    match masked {
        Some(mut out) => {
            out.push_str(&xml[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(xml),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quoted_gt_does_not_end_the_tag() {
        let xml = r#"<w:p a="x>y" b='>'>text"#;
        let tag = tag_at(xml, 0);
        assert_eq!(&xml[tag.start..tag.end], r#"<w:p a="x>y" b='>'>"#);
        assert_eq!(tag.name, "w:p");
        assert!(!tag.closing && !tag.self_closing);
    }

    #[test]
    fn an_unterminated_tag_runs_to_the_end() {
        let xml = r#"<w:p a="never closed>"#;
        let tag = tag_at(xml, 0);
        assert_eq!(tag.end, xml.len());
        assert_eq!(tag.name, "w:p");
    }

    #[test]
    fn closing_and_self_closing_forms() {
        assert!(tag_at("</w:p>", 0).closing);
        assert!(tag_at("<w:br/>", 0).self_closing);
    }

    #[test]
    fn a_closing_tag_that_ends_like_a_self_closing_one_is_a_closing_tag() {
        let tag = tag_at("</x/>", 0);
        assert!(tag.closing && !tag.self_closing);
    }

    #[test]
    fn names_follow_the_scanner_grammar() {
        assert_eq!(tag_at("</ w:p>", 0).name, "w:p");
        assert_eq!(tag_at("<\u{00A0}w:p>", 0).name, "w:p");
        assert_eq!(tag_at("<a.b-c_d:e f='1'>", 0).name, "a.b-c_d:e");
    }

    #[test]
    fn a_digit_or_a_non_ascii_letter_cannot_start_a_name() {
        assert_eq!(tag_at("<1a>", 0).name, "");
        assert_eq!(tag_at("<\u{00E9}l>", 0).name, "");
    }

    #[test]
    fn a_name_stops_at_the_first_non_ascii_character() {
        assert_eq!(tag_at("<w:p\u{00E9}>", 0).name, "w:p");
    }

    #[test]
    fn opaque_constructs_end_at_their_terminator() {
        assert_eq!(opaque_end("<!-- a > b --><w:p/>", 0), Some(14));
        assert_eq!(opaque_end("<![CDATA[a]]>b", 0), Some(13));
        assert_eq!(opaque_end("<?pi a?>b", 0), Some(8));
        assert_eq!(opaque_end("<w:p>", 0), None);
    }

    #[test]
    fn a_doctype_skips_its_internal_subset_and_quotes() {
        let xml = r#"<!DOCTYPE a [<!ENTITY e ">]"> ]><w:document/>"#;
        let end = opaque_end(xml, 0).unwrap();
        assert_eq!(&xml[end..], "<w:document/>");
    }

    #[test]
    fn unterminated_opaque_constructs_run_to_the_end() {
        for xml in [
            "<!-- never",
            "<![CDATA[never",
            "<?never",
            "<!DOCTYPE a [",
            "<!--",
        ] {
            assert_eq!(opaque_end(xml, 0), Some(xml.len()), "{xml}");
        }
    }

    #[test]
    fn masking_blanks_what_a_scan_must_not_see_and_keeps_every_offset() {
        let xml = "<a><!-- </a> --><![CDATA[</a>]]><?pi </a>?>\u{e9}</a>";
        let masked = mask_opaque(xml);
        assert_eq!(masked.len(), xml.len());
        assert_eq!(masked.find("</a>"), xml.rfind("</a>"));
        assert_eq!(mask_opaque("<w:p/>"), "<w:p/>");
        // an opener without its terminator is no match: the later construct is
        assert_eq!(
            mask_opaque("<!-- x <?y?>"),
            format!("<!-- x{}", " ".repeat(6))
        );
        assert_eq!(mask_opaque("<!-->x-->"), "         ");
    }

    #[test]
    fn a_terminator_cannot_reuse_the_characters_of_the_opener() {
        assert_eq!(opaque_end("<!-->x-->y", 0), Some(9));
    }
}
