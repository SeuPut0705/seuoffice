//! patch.ts and its helpers, ported: `save_docx` writes a model back into the
//! original package. Three slices, each its own module here: `save` (the
//! entry, its phases, the revision/bookmark/relationship allocators and the
//! small helpers), `parts` and `features`.

pub mod features;
pub mod parts;
#[allow(clippy::module_inception)]
pub mod save;
