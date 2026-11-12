//! `apps/slides/src/main/ai-default-fonts.ts`: the fonts AI slide generation
//! uses when the request names none (Settings, General, written by the
//! shell). Read from `userData/app-settings.json` on every call, so a change
//! applies to the next generation without a restart.

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, json_parse};

use crate::packages::ai_provider::jsval::{Obj, as_record, as_str, length16, prop, spread, text};
use crate::packages::ui::{
    SLIDES_AI_FONTS_KEY, SlidesAiFontRoles, SlidesAiFonts, normalize_slides_ai_fonts,
};

/// `SettingsPathProvider`: the subset of Electron's `app` this module needs.
pub trait SettingsPathProvider {
    /// `app.getPath('userData')`
    fn user_data_path(&self) -> String;
}

/// `readSlidesAiFonts(app, lang)`: the stored choice, or the default for
/// `lang` when the file or the key is missing or unreadable.
pub fn read_slides_ai_fonts(app: &dyn SettingsPathProvider, lang: &str) -> SlidesAiFonts {
    let path = join(&[app.user_data_path().as_str(), "app-settings.json"]);
    let parsed = fs::read(&path)
        .ok()
        // readFileSync(path, 'utf8'): ill-formed bytes become U+FFFD, a BOM stays
        .and_then(|bytes| json_parse(&String::from_utf8_lossy(&bytes)).ok());
    match parsed {
        Some(raw) => {
            let value = as_record(&raw).and_then(|o| o.get(SLIDES_AI_FONTS_KEY));
            normalize_slides_ai_fonts(value, lang)
        }
        None => normalize_slides_ai_fonts(None, lang),
    }
}

/// `TITLE_ROLE_MIN_PT`: text at or above this size takes the title family.
pub const TITLE_ROLE_MIN_PT: f64 = 28.0;

/// `fillMissingRunFonts(spec, roles)`: gives every run the page writer left
/// without a font the configured family, by size: titles get the title
/// family, the rest the body family. A run that names a font keeps it. Runs
/// with no size count as body text. A page spec is a JSON value; an element
/// whose `paragraphs`, or a paragraph whose `runs`, is not a list is left as
/// it is (the TypeScript throws a `TypeError` there).
pub fn fill_missing_run_fonts(spec: &JsonValue, roles: &SlidesAiFontRoles) -> JsonValue {
    let Some(spec_obj) = as_record(spec) else {
        return spec.clone();
    };
    let Some(JsonValue::Array(elements)) = spec_obj.get("elements") else {
        return spec.clone();
    };
    let mut changed = false;
    let mut fill_paragraphs = |paragraphs: &[JsonValue]| -> Vec<JsonValue> {
        paragraphs
            .iter()
            .map(|p| {
                let Some(JsonValue::Array(runs)) = prop(p, "runs") else {
                    return p.clone();
                };
                let runs: Vec<JsonValue> = runs
                    .iter()
                    .map(|r| {
                        if prop(r, "font").is_some_and(JsonValue::truthy) {
                            return r.clone();
                        }
                        changed = true;
                        let title = matches!(prop(r, "sizePt"), Some(JsonValue::Number(x)) if *x >= TITLE_ROLE_MIN_PT);
                        let mut run = spread(Some(r));
                        run.set(
                            "font",
                            text(if title { roles.title.as_str() } else { roles.body.as_str() }),
                        );
                        JsonValue::Object(run)
                    })
                    .collect();
                let mut paragraph = spread(Some(p));
                paragraph.set("runs", JsonValue::Array(runs));
                JsonValue::Object(paragraph)
            })
            .collect()
    };
    let elements: Vec<JsonValue> = elements
        .iter()
        .map(|el| {
            let is_image = as_str(prop(el, "type")) == Some("image");
            match prop(el, "paragraphs") {
                Some(JsonValue::Array(paragraphs)) if !is_image => {
                    let mut next = spread(Some(el));
                    next.set("paragraphs", JsonValue::Array(fill_paragraphs(paragraphs)));
                    JsonValue::Object(next)
                }
                _ => el.clone(),
            }
        })
        .collect();
    if !changed {
        return spec.clone();
    }
    let mut next: Obj = spec_obj.clone();
    next.set("elements", JsonValue::Array(elements));
    JsonValue::Object(next)
}

/// `parseFontRoles(value)`: the roles an IPC caller sent, or `None` when they
/// are not two usable family names.
pub fn parse_font_roles(value: &JsonValue) -> Option<SlidesAiFontRoles> {
    // `!value || typeof value !== 'object'`
    if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let name = |x: Option<&JsonValue>| -> Option<String> {
        let t = as_str(x)?;
        let trimmed = jscompat::trim(t);
        (!trimmed.is_empty() && length16(t) <= 80).then(|| trimmed.to_owned())
    };
    let title = name(prop(value, "title"))?;
    let body = name(prop(value, "body"))?;
    Some(SlidesAiFontRoles { title, body })
}
