//! The `orgChart` family of layoutDiagramFallback: the constraint
//! interpreter of dgm_hier, its connectors drawn as thin rects like the
//! other families.

use std::collections::HashMap;

use jscompat::math_max;

use super::{DgmFill, DgmSpOpts, DgmTreeNode, Fallback, dgm_box, fit_size_w, min_of, text_lines};
use crate::dgm_hier::{HierTreeNode, layout_hier_tree, parse_hier_constraints};

/// The tree as dgm_hier reads it. The diagram tree is at most
/// `MAX_DGM_TREE_DEPTH + 1` deep, so this recursion is bounded.
fn hier_tree(node: &DgmTreeNode<'_>) -> HierTreeNode {
    HierTreeNode {
        children: node.children.iter().map(hier_tree).collect(),
        asst: node.asst.then_some(true),
        hier_branch: node.hier_branch.clone(),
    }
}

/// Each node of the dgm_hier tree to the diagram node it was made from: a
/// laid-out box names the former, and the TypeScript reads the latter's
/// texts and color from the same object.
fn pair_nodes<'a>(
    hier: &[HierTreeNode],
    dgm: &'a [DgmTreeNode<'a>],
    out: &mut HashMap<*const HierTreeNode, &'a DgmTreeNode<'a>>,
) {
    for (h, d) in hier.iter().zip(dgm) {
        out.insert(h, d);
        pair_nodes(&h.children, &d.children, out);
    }
}

pub(super) fn org_chart(f: &mut Fallback<'_>) {
    let roots = f.roots;
    let (frame_cx, frame_cy) = (f.frame_cx, f.frame_cy);
    let cons = parse_hier_constraints(f.layout_xml);
    let hier_roots: Vec<HierTreeNode> = roots.iter().map(hier_tree).collect();
    let Some(geo) = layout_hier_tree(&hier_roots, cons, frame_cx, frame_cy) else {
        return;
    };
    let mut nodes = HashMap::new();
    pair_nodes(&hier_roots, roots, &mut nodes);
    let boxes: Vec<_> = geo
        .boxes
        .iter()
        .filter_map(|b| Some((b, *nodes.get(&std::ptr::from_ref(b.node))?)))
        .collect();
    let line_w = math_max(frame_cx * 0.0012, 9525.0);
    let line_color = f.first_color();
    // primFontSz op=equ: every node box shares the smallest fitting size
    let with_text: Vec<_> = boxes
        .iter()
        .filter(|(_, node)| !node.texts.is_empty())
        .collect();
    let size_pt = if with_text.is_empty() {
        cons.font_max.0
    } else {
        min_of(
            with_text
                .iter()
                .map(|(b, node)| fit_size_w(b.h.0, b.w.0, &node.texts, cons.font_max.0)),
        )
    };
    for ln in &geo.lines {
        f.push(
            dgm_box(
                ln.x.0 - line_w / 2.0,
                ln.y.0 - line_w / 2.0,
                ln.cx.0 + line_w,
                ln.cy.0 + line_w,
            ),
            DgmFill::Color(line_color),
            &[],
            DgmSpOpts::default(),
        );
    }
    for (b, node) in boxes {
        let fill = f.color_of(node, 0);
        f.push(
            dgm_box(b.x.0, b.y.0, b.w.0, b.h.0),
            fill,
            &text_lines(&node.texts, size_pt),
            DgmSpOpts::default(),
        );
    }
}
