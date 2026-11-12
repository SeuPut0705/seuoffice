//! `apps/pdf/src/main/export-images.ts`: the file names of the page images a
//! PDF exports.

use crate::packages::electron_utils::numbered_export_paths::numbered_export_paths;
use jscompat::node_path::host;
use jscompat::{JsRegex, JsonValue, js_regex, to_primitive};

/// What the TypeScript throws (`error.message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportError(pub String);

/// `Number.isSafeInteger(value) && value > 0`
fn valid_page_number(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(x)
            if x.is_finite()
                && x.fract() == 0.0
                && x.abs() <= 9_007_199_254_740_991.0
                && *x > 0.0 =>
        {
            Some(*x)
        }
        _ => None,
    }
}

pub fn is_valid_export_page_number(value: &JsonValue) -> bool {
    valid_page_number(value).is_some()
}

pub fn has_valid_export_page_numbers(value: &JsonValue, expected_length: f64) -> bool {
    let JsonValue::Array(items) = value else {
        return false;
    };
    if items.len() as f64 != expected_length {
        return false;
    }
    let mut seen: Vec<f64> = Vec::with_capacity(items.len());
    for item in items {
        match valid_page_number(item) {
            Some(n) => seen.push(n),
            None => return false,
        }
    }
    // duplicate pages would write two exports over one target file
    seen.sort_by(f64::total_cmp);
    seen.windows(2).all(|pair| pair[0] != pair[1])
}

fn illegal_name_chars() -> &'static JsRegex {
    js_regex!(r#"[/\\:*?"<>|]"#, "g")
}

/// `baseName` is `unknown` in the TypeScript: `String(baseName || 'page')`.
pub fn build_export_image_paths(
    dir: &str,
    base_name: Option<&JsonValue>,
    page_numbers: &[JsonValue],
    ext: &str,
) -> Result<Vec<String>, ExportError> {
    let root = host::resolve(&[dir]);
    let named = match base_name {
        Some(value) if value.truthy() => to_primitive(Some(value))
            .map_err(|e| ExportError(e.0))?
            .to_js_string(),
        _ => "page".to_owned(),
    };
    let safe_base = illegal_name_chars().replace_all(&named, |_| "_".to_owned());
    let mut out = Vec::with_capacity(page_numbers.len());
    for page_number in page_numbers {
        let Some(page_number) = valid_page_number(page_number) else {
            return Err(ExportError("pdf: invalid page numbers".to_owned()));
        };
        let name = format!(
            "{safe_base}-p{}.{ext}",
            jscompat::number_to_string(page_number)
        );
        let target = host::join(&[&root, &name]);
        let from_root = host::relative(&root, &target);
        if from_root.is_empty()
            || from_root == ".."
            || from_root.starts_with(&format!("..{}", host::SEP))
            || host::is_absolute(&from_root)
        {
            return Err(ExportError("pdf: invalid export path".to_owned()));
        }
        out.push(target);
    }
    Ok(out)
}

/// Save As > PNG page images: the files written for the one name the shell's
/// save dialog picked. `None` when the target is not an absolute .png path.
pub fn build_save_as_image_paths(
    target: &str,
    count: f64,
) -> Result<Option<Vec<String>>, crate::packages::electron_utils::numbered_export_paths::RangeError>
{
    if !host::is_absolute(target) || !js_regex!(r"\.png$", "i").test(target) {
        return Ok(None);
    }
    numbered_export_paths(target, count).map(Some)
}
