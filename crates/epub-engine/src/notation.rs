//! `notation.ts` of `packages/epub-engine`: block text notation shared by the
//! AI tools and book translation.
//!
//! Bold is `<b>...</b>`, italic `<i>...</i>`, a line break `<br/>`. Every other
//! inline element becomes a placeholder numbered in order within the block:
//! `<xN>...</xN>` when it has content, `<xN/>` when it has none.
//!
//! A notation is a JavaScript string, so a text, a tree and a message are
//! UTF-16 units: a numeric reference can decode to a lone surrogate, and the
//! message of an unknown tag holds the tag as it was written. The notation
//! patterns of the TypeScript are sticky regular expressions over such a
//! string; `jscompat::JsRegex` searches a `&str`, so each is read by hand
//! here, with the longest-match order of the pattern.

use std::collections::HashSet;

use jscompat::{Radix, number_to_string, parse_int, to_number};

use crate::blocks::{ChapterBlock, OpenChapter, is_opaque};
use crate::utf16::{is_space, lossy, units};
use crate::xml_positions_types::{ElementId, Thrown, XmlDocument, XmlNode, deeper};

#[derive(Debug, Clone, PartialEq)]
pub struct PlaceholderSource {
    /// Placeholder number, from 1.
    pub n: f64,
    /// Qualified tag name of the original element.
    pub tag: String,
    /// Written `<xN/>`: the element had no text and no child elements, or is opaque.
    pub empty: bool,
    /// Original start tag, verbatim.
    pub start_tag: Vec<u16>,
    /// Original end tag, verbatim.
    pub end_tag: Vec<u16>,
    /// Whole original element, verbatim.
    pub outer: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarkSource {
    pub start_tag: Vec<u16>,
    pub end_tag: Vec<u16>,
}

/// What decoding needs to restore a block's original markup.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NotationContext {
    pub placeholders: Vec<PlaceholderSource>,
    /// Original bold elements, in reading order.
    pub bold: Vec<MarkSource>,
    /// Original italic elements, in reading order.
    pub italic: Vec<MarkSource>,
    /// Original line break elements, verbatim, in reading order.
    pub breaks: Vec<Vec<u16>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlockNotation {
    pub text: Vec<u16>,
    pub context: NotationContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NotationOptions {
    /// Leave out ruby readings (`rt`, `rp`), keeping the base text.
    pub drop_ruby: bool,
}

/// What `{ ok: false, error }` and a throw both are to the code that goes on:
/// the functions that return `{ ok: true, ... } | { ok: false, error }` in
/// TypeScript return `Result<_, NotationError>` here.
#[derive(Debug, Clone, PartialEq)]
pub enum NotationError {
    /// `{ ok: false, error }`.
    Invalid(Vec<u16>),
    /// The TypeScript threw.
    Thrown(Thrown),
}

impl From<Thrown> for NotationError {
    fn from(thrown: Thrown) -> Self {
        Self::Thrown(thrown)
    }
}

fn invalid(message: String) -> NotationError {
    NotationError::Invalid(units(&message))
}

/// `'b' | 'i'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkName {
    B,
    I,
}

impl MarkName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::B => "b",
            Self::I => "i",
        }
    }
}

/// `NotationNode`: parsed notation. `orig` points into the context's original marks.
#[derive(Debug, Clone, PartialEq)]
pub enum NotationNode {
    Text(Vec<u16>),
    /// `{ t: 'b' | 'i', orig, c }`
    Mark {
        t: MarkName,
        orig: Option<usize>,
        c: Vec<NotationNode>,
    },
    Br {
        orig: Option<usize>,
    },
    /// `{ t: 'x', n, c }`; `c` is null for `<xN/>`. A number a model writes
    /// can be past 2^53, so `n` is a double.
    X {
        n: f64,
        c: Option<Vec<NotationNode>>,
    },
}

/// A tree is as deep as the notation nests, which a model can make deeper
/// than the stack holds: the children of a node are dropped one level at a
/// time from a list, not by the recursion of the drop glue.
impl Drop for NotationNode {
    fn drop(&mut self) {
        let mut pending: Vec<Vec<NotationNode>> = Vec::new();
        let take_children = |node: &mut NotationNode, pending: &mut Vec<Vec<NotationNode>>| {
            if let NotationNode::Mark { c, .. } | NotationNode::X { c: Some(c), .. } = node {
                pending.push(std::mem::take(c));
            }
        };
        take_children(self, &mut pending);
        while let Some(mut list) = pending.pop() {
            for node in &mut list {
                take_children(node, &mut pending);
            }
        }
    }
}

fn is_bold(local: &str) -> bool {
    local == "strong" || local == "b"
}

fn is_italic(local: &str) -> bool {
    local == "em" || local == "i"
}

fn is_ruby_reading(local: &str) -> bool {
    local == "rt" || local == "rp"
}

const LT: u16 = 0x3C;
const GT: u16 = 0x3E;
const AMP: u16 = 0x26;
const SLASH: u16 = 0x2F;

/// `text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')`
pub fn escape_notation_text(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    for &unit in text {
        match unit {
            AMP => out.extend(units("&amp;")),
            LT => out.extend(units("&lt;")),
            GT => out.extend(units("&gt;")),
            _ => out.push(unit),
        }
    }
    out
}

/// `XML_DISALLOWED`: the characters XML 1.0 does not allow, unpaired
/// surrogates included, removed.
fn without_disallowed(text: &[u16]) -> Vec<u16> {
    let is_high = |u: u16| (0xD800..=0xDBFF).contains(&u);
    let is_low = |u: u16| (0xDC00..=0xDFFF).contains(&u);
    let mut out = Vec::with_capacity(text.len());
    for (i, &unit) in text.iter().enumerate() {
        let disallowed = matches!(unit, 0x0000..=0x0008 | 0x000B | 0x000C | 0x000E..=0x001F | 0xFFFE | 0xFFFF)
            || (is_high(unit) && !text.get(i + 1).is_some_and(|&n| is_low(n)))
            || (is_low(unit) && !(i > 0 && is_high(text[i - 1])));
        if !disallowed {
            out.push(unit);
        }
    }
    out
}

fn escape_xml_text(text: &[u16]) -> Vec<u16> {
    escape_notation_text(&without_disallowed(text))
}

fn has_content(doc: &XmlDocument, id: ElementId) -> bool {
    doc.element(id)
        .children
        .iter()
        .any(|c| matches!(c, XmlNode::Text(_) | XmlNode::Element(_)))
}

fn push_text(out: &mut Vec<NotationNode>, v: &[u16]) {
    if let Some(NotationNode::Text(last)) = out.last_mut() {
        last.extend_from_slice(v);
    } else {
        out.push(NotationNode::Text(v.to_vec()));
    }
}

struct EncodeState<'a> {
    doc: &'a XmlDocument,
    drop_ruby: bool,
    context: NotationContext,
}

/// What one element of a block becomes before its children are encoded: kept
/// apart from `encode_nodes` so that the frame of the recursion stays small.
enum Encoded<'a> {
    Skip,
    Break(NotationNode),
    Mark {
        t: MarkName,
        orig: usize,
        children: &'a [XmlNode],
    },
    Placeholder {
        n: f64,
        children: Option<&'a [XmlNode]>,
    },
}

#[inline(never)]
fn encode_element<'a>(
    doc: &'a XmlDocument,
    id: ElementId,
    state: &mut EncodeState<'_>,
) -> Encoded<'a> {
    let el = doc.element(id);
    if state.drop_ruby && is_ruby_reading(&el.local) {
        return Encoded::Skip;
    }
    let plain = el.attributes.is_empty();
    let start_tag = doc.source[el.start..el.start_tag_end].to_vec();
    let end_tag = doc.source[el.end_tag_start..el.end].to_vec();
    let outer = doc.source[el.start..el.end].to_vec();
    if plain && el.local == "br" && !has_content(doc, id) {
        state.context.breaks.push(outer);
        return Encoded::Break(NotationNode::Br {
            orig: Some(state.context.breaks.len() - 1),
        });
    }
    let empty = is_opaque(&el.local) || !has_content(doc, id);
    if !empty && plain && (is_bold(&el.local) || is_italic(&el.local)) {
        let bold = is_bold(&el.local);
        let list = if bold {
            &mut state.context.bold
        } else {
            &mut state.context.italic
        };
        list.push(MarkSource { start_tag, end_tag });
        return Encoded::Mark {
            t: if bold { MarkName::B } else { MarkName::I },
            orig: list.len() - 1,
            children: &el.children,
        };
    }
    let n = (state.context.placeholders.len() + 1) as f64;
    state.context.placeholders.push(PlaceholderSource {
        n,
        tag: el.name.clone(),
        empty,
        start_tag,
        end_tag,
        outer,
    });
    Encoded::Placeholder {
        n,
        children: if empty { None } else { Some(&el.children) },
    }
}

fn encode_nodes(
    nodes: &[XmlNode],
    state: &mut EncodeState<'_>,
    depth: usize,
) -> Result<Vec<NotationNode>, Thrown> {
    let depth = deeper(depth)?;
    let mut out = Vec::new();
    let doc = state.doc;
    for node in nodes {
        let id = match node {
            XmlNode::Text(text) => {
                push_text(&mut out, &text.value);
                continue;
            }
            XmlNode::Other(_) => continue,
            XmlNode::Element(id) => *id,
        };
        match encode_element(doc, id, state) {
            Encoded::Skip => {}
            Encoded::Break(node) => out.push(node),
            Encoded::Mark { t, orig, children } => {
                let c = encode_nodes(children, state, depth)?;
                out.push(NotationNode::Mark {
                    t,
                    orig: Some(orig),
                    c,
                });
            }
            Encoded::Placeholder { n, children } => {
                let c = match children {
                    Some(children) => Some(encode_nodes(children, state, depth)?),
                    None => None,
                };
                out.push(NotationNode::X { n, c });
            }
        }
    }
    Ok(out)
}

/// `encodeBlock`: encodes a block into a notation tree and its context.
pub fn encode_block(
    map: &OpenChapter,
    block: &ChapterBlock,
    options: NotationOptions,
) -> Result<(Vec<NotationNode>, NotationContext), Thrown> {
    let mut state = EncodeState {
        doc: &map.doc,
        drop_ruby: options.drop_ruby,
        context: NotationContext::default(),
    };
    let children = &map.doc.element(block.element).children;
    let tree = encode_nodes(children, &mut state, 0)?;
    Ok((tree, state.context))
}

fn serialize_into(tree: &[NotationNode], out: &mut Vec<u16>, depth: usize) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    for node in tree {
        match node {
            NotationNode::Text(v) => out.extend(escape_notation_text(v)),
            NotationNode::Br { .. } => out.extend(units("<br/>")),
            NotationNode::Mark { t, c, .. } => {
                out.extend(units(&format!("<{}>", t.as_str())));
                serialize_into(c, out, depth)?;
                out.extend(units(&format!("</{}>", t.as_str())));
            }
            NotationNode::X { n, c: None } => {
                out.extend(units(&format!("<x{}/>", number_to_string(*n))));
            }
            NotationNode::X { n, c: Some(c) } => {
                let n = number_to_string(*n);
                out.extend(units(&format!("<x{n}>")));
                serialize_into(c, out, depth)?;
                out.extend(units(&format!("</x{n}>")));
            }
        }
    }
    Ok(())
}

/// `serializeNotation`
pub fn serialize_notation(tree: &[NotationNode]) -> Result<Vec<u16>, Thrown> {
    let mut out = Vec::new();
    serialize_into(tree, &mut out, 0)?;
    Ok(out)
}

/// `blockNotation`: the block's text in the notation.
pub fn block_notation(
    map: &OpenChapter,
    block: &ChapterBlock,
    options: NotationOptions,
) -> Result<BlockNotation, Thrown> {
    let (tree, context) = encode_block(map, block, options)?;
    Ok(BlockNotation {
        text: serialize_notation(&tree)?,
        context,
    })
}

fn plain_text_into(tree: &[NotationNode], out: &mut Vec<u16>, depth: usize) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    for node in tree {
        match node {
            NotationNode::Text(v) => out.extend_from_slice(v),
            NotationNode::Mark { c, .. } => plain_text_into(c, out, depth)?,
            NotationNode::X { c: Some(c), .. } => plain_text_into(c, out, depth)?,
            NotationNode::X { c: None, .. } | NotationNode::Br { .. } => {}
        }
    }
    Ok(())
}

/// `notationPlainText`: plain text of a notation tree.
pub fn notation_plain_text(tree: &[NotationNode]) -> Result<Vec<u16>, Thrown> {
    let mut out = Vec::new();
    plain_text_into(tree, &mut out, 0)?;
    Ok(out)
}

/// `blockPlainText`: the block's plain text: the characters that edit offsets
/// (split, line break, bold/italic ranges) count. Ruby readings are included;
/// the content of opaque elements, comments and line breaks are not.
pub fn block_plain_text(map: &OpenChapter, block: &ChapterBlock) -> Result<Vec<u16>, Thrown> {
    notation_plain_text(&encode_block(map, block, NotationOptions::default())?.0)
}

// ---------------------------------------------------------------------------
// Parsing

fn digits_from(text: &[u16], at: usize) -> usize {
    let mut end = at;
    while text.get(end).is_some_and(|u| (0x30..=0x39).contains(u)) {
        end += 1;
    }
    end
}

fn skip_spaces(text: &[u16], mut at: usize) -> usize {
    while text.get(at).is_some_and(|&u| is_space(u)) {
        at += 1;
    }
    at
}

fn starts_with_at(text: &[u16], at: usize, literal: &str) -> bool {
    let lit = units(literal);
    text.get(at..at + lit.len()).is_some_and(|s| s == lit)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagKind {
    Br,
    Open,
    Close,
    XEmpty,
    XOpen,
    XClose,
}

/// One of `TAG_PATTERNS`, sticky at `at`: the end of the match and the
/// capture (the mark letter, or the digits of the placeholder number).
fn match_tag(text: &[u16], at: usize, kind: TagKind) -> Option<(usize, Vec<u16>)> {
    match kind {
        // /<br\s*\/?>/y
        TagKind::Br => {
            if !starts_with_at(text, at, "<br") {
                return None;
            }
            let mut j = skip_spaces(text, at + 3);
            if text.get(j) == Some(&SLASH) {
                j += 1;
            }
            (text.get(j) == Some(&GT)).then(|| (j + 1, Vec::new()))
        }
        // /<(b|i)>/y and /<\/(b|i)>/y
        TagKind::Open | TagKind::Close => {
            let j = if kind == TagKind::Open {
                at + 1
            } else {
                at + 2
            };
            if text.get(at) != Some(&LT)
                || (kind == TagKind::Close && text.get(at + 1) != Some(&SLASH))
            {
                return None;
            }
            let letter = *text.get(j)?;
            (matches!(letter, 0x62 | 0x69) && text.get(j + 1) == Some(&GT))
                .then(|| (j + 2, vec![letter]))
        }
        // /<x([1-9][0-9]*)\s*\/>/y, /<x([1-9][0-9]*)>/y, /<\/x([1-9][0-9]*)>/y
        TagKind::XEmpty | TagKind::XOpen | TagKind::XClose => {
            let from = if kind == TagKind::XClose {
                if !starts_with_at(text, at, "</x") {
                    return None;
                }
                at + 3
            } else {
                if !starts_with_at(text, at, "<x") {
                    return None;
                }
                at + 2
            };
            if !text.get(from).is_some_and(|&u| (0x31..=0x39).contains(&u)) {
                return None;
            }
            let end = digits_from(text, from + 1);
            let digits = text[from..end].to_vec();
            if kind == TagKind::XEmpty {
                let j = skip_spaces(text, end);
                (text.get(j) == Some(&SLASH) && text.get(j + 1) == Some(&GT))
                    .then(|| (j + 2, digits))
            } else {
                (text.get(end) == Some(&GT)).then(|| (end + 1, digits))
            }
        }
    }
}

const TAG_PATTERNS: [TagKind; 6] = [
    TagKind::Br,
    TagKind::Open,
    TagKind::Close,
    TagKind::XEmpty,
    TagKind::XOpen,
    TagKind::XClose,
];

/// `ENTITY`, sticky at the `&` at `at`: the end of the match and the reference.
fn match_entity(text: &[u16], at: usize) -> Option<(usize, String)> {
    let from = at + 1;
    for name in ["amp", "lt", "gt", "quot", "apos"] {
        if starts_with_at(text, from, name) && text.get(from + name.len()) == Some(&0x3B) {
            return Some((from + name.len() + 1, name.to_owned()));
        }
    }
    if text.get(from) != Some(&0x23) {
        return None;
    }
    let end = digits_from(text, from + 1);
    if end > from + 1 && text.get(end) == Some(&0x3B) {
        return Some((end + 1, lossy(&text[from..end])));
    }
    if text.get(from + 1) == Some(&0x78) {
        let mut end = from + 2;
        while text
            .get(end)
            .is_some_and(|&u| char::from_u32(u32::from(u)).is_some_and(|c| c.is_ascii_hexdigit()))
        {
            end += 1;
        }
        if end > from + 2 && text.get(end) == Some(&0x3B) {
            return Some((end + 1, lossy(&text[from..end])));
        }
    }
    None
}

/// `decodeEntity`
fn decode_entity(reference: &str) -> Option<Vec<u16>> {
    let Some(rest) = reference.strip_prefix('#') else {
        return Some(units(match reference {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            _ => "'",
        }));
    };
    let code = match rest.strip_prefix('x') {
        Some(hex) => parse_int(hex, Radix::Sixteen),
        None => parse_int(rest, Radix::Ten),
    };
    if !code.is_finite() || code < 1.0 || code > 1_114_111.0 {
        return None;
    }
    // a surrogate is a code point: `String.fromCodePoint` writes it as one unit
    let code = code as u32;
    Some(match char::from_u32(code) {
        Some(c) => c.encode_utf16(&mut [0; 2]).to_vec(),
        None => vec![code as u16],
    })
}

struct Frame {
    t: FrameKind,
    close: String,
    c: Vec<NotationNode>,
}

enum FrameKind {
    Mark(MarkName),
    X(f64),
}

/// `parseNotation`: the notation as a tree, or why it is not one.
fn parse_notation(
    text: &[u16],
    allow_placeholders: bool,
) -> Result<Vec<NotationNode>, NotationError> {
    let mut root: Vec<NotationNode> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut i = 0;
    let mut pending: Vec<u16> = Vec::new();

    fn children<'a>(
        root: &'a mut Vec<NotationNode>,
        stack: &'a mut [Frame],
    ) -> &'a mut Vec<NotationNode> {
        match stack.last_mut() {
            Some(frame) => &mut frame.c,
            None => root,
        }
    }
    fn flush(root: &mut Vec<NotationNode>, stack: &mut [Frame], pending: &mut Vec<u16>) {
        if !pending.is_empty() {
            push_text(children(root, stack), pending);
        }
        pending.clear();
    }

    while i < text.len() {
        let ch = text[i];
        if ch == AMP {
            let value = match_entity(text, i)
                .and_then(|(end, reference)| decode_entity(&reference).map(|value| (end, value)));
            if let Some((end, value)) = value {
                pending.extend(value);
                i = end;
            } else {
                pending.push(AMP);
                i += 1;
            }
            continue;
        }
        if ch != LT {
            let end = text[i..]
                .iter()
                .position(|&u| u == LT || u == AMP)
                .map_or(text.len(), |next| i + next);
            pending.extend_from_slice(&text[i..end]);
            i = end;
            continue;
        }
        let mut matched = false;
        for kind in TAG_PATTERNS {
            let Some((end, capture)) = match_tag(text, i, kind) else {
                continue;
            };
            matched = true;
            flush(&mut root, &mut stack, &mut pending);
            let tag = &text[i..end];
            i = end;
            let is_x = matches!(kind, TagKind::XEmpty | TagKind::XOpen | TagKind::XClose);
            if !allow_placeholders && is_x {
                let mut message = units("placeholder ");
                message.extend_from_slice(tag);
                message.extend(units(" is not allowed in a new block"));
                return Err(NotationError::Invalid(message));
            }
            let digits = lossy(&capture);
            match kind {
                TagKind::Br => {
                    children(&mut root, &mut stack).push(NotationNode::Br { orig: None })
                }
                TagKind::Open => {
                    let t = if capture == [0x62] {
                        MarkName::B
                    } else {
                        MarkName::I
                    };
                    stack.push(Frame {
                        t: FrameKind::Mark(t),
                        close: t.as_str().to_owned(),
                        c: Vec::new(),
                    });
                }
                TagKind::XOpen => stack.push(Frame {
                    t: FrameKind::X(to_number(&digits)),
                    close: format!("x{digits}"),
                    c: Vec::new(),
                }),
                TagKind::XEmpty => children(&mut root, &mut stack).push(NotationNode::X {
                    n: to_number(&digits),
                    c: None,
                }),
                TagKind::Close | TagKind::XClose => {
                    let name = if kind == TagKind::Close {
                        digits
                    } else {
                        format!("x{digits}")
                    };
                    let Some(top) = stack.pop() else {
                        return Err(invalid(format!("closing </{name}> has no opening tag")));
                    };
                    if top.close != name {
                        return Err(invalid(format!(
                            "</{name}> closes <{}>; tags must nest",
                            top.close
                        )));
                    }
                    let node = match top.t {
                        FrameKind::Mark(t) => NotationNode::Mark {
                            t,
                            orig: None,
                            c: top.c,
                        },
                        FrameKind::X(n) => NotationNode::X { n, c: Some(top.c) },
                    };
                    children(&mut root, &mut stack).push(node);
                }
            }
            break;
        }
        if matched {
            continue;
        }
        // LOOKS_LIKE_TAG: /<\/?[A-Za-z]/y
        let letter_at = if text.get(i + 1) == Some(&SLASH) {
            i + 2
        } else {
            i + 1
        };
        if text
            .get(letter_at)
            .is_some_and(|&u| matches!(u, 0x41..=0x5A | 0x61..=0x7A))
        {
            // /^<[^>]*>?/ of the rest of the text
            let close = text[i..].iter().position(|&u| u == GT);
            let end = close.map_or(text.len(), |at| i + at + 1);
            let mut message = units("unknown tag ");
            message.extend_from_slice(&text[i..end]);
            return Err(NotationError::Invalid(message));
        }
        pending.push(LT);
        i += 1;
    }
    flush(&mut root, &mut stack, &mut pending);
    if let Some(open) = stack.last() {
        return Err(invalid(format!("<{}> is not closed", open.close)));
    }
    Ok(root)
}

/// `collect(tree, t)`, counted: how many nodes of the kind there are.
fn count_nodes(
    tree: &[NotationNode],
    wanted: &dyn Fn(&NotationNode) -> bool,
    depth: usize,
) -> Result<usize, Thrown> {
    let depth = deeper(depth)?;
    let mut count = 0;
    for node in tree {
        if wanted(node) {
            count += 1;
        }
        if let NotationNode::Mark { c, .. } | NotationNode::X { c: Some(c), .. } = node {
            count += count_nodes(c, wanted, depth)?;
        }
    }
    Ok(count)
}

/// The placeholder numbered `n`, as `context.placeholders[n - 1]` finds it.
fn placeholder_of(context: &NotationContext, n: f64) -> Option<&PlaceholderSource> {
    let index = n - 1.0;
    if index >= 0.0 && index.fract() == 0.0 && index < context.placeholders.len() as f64 {
        context.placeholders.get(index as usize)
    } else {
        None
    }
}

/// `Set` keys are compared as SameValueZero.
fn key_of(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        f64::NAN.to_bits()
    } else {
        x.to_bits()
    }
}

/// `collect(tree, 'x')`: the placeholders of a tree in the order they are listed,
/// as their number and whether they have content.
fn collect_placeholders(
    tree: &[NotationNode],
    out: &mut Vec<(f64, bool)>,
    depth: usize,
) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    for node in tree {
        if let NotationNode::X { n, c } = node {
            out.push((*n, c.is_some()));
        }
        if let NotationNode::Mark { c, .. } | NotationNode::X { c: Some(c), .. } = node {
            collect_placeholders(c, out, depth)?;
        }
    }
    Ok(())
}

fn check_tree(tree: &[NotationNode], context: &NotationContext) -> Result<(), NotationError> {
    let mut listed = Vec::new();
    collect_placeholders(tree, &mut listed, 0)?;
    let mut seen = HashSet::new();
    for (n, has_content) in listed {
        let n_text = number_to_string(n);
        let Some(source) = placeholder_of(context, n) else {
            return Err(invalid(format!(
                "placeholder x{n_text} does not exist in this block"
            )));
        };
        if !seen.insert(key_of(n)) {
            return Err(invalid(format!(
                "placeholder x{n_text} appears more than once"
            )));
        }
        if source.empty && has_content {
            return Err(invalid(format!(
                "placeholder x{n_text} must be written <x{n_text}/>"
            )));
        }
        if !source.empty && !has_content {
            return Err(invalid(format!(
                "placeholder x{n_text} must be written <x{n_text}>\u{2026}</x{n_text}>"
            )));
        }
    }
    let missing: Vec<String> = context
        .placeholders
        .iter()
        .filter(|p| !seen.contains(&key_of(p.n)))
        .map(|p| format!("x{}", number_to_string(p.n)))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(invalid(format!(
            "placeholders missing: {}",
            missing.join(", ")
        )))
    }
}

/// `checkNotation`: checks that the placeholders match the block's: same
/// kinds, same count, paired and nested.
pub fn check_notation(text: &[u16], context: &NotationContext) -> Result<(), NotationError> {
    let tree = parse_notation(text, true)?;
    check_tree(&tree, context)
}

#[derive(Debug, Clone, Copy)]
enum MarkOrBr {
    Mark(MarkName),
    Br,
}

/// `assignOriginals`: gives bold, italic and line breaks their original
/// markup when their number is unchanged.
fn assign_originals(tree: &mut [NotationNode], context: &NotationContext) -> Result<(), Thrown> {
    for (wanted, count) in [
        (MarkOrBr::Mark(MarkName::B), context.bold.len()),
        (MarkOrBr::Mark(MarkName::I), context.italic.len()),
        (MarkOrBr::Br, context.breaks.len()),
    ] {
        let found = count_nodes(
            tree,
            &|node| match (node, wanted) {
                (NotationNode::Mark { t, .. }, MarkOrBr::Mark(m)) => *t == m,
                (NotationNode::Br { .. }, MarkOrBr::Br) => true,
                _ => false,
            },
            0,
        )?;
        if found == count {
            assign_preorder(tree, wanted, &mut 0, 0)?;
        }
    }
    Ok(())
}

/// The same numbering as `collect`: a node before its children, in tree order.
fn assign_preorder(
    tree: &mut [NotationNode],
    wanted: MarkOrBr,
    next: &mut usize,
    depth: usize,
) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    for node in tree {
        match (&mut *node, wanted) {
            (NotationNode::Mark { t, orig, .. }, MarkOrBr::Mark(m)) if *t == m => {
                *orig = Some(*next);
                *next += 1;
            }
            (NotationNode::Br { orig }, MarkOrBr::Br) => {
                *orig = Some(*next);
                *next += 1;
            }
            _ => {}
        }
        if let NotationNode::Mark { c, .. } | NotationNode::X { c: Some(c), .. } = node {
            assign_preorder(c, wanted, next, depth)?;
        }
    }
    Ok(())
}

/// `Cannot read properties of undefined (reading 'x')`
fn undefined_read(property: &str) -> Thrown {
    Thrown::new(
        "TypeError",
        format!("Cannot read properties of undefined (reading '{property}')"),
    )
}

fn tree_to_xhtml_into(
    tree: &[NotationNode],
    context: &NotationContext,
    out: &mut Vec<u16>,
    depth: usize,
) -> Result<(), Thrown> {
    let depth = deeper(depth)?;
    for node in tree {
        match node {
            NotationNode::Text(v) => out.extend(escape_xml_text(v)),
            NotationNode::Br { orig: None } => out.extend(units("<br/>")),
            // `context.breaks[orig]!` is undefined when there is none, and `+=` writes "undefined"
            NotationNode::Br { orig: Some(orig) } => match context.breaks.get(*orig) {
                Some(original) => out.extend_from_slice(original),
                None => out.extend(units("undefined")),
            },
            NotationNode::Mark { t, orig, c } => {
                let (start_tag, end_tag) = match orig {
                    None if *t == MarkName::B => (units("<strong>"), units("</strong>")),
                    None => (units("<em>"), units("</em>")),
                    Some(orig) => {
                        let originals = if *t == MarkName::B {
                            &context.bold
                        } else {
                            &context.italic
                        };
                        let mark = originals
                            .get(*orig)
                            .ok_or_else(|| undefined_read("startTag"))?;
                        (mark.start_tag.clone(), mark.end_tag.clone())
                    }
                };
                out.extend(start_tag);
                tree_to_xhtml_into(c, context, out, depth)?;
                out.extend(end_tag);
            }
            NotationNode::X { n, c } => {
                let source = placeholder_of(context, *n);
                match c {
                    None => {
                        out.extend_from_slice(&source.ok_or_else(|| undefined_read("outer"))?.outer)
                    }
                    Some(c) => {
                        let source = source.ok_or_else(|| undefined_read("startTag"))?;
                        out.extend_from_slice(&source.start_tag);
                        tree_to_xhtml_into(c, context, out, depth)?;
                        out.extend_from_slice(&source.end_tag);
                    }
                }
            }
        }
    }
    Ok(())
}

/// `notationTreeToXhtml`: writes a checked notation tree as inner XHTML.
pub fn notation_tree_to_xhtml(
    tree: &[NotationNode],
    context: &NotationContext,
) -> Result<Vec<u16>, Thrown> {
    let mut out = Vec::new();
    tree_to_xhtml_into(tree, context, &mut out, 0)?;
    Ok(out)
}

/// `parseBlockNotation`: parses and checks a notation into a tree with
/// originals assigned.
pub fn parse_block_notation(
    text: &[u16],
    context: &NotationContext,
) -> Result<Vec<NotationNode>, NotationError> {
    let mut tree = parse_notation(text, true)?;
    check_tree(&tree, context)?;
    assign_originals(&mut tree, context)?;
    Ok(tree)
}

/// `notationToXhtml`: turns notation for an existing block back into inner
/// XHTML. Placeholders must match the block's (see `check_notation`); new bold
/// and italic become `strong` and `em`.
pub fn notation_to_xhtml(
    text: &[u16],
    context: &NotationContext,
) -> Result<Vec<u16>, NotationError> {
    let tree = parse_block_notation(text, context)?;
    Ok(notation_tree_to_xhtml(&tree, context)?)
}

/// `newBlockNotationToXhtml`: turns notation for a new block into inner XHTML:
/// only `strong`, `em` and `br`, no placeholders.
pub fn new_block_notation_to_xhtml(text: &[u16]) -> Result<Vec<u16>, NotationError> {
    let tree = parse_notation(text, false)?;
    Ok(notation_tree_to_xhtml(&tree, &NotationContext::default())?)
}
