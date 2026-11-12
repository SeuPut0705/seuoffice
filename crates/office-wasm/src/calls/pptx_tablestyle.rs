//! table-style.ts of the slides engine, called as `table-style.<TypeScript
//! name>`, as tools/pptx-diff/calls-tablestyle.ts calls it. A theme arrives
//! as `args.theme`, the JSON of what the real `parseTheme` returned; a style
//! definition as `args.def`, the JSON of what `resolveTableStyle` returned.

use pptx_engine::table_style::{
    BUILTIN_TABLE_STYLES, LEGACY_NO_STYLE, TableStyleDef, TableStyleFlags,
    builtin_table_style_name, cell_part_style, cell_style_borders, resolve_builtin_table_style_id,
    resolve_table_style,
};
use pptx_engine::theme::Theme;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// `items[index]` of a JavaScript array: an element only at an integer
/// index inside it.
fn element_at<T>(items: &[T], index: f64) -> Option<&T> {
    if index >= 0.0 && index.fract() == 0.0 && index < items.len() as f64 {
        items.get(index as usize)
    } else {
        None
    }
}

/// The position arguments of `cellStyleBorders` and `cellPartStyle`.
struct Cell {
    def: TableStyleDef,
    flags: TableStyleFlags,
    r: f64,
    c: f64,
    n_rows: f64,
    n_cols: f64,
}

fn cell(args: &Value) -> Result<Cell, String> {
    Ok(Cell {
        def: required(args, "def")?,
        flags: required(args, "flags")?,
        r: required(args, "r")?,
        c: required(args, "c")?,
        n_rows: required(args, "nRows")?,
        n_cols: required(args, "nCols")?,
    })
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "table-style.BUILTIN_TABLE_STYLES" => optional(element_at(
            BUILTIN_TABLE_STYLES.as_slice(),
            required(args, "index")?,
        )),
        "table-style.BUILTIN_TABLE_STYLES.length" => {
            let mut count = 0_u32;
            for style in BUILTIN_TABLE_STYLES.iter() {
                let family = serde_json::to_value(style.family).map_err(|e| e.to_string())?;
                if text.is_empty() || family.as_str() == Some(text) {
                    count += 1;
                }
            }
            value(count)
        }
        "table-style.LEGACY_NO_STYLE" => {
            optional((text == "LEGACY_NO_STYLE").then_some(LEGACY_NO_STYLE))
        }
        "table-style.builtinTableStyleName" => {
            let undefined: Option<bool> = arg(args, "undefined")?;
            optional(builtin_table_style_name(
                (undefined != Some(true)).then_some(text),
            ))
        }
        "table-style.resolveBuiltinTableStyleId" => optional(resolve_builtin_table_style_id(text)),
        "table-style.resolveTableStyle" => {
            let style_id: Option<String> = arg(args, "styleId")?;
            let no_xml: Option<bool> = arg(args, "noXml")?;
            let theme: Option<Theme> = arg(args, "theme")?;
            optional(resolve_table_style(
                style_id.as_deref(),
                (no_xml != Some(true)).then_some(text),
                theme.as_ref(),
            ))
        }
        "table-style.cellStyleBorders" => {
            let Cell {
                def,
                flags,
                r,
                c,
                n_rows,
                n_cols,
            } = cell(args)?;
            value(cell_style_borders(&def, &flags, r, c, n_rows, n_cols))
        }
        "table-style.cellPartStyle" => {
            let Cell {
                def,
                flags,
                r,
                c,
                n_rows,
                n_cols,
            } = cell(args)?;
            value(cell_part_style(&def, &flags, r, c, n_rows, n_cols))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
