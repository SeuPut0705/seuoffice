//! `apps/markdown/src/main/recovery.ts` is `apps/html/src/main/recovery.ts`
//! byte for byte ("change one, change the other"), so there is one
//! implementation: [`crate::html::recovery`]. The comparison runs both
//! TypeScript files against it, so a later divergence of either copy shows.

pub use crate::html::recovery::*;
