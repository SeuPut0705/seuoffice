//! placeholder.ts of the slides engine, called as `placeholder.<TypeScript
//! name>`, as tools/pptx-diff/calls-placeholder.ts calls it. A theme arrives
//! as `args.theme`, the JSON of what the real `parseTheme` returned; a media
//! map as a list of `[rId, path]` pairs. A node is taken by `args.name` from
//! `text`, parsed as parse.ts parses it, or as placeholder.ts does where
//! `args.parser` is `placeholder`. The layers of a placeholder are the
//! placeholder maps of `text` (the layout, or the master where `args.textIs`
//! is `master`) and of `args.masterXml` / `args.layoutXml`.

use jscompat::{JsMap, JsNum};
use ooxml_xml::ObjectOptions;
use pptx_engine::placeholder::{
    LstStyleSource, MAX_AUTO_NUM_START, MasterTextStyles, PlaceholderMap, TextStyleLevels,
    merge_text_style_chain, parse_def_r_pr_style, parse_default_text_style, parse_lst_style_levels,
    parse_master_text_styles, parse_placeholder_map, placeholder_style_chain,
    resolve_placeholder_anchor, resolve_placeholder_anchor_ctr, resolve_placeholder_fill_sp_pr,
    resolve_placeholder_insets, resolve_placeholder_preset_geom, resolve_placeholder_transform,
};
use pptx_engine::theme::Theme;
use pptx_engine::xml_utils::xml_parse_object as parse_object;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// `isArray` of the parser of packages/pptx-engine/src/parse.ts, which
/// parses the `a:lstStyle` and `a:defRPr` nodes parse.ts hands over.
const PARSE_ARRAY_NAMES: [&str; 12] = [
    "a:p",
    "a:r",
    "a:br",
    "a:fld",
    "p:sp",
    "p:pic",
    "p:graphicFrame",
    "p:grpSp",
    "p:cxnSp",
    "a:tr",
    "a:tc",
    "a:gridCol",
];

/// `isArray` of `phParser` of placeholder.ts.
const PH_ARRAY_NAMES: [&str; 3] = ["p:sp", "p:graphicFrame", "p:pic"];

/// The node `args.name` of `text`.
fn node_of(text: &str, args: &Value) -> Result<Option<Value>, String> {
    let parser: Option<String> = arg(args, "parser")?;
    let options = if parser.as_deref() == Some("placeholder") {
        ObjectOptions {
            trim_values: true,
            parse_tag_value: true,
            array_names: &PH_ARRAY_NAMES,
        }
    } else {
        ObjectOptions {
            trim_values: false,
            parse_tag_value: false,
            array_names: &PARSE_ARRAY_NAMES,
        }
    };
    let tree = parse_object(text, &options).map_err(|error| error.to_string())?;
    let name: String = required(args, "name")?;
    Ok(tree.get(name.as_str()).cloned())
}

/// `new Map(args[key])`
fn media_rels(args: &Value, key: &str) -> Result<Option<JsMap<String>>, String> {
    let pairs: Option<Vec<(String, String)>> = arg(args, key)?;
    Ok(pairs.map(|pairs| {
        let mut map = JsMap::new();
        for (id, path) in pairs {
            map.set(id, path);
        }
        map
    }))
}

/// The layers a placeholder of a slide inherits from, as index.ts reads them.
struct Layers {
    layout: Option<PlaceholderMap>,
    master: Option<PlaceholderMap>,
    master_tx: Option<MasterTextStyles>,
    r#type: Option<String>,
    idx: Option<String>,
}

fn layers_of(text: &str, args: &Value) -> Result<Layers, String> {
    let theme: Option<Theme> = arg(args, "theme")?;
    let text_is: Option<String> = arg(args, "textIs")?;
    let master_text = text_is.as_deref() == Some("master");
    let layout_arg: Option<String> = arg(args, "layoutXml")?;
    let master_arg: Option<String> = arg(args, "masterXml")?;
    let layout_xml = if master_text {
        layout_arg.as_deref()
    } else {
        Some(text)
    };
    let master_xml = if master_text {
        Some(text)
    } else {
        master_arg.as_deref()
    };
    let layout_media = media_rels(args, "layoutMediaRels")?;
    let master_media = media_rels(args, "masterMediaRels")?;
    let no_tx: Option<bool> = arg(args, "noTx")?;
    Ok(Layers {
        layout: layout_xml
            .map(|xml| parse_placeholder_map(xml, theme.as_ref(), layout_media.as_ref())),
        master: master_xml
            .map(|xml| parse_placeholder_map(xml, theme.as_ref(), master_media.as_ref())),
        master_tx: master_xml
            .filter(|_| no_tx != Some(true))
            .map(|xml| parse_master_text_styles(xml, theme.as_ref(), master_media.as_ref())),
        r#type: arg(args, "type")?,
        idx: arg(args, "idx")?,
    })
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "placeholder.constants" => {
            let name: String = required(args, "name")?;
            match name.as_str() {
                "MAX_AUTO_NUM_START" => value(JsNum(MAX_AUTO_NUM_START)),
                _ => Err(format!("no constant {name}")),
            }
        }
        "placeholder.parsePlaceholderMap" => {
            let theme: Option<Theme> = arg(args, "theme")?;
            let media = media_rels(args, "mediaRels")?;
            value(parse_placeholder_map(text, theme.as_ref(), media.as_ref()))
        }
        "placeholder.parseDefRPrStyle" => {
            let node = node_of(text, args)?;
            let theme: Option<Theme> = arg(args, "theme")?;
            let ph_clr: Option<String> = arg(args, "phClr")?;
            optional(parse_def_r_pr_style(
                node.as_ref(),
                theme.as_ref(),
                ph_clr.as_deref(),
            ))
        }
        "placeholder.parseLstStyleLevels" => {
            let node = node_of(text, args)?;
            let theme: Option<Theme> = arg(args, "theme")?;
            let media = media_rels(args, "mediaRels")?;
            let no_src: Option<bool> = arg(args, "noSrc")?;
            let foreign_part: Option<bool> = arg(args, "foreignPart")?;
            let src = (no_src != Some(true)).then(|| LstStyleSource {
                media_rels: media.as_ref(),
                foreign_part: foreign_part == Some(true),
            });
            optional(parse_lst_style_levels(
                node.as_ref(),
                theme.as_ref(),
                src.as_ref(),
            ))
        }
        "placeholder.parseDefaultTextStyle" => {
            let theme: Option<Theme> = arg(args, "theme")?;
            optional(parse_default_text_style(text, theme.as_ref()))
        }
        "placeholder.parseMasterTextStyles" => {
            let theme: Option<Theme> = arg(args, "theme")?;
            let media = media_rels(args, "mediaRels")?;
            value(parse_master_text_styles(
                text,
                theme.as_ref(),
                media.as_ref(),
            ))
        }
        "placeholder.resolvePlaceholderInsets" => {
            let l = layers_of(text, args)?;
            optional(resolve_placeholder_insets(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        "placeholder.resolvePlaceholderAnchor" => {
            let l = layers_of(text, args)?;
            optional(resolve_placeholder_anchor(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        "placeholder.resolvePlaceholderAnchorCtr" => {
            let l = layers_of(text, args)?;
            optional(resolve_placeholder_anchor_ctr(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        "placeholder.placeholderStyleChain" => {
            let l = layers_of(text, args)?;
            value(placeholder_style_chain(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.master_tx.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        "placeholder.mergeTextStyleChain" => {
            let chain: Vec<Option<TextStyleLevels>> = required(args, "chain")?;
            let level: f64 = required(args, "level")?;
            optional(merge_text_style_chain(&chain, level))
        }
        "placeholder.resolvePlaceholderFillSpPr" => {
            let l = layers_of(text, args)?;
            optional(resolve_placeholder_fill_sp_pr(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        "placeholder.resolvePlaceholderTransform" => {
            let l = layers_of(text, args)?;
            optional(resolve_placeholder_transform(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        "placeholder.resolvePlaceholderPresetGeom" => {
            let l = layers_of(text, args)?;
            optional(resolve_placeholder_preset_geom(
                l.layout.as_ref(),
                l.master.as_ref(),
                l.r#type.as_deref(),
                l.idx.as_deref(),
            ))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
