//! Group math: packages/docx-engine/src/math.ts against crates/omml, and the
//! round trips through both directions, each side composed of its own
//! functions. LaTeX converted to OMML goes into `<m:oMath>` before it is read
//! again, as every caller of `latexToOmml` in the product does.

use omml::{
    latex_to_omml, math_paragraph_xml, math_tokens_of, omml_ends_with_break, omml_fragments_of,
    omml_to_latex, omml_to_mathml,
};
use serde_json::Value;

use super::{Returned, arg, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "ommlFragmentsOf" => value(omml_fragments_of(text)),
        "ommlEndsWithBreak" => value(omml_ends_with_break(text)),
        "mathTokensOf" => value(math_tokens_of(text)),
        "ommlToMathML" => value(omml_to_mathml(text)),
        "ommlToLatex" => value(omml_to_latex(text)),
        "latexToOmml" => value(latex_to_omml(text).map_err(|error| error.to_string())?),
        "mathParagraphXml" => {
            let align: Option<String> = arg(args, "align")?;
            value(math_paragraph_xml(text, align.as_deref()))
        }
        // null where the OMML has no LaTeX form
        "roundTripFromOmml" => value(
            omml_to_latex(text)
                .map(|latex| latex_to_omml(&latex))
                .transpose()
                .map_err(|error| error.to_string())?,
        ),
        "roundTripFromLatex" => {
            let omml = latex_to_omml(text).map_err(|error| error.to_string())?;
            value(omml_to_latex(&format!("<m:oMath>{omml}</m:oMath>")))
        }
        "mathMLFromLatex" => {
            let omml = latex_to_omml(text).map_err(|error| error.to_string())?;
            value(omml_to_mathml(&format!("<m:oMath>{omml}</m:oMath>")))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
