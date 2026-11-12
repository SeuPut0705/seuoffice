//! The OpenDocument Text bridge, ported from `packages/odt-engine`: one module
//! per TypeScript file, in the same layers. `C3-PLAN.md` is the contract the
//! port was written to.

pub mod assemble;
pub mod core;
pub mod objects;
pub mod offset;
pub mod page;
pub mod table;
pub mod text;
