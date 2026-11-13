//! `apps/shell/src/main/generate/limits.ts`: the generate window's adjustable
//! values, in one place.

/// 8.7 "long material": text length of all materials together, above which slides/html warn
pub const LONG_MATERIAL_NOTICE_CHARS: f64 = 8_000.0;

/// 8.7 "usage": the text length of all materials together above which the
/// window warns that the run will use a lot of the plan's limit
pub const USAGE_NOTICE_CHARS: f64 = 100_000.0;

/// materials one request can carry
pub const MAX_MATERIALS: usize = 20;

/// one material's size cap: the editors' existing attachment cap
pub const MAX_MATERIAL_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// every receiving editor refuses images above this size
pub const MAX_IMAGE_MATERIAL_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

/// input guard on the request text crossing IPC; not a product rule
pub const MAX_REQUEST_TEXT_CHARS: usize = 32_000;
