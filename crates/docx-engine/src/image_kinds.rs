//! The image predicates of packages/docx-engine/src/tiff.ts and metafile.ts
//! that need no canvas: which MIME types are TIFF or metafiles, and whether
//! TIFF dimensions fit the pixel budget.
//!
//! Not ported: the decoders `tiffToDataUrl`, `tiffToDataUrlAsync` (UTIF and a
//! canvas) and `metafileToDataUrl` (the vendored EMF/WMF converter and a
//! canvas). They stay with the host.

/// `TIFF_MIMES`
const TIFF_MIMES: [&str; 3] = ["image/tiff", "image/tif", "image/x-tiff"];

/// `isTiffMime`
pub fn is_tiff_mime(mime: Option<&str>) -> bool {
    mime.is_some_and(|mime| TIFF_MIMES.contains(&mime))
}

/// `MAX_TIFF_PIXELS`: a 1200 dpi Letter or 600 dpi A3 scan.
const MAX_TIFF_PIXELS: f64 = 150_000_000.0;
/// `MAX_TIFF_DIM`: the canvas edge limit.
const MAX_TIFF_DIM: f64 = 16384.0;

/// `Number.isInteger`
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `tiffDimsOk`. Its arguments are `unknown`: `None` stands for any value
/// whose `typeof` is not `number`.
pub fn tiff_dims_ok(width: Option<f64>, height: Option<f64>) -> bool {
    let (Some(width), Some(height)) = (width, height) else {
        return false;
    };
    is_integer(width)
        && is_integer(height)
        && width > 0.0
        && height > 0.0
        && width <= MAX_TIFF_DIM
        && height <= MAX_TIFF_DIM
        && width * height <= MAX_TIFF_PIXELS
}

/// `EMF_MIMES`, `WMF_MIMES`, `EMZ_MIMES` and `WMZ_MIMES` in that order.
const METAFILE_MIMES: [&str; 8] = [
    "image/emf",
    "image/x-emf",
    "image/wmf",
    "image/x-wmf",
    "image/emz",
    "image/x-emz",
    "image/wmz",
    "image/x-wmz",
];

/// `isMetafileMime`
pub fn is_metafile_mime(mime: Option<&str>) -> bool {
    mime.is_some_and(|mime| METAFILE_MIMES.contains(&mime))
}

/// `MAX_METAFILE_GUNZIP_BYTES`: decompression bombs must not exhaust memory.
pub const MAX_METAFILE_GUNZIP_BYTES: f64 = 64.0 * 1024.0 * 1024.0;
