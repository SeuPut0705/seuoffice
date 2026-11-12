//! align.ts, dgm-hier.ts, smartart-layout.ts and format-brush.ts of the
//! slides engine, called as `<module>.<TypeScript name>`.

use std::collections::HashMap;

use jscompat::JsNum;
use pptx_engine::align::{AlignRect, align_rects, distribute_rects};
use pptx_engine::dgm_hier::{
    HierConstraints, HierTreeNode, layout_hier_tree, parse_hier_constraints,
};
use pptx_engine::format_brush::{CopiedFormat, TextElement, apply_format, extract_format};
use pptx_engine::smartart_layout::{SMARTART_PALETTE, layout_shapes};
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// A box of `layoutHierTree` with its node as the caller passed it: the
/// TypeScript returns the node object itself, every key of it.
#[derive(Serialize)]
struct WireBox<'a> {
    node: &'a Value,
    x: JsNum,
    y: JsNum,
    w: JsNum,
    h: JsNum,
}

/// A line of `layoutHierTree`; `to` is the node object itself, present only
/// where the TypeScript spreads it in.
#[derive(Serialize)]
struct WireLine<'a> {
    x: JsNum,
    y: JsNum,
    cx: JsNum,
    cy: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<&'a Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireHierLayout<'a> {
    boxes: Vec<WireBox<'a>>,
    lines: Vec<WireLine<'a>>,
    box_w: JsNum,
}

/// Pairs each parsed node with the JSON it came from.
fn index_nodes<'a>(
    node: &'a HierTreeNode,
    source: &'a Value,
    into: &mut HashMap<*const HierTreeNode, &'a Value>,
) {
    into.insert(std::ptr::from_ref(node), source);
    if let Some(children) = source.get("children").and_then(Value::as_array) {
        for (child, child_source) in node.children.iter().zip(children) {
            index_nodes(child, child_source, into);
        }
    }
}

fn layout_hier_tree_call(text: &str, args: &Value) -> Returned {
    let roots: Vec<HierTreeNode> = required(args, "roots")?;
    let sources = args
        .get("roots")
        .and_then(Value::as_array)
        .ok_or("the roots argument is not a list")?;
    let mut nodes = HashMap::new();
    for (root, source) in roots.iter().zip(sources) {
        index_nodes(root, source, &mut nodes);
    }
    let cons: HierConstraints = match arg(args, "cons")? {
        Some(cons) => cons,
        None => parse_hier_constraints(Some(text)),
    };
    let frame_cx: f64 = required(args, "frameCx")?;
    let frame_cy: f64 = required(args, "frameCy")?;
    let Some(geo) = layout_hier_tree(&roots, cons, frame_cx, frame_cy) else {
        return value(Value::Null);
    };
    let boxes = geo
        .boxes
        .iter()
        .map(|b| {
            nodes
                .get(&std::ptr::from_ref(b.node))
                .map(|&node| WireBox {
                    node,
                    x: b.x,
                    y: b.y,
                    w: b.w,
                    h: b.h,
                })
                .ok_or_else(|| "a box of a node not in the roots".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let lines = geo
        .lines
        .iter()
        .map(|ln| {
            let to = match ln.to {
                Some(node) => Some(
                    nodes
                        .get(&std::ptr::from_ref(node))
                        .copied()
                        .ok_or_else(|| "a line to a node not in the roots".to_owned())?,
                ),
                None => None,
            };
            Ok(WireLine {
                x: ln.x,
                y: ln.y,
                cx: ln.cx,
                cy: ln.cy,
                to,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    value(WireHierLayout {
        boxes,
        lines,
        box_w: geo.box_w,
    })
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "align.alignRects" => {
            let rects: Vec<AlignRect> = required(args, "rects")?;
            let kind: String = required(args, "kind")?;
            let container: Option<AlignRect> = arg(args, "containerRect")?;
            value(align_rects(&rects, &kind, container))
        }
        "align.distributeRects" => {
            let rects: Vec<AlignRect> = required(args, "rects")?;
            let kind: String = required(args, "kind")?;
            value(distribute_rects(&rects, &kind))
        }
        "dgm-hier.parseHierConstraints" => {
            let undefined: Option<bool> = arg(args, "undefined")?;
            value(parse_hier_constraints(
                (undefined != Some(true)).then_some(text),
            ))
        }
        "dgm-hier.layoutHierTree" => layout_hier_tree_call(text, args),
        "smartart-layout.layoutShapes" => {
            let layout: String = required(args, "layout")?;
            let items: Vec<String> = required(args, "items")?;
            let cx: f64 = required(args, "cx")?;
            let cy: f64 = required(args, "cy")?;
            value(layout_shapes(&layout, &items, cx, cy))
        }
        "smartart-layout.SMARTART_PALETTE" => {
            let index: f64 = required(args, "index")?;
            // an array index: a whole number from 0 (or -0) below the length
            let found = (index.fract() == 0.0 && index >= 0.0)
                .then(|| SMARTART_PALETTE.get(index as usize))
                .flatten();
            optional(found)
        }
        "format-brush.extractFormat" => {
            let el: TextElement = required(args, "el")?;
            value(extract_format(&el))
        }
        "format-brush.applyFormat" => {
            let fmt: CopiedFormat = required(args, "fmt")?;
            let target_type: Option<String> = arg(args, "targetType")?;
            value(apply_format(&fmt, target_type.as_deref().unwrap_or("")))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
