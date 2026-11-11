//! The `props` command: calls exported functions of parse-props.ts (and of the
//! helpers it stands on) under their TypeScript names.
//!
//! A reply carries `value` where the TypeScript function returns a value,
//! nothing where it returns `undefined`, and `error` where it throws.

use docx_engine::props::{self, CharIndents, CharUnits, ParaBorderModel, ParaBorderSides, Run};
use docx_engine::styles::run_border_of;
use docx_engine::theme::{ThemeColors, ThemeFonts, resolve_theme_color};
use docx_engine::xml_text;
use jscompat::{
    JsNum, Radix, math_round, number_to_string, parse_float, parse_int, to_int32, to_number,
    to_string_radix16,
};
use ooxml_xml::{XNode, parse_ordered, serialize, serialize_element};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::cell::OnceCell;

use crate::calls::{self, Returned, optional, value};

/// The calls on one text: it crosses the wire and is parsed once.
#[derive(Deserialize)]
pub struct Input {
    /// The text argument, or the XML the node argument is parsed from.
    #[serde(default)]
    xml: String,
    calls: Vec<Call>,
}

#[derive(Deserialize)]
struct Call {
    #[serde(rename = "fn")]
    name: String,
    /// Read by the function called: a group of `calls` takes it as it is.
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Args {
    /// The top-level element of `xml` that is the node argument.
    node: Option<String>,
    name: Option<String>,
    root_tag: Option<String>,
    part: Option<String>,
    tag: Option<String>,
    with_inside: bool,
    mark_only: bool,
    besides_breaks: bool,
    cs_size_half_points: Option<f64>,
    theme: Option<ThemeColors>,
    fonts: Option<ThemeFonts>,
    ea_ref: Option<String>,
    de: Option<bool>,
    dn: Option<bool>,
    base: Option<CharIndents>,
    over: Option<CharIndents>,
    chars: Option<CharIndents>,
    format: Option<Map<String, Value>>,
    units: Option<CharUnits>,
    runs: Option<Vec<Run>>,
    sides: Option<ParaBorderSides>,
    direct: Option<ParaBorderModel>,
    theme_color: Option<String>,
    tint: Option<String>,
    shade: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Outcome {
    Value { value: Value },
    Undefined {},
    Error { error: String },
}

pub fn run(input: &Input) -> Vec<Outcome> {
    let parsed = OnceCell::new();
    input
        .calls
        .iter()
        .map(|call| {
            let returned = calls::dispatch(&call.name, &input.xml, &call.args)
                .unwrap_or_else(|| own(call, &input.xml, &parsed));
            match returned {
                Ok(Some(value)) => Outcome::Value { value },
                Ok(None) => Outcome::Undefined {},
                Err(error) => Outcome::Error { error },
            }
        })
        .collect()
}

/// `xmlParser.parse(xml)`, or why it throws.
type Parsed = OnceCell<Result<Vec<XNode>, String>>;

/// A call of a function of this module, which reads its arguments typed.
fn own(call: &Call, xml: &str, parsed: &Parsed) -> Returned {
    let args = if call.args.is_null() {
        Args::default()
    } else {
        serde_json::from_value(call.args.clone()).map_err(|error| error.to_string())?
    };
    dispatch(&call.name, &args, xml, parsed)
}

/// For a function that returns `null` where Rust has `None`.
fn nullable(result: Option<impl Serialize>) -> Returned {
    value(result)
}

fn missing(argument: &str) -> String {
    format!("the {argument} argument is missing")
}

/// A number as `String(x)` writes it, with -0 told apart.
fn exact(x: f64) -> String {
    if x == 0.0 && x.is_sign_negative() {
        "-0".to_owned()
    } else {
        number_to_string(x)
    }
}

fn dispatch(name: &str, args: &Args, xml: &str, parsed: &Parsed) -> Returned {
    let theme = args.theme.as_ref();
    let fonts = args.fonts.as_ref();

    // the functions over text
    match name {
        "staysVanished" => return value(props::stays_vanished(xml)),
        "crossParaCommentMarkers" => return value(props::cross_para_comment_markers(xml)),
        "bookmarkNamesOf" => return value(props::bookmark_names_of(xml)),
        "rawPPrOf" => return optional(props::raw_ppr_of(xml)),
        "isThinRule" => return value(props::is_thin_rule(xml)),
        "ruleDisplayOf" => return value(props::rule_display_of(xml)),
        "isInvisibleEmptyShape" => return value(props::is_invisible_empty_shape(xml)),
        "isInvisibleVmlPict" => return value(props::is_invisible_vml_pict(xml)),
        "stripTextboxes" => return value(props::strip_textboxes(xml)),
        "hostPageBreak" => return value(props::host_page_break(xml)),
        "fieldCharsBalanced" => return value(props::field_chars_balanced(xml)),
        "onlyOleFields" => return value(props::only_ole_fields(xml)),
        "fieldInstructions" => return value(props::field_instructions(xml)),
        "onlyXeFields" => return value(props::only_xe_fields(xml)),
        "rubyFragmentsOf" => return value(props::ruby_fragments_of(xml)),
        "partXmlSpacePreserve" => {
            let root_tag = args.root_tag.as_deref().ok_or_else(|| missing("rootTag"))?;
            return value(
                props::part_xml_space_preserve(xml, root_tag).map_err(|error| error.to_string())?,
            );
        }
        "convertibleHyperlink" => return nullable(props::convertible_hyperlink(xml)),
        "SIMPLE_INLINE_FIELD_RE" => return value(props::simple_inline_field().test(xml)),
        "ZOTERO_INLINE_FIELD_RE" => return value(props::zotero_inline_field().test(xml)),
        "MERGEFIELD_INSTR_RE" => {
            let found = props::mergefield_instr().exec(xml);
            return nullable(found.map(|found| [found.get(1), found.get(2)]));
        }
        "JC_ALIGN" => return optional(props::jc_align(xml)),
        "EA_LANG_DEFAULT_FONT" => return optional(props::ea_lang_default_font(xml)),
        "isOn" => return value(props::is_on(Some(xml))),
        "plainText" => return value(xml_text::plain_text(xml)),
        "mathTokens" => return value(xml_text::math_tokens(xml)),
        "decodeEntities" => return value(xml_text::decode_entities(xml)),
        "decodeNumericCharRefs" => return value(xml_text::decode_numeric_char_refs(xml)),
        "stripHash" => return value(xml_text::strip_hash(xml)),
        "lineTwipsOf" => return value(exact(xml_text::line_twips_of(Some(xml)))),
        "onOffTagIn" => {
            let name = args.name.as_deref().ok_or_else(|| missing("name"))?;
            return optional(
                xml_text::on_off_tag_in(xml, name).map_err(|error| error.to_string())?,
            );
        }
        "jsPrimitives" => {
            let number = to_number(xml);
            return value(json!({
                "parseInt10": exact(parse_int(xml, Radix::Ten)),
                "parseInt16": exact(parse_int(xml, Radix::Sixteen)),
                "parseFloat": exact(parse_float(xml)),
                "number": exact(number),
                "round": exact(math_round(number)),
                "roundOfHundredth": exact(math_round(number / 100.0)),
                "int32": to_int32(number),
                "hex": to_string_radix16(math_round(number)),
            }));
        }
        _ => {}
    }

    // the functions over model values
    match name {
        "autoSpaceMode" => return optional(props::auto_space_mode(args.de, args.dn)),
        "mergeCharIndents" => {
            return optional(props::merge_char_indents(
                args.base.clone(),
                args.over.clone(),
            ));
        }
        "activeCharIndents" => return optional(props::active_char_indents(args.chars.as_ref())),
        "resolveCharIndents" => {
            let chars = args.chars.as_ref().ok_or_else(|| missing("chars"))?;
            let units = args.units.ok_or_else(|| missing("units"))?;
            return value(props::resolve_char_indents(
                args.format.as_ref(),
                chars,
                units,
            ));
        }
        "spaceOnlyRuns" | "breakOnlyRuns" | "mergeRuns" => {
            let runs = args.runs.as_deref().ok_or_else(|| missing("runs"))?;
            let texts: Vec<&str> = runs
                .iter()
                .map(|run| run.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect();
            return match name {
                "spaceOnlyRuns" => value(props::space_only_runs(&texts)),
                "breakOnlyRuns" => value(props::break_only_runs(&texts)),
                _ => value(props::merge_runs(runs)),
            };
        }
        "themeLangEaSlotFont" => {
            let fonts = fonts.ok_or_else(|| missing("fonts"))?;
            return optional(props::theme_lang_ea_slot_font(
                fonts,
                args.ea_ref.as_deref(),
            ));
        }
        "paraBordersOf" => {
            let sides = args.sides.as_ref().ok_or_else(|| missing("sides"))?;
            return value(props::para_borders_of(sides));
        }
        "mergeStyleBorders" => {
            let sides = args.sides.as_ref().ok_or_else(|| missing("sides"))?;
            return value(props::merge_style_borders(sides, args.direct.as_ref()));
        }
        "resolveThemeColor" => {
            let theme_color = args
                .theme_color
                .as_deref()
                .ok_or_else(|| missing("themeColor"))?;
            let colors = theme.ok_or_else(|| missing("theme"))?;
            return nullable(resolve_theme_color(
                theme_color,
                colors,
                args.tint.as_deref(),
                args.shade.as_deref(),
            ));
        }
        _ => {}
    }

    // the functions over a node of the parsed text
    let nodes = parsed
        .get_or_init(|| {
            parse_ordered(xml, props::XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(String::clone)?;
    let found = args
        .node
        .as_deref()
        .and_then(|wanted| nodes.iter().find(|node| node.name() == Some(wanted)));
    let empty = XNode::empty();
    let node = found.unwrap_or(&empty);
    let serialized = |runs: Vec<props::SyntheticRun<'_>>| -> Vec<String> {
        runs.iter()
            .map(|run| serialize_element("w:r", run.attrs, &run.children))
            .collect()
    };
    match name {
        "collectNodes" | "collectTopNodes" => {
            let wanted = args.name.as_deref().ok_or_else(|| missing("name"))?;
            let mut out = Vec::new();
            if name == "collectNodes" {
                props::collect_nodes(nodes, wanted, &mut out);
            } else {
                props::collect_top_nodes(nodes, wanted, &mut out);
            }
            value(out.into_iter().map(serialize).collect::<Vec<_>>())
        }
        "allRunsVanished" => value(props::all_runs_vanished(node)),
        "hasLayoutRunContent" => {
            let pattern = if args.besides_breaks {
                props::layout_run_content_besides_breaks()
            } else {
                props::layout_run_content()
            };
            value(props::has_layout_run_content(node, pattern))
        }
        "txbxHasStructuredContent" => value(props::txbx_has_structured_content(node)),
        "autoSpaceFlagsOf" => value(props::auto_space_flags_of(node)),
        "tabStopsOf" => optional(props::tab_stops_of(node)),
        "ptabDisplayStops" => value(props::ptab_display_stops(node)),
        "checkboxStateOf" => nullable(props::checkbox_state_of(found)),
        "indentTwipsOf" => value(props::indent_twips_of(node)),
        "charIndentsOf" => optional(props::char_indents_of(found)),
        "emptyParaSizeHalfPoints" => optional(
            props::empty_para_size_half_points(
                node,
                node.find_child("w:pPr"),
                args.mark_only,
                args.cs_size_half_points,
            )
            .map(JsNum),
        ),
        "emptyParaMarkFont" => optional(props::empty_para_mark_font(
            node,
            node.find_child("w:pPr"),
            fonts,
            args.mark_only,
        )),
        "splitImageRun" => value(serialized(props::split_image_run(node))),
        "splitSymRun" => value(match props::split_sym_run(node) {
            Some(runs) => serialized(runs),
            None => vec![serialize(node)],
        }),
        "rubyPartText" => {
            let part = args.part.as_deref().ok_or_else(|| missing("part"))?;
            value(props::ruby_part_text(node, part))
        }
        "themedRFonts" => value(props::themed_r_fonts(node, fonts)),
        "shdDisplayFill" => optional(props::shd_display_fill(found, theme)),
        "rowBandSizeOf" => optional(props::row_band_size_of(found).map(JsNum)),
        "tableLookOf" => value(props::table_look_of(found)),
        "paraBorderSidesOf" => optional(props::para_border_sides_of(node, theme)),
        "mergedBorderLinesOf" => {
            let tag = args.tag.as_deref().ok_or_else(|| missing("tag"))?;
            optional(props::merged_border_lines_of(found, tag, args.with_inside))
        }
        "cellMarginsOf" => optional(props::cell_margins_of(found)),
        "colorFrom" => optional(xml_text::color_from(found, theme)),
        "autoColorOf" => optional(xml_text::auto_color_of(found)),
        "onOffOf" => {
            let child = args.name.as_deref().ok_or_else(|| missing("name"))?;
            optional(xml_text::on_off_of(node, child))
        }
        "runBorderOf" => optional(run_border_of(node)),
        _ => Err(format!("unknown function {name}")),
    }
}
