//! Pure XML to value readers for paragraph, run and table-cell properties
//! (packages/docx-engine/src/parse-props.ts): no document context, no
//! recursion into block builders.

pub mod borders;
mod fields;
mod fonts;
mod indent;
mod paragraph;
mod runs;

pub use borders::*;
pub use fields::*;
pub use fonts::*;
pub use indent::*;
pub use paragraph::*;
pub use runs::*;
