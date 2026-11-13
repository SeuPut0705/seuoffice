//! `page/sectpr.ts`: `w:sectPr` markup for the bridge docx, and carrying it in
//! a paragraph.

use jscompat::{js_regex, number_to_string};
use serde::Deserialize;

use super::geometry::{Columns, PageGeometry};

/// `SectPrSpec`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectPrSpec {
    /// `w:headerReference` / `w:footerReference` elements
    pub references: Vec<String>,
    pub continuous: bool,
    pub geometry: PageGeometry,
    /// overrides the layout's columns (a `text:section`'s own columns)
    #[serde(default)]
    pub columns: Option<ColumnsSpec>,
    pub page_number: PageNumberSpec,
    pub title_pg: bool,
}

/// The `columns` of a `SectPrSpec`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ColumnsSpec {
    pub count: f64,
    pub gap: f64,
}

impl From<Columns> for ColumnsSpec {
    fn from(c: Columns) -> Self {
        ColumnsSpec {
            count: c.count.0,
            gap: c.gap.0,
        }
    }
}

/// The `pageNumber` of a `SectPrSpec`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PageNumberSpec {
    #[serde(default)]
    pub fmt: Option<String>,
    #[serde(default)]
    pub start: Option<f64>,
}

/// `buildSectPr`: a `w:sectPr` in CT_SectPr child order.
pub fn build_sect_pr(spec: &SectPrSpec) -> String {
    let g = &spec.geometry;
    let n = |x: jscompat::JsNum| number_to_string(x.0);
    let mut out = String::from("<w:sectPr>");
    out.push_str(&spec.references.concat());
    if spec.continuous {
        out.push_str("<w:type w:val=\"continuous\"/>");
    }
    out.push_str(&format!(
        "<w:pgSz w:w=\"{}\" w:h=\"{}\"{}/>",
        n(g.width),
        n(g.height),
        if g.landscape {
            " w:orient=\"landscape\""
        } else {
            ""
        }
    ));
    out.push_str(&format!(
        "<w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"{}\" w:footer=\"{}\" w:gutter=\"0\"/>",
        n(g.top),
        n(g.right),
        n(g.bottom),
        n(g.left),
        n(g.header),
        n(g.footer)
    ));
    let fmt = &spec.page_number.fmt;
    let start = spec.page_number.start;
    if fmt.is_some() || start.is_some() {
        out.push_str("<w:pgNumType");
        if let Some(fmt) = fmt {
            out.push_str(&format!(" w:fmt=\"{fmt}\""));
        }
        if let Some(start) = start {
            out.push_str(&format!(" w:start=\"{}\"", number_to_string(start)));
        }
        out.push_str("/>");
    }
    let cols = spec.columns.unwrap_or(ColumnsSpec {
        count: g.columns.0,
        gap: g.column_gap.0,
    });
    if cols.count > 1.0 {
        out.push_str(&format!(
            "<w:cols w:num=\"{}\" w:space=\"{}\"/>",
            number_to_string(cols.count),
            number_to_string(cols.gap)
        ));
    }
    if spec.title_pg {
        out.push_str("<w:titlePg/>");
    }
    out.push_str("</w:sectPr>");
    out
}

fn sect_pr_regex() -> &'static jscompat::JsRegex {
    js_regex!(r"<w:sectPr(?:\s[^>]*)?\/>|<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>")
}

/// `injectParagraphSectPr`: puts `sect_pr` into the paragraph's `w:pPr`
/// (creating one when missing).
pub fn inject_paragraph_sect_pr(paragraph_xml: &str, sect_pr: &str) -> String {
    let Some(open) = js_regex!(r"^<w:p(?:\s[^>]*)?>").exec(paragraph_xml) else {
        return paragraph_xml.to_owned();
    };
    let at = open.end();
    let rest = &paragraph_xml[at..];
    if let Some(after) = rest.strip_prefix("<w:pPr/>") {
        return format!(
            "{}<w:pPr>{}</w:pPr>{}",
            &paragraph_xml[..at],
            sect_pr,
            after
        );
    }
    if js_regex!(r"^<w:pPr[\s>]").test(rest)
        && let Some(close) = rest.find("</w:pPr>")
    {
        return format!(
            "{}{}{}{}",
            &paragraph_xml[..at],
            &rest[..close],
            sect_pr,
            &rest[close..]
        );
    }
    format!("{}<w:pPr>{}</w:pPr>{}", &paragraph_xml[..at], sect_pr, rest)
}

/// `paragraphSectPr`: the paragraph-level `w:sectPr` of a body element.
pub fn paragraph_sect_pr(xml: &str) -> Option<String> {
    if !js_regex!(r"^<w:p[\s>]").test(xml) {
        return None;
    }
    let p_pr = js_regex!(r"^<w:p(?:\s[^>]*)?><w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>").exec(xml)?;
    sect_pr_regex()
        .exec(p_pr.get(1)?)
        .map(|m| m.as_str().to_owned())
}

/// `stripParagraphSectPr`: removes the paragraph-level `w:sectPr` (and a
/// `w:pPr` left empty by it).
pub fn strip_paragraph_sect_pr(xml: &str) -> String {
    let Some(sect) = paragraph_sect_pr(xml) else {
        return xml.to_owned();
    };
    let at = xml.find(&sect).unwrap_or(0);
    let out = format!("{}{}", &xml[..at], &xml[at + sect.len()..]);
    match js_regex!(r"^(<w:p(?:\s[^>]*)?>)<w:pPr><\/w:pPr>").exec(&out) {
        Some(m) => format!("{}{}", m.get(1).unwrap_or(""), &out[m.end()..]),
        None => out,
    }
}

/// `stripPPrSectPr`: a `w:pPr` string without its `w:sectPr` (`None` when
/// nothing else remains).
pub fn strip_p_pr_sect_pr(p_pr: Option<&str>) -> Option<String> {
    let p_pr = p_pr?;
    if !p_pr.contains("<w:sectPr") {
        return Some(p_pr.to_owned());
    }
    let out = match sect_pr_regex().exec(p_pr) {
        Some(m) => format!("{}{}", &p_pr[..m.start()], &p_pr[m.end()..]),
        None => p_pr.to_owned(),
    };
    if js_regex!(r"^<w:pPr(?:\s[^>]*)?>\s*<\/w:pPr>$").test(&out) {
        None
    } else {
        Some(out)
    }
}
