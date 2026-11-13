//! `apps/shell/src/main/mcp/pptx-outline.ts`: headless pptx generation for the
//! MCP server: outline -> op sequence.
//!
//! Pure functions over data. The ops use the canonical `@seuoffice/pptx-ops`
//! vocabulary and are handed to the `seuoffice` CLI (`create --type pptx
//! --ops`), so this module carries only the ergonomic outline-to-ops adapter.
//!
//! Outline convention (markdown):
//!   `# Title`   starts a new slide (the text after `#` is its title)
//!   `## Text`   a bold body line on the current slide
//!   `- Text`    a bullet (indent with two leading spaces per level)
//!   `1. Text`   a numbered bullet
//!   plain line  a body paragraph without a bullet
//!
//! The JSON format is `{ slides: [{ title, bullets }] }` with the same pieces:
//! `bullets` entries are bullets (a bare string gets a character bullet, and an
//! entry may name `bullet: "number"`), while `paragraphs` is plain text.

use jscompat::{JsObject, JsonValue, js_regex, json_parse, trim};

use super::tools::session_tools::js_object;

/// `PptxSourceFormat`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PptxSourceFormat {
    Markdown,
    Json,
}

/// `OutlineParagraph['bullet']`: char = `•` bullet, number = `1.` bullet
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutlineBullet {
    Char,
    Number,
}

/// `OutlineParagraph`
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineParagraph {
    pub text: String,
    /// absent = plain paragraph
    pub bullet: Option<OutlineBullet>,
    /// nesting level for bullets (0-based); markdown indentation maps here
    pub level: Option<f64>,
    /// bold body line (markdown `##`)
    pub bold: Option<bool>,
}

impl OutlineParagraph {
    fn plain(text: &str) -> Self {
        OutlineParagraph {
            text: text.to_owned(),
            bullet: None,
            level: None,
            bold: None,
        }
    }
}

/// `OutlineSlide`
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineSlide {
    pub title: Option<String>,
    pub paragraphs: Vec<OutlineParagraph>,
}

/// standard 16:9 title placeholder in document-space EMU (matches createBlankPptx): x, y, cx, cy
const TITLE: [f64; 4] = [914_400.0, 685_800.0, 10_363_200.0, 1_127_760.0];
/// the body placeholder
const BODY: [f64; 4] = [914_400.0, 2_057_400.0, 10_363_200.0, 4_114_800.0];
/// PowerPoint's default bullet geometry per level (marL/indent EMU)
const BULLET_STEP: f64 = 342_900.0;

pub const MAX_OUTLINE_SLIDES: usize = 100;

/// `parsePptxOutline(format, content)`: parse an outline in the given format
/// into slides; `Err` is the guided message of what it throws.
pub fn parse_pptx_outline(
    format: PptxSourceFormat,
    content: &str,
) -> Result<Vec<OutlineSlide>, String> {
    match format {
        PptxSourceFormat::Json => parse_json_outline(content),
        PptxSourceFormat::Markdown => Ok(parse_markdown_outline(content)),
    }
}

fn parse_json_outline(raw: &str) -> Result<Vec<OutlineSlide>, String> {
    let parsed = json_parse(raw).map_err(|error| {
        format!(
            "outline must be valid JSON when format is \"json\": {}",
            error.message()
        )
    })?;
    // `Array.isArray(parsed) ? parsed : parsed?.slides`
    let list = match &parsed {
        JsonValue::Array(items) => Some(items.clone()),
        other => match other.get("slides").as_deref() {
            Some(JsonValue::Array(items)) => Some(items.clone()),
            _ => None,
        },
    };
    let Some(list) = list else {
        return Err("outline JSON must be an array of slides or { slides: [...] }".to_owned());
    };
    let mut slides = Vec::new();
    for (index, entry) in list.iter().enumerate() {
        if let JsonValue::String(text) = entry {
            slides.push(OutlineSlide {
                title: None,
                paragraphs: vec![OutlineParagraph::plain(text)],
            });
            continue;
        }
        if !matches!(entry, JsonValue::Object(_) | JsonValue::Array(_)) {
            return Err(format!("slide {index} must be an object or a string"));
        }
        // an array entry has none of the three keys
        let field = |key: &str| match entry {
            JsonValue::Object(_) => entry.get(key).map(|value| value.into_owned()),
            _ => None,
        };
        // A `bullets` array means bullets: a bare string entry defaults to a
        // character bullet, the same as the markdown `- item` form. `paragraphs` is
        // the plain-text spelling and keeps no bullet.
        let bullets = field("bullets");
        let is_bullets = matches!(bullets, Some(JsonValue::Array(_)));
        let raw_bullets: Vec<JsonValue> = match (bullets, field("paragraphs")) {
            (Some(JsonValue::Array(items)), _) => items,
            (_, Some(JsonValue::Array(items))) => items,
            _ => Vec::new(),
        };
        let title = match field("title") {
            Some(JsonValue::String(title)) if !trim(&title).is_empty() => {
                Some(trim(&title).to_owned())
            }
            _ => None,
        };
        let mut paragraphs = Vec::new();
        for b in &raw_bullets {
            if let JsonValue::String(text) = b {
                paragraphs.push(OutlineParagraph {
                    text: text.clone(),
                    bullet: is_bullets.then_some(OutlineBullet::Char),
                    level: None,
                    bold: None,
                });
                continue;
            }
            // `bl?.text`: only an object has the keys
            let get = |key: &str| match b {
                JsonValue::Object(_) => b.get(key).map(|value| value.into_owned()),
                _ => None,
            };
            let Some(JsonValue::String(text)) = get("text") else {
                return Err(format!(
                    "slide {index}: each bullet needs a \"text\" string"
                ));
            };
            let bullet = match get("bullet") {
                Some(JsonValue::String(kind)) if kind == "number" => Some(OutlineBullet::Number),
                Some(JsonValue::String(kind)) if kind == "char" => Some(OutlineBullet::Char),
                _ => is_bullets.then_some(OutlineBullet::Char),
            };
            let level = match get("level") {
                Some(JsonValue::Number(level)) if level.fract() == 0.0 && level > 0.0 => {
                    Some(level)
                }
                _ => None,
            };
            let bold = (get("bold") == Some(JsonValue::Bool(true))).then_some(true);
            paragraphs.push(OutlineParagraph {
                text,
                bullet,
                level,
                bold,
            });
        }
        slides.push(OutlineSlide { title, paragraphs });
    }
    Ok(slides)
}

/// the number of UTF-16 code units of a string
fn length16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Math.min(Math.floor(indent.length / 2), 4)`
fn indent_level(indent: &str) -> f64 {
    ((length16(indent) / 2).min(4)) as f64
}

fn parse_markdown_outline(raw: &str) -> Vec<OutlineSlide> {
    let mut slides: Vec<OutlineSlide> = Vec::new();
    let mut current: Option<OutlineSlide> = None;
    for line in js_regex!(r"\r?\n").split(raw) {
        if let Some(heading) = js_regex!(r"^(#{1,6})\s+(.*)$").exec(line) {
            let depth = length16(heading.get(1).unwrap_or(""));
            let text = trim(heading.get(2).unwrap_or(""));
            if depth == 1 {
                if let Some(done) = current.take() {
                    slides.push(done);
                }
                current = Some(OutlineSlide {
                    title: (!text.is_empty()).then(|| text.to_owned()),
                    paragraphs: Vec::new(),
                });
            } else if let Some(slide) = current.as_mut()
                && !text.is_empty()
            {
                slide.paragraphs.push(OutlineParagraph {
                    text: text.to_owned(),
                    bullet: None,
                    level: None,
                    bold: Some(true),
                });
            }
            continue;
        }
        let item = |found: jscompat::JsMatch<'_>, bullet: OutlineBullet| {
            let level = indent_level(found.get(1).unwrap_or(""));
            OutlineParagraph {
                text: found.get(2).unwrap_or("").to_owned(),
                bullet: Some(bullet),
                level: (level != 0.0).then_some(level),
                bold: None,
            }
        };
        if let Some(found) = js_regex!(r"^(\s*)[-*]\s+(.*)$").exec(line) {
            current
                .get_or_insert_with(empty_slide)
                .paragraphs
                .push(item(found, OutlineBullet::Char));
            continue;
        }
        if let Some(found) = js_regex!(r"^(\s*)\d+[.)]\s+(.*)$").exec(line) {
            current
                .get_or_insert_with(empty_slide)
                .paragraphs
                .push(item(found, OutlineBullet::Number));
            continue;
        }
        let text = trim(line);
        if text.is_empty() {
            continue;
        }
        current
            .get_or_insert_with(empty_slide)
            .paragraphs
            .push(OutlineParagraph::plain(text));
    }
    if let Some(done) = current.take() {
        slides.push(done);
    }
    slides
}

fn empty_slide() -> OutlineSlide {
    OutlineSlide {
        title: None,
        paragraphs: Vec::new(),
    }
}

fn num(value: f64) -> JsonValue {
    JsonValue::Number(value)
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

/// `{ x, y, cx, cy }`
fn offset(box_: [f64; 4]) -> JsonValue {
    js_object(vec![
        ("x", num(box_[0])),
        ("y", num(box_[1])),
        ("cx", num(box_[2])),
        ("cy", num(box_[3])),
    ])
}

/// `{ slide: n }`
fn slide_target(slide: usize) -> JsonValue {
    js_object(vec![("slide", num(slide as f64))])
}

/// `outlineToOps(slides)`: map parsed slides to one flat op sequence.
///
/// The CLI applies ops one by one to a blank one-slide deck, and later ops can
/// target slides earlier ops added, so a single array is enough: create the
/// extra pages first, then fill every page.
pub fn outline_to_ops(slides: &[OutlineSlide]) -> Result<Vec<JsonValue>, String> {
    if slides.is_empty() {
        return Err(
            "outline produced no slides \u{2014} add at least one \"# Slide title\" (or JSON entry)"
                .to_owned(),
        );
    }
    if slides.len() > MAX_OUTLINE_SLIDES {
        return Err(format!(
            "outline has {} slides; the limit is {MAX_OUTLINE_SLIDES}",
            slides.len()
        ));
    }
    let mut ops: Vec<JsonValue> = Vec::new();
    for index in 1..slides.len() {
        ops.push(js_object(vec![
            ("op", text("addBlankSlide")),
            ("target", slide_target(index - 1)),
        ]));
    }
    for (index, slide) in slides.iter().enumerate() {
        if let Some(title) = slide.title.as_deref().filter(|title| !title.is_empty()) {
            let run = js_object(vec![
                ("text", text(title)),
                ("bold", JsonValue::Bool(true)),
                ("fontSize", num(36.0)),
            ]);
            let paragraph = js_object(vec![
                ("runs", JsonValue::Array(vec![run])),
                ("align", text("left")),
            ]);
            ops.push(textbox(index, TITLE, vec![paragraph]));
        }
        if !slide.paragraphs.is_empty() {
            let paragraphs = slide.paragraphs.iter().map(body_paragraph).collect();
            ops.push(textbox(index, BODY, paragraphs));
        }
    }
    Ok(ops)
}

/// an `addElement` textbox op
fn textbox(slide: usize, box_: [f64; 4], paragraphs: Vec<JsonValue>) -> JsonValue {
    js_object(vec![
        ("op", text("addElement")),
        ("target", slide_target(slide)),
        ("kind", text("textbox")),
        ("offset", offset(box_)),
        ("paragraphs", JsonValue::Array(paragraphs)),
        ("bodyPr", js_object(vec![("autoFit", text("shrink"))])),
    ])
}

/// `bodyParagraph(p)`
fn body_paragraph(p: &OutlineParagraph) -> JsonValue {
    let mut run = JsObject::new();
    run.set("text", text(&p.text));
    run.set("fontSize", num(20.0));
    if p.bold == Some(true) {
        run.set("bold", JsonValue::Bool(true));
    }
    let runs = JsonValue::Array(vec![JsonValue::Object(run)]);
    let mut out = JsObject::new();
    out.set("runs", runs);
    let Some(bullet) = p.bullet else {
        if p.bold != Some(true) {
            out.set("align", text("left"));
        }
        return JsonValue::Object(out);
    };
    let level = p.level.unwrap_or(0.0);
    out.set(
        "bullet",
        match bullet {
            OutlineBullet::Number => js_object(vec![
                ("type", text("number")),
                ("numType", text("arabicPeriod")),
            ]),
            OutlineBullet::Char => {
                js_object(vec![("type", text("char")), ("char", text("\u{2022}"))])
            }
        },
    );
    out.set("marL", num(BULLET_STEP * (level + 1.0)));
    out.set("indent", num(-BULLET_STEP));
    if level != 0.0 {
        out.set("level", num(level));
    }
    JsonValue::Object(out)
}
