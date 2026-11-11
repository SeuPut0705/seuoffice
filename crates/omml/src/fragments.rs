//! Fragment extraction: the `<m:oMath>` zones of a paragraph and their tokens.

use jscompat::js_regex;

/// `ommlFragmentsOf`: every `<m:oMath>` of a paragraph in document order,
/// `<m:oMathPara>` unwrapped.
pub fn omml_fragments_of(paragraph_xml: &str) -> Vec<&str> {
    // `(?=[\s>])` keeps <m:oMathPara> from matching
    js_regex!(r"<m:oMath(?=[\s>])(?:\s[^>]*)?>[\s\S]*?<\/m:oMath>")
        .find_iter(paragraph_xml)
        .map(|found| found.as_str())
        .collect()
}

/// `ommlEndsWithBreak`: the zone ends in `<m:r><w:br/></m:r>`, Word's manual
/// line break inside math.
pub fn omml_ends_with_break(omml_xml: &str) -> bool {
    js_regex!(r"<w:br\b[^>]*\/>\s*<\/m:r>\s*<\/m:oMath>\s*$").test(omml_xml)
}

/// `mathTokensOf`: the `<m:t>` texts in document order, the five entities
/// decoded one after the other.
pub fn math_tokens_of(xml: &str) -> Vec<String> {
    js_regex!(r"<m:t(?:\s[^>]*)?>([\s\S]*?)<\/m:t>")
        .find_iter(xml)
        .map(|found| {
            found
                .get(1)
                .unwrap_or("")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&amp;", "&")
        })
        .collect()
}
