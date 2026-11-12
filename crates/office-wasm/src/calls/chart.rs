//! `chart.<name>`: the read side of chart.ts. `parseChartPartXml` takes the
//! part text, `args.partPath` and `args.theme` (`ThemeColors`); the colour
//! helpers take `args.hex` and their factors, a null factor standing for NaN.
//! `constants` answers `args.name`.

use docx_engine::chart;
use docx_engine::theme::ThemeColors;
use jscompat::JsNum;
use serde_json::Value;

use super::{Returned, arg, required, value};

/// A number argument; null stands for NaN, which JSON cannot carry.
fn number(args: &Value, key: &str) -> Result<f64, String> {
    Ok(arg::<JsNum>(args, key)?.map_or(f64::NAN, |n| n.0))
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constants" => match required::<String>(args, "name")?.as_str() {
            "DEFAULT_FRAME_LINE" => value(chart::DEFAULT_FRAME_LINE),
            "MAX_CHART_CACHE_POINTS" => value(JsNum(chart::MAX_CHART_CACHE_POINTS)),
            "MAX_CHART_SERIES" => value(chart::MAX_CHART_SERIES),
            "LEGEND_POSITIONS" => value(chart::LEGEND_POSITIONS),
            "GRAYSCALE_PALETTE" => value(chart::GRAYSCALE_PALETTE),
            name => Err(format!("no constant {name}")),
        },
        "parseChartPartXml" => value(chart::parse_chart_part_xml(
            text,
            &required::<String>(args, "partPath")?,
            arg::<ThemeColors>(args, "theme")?.as_ref(),
        )?),
        "shadeHex" => value(chart::shade_hex(
            &required::<String>(args, "hex")?,
            number(args, "factor")?,
        )),
        "tintHex" => value(chart::tint_hex(
            &required::<String>(args, "hex")?,
            number(args, "factor")?,
        )),
        "lumHex" => value(chart::lum_hex(
            &required::<String>(args, "hex")?,
            number(args, "mod")?,
            number(args, "off")?,
        )),
        _ => Err(format!("no function {function}")),
    }
}
