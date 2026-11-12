//! `packages/electron-utils/src/numbered-export-paths.ts`: one file name per
//! page beside the one the person typed.

use jscompat::{number_to_string, pad_start};

/// What the TypeScript throws (`error.message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeError(pub String);

/// `numberedExportPaths(target, count)`
pub fn numbered_export_paths(target: &str, count: f64) -> Result<Vec<String>, RangeError> {
    // Math.max(0, Math.floor(count)): NaN stays NaN
    let floored = count.floor();
    let pages = if floored.is_nan() {
        floored
    } else {
        floored.max(0.0)
    };
    if pages <= 1.0 {
        return Ok(if pages == 1.0 {
            vec![target.to_owned()]
        } else {
            Vec::new()
        });
    }
    let slash = target.rfind(['/', '\\']);
    let dot = target.rfind('.');
    // `dot > slash + 1`, with -1 for no slash
    let has_ext = match (dot, slash) {
        (Some(dot), Some(slash)) => dot > slash + 1,
        (Some(dot), None) => dot > 0,
        (None, _) => false,
    };
    let (stem, ext) = match dot {
        Some(dot) if has_ext => (&target[..dot], &target[dot..]),
        _ => (target, ""),
    };
    let width = 2.max(number_to_string(pages).len());
    // Array.from({ length: pages }): NaN is no length, more than 2^32 - 1 is no array
    if pages.is_nan() {
        return Ok(Vec::new());
    }
    if pages > 4_294_967_295.0 {
        return Err(RangeError("Invalid array length".to_owned()));
    }
    Ok((0..pages as u64)
        .map(|i| {
            format!(
                "{stem}-{}{ext}",
                pad_start(&(i + 1).to_string(), width, '0')
            )
        })
        .collect())
}
