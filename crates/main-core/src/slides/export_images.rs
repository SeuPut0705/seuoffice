//! `apps/slides/src/main/export-images.ts`.

use jscompat::node_path::host::join;
use jscompat::pad_start;

/// `buildExportImagePaths(dir, baseName, count, ext)`. `count` is a number:
/// `Array.from({ length })` takes its integer part, and NaN is no length.
pub fn build_export_image_paths(dir: &str, base_name: &str, count: f64, ext: &str) -> Vec<String> {
    let pad = if count >= 100.0 { 3 } else { 2 };
    // Math.max(0, count): NaN stays NaN, which ToLength makes 0
    let length = if count.is_nan() { 0.0 } else { count.max(0.0) };
    let length = length.trunc() as u64;
    (0..length)
        .map(|i| {
            let name = format!(
                "{base_name}-{}.{ext}",
                pad_start(&(i + 1).to_string(), pad, '0')
            );
            join(&[dir, &name])
        })
        .collect()
}
