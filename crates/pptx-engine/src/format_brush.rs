//! Format painter (packages/pptx-engine/src/format-brush.ts): what is copied
//! from a text or shape element, and what applying it to a target changes.
//!
//! `Fill`, `Stroke` and `ResolvedColor` are carried as the JSON they are,
//! since nothing here reads inside them. The model port replaces the element
//! structs below.

use jscompat::value_truthy;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// A key that is present, `null` included: `Some(Value::Null)` for `null`,
/// `None` (by `#[serde(default)]`) where the key is absent.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// What `extractFormat` reads of a `TextElement`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TextElement {
    #[serde(rename = "type", default, deserialize_with = "present")]
    pub r#type: Option<Value>,
    pub fill: Option<Value>,
    pub stroke: Option<Value>,
    pub adjust: Option<Map<String, Value>>,
    pub text: Option<TextBody>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TextBody {
    pub paragraphs: Option<Vec<Paragraph>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Paragraph {
    pub runs: Option<Vec<TextRun>>,
    pub align: Option<Value>,
}

/// The run fields copied; `None` is `null` or absent, the `!= null` test.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub font_family: Option<Value>,
    pub font_size: Option<Value>,
    pub bold: Option<Value>,
    pub italic: Option<Value>,
    pub underline: Option<Value>,
    pub color: Option<Value>,
}

/// `ShapeFormat`. `fill` and `stroke` keep a `null` (`Some(Value::Null)`):
/// `applyFormat` tests them against `undefined` only.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ShapeFormat {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjust: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParagraphFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Value>,
}

/// `CopiedFormat`. `run` is a `TextRunFormat` as the object it is: its keys
/// in the order they were set, and `applyFormat` passes it on whole.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedFormat {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_type: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<ShapeFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<ParagraphFormat>,
}

/// `FormatPatchResult`. `stroke` as `Some(Value::Null)` removes the stroke.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatPatchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_format: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Value>,
}

/// `extractFormat`: the write-back-able format of a text or shape element.
pub fn extract_format(el: &TextElement) -> CopiedFormat {
    let mut shape = ShapeFormat::default();
    if value_truthy(el.fill.as_ref()) {
        shape.fill = el.fill.clone();
    }
    if value_truthy(el.stroke.as_ref()) {
        shape.stroke = el.stroke.clone();
    }
    if let Some(adjust) = el.adjust.as_ref().filter(|adjust| !adjust.is_empty()) {
        shape.adjust = Some(adjust.clone());
    }

    let mut run = Map::new();
    let mut para = ParagraphFormat::default();

    let first_para = el
        .text
        .as_ref()
        .and_then(|text| text.paragraphs.as_ref())
        .and_then(|paragraphs| paragraphs.first());
    if let Some(first_para) = first_para {
        if value_truthy(first_para.align.as_ref()) {
            para.align = first_para.align.clone();
        }
        let first_run = first_para.runs.as_ref().and_then(|runs| runs.first());
        if let Some(first_run) = first_run {
            let fields = [
                ("fontFamily", &first_run.font_family),
                ("fontSize", &first_run.font_size),
                ("bold", &first_run.bold),
                ("italic", &first_run.italic),
                ("underline", &first_run.underline),
                ("color", &first_run.color),
            ];
            for (key, field) in fields {
                if let Some(v) = field {
                    run.insert(key.to_owned(), v.clone());
                }
            }
        }
    }

    let shape_empty = shape.fill.is_none() && shape.stroke.is_none() && shape.adjust.is_none();
    CopiedFormat {
        source_type: el.r#type.clone(),
        shape: (!shape_empty).then_some(shape),
        run: (!run.is_empty()).then_some(run),
        paragraph: para.align.is_some().then_some(para),
    }
}

/// `applyFormat`: what changes on a target of `target_type`. A picture takes
/// the stroke only; any other target takes fill, stroke, run and alignment.
pub fn apply_format(fmt: &CopiedFormat, target_type: &str) -> FormatPatchResult {
    let mut result = FormatPatchResult::default();
    let shape = fmt.shape.as_ref();

    if target_type == "picture" {
        if let Some(stroke) = shape.and_then(|shape| shape.stroke.as_ref()) {
            result.stroke = Some(stroke.clone());
        }
        return result;
    }

    if let Some(fill) = shape.and_then(|shape| shape.fill.as_ref()) {
        result.fill = Some(fill.clone());
    }
    if let Some(stroke) = shape.and_then(|shape| shape.stroke.as_ref()) {
        result.stroke = Some(stroke.clone());
    }
    if let Some(run) = fmt.run.as_ref().filter(|run| !run.is_empty()) {
        result.run_format = Some(run.clone());
    }
    let align = fmt.paragraph.as_ref().and_then(|p| p.align.as_ref());
    if value_truthy(align) {
        result.align = align.cloned();
    }

    result
}
