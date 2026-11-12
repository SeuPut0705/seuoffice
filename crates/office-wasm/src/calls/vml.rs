//! `vml.*`: the shape readers of parse-vml.ts under their TypeScript names.
//! The helpers the watermark readers stand on are in group `section`.

use docx_engine::props::XML_PARSER_MAX_NESTED_TAGS;
use docx_engine::vml::Dim;
use docx_engine::vml::shape::{
    self, Coord, VML_PICT_RID_RE, VML_PICT_RID_SOURCE, VML_WORDART_RE, VML_WORDART_SOURCE,
    VmlGroupScale, VmlOrigin,
};
use docx_engine::vml::word_art;
use jscompat::JsNum;
use ooxml_xml::{XNode, parse_ordered};
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// A regular expression as `{ source, flags }`.
#[derive(Serialize)]
struct Pattern {
    source: &'static str,
    flags: &'static str,
}

/// The exported constants of parse-vml.ts this group holds, by name.
fn constant(name: &str) -> Returned {
    match name {
        "VML_WORDART_RE" => value(Pattern {
            source: VML_WORDART_SOURCE,
            flags: "",
        }),
        "VML_PICT_RID_RE" => value(Pattern {
            source: VML_PICT_RID_SOURCE,
            flags: "",
        }),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constants" => constant(&required::<String>(args, "name")?),
        "VML_WORDART_RE" => value(VML_WORDART_RE.test(text)),
        "VML_PICT_RID_RE" => value(VML_PICT_RID_RE.test(text)),
        "vmlGroupScale" => {
            // the top-level element of `text` named `args.node`, as the
            // TypeScript side picks it from `xmlParser.parse(text)`
            let nodes = parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS)
                .map_err(|error| error.to_string())?;
            let wanted: Option<String> = arg(args, "node")?;
            let group = wanted
                .as_deref()
                .and_then(|wanted| nodes.iter().find(|node| node.name() == Some(wanted)))
                .ok_or("attrsOf(undefined) throws")?;
            let parent_scale: Option<VmlGroupScale> = arg(args, "parentScale")?;
            value(shape::vml_group_scale(group, parent_scale))
        }
        "vmlCoordPx" => {
            let key: Coord = required(args, "key")?;
            let scale: VmlGroupScale = required(args, "scale")?;
            let origin: VmlOrigin = required(args, "origin")?;
            value(JsNum(shape::vml_coord_px(text, key, scale, origin)))
        }
        "vmlPathToNormD" => {
            // null is NaN, which JSON cannot carry
            let cw: f64 = arg(args, "cw")?.unwrap_or(f64::NAN);
            let ch: f64 = arg(args, "ch")?.unwrap_or(f64::NAN);
            optional(shape::vml_path_to_norm_d(text, cw, ch))
        }
        "vmlShapeDimPx" => {
            let key: Dim = required(args, "key")?;
            let scale: Option<VmlGroupScale> = arg(args, "scale")?;
            optional(shape::vml_shape_dim_px(text, key, scale).map(JsNum))
        }
        "vmlShapeTypeTable" => value(shape::vml_shape_type_table(text)),
        "vmlShapeSvg" => {
            let types: Option<String> = arg(args, "types")?;
            let table = types.as_deref().map(shape::vml_shape_type_table);
            value(shape::vml_shape_svg(text, table.as_ref()))
        }
        "vmlWordArtBox" => {
            // `nodeOf(text, args) ?? {}`: the element `args.node` of `text`
            let nodes = parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS)
                .map_err(|error| error.to_string())?;
            let wanted: Option<String> = arg(args, "node")?;
            let empty = XNode::empty();
            let shape = wanted
                .as_deref()
                .and_then(|wanted| nodes.iter().find(|node| node.name() == Some(wanted)))
                .unwrap_or(&empty);
            value(word_art::vml_word_art_box(shape))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
