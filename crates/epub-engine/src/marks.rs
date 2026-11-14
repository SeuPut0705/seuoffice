//! `marks.ts` of `packages/epub-engine`: bold and italic toggling on a
//! block's notation tree.
//!
//! The tree is flattened into atoms (characters, line breaks, empty
//! placeholders), each carrying the marks it sits in and the placeholders
//! around it. The toggle changes the marks of the atoms in range, then the tree
//! is rebuilt: placeholders keep their structure, and each mark is written at
//! the outermost level where it covers whole units, but never further out than
//! the original element was. Untouched marks keep pointing at their original
//! element, so their markup is written back unchanged.

use std::rc::Rc;

use crate::notation::{MarkName, NotationNode};
use crate::xml_positions_types::{Thrown, deeper};

#[derive(Debug, Clone, Copy)]
struct Mark {
    /// Index into the context's original marks, or null for a new mark.
    orig: Option<usize>,
    /// Number of placeholders around the mark element.
    depth: usize,
}

/// `Record<MarkName, Mark | null>`
#[derive(Debug, Clone, Copy, Default)]
struct Marks {
    b: Option<Mark>,
    i: Option<Mark>,
}

impl Marks {
    fn get(&self, mark: MarkName) -> Option<Mark> {
        match mark {
            MarkName::B => self.b,
            MarkName::I => self.i,
        }
    }

    fn with(mut self, mark: MarkName, value: Option<Mark>) -> Self {
        match mark {
            MarkName::B => self.b = value,
            MarkName::I => self.i = value,
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtomKind {
    Char,
    Br,
    XEmpty,
    XHollow,
}

#[derive(Debug, Clone)]
struct Atom {
    kind: AtomKind,
    ch: u16,
    /// Placeholder number for `xempty`/`xhollow`, original index for `br`.
    n: Option<f64>,
    /// Placeholder numbers from the outside in.
    path: Rc<Vec<f64>>,
    marks: Marks,
    /// Mark nesting, outside first.
    order: Vec<MarkName>,
}

/// One atom with its surroundings. Kept out of line so that the frame of
/// `flatten`, which recurses once for each level of the tree, stays small.
#[inline(never)]
fn push_atom(
    out: &mut Vec<Atom>,
    kind: AtomKind,
    (ch, n): (u16, Option<f64>),
    path: &Rc<Vec<f64>>,
    marks: Marks,
    order: &[MarkName],
) {
    out.push(Atom {
        kind,
        ch,
        n,
        path: path.clone(),
        marks,
        order: order.to_vec(),
    });
}

/// The marks and their nesting inside a `b` or `i` element.
#[inline(never)]
fn inside_mark(
    marks: Marks,
    order: &[MarkName],
    t: MarkName,
    orig: Option<usize>,
    depth: usize,
) -> (Marks, Vec<MarkName>) {
    let inner = marks.with(t, Some(marks.get(t).unwrap_or(Mark { orig, depth })));
    let mut inner_order = order.to_vec();
    if !order.contains(&t) {
        inner_order.push(t);
    }
    (inner, inner_order)
}

#[inline(never)]
fn path_with(path: &Rc<Vec<f64>>, n: f64) -> Rc<Vec<f64>> {
    let mut deeper_path = path.as_ref().clone();
    deeper_path.push(n);
    Rc::new(deeper_path)
}

fn flatten(
    tree: &[NotationNode],
    path: &Rc<Vec<f64>>,
    marks: Marks,
    order: &[MarkName],
    out: &mut Vec<Atom>,
    depth: usize,
) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    for node in tree {
        match node {
            NotationNode::Text(v) => {
                for &ch in v {
                    push_atom(out, AtomKind::Char, (ch, None), path, marks, order);
                }
            }
            NotationNode::Br { orig } => {
                let n = orig.map(|o| o as f64);
                push_atom(out, AtomKind::Br, (0, n), path, marks, order);
            }
            NotationNode::Mark { t, orig, c } => {
                let (inner, inner_order) = inside_mark(marks, order, *t, *orig, path.len());
                flatten(c, path, inner, &inner_order, out, depth)?;
            }
            NotationNode::X { n, c: None } => {
                push_atom(out, AtomKind::XEmpty, (0, Some(*n)), path, marks, order);
            }
            NotationNode::X { n, c: Some(c) } => {
                let before = out.len();
                flatten(c, &path_with(path, *n), marks, order, out, depth)?;
                if out.len() == before {
                    push_atom(out, AtomKind::XHollow, (0, Some(*n)), path, marks, order);
                }
            }
        }
    }
    Ok(())
}

/// How many placeholders may nest around the characters of a toggle. A level of
/// `rebuild`, `wrap` (once for each of the two marks) and `render` takes about
/// 2.7 KB of stack, so this is far less than `MAX_DEPTH`; V8 gives up past 3,000.
const MAX_REBUILD_DEPTH: usize = 128;

enum Unit {
    Leaf(Atom),
    Group { n: f64, atoms: Vec<Atom> },
}

fn unit_atoms(unit: &Unit) -> &[Atom] {
    match unit {
        Unit::Leaf(atom) => std::slice::from_ref(atom),
        Unit::Group { atoms, .. } => atoms,
    }
}

fn mark_key(mark: Option<Mark>) -> String {
    match mark {
        None => "none".to_owned(),
        Some(Mark { orig: None, .. }) => "new".to_owned(),
        Some(Mark {
            orig: Some(orig), ..
        }) => format!("o{orig}"),
    }
}

/// The mark key shared by all atoms of a unit that can be written at `depth`, or `mixed`.
fn unit_key(unit: &Unit, mark: MarkName, depth: usize) -> String {
    let atoms = unit_atoms(unit);
    let key = mark_key(atoms[0].marks.get(mark));
    for atom in atoms {
        let m = atom.marks.get(mark);
        if mark_key(m) != key {
            return "mixed".to_owned();
        }
        if m.is_some_and(|m| m.depth > depth) {
            return "mixed".to_owned();
        }
    }
    key
}

/// Lets new marks join an adjacent original mark element instead of starting their own.
fn unify_keys(keys: &[String]) -> Vec<String> {
    let mut out = keys.to_vec();
    let mut i = 0;
    while i < out.len() {
        if out[i] == "none" || out[i] == "mixed" {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < out.len() && out[j] != "none" && out[j] != "mixed" {
            j += 1;
        }
        let mut origs: Vec<&String> = Vec::new();
        for key in &out[i..j] {
            if key != "new" && !origs.contains(&key) {
                origs.push(key);
            }
        }
        if origs.len() == 1 {
            let only = origs[0].clone();
            for key in &mut out[i..j] {
                key.clone_from(&only);
            }
        }
        i = j;
    }
    out
}

fn mark_order(atoms: &[Atom]) -> Vec<MarkName> {
    atoms
        .iter()
        .find(|a| a.order.len() == 2)
        .map_or_else(|| vec![MarkName::B, MarkName::I], |both| both.order.clone())
}

fn render(
    units: Vec<Unit>,
    depth: usize,
    applied: &[MarkName],
    stack: usize,
) -> Result<Vec<NotationNode>, Thrown> {
    let mut out: Vec<NotationNode> = Vec::new();
    for unit in units {
        let atom = match unit {
            Unit::Group { n, atoms } => {
                out.push(NotationNode::X {
                    n,
                    c: Some(rebuild(&atoms, depth + 1, applied, stack)?),
                });
                continue;
            }
            Unit::Leaf(atom) => atom,
        };
        match atom.kind {
            AtomKind::Char => {
                if let Some(NotationNode::Text(last)) = out.last_mut() {
                    last.push(atom.ch);
                } else {
                    out.push(NotationNode::Text(vec![atom.ch]));
                }
            }
            AtomKind::Br => out.push(NotationNode::Br {
                orig: atom.n.map(|n| n as usize),
            }),
            AtomKind::XEmpty | AtomKind::XHollow => out.push(NotationNode::X {
                // `atom.n!`: an `xempty` or `xhollow` always has its number
                n: atom.n.unwrap_or(f64::NAN),
                c: if atom.kind == AtomKind::XEmpty {
                    None
                } else {
                    Some(Vec::new())
                },
            }),
        }
    }
    Ok(out)
}

fn wrap(
    units: Vec<Unit>,
    marks: &[MarkName],
    depth: usize,
    applied: &[MarkName],
    stack: usize,
) -> Result<Vec<NotationNode>, Thrown> {
    // `wrap` recurses once for each of at most two marks; the nesting is `rebuild`'s
    let Some((&mark, rest)) = marks.split_first() else {
        return render(units, depth, applied, stack);
    };
    let keys = unify_keys(
        &units
            .iter()
            .map(|u| unit_key(u, mark, depth))
            .collect::<Vec<_>>(),
    );
    let mut out: Vec<NotationNode> = Vec::new();
    let mut remaining = units.into_iter();
    let mut i = 0;
    while i < keys.len() {
        let mut j = i + 1;
        while j < keys.len() && keys[j] == keys[i] {
            j += 1;
        }
        let run: Vec<Unit> = remaining.by_ref().take(j - i).collect();
        let key = &keys[i];
        if key == "none" || key == "mixed" {
            out.extend(wrap(run, rest, depth, applied, stack)?);
        } else {
            let mut inner = applied.to_vec();
            if !inner.contains(&mark) {
                inner.push(mark);
            }
            out.push(NotationNode::Mark {
                t: mark,
                orig: if key == "new" {
                    None
                } else {
                    // `Number(key.slice(1))`
                    key[1..].parse::<usize>().ok()
                },
                c: wrap(run, rest, depth, &inner, stack)?,
            });
        }
        i = j;
    }
    Ok(out)
}

fn rebuild(
    atoms: &[Atom],
    depth: usize,
    applied: &[MarkName],
    stack: usize,
) -> Result<Vec<NotationNode>, Thrown> {
    if stack >= MAX_REBUILD_DEPTH {
        return Err(Thrown::stack_overflow());
    }
    let stack = stack + 1;
    let mut units: Vec<Unit> = Vec::new();
    for atom in atoms {
        if atom.path.len() == depth {
            units.push(Unit::Leaf(atom.clone()));
            continue;
        }
        let n = atom.path[depth];
        if let Some(Unit::Group { n: last_n, atoms }) = units.last_mut()
            && *last_n == n
        {
            atoms.push(atom.clone());
        } else {
            units.push(Unit::Group {
                n,
                atoms: vec![atom.clone()],
            });
        }
    }
    let marks: Vec<MarkName> = mark_order(atoms)
        .into_iter()
        .filter(|m| !applied.contains(m))
        .collect();
    wrap(units, &marks, depth, applied, stack)
}

/// `ToIntegerOrInfinity`, then the `slice` clamp of `Array.prototype.slice`.
fn slice_bound(len: usize, x: f64) -> usize {
    let integer = if x.is_nan() { 0.0 } else { x.trunc() };
    if integer < 0.0 {
        (len as f64 + integer).max(0.0) as usize
    } else {
        integer.min(len as f64) as usize
    }
}

/// `text[k]` for a number `k`: undefined unless `k` is an index of the text.
fn unit_at(text: &[u16], k: f64) -> Option<u16> {
    (k >= 0.0 && k.fract() == 0.0 && k < text.len() as f64).then(|| text[k as usize])
}

/// Toggles bold (`b`) or italic (`i`) on the plain-text range `[start, end)`.
/// If every character in range already has the mark it is removed there,
/// otherwise it is added. Returns `None` when the range holds no character.
pub fn toggle_mark_in_tree(
    tree: &[NotationNode],
    mark: MarkName,
    mut start: f64,
    mut end: f64,
) -> Result<Option<Vec<NotationNode>>, Thrown> {
    let mut atoms = Vec::new();
    flatten(
        tree,
        &Rc::new(Vec::new()),
        Marks::default(),
        &[],
        &mut atoms,
        0,
    )?;
    let chars: Vec<usize> = (0..atoms.len())
        .filter(|&i| atoms[i].kind == AtomKind::Char)
        .collect();
    let text: Vec<u16> = chars.iter().map(|&i| atoms[i].ch).collect();
    // Never cut a surrogate pair.
    let is_low = |k: f64| {
        unit_at(&text, k).is_some_and(|u| (0xDC00..=0xDFFF).contains(&u))
            && unit_at(&text, k - 1.0).is_some_and(|u| (0xD800..=0xDBFF).contains(&u))
    };
    if is_low(start) {
        start -= 1.0;
    }
    if is_low(end) {
        end += 1.0;
    }
    let from = slice_bound(chars.len(), start);
    let to = slice_bound(chars.len(), end);
    let in_range = if from < to { &chars[from..to] } else { &[] };
    let (Some(&first), Some(&last)) = (in_range.first(), in_range.last()) else {
        return Ok(None);
    };
    let turn_off = in_range.iter().all(|&i| atoms[i].marks.get(mark).is_some());
    let span_path = atoms[first].path.clone();
    let mut common = span_path.len();
    for atom in &atoms[first..=last] {
        let mut k = 0;
        while k < common && k < atom.path.len() && atom.path[k] == span_path[k] {
            k += 1;
        }
        common = k;
    }
    for atom in &mut atoms[first..=last] {
        if turn_off {
            atom.marks = atom.marks.with(mark, None);
        } else if atom.marks.get(mark).is_none() {
            atom.marks = atom.marks.with(
                mark,
                Some(Mark {
                    orig: None,
                    depth: common,
                }),
            );
            if !atom.order.contains(&mark) {
                atom.order.push(mark);
            }
        }
    }
    rebuild(&atoms, 0, &[], 0).map(Some)
}
