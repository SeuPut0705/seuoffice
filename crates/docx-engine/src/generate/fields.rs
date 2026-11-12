//! The field paragraph builders of generate.ts: `generateTocFieldXml`,
//! `generateCaptionXml`, `generateIndexFieldXml`.

#[cfg(feature = "icu-collation")]
use icu_collator::options::CollatorOptions;
#[cfg(feature = "icu-collation")]
use icu_collator::{Collator, CollatorBorrowed};
#[cfg(feature = "icu-collation")]
use icu_locale_core::locale;
use jscompat::{JsNum, math_max, math_min, number_to_string, trim};
use serde::Deserialize;

use super::escape_xml_text;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    /// heading level 1-9
    pub level: JsNum,
    pub text: String,
    pub page_no: Option<JsNum>,
}

/// A real TOC field as one w:p fragment per line
pub fn generate_toc_field_xml(entries: &[TocEntry]) -> Vec<String> {
    if entries.is_empty() {
        return Vec::new();
    }
    let mut deepest = 1.0;
    for entry in entries {
        if entry.level.0 > deepest {
            deepest = entry.level.0;
        }
    }
    let max_level = math_min(deepest, 9.0);
    let begin = format!(
        "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r>\
         <w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-{}\" \\h \\z \\u </w:instrText></w:r>\
         <w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
        number_to_string(max_level)
    );
    let end = "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>";
    let last_index = entries.len() - 1;
    entries
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let p_pr = format!(
                "<w:pPr><w:pStyle w:val=\"TOC{}\"/>\
                 <w:tabs><w:tab w:val=\"right\" w:leader=\"dot\" w:pos=\"9350\"/></w:tabs>\
                 <w:rPr><w:noProof/></w:rPr></w:pPr>",
                number_to_string(math_min(math_max(entry.level.0, 1.0), 9.0))
            );
            let page = entry.page_no.map_or(String::new(), |page| {
                format!(
                    "<w:r><w:rPr><w:noProof/></w:rPr><w:t>{}</w:t></w:r>",
                    number_to_string(page.0)
                )
            });
            format!(
                "<w:p>{p_pr}{}<w:r><w:rPr><w:noProof/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>\
                 <w:r><w:rPr><w:noProof/></w:rPr><w:tab/></w:r>{page}{}</w:p>",
                if i == 0 { begin.as_str() } else { "" },
                escape_xml_text(&entry.text),
                if i == last_index { end } else { "" },
            )
        })
        .collect()
}

/// Caption paragraph: `<label> <SEQ label> <text>`
pub fn generate_caption_xml(label: &str, number: JsNum, text: &str) -> String {
    let r_pr =
        "<w:rPr><w:color w:val=\"44546A\"/><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr>";
    let run = |inner: &str| format!("<w:r>{r_pr}{inner}</w:r>");
    let label = escape_xml_text(label);
    let mut out = String::from(
        "<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"80\" w:after=\"200\"/></w:pPr>",
    );
    out.push_str(&run(&format!("<w:t xml:space=\"preserve\">{label} </w:t>")));
    out.push_str(&run(
        "<w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/>",
    ));
    out.push_str(&run(&format!(
        "<w:instrText xml:space=\"preserve\"> SEQ {label} \\* ARABIC </w:instrText>"
    )));
    out.push_str(&run("<w:fldChar w:fldCharType=\"separate\"/>"));
    out.push_str(&run(&format!("<w:t>{}</w:t>", number_to_string(number.0))));
    out.push_str(&run("<w:fldChar w:fldCharType=\"end\"/>"));
    if !text.is_empty() {
        out.push_str(&run(&format!(
            "<w:t xml:space=\"preserve\"> {}</w:t>",
            escape_xml_text(text)
        )));
    }
    out.push_str("</w:p>");
    out
}

#[cfg(not(any(feature = "icu-collation", target_arch = "wasm32")))]
compile_error!(
    "docx-engine needs the `icu-collation` feature outside wasm32: only a wasm host supplies the INDEX field collator"
);

/// `new Intl.Collator('zh-CN')`: the default (pinyin) collation, tertiary strength
#[cfg(feature = "icu-collation")]
fn zh_cn_collator() -> CollatorBorrowed<'static> {
    Collator::try_new(locale!("zh-CN").into(), CollatorOptions::default())
        .expect("compiled collation data holds zh")
}

/// `new Intl.Collator('zh-CN').compare(a, b)` of the host. ECMA-402 (20.1.1)
/// defines `a.localeCompare(b, 'zh-CN')` as exactly that comparison, so the
/// host's answer is the TypeScript's answer on the same engine.
#[cfg(all(target_arch = "wasm32", not(feature = "icu-collation")))]
fn host_compare(a: &str, b: &str) -> std::cmp::Ordering {
    #[link(wasm_import_module = "seu_host")]
    unsafe extern "C" {
        /// Compares two UTF-8 strings of this module's memory as
        /// `Intl.Collator('zh-CN').compare` does: below, at or above zero.
        fn host_collate(a_ptr: *const u8, a_len: u32, b_ptr: *const u8, b_len: u32) -> i32;
    }
    // SAFETY: both strings are live and valid UTF-8 for the call; the host only reads them.
    // A length fits u32: usize is 32 bits on wasm32.
    let sign = unsafe { host_collate(a.as_ptr(), a.len() as u32, b.as_ptr(), b.len() as u32) };
    sign.cmp(&0)
}

/// INDEX field as one w:p per cached entry line, sorted as `localeCompare(b, 'zh-CN')` sorts
pub fn generate_index_field_xml(terms: &[String]) -> Vec<String> {
    let mut unique: Vec<&str> = Vec::new();
    for term in terms {
        let t = trim(term);
        if !t.is_empty() && !unique.contains(&t) {
            unique.push(t);
        }
    }
    if unique.is_empty() {
        return Vec::new();
    }
    // Array.prototype.sort is stable, as is sort_by
    #[cfg(feature = "icu-collation")]
    {
        let collator = zh_cn_collator();
        unique.sort_by(|a, b| collator.compare(a, b));
    }
    #[cfg(not(feature = "icu-collation"))]
    unique.sort_by(|a, b| host_compare(a, b));
    let begin = "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r>\
                 <w:r><w:instrText xml:space=\"preserve\"> INDEX \\c \"2\" </w:instrText></w:r>\
                 <w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>";
    let end = "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>";
    let p_pr = "<w:pPr><w:tabs><w:tab w:val=\"right\" w:leader=\"dot\" w:pos=\"4300\"/></w:tabs>\
                <w:rPr><w:noProof/></w:rPr></w:pPr>";
    let last_index = unique.len() - 1;
    unique
        .iter()
        .enumerate()
        .map(|(i, term)| {
            format!(
                "<w:p>{p_pr}{}<w:r><w:rPr><w:noProof/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>\
                 <w:r><w:rPr><w:noProof/></w:rPr><w:tab/></w:r>{}</w:p>",
                if i == 0 { begin } else { "" },
                escape_xml_text(term),
                if i == last_index { end } else { "" },
            )
        })
        .collect()
}
