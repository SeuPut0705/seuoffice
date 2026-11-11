//! Office Math Markup (packages/docx-engine/src/math.ts): OMML to MathML Core
//! and to a LaTeX subset, and that LaTeX subset back to OMML.

mod fragments;
mod latex_to_omml;
mod mathml;
mod omml_to_latex;
mod tables;
mod xml;

pub use fragments::{math_tokens_of, omml_ends_with_break, omml_fragments_of};
pub use latex_to_omml::{LatexError, MAX_NESTING, latex_to_omml, math_paragraph_xml};
pub use mathml::omml_to_mathml;
pub use omml_to_latex::omml_to_latex;
