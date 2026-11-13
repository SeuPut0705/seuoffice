//! `packages/font-metrics/src`: what the main process reads of the installed
//! fonts' own tables. `family_info` is `family-info.ts`, `metrics` is
//! `metrics.ts` and `sfnt` the parts of `sfnt.ts` that `pdf::font_locate`
//! (which holds the table readers and the font index) does not have.

pub mod family_info;
pub mod metrics;
pub mod sfnt;
