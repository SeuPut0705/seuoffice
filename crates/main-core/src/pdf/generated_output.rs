//! `apps/pdf/src/main/generated-output.ts`: a safe, unused PDF path inside
//! the configured SeuOffice save directory.

use jscompat::node_path::host;
use jscompat::{JsonValue, js_regex, to_primitive, trim};

/// `existsSync(path)`
pub fn exists_sync(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// What the TypeScript throws: a `TypeError` of `String(suggestedName)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StringifyError(pub String);

/// `uniqueGeneratedPdfPath(dir, suggestedName, pathExists)`; `suggestedName`
/// is a string, `String()` of it guards anything else.
pub fn unique_generated_pdf_path(
    dir: &str,
    suggested_name: Option<&JsonValue>,
    path_exists: &dyn Fn(&str) -> bool,
) -> Result<String, StringifyError> {
    // Control characters are intentionally rejected from generated file names.
    let invalid_file_name_characters = js_regex!(r#"[/\\:*?"<>|\u0000-\u001f]"#, "g");
    let named = match suggested_name {
        Some(value) if value.truthy() => to_primitive(Some(value))
            .map_err(|e| StringifyError(e.0))?
            .to_js_string(),
        _ => "merged.pdf".to_owned(),
    };
    let colonless = js_regex!(r":", "g").replace_all(&named, |_| "_".to_owned());
    let replaced = invalid_file_name_characters
        .replace_all(&host::basename(&colonless, None), |_| "_".to_owned());
    let mut file_name = trim(&replaced).to_owned();
    if file_name.is_empty() || file_name == "." || file_name == ".." {
        file_name = "merged.pdf".to_owned();
    }
    if !js_regex!(r"\.pdf$", "i").test(&file_name) {
        file_name.push_str(".pdf");
    }

    // the last four code units are the ASCII `.pdf` in some case
    let stem = &file_name[..file_name.len() - 4];
    let mut candidate = host::join(&[dir, &file_name]);
    let mut i = 2;
    while path_exists(&candidate) {
        candidate = host::join(&[dir, &format!("{stem}-{i}.pdf")]);
        i += 1;
    }
    Ok(candidate)
}
