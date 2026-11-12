//! The markup scanners of patch.ts the part writers share: where a comment,
//! CDATA section, processing instruction or declaration ends, where a start
//! tag ends, and the prefixes a part binds a namespace to.

use jscompat::js_regex;

/// `opaqueMarkupEnd`: the end of the comment, CDATA section, processing
/// instruction or declaration that starts at byte `start`; None for an
/// element tag. An unterminated one runs to the end of the text.
pub fn opaque_markup_end(xml: &str, start: usize) -> Option<usize> {
    let rest = &xml[start..];
    if rest.starts_with("<!--") {
        return Some(match xml[start + 4..].find("-->") {
            Some(at) => start + 4 + at + 3,
            None => xml.len(),
        });
    }
    if rest.starts_with("<![CDATA[") {
        return Some(match xml[start + 9..].find("]]>") {
            Some(at) => start + 9 + at + 3,
            None => xml.len(),
        });
    }
    if rest.starts_with("<?") {
        return Some(match xml[start + 2..].find("?>") {
            Some(at) => start + 2 + at + 2,
            None => xml.len(),
        });
    }
    if !rest.starts_with("<!") {
        return None;
    }
    let mut quote = None;
    let mut subset_depth = 0usize;
    for (offset, byte) in xml.as_bytes()[start + 2..].iter().enumerate() {
        let index = start + 2 + offset;
        match quote {
            Some(open) => {
                if *byte == open {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' => quote = Some(*byte),
                b'[' => subset_depth += 1,
                b']' => subset_depth = subset_depth.saturating_sub(1),
                b'>' if subset_depth == 0 => return Some(index + 1),
                _ => {}
            },
        }
    }
    Some(xml.len())
}

/// `xmlTagEnd`: the end of the tag that starts at byte `start`, read past a
/// quoted `>`; the end of the text when the tag is left open.
pub fn xml_tag_end(xml: &str, start: usize) -> usize {
    let mut quote = None;
    for (offset, byte) in xml.as_bytes()[start + 1..].iter().enumerate() {
        match quote {
            Some(open) => {
                if *byte == open {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' => quote = Some(*byte),
                b'>' => return start + 1 + offset + 1,
                _ => {}
            },
        }
    }
    xml.len()
}

/// `namespacePrefixes`: the prefixes declared anywhere in this standalone XML
/// part for one of `namespaces`, in order of appearance (`""` for the default
/// namespace).
pub fn namespace_prefixes(xml: &str, namespaces: &[&str]) -> Vec<String> {
    let declaration = js_regex!(
        r#"\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])([^"']*)\2"#,
        "g"
    );
    let mut found: Vec<String> = Vec::new();
    for declared in declaration.find_iter(xml) {
        if namespaces.contains(&declared.get(3).unwrap_or_default()) {
            let prefix = declared.get(1).unwrap_or_default();
            if !found.iter().any(|seen| seen == prefix) {
                found.push(prefix.to_owned());
            }
        }
    }
    found
}
