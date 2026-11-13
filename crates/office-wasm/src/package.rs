//! The `package` and `packageParts` commands: a docx opened the way
//! `loadDocxZip` opens it, and every value `parseDocx` reads from the package
//! before it reaches the body.
//!
//! A value the TypeScript returns is `{ value }`, one it throws on is
//! `{ error }`: the readers fail one by one there, and the gate compares them
//! one by one.

use docx_engine::font_table::{FONT_TABLE_PART_PATH, parse_font_table, read_embedded_fonts};
use docx_engine::numbering::parse_numbering;
use docx_engine::package::{
    Thrown, content_types_of, parse_rels, part_text, rels_path_of, resolve_main_document_path,
    resolve_relationship_target_path,
};
use docx_engine::settings::{
    parse_comments, parse_protection, parse_remove_personal_info, parse_write_protection,
};
use docx_engine::styles::{heading_styles_of, parse_styles};
use docx_engine::theme::parse_theme;
use jscompat::js_regex;
use ooxml_pkg::{Package, load_docx_package};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct WirePart {
    name: String,
    text: String,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Opened {
    /// `loadDocxZip` throws: the message of the error.
    Refused { refused: String },
    Read {
        entries: Vec<WireEntry>,
        model: Value,
    },
}

/// One entry of `zip.files`, in key order.
#[derive(Serialize)]
pub struct WireEntry {
    name: String,
    dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    length: Option<usize>,
    /// FNV-1a, 32 bits, of the content.
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<u32>,
    /// What reading the entry throws.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}

pub fn open(bytes: &[u8]) -> Opened {
    match load_docx_package(bytes) {
        Ok(package) => read(&package),
        Err(refused) => Opened::Refused { refused },
    }
}

pub fn from_parts(parts: Vec<WirePart>) -> Opened {
    read(&Package::from_parts(
        parts.into_iter().map(|part| (part.name, part.text)),
    ))
}

fn outcome<T: Serialize>(result: Result<T, Thrown>) -> Value {
    match result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())) {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error }),
    }
}

fn read(package: &Package) -> Opened {
    let entries = package
        .parts()
        .iter()
        .map(|part| {
            let content = (!part.is_dir).then(|| part.bytes());
            WireEntry {
                name: part.name.to_string(),
                dir: part.is_dir,
                length: content
                    .as_ref()
                    .and_then(|bytes| bytes.as_ref().ok().map(|bytes| bytes.len())),
                hash: content
                    .as_ref()
                    .and_then(|bytes| bytes.as_ref().ok().map(|bytes| fnv1a(bytes))),
                error: content.and_then(|bytes| bytes.err().map(|error| error.reason)),
            }
        })
        .collect();

    let main_path = resolve_main_document_path(package);
    let document_rels = match &main_path {
        Ok(Some(path)) => outcome(parse_rels(package, &rels_path_of(path))),
        _ => Value::Null,
    };
    // every relationships part, and where each of its targets leads
    let mut relationships = Vec::new();
    let mut targets = Vec::new();
    for part in package.parts() {
        if part.is_dir || !part.name.ends_with(".rels") {
            continue;
        }
        let rels = parse_rels(package, &part.name);
        if let Ok(rels) = &rels {
            // a/_rels/b.xml.rels belongs to a/b.xml
            let source = js_regex!(r"(^|/)_rels/([^/]+)\.rels$")
                .exec(&part.name)
                .map(|found| {
                    format!(
                        "{}{}{}",
                        &part.name[..found.start()],
                        found.get(1).unwrap_or(""),
                        found.get(2).unwrap_or("")
                    )
                })
                .unwrap_or_default();
            let resolved: Vec<Option<String>> = rels
                .values()
                .map(|rel| resolve_relationship_target_path(&source, &rel.target))
                .collect();
            targets.push(json!([part.name.as_str(), source, resolved]));
        }
        relationships.push(json!([part.name.as_str(), outcome(rels)]));
    }

    let theme = parse_theme(package);
    let (theme_colors, theme_fonts) = match &theme {
        Ok(theme) => (theme.colors.as_ref(), theme.fonts.as_ref()),
        Err(_) => (None, None),
    };
    let styles = parse_styles(package, theme_colors, theme_fonts);
    let heading_styles = styles
        .as_ref()
        .map(|parsed| heading_styles_of(&parsed.styles))
        .map_err(String::clone);
    let styles = styles.map(|parsed| {
        let mut value = json!({ "styles": parsed.styles });
        if let Some(doc_defaults) = parsed.doc_defaults {
            value["docDefaults"] = json!(doc_defaults);
        }
        value
    });

    let font_table = part_text(package, FONT_TABLE_PART_PATH)
        .map(|text| text.map_or_else(Vec::new, parse_font_table));
    let embedded_fonts = match &font_table {
        Ok(font_table) => outcome(read_embedded_fonts(package, font_table).map(|fonts| {
            fonts
                .iter()
                .map(|font| {
                    // `({ data, ...font }) => ({ ...font, length, hash })`
                    let mut value = json!({
                        "family": font.family,
                        "bold": font.bold,
                        "italic": font.italic,
                    });
                    if let Some(line_metrics) = font.line_metrics {
                        value["lineMetrics"] = json!(line_metrics);
                    }
                    value["length"] = json!(font.data.len());
                    value["hash"] = json!(fnv1a(&font.data));
                    value
                })
                .collect::<Vec<_>>()
        })),
        Err(_) => Value::Null,
    };

    let model = json!({
        "mainPath": outcome(main_path),
        "documentRels": document_rels,
        "relationships": relationships,
        "targets": targets,
        "contentTypes": outcome(content_types_of(package)),
        "theme": outcome(theme.clone()),
        "styles": outcome(styles),
        "headingStyles": outcome(heading_styles),
        "numbering": outcome(parse_numbering(package)),
        "fontTable": outcome(font_table),
        "embeddedFonts": embedded_fonts,
        "comments": outcome(parse_comments(package)),
        "protection": outcome(parse_protection(package)),
        "writeProtection": outcome(parse_write_protection(package)),
        "removePersonalInfo": outcome(parse_remove_personal_info(package)),
    });
    Opened::Read { entries, model }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::open;

    /// crates/fixtures/package-layer.json, written by
    /// tools/docx-diff/write-fixtures.ts: containers built for the gate, each
    /// with what the TypeScript engine made of it.
    #[derive(Deserialize)]
    struct Fixtures {
        containers: Vec<Container>,
    }

    #[derive(Deserialize)]
    struct Container {
        name: String,
        /// The bytes, in hex.
        docx: String,
        typescript: Value,
    }

    /// What the two engines are not asked to agree on: the text of an error a
    /// reader throws (only that it throws), and the host's own words after
    /// "cannot be inflated:".
    fn comparable(value: &mut Value) {
        match value {
            Value::Object(fields) => {
                if let Some(error) = fields.get_mut("error") {
                    *error = Value::Bool(true);
                }
                if let Some(Value::String(refused)) = fields.get_mut("refused") {
                    let marker = "cannot be inflated:";
                    if let Some(at) = refused.find(marker) {
                        refused.truncate(at + marker.len());
                    }
                }
                fields.values_mut().for_each(comparable);
            }
            Value::Array(items) => items.iter_mut().for_each(comparable),
            _ => {}
        }
    }

    #[test]
    fn built_containers_open_as_the_typescript_engine_opens_them() {
        let fixtures: Fixtures = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/package-layer.json"
        )))
        .expect("the fixtures are JSON");
        assert!(
            fixtures.containers.len() >= 70,
            "the fixtures hold the containers"
        );
        let mut refused = 0;
        for container in fixtures.containers {
            let docx: Vec<u8> = (0..container.docx.len() / 2)
                .map(|at| u8::from_str_radix(&container.docx[2 * at..2 * at + 2], 16).unwrap())
                .collect();
            let mut rust = serde_json::to_value(open(&docx)).unwrap();
            let mut typescript = container.typescript;
            comparable(&mut rust);
            comparable(&mut typescript);
            refused += usize::from(typescript.get("refused").is_some());
            assert_eq!(rust, typescript, "{}", container.name);
        }
        assert!(refused >= 30, "the fixtures hold the refusals");
    }
}
