//! Display maths of a paragraph: alignment, size and the source its
//! fragments are read from.

use jscompat::{JsNum, Radix, RegexError, math_max, parse_int};

use crate::fields::tag_attr;
use crate::model::EffectivePPr;
use crate::props::strip_textboxes;
use crate::xml_tag::remove_segments;

/// `mathParaAlign`: an oMathPara follows its m:jc (Word's default
/// centerGroup, written out so the paragraph style's alignment cannot win);
/// a bare math-only paragraph is inline maths and follows the paragraph's own
/// w:jc (default left).
pub fn math_para_align(paragraph_xml: &str, p_pr: &str) -> Result<&'static str, RegexError> {
    if paragraph_xml.contains("<m:oMathPara") {
        return Ok(match tag_attr(paragraph_xml, "m:jc", "m:val")? {
            Some("left") => "left",
            Some("right") => "right",
            Some("center") => "center",
            _ => "centerGroup",
        });
    }
    Ok(match tag_attr(p_pr, "w:jc", "w:val")? {
        Some("center") => "center",
        Some("right" | "end") => "right",
        _ => "left",
    })
}

/// `mathSizeHalfPoints`: the first w:sz inside the OMML (m:r or m:ctrlPr),
/// else the paragraph mark's size resolved through its chain.
pub fn math_size_half_points(omml: &str, eff: &EffectivePPr) -> Result<JsNum, RegexError> {
    let explicit = parse_int(tag_attr(omml, "w:sz", "w:val")?.unwrap_or(""), Radix::Ten);
    if explicit.is_finite() {
        return Ok(JsNum(math_max(1.0, explicit)));
    }
    Ok(eff.mark.size_half_points)
}

/// `mathSourceXmlOf`: the paragraph's maths source without mc:Fallback and
/// w:txbxContent, which the run walk never enters, so fragment indexes stay
/// aligned with the nodes visited.
pub fn math_source_xml_of(xml: &str) -> String {
    if xml.contains("<mc:Fallback") {
        strip_textboxes(&remove_segments(xml, "mc:Fallback")).into_owned()
    } else {
        strip_textboxes(xml).into_owned()
    }
}
