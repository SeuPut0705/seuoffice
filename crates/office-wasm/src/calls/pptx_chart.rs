//! chart.ts and chartex.ts of the slides engine, called as `<module>.<TypeScript
//! name>`. The chart part arrives as `text`, the theme as `args.theme` (the
//! JSON of what the real `parseTheme` returned). `resolveFill` is a function
//! and cannot cross: `args.resolveFill: "stub"` stands for the resolver of
//! tools/pptx-diff/calls-chart.ts (`stubFill`), the same rule on both sides.

use pptx_engine::chart::parse_chart_xml;
use pptx_engine::chartex::parse_chart_ex_xml;
use pptx_engine::theme::Theme;
use pptx_engine::types::{Fill, GradientFill, ImageFill, PatternFill};
use serde_json::Value;

use super::{Returned, arg, value};

/// `String(value ?? '')`
fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => jscompat::value_to_string(Some(other)),
    }
}

/// `stubFill` of calls-chart.ts: a fill for each fill element, by presence.
fn stub_fill(sp_pr: Option<&Value>) -> Option<Fill> {
    let sp = sp_pr?.as_object()?;
    if sp.contains_key("a:noFill") {
        return Some(Fill::None);
    }
    if let Some(blip) = sp.get("a:blipFill") {
        let embed = blip
            .as_object()
            .and_then(|b| b.get("a:blip"))
            .and_then(Value::as_object)
            .and_then(|b| b.get("@_r:embed"));
        return Some(Fill::Image(ImageFill {
            media_ref: string_or_empty(embed),
            mode: None,
            alpha: None,
            fill_rect: None,
            duotone: None,
            clr_change: None,
            lum: None,
            bi_level: None,
            tile: None,
        }));
    }
    if let Some(patt) = sp.get("a:pattFill") {
        let prst = patt.as_object().and_then(|p| p.get("@_prst"));
        return Some(Fill::Pattern(PatternFill {
            fg: "#000000".to_owned(),
            bg: "#FFFFFF".to_owned(),
            preset: string_or_empty(prst),
        }));
    }
    if sp.contains_key("a:gradFill") {
        return Some(Fill::Gradient(GradientFill {
            stops: Vec::new(),
            angle: None,
            scaled: None,
            path: None,
            fill_to: None,
            tile_rect: None,
        }));
    }
    None
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "chart.parseChartXml" => {
            let theme: Option<Theme> = arg(args, "theme")?;
            let stub: Option<String> = arg(args, "resolveFill")?;
            let resolve: &dyn Fn(Option<&Value>) -> Option<Fill> = &stub_fill;
            let resolve_fill = (stub.as_deref() == Some("stub")).then_some(resolve);
            value(parse_chart_xml(text, theme.as_ref(), resolve_fill)?)
        }
        "chartex.parseChartExXml" => {
            let theme: Option<Theme> = arg(args, "theme")?;
            value(parse_chart_ex_xml(text, theme.as_ref())?)
        }
        _ => Err(format!("unknown function {function}")),
    }
}
