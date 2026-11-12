//! `drawing.<name>`: parse-drawing-geometry.ts. A function over a node takes
//! the XML text and the name of the top-level element in `args.node`; the
//! theme crosses as `args.theme` (`ThemeColors`), a section as the w:sectPr
//! text both sides read with `sectionSettingsFromXml`.

use docx_engine::drawing_geometry::anchor::{self, DrawingAnchorMeta, GroupCtm};
use docx_engine::drawing_geometry::{fill, line_box};
use docx_engine::props::XML_PARSER_MAX_NESTED_TAGS;
use docx_engine::section::{SectionSettings, section_settings_from_xml};
use docx_engine::theme::ThemeColors;
use jscompat::JsNum;
use ooxml_xml::{XNode, parse_ordered};
use serde_json::{Value, json};

use super::{Returned, arg, optional, required, value};

/// The top-level element of `text` named `args.node`, as the TypeScript side
/// picks it from `xmlParser.parse(text)`; `Err` where the parser refuses.
// to calls/mod.rs: the same helper as `with_node` of resolve.rs
fn with_node(text: &str, args: &Value, call: impl FnOnce(Option<&XNode>) -> Returned) -> Returned {
    let nodes =
        parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    let wanted: Option<String> = arg(args, "node")?;
    let node = wanted
        .as_deref()
        .and_then(|wanted| nodes.iter().find(|node| node.name() == Some(wanted)));
    call(node)
}

/// `nodeOf(text, args) ?? {}`
fn with_element(text: &str, args: &Value, call: impl FnOnce(&XNode) -> Returned) -> Returned {
    with_node(text, args, |node| match node {
        Some(node) => call(node),
        None => call(&XNode::empty()),
    })
}

/// `args.noSection === true ? undefined : sectionSettingsFromXml(text)`
fn section(text: &str, args: &Value) -> Result<Option<SectionSettings>, String> {
    let no_section: Option<bool> = arg(args, "noSection")?;
    Ok((no_section != Some(true)).then(|| section_settings_from_xml(text, None)))
}

/// The exported constants, by name: a regex as `{source, flags}`, a Set as its
/// sorted values.
fn constant(name: &str) -> Returned {
    match name {
        "LINE_PRSTS_RE" => value(json!({ "source": anchor::LINE_PRSTS_RE_SOURCE, "flags": "" })),
        "LINE_PRSTS" => {
            let mut prsts = anchor::LINE_PRSTS;
            prsts.sort_unstable();
            value(prsts)
        }
        "EMU_PER_TWIP" => value(JsNum(anchor::EMU_PER_TWIP)),
        "MIN_WRAP_SLIVER_EMU" => value(JsNum(anchor::MIN_WRAP_SLIVER_EMU)),
        "DEFAULT_WRAP_DIST_EMU" => value(JsNum(anchor::DEFAULT_WRAP_DIST_EMU)),
        "IDENTITY_CTM" => value(anchor::IDENTITY_CTM),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let theme = || arg::<ThemeColors>(args, "theme");
    match function {
        "constants" => constant(&required::<String>(args, "name")?),
        "colorNodeHex" => {
            let theme = theme()?;
            with_node(text, args, |node| {
                optional(fill::color_node_hex(node, theme.as_ref()))
            })
        }
        "solidFillAlpha" => with_node(text, args, |node| {
            optional(fill::solid_fill_alpha(node).map(JsNum))
        }),
        "topLevelDrawings" => value(anchor::top_level_drawings(text)),
        "drawingAnchorMeta" => value(anchor::drawing_anchor_meta(text)),
        "resolveAnchorPagePos" => {
            let meta: DrawingAnchorMeta = required(args, "meta")?;
            let sect = section(text, args)?;
            value(anchor::resolve_anchor_page_pos(&meta, sect.as_ref()))
        }
        "resolveAnchorPageYEmu" => {
            let meta: DrawingAnchorMeta = required(args, "meta")?;
            let sect = section(text, args)?;
            optional(anchor::resolve_anchor_page_y_emu(&meta, sect.as_ref()).map(JsNum))
        }
        "gradFillApproxHex" => {
            let theme = theme()?;
            with_element(text, args, |sp_pr| {
                optional(fill::grad_fill_approx_hex(sp_pr, theme.as_ref()))
            })
        }
        "w14TextFillHex" => {
            let theme = theme()?;
            with_element(text, args, |r_pr| {
                optional(fill::w14_text_fill_hex(r_pr, theme.as_ref()))
            })
        }
        "w14GlowOf" => {
            let theme = theme()?;
            with_element(text, args, |r_pr| {
                optional(fill::w14_glow_of(r_pr, theme.as_ref()))
            })
        }
        "composeGroupCtm" => {
            let outer: GroupCtm = required(args, "outer")?;
            with_element(text, args, |group| {
                value(anchor::compose_group_ctm(group, &outer))
            })
        }
        "lineBoxOf" => {
            let theme = theme()?;
            with_element(text, args, |shape| {
                value(line_box::line_box_of(shape, theme.as_ref()))
            })
        }
        _ => Err(format!("no function {function}")),
    }
}
