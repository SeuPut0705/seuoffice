//! Text patches of generate.ts: cached field text, OMML tokens, table cell
//! texts and textbox paragraphs, each rewriting only the text it owns.
//!
//! Offsets are UTF-8 bytes. Where the TypeScript measures or cuts a text by
//! its UTF-16 length (`distributeText`, the splice of `replaceTextNodes`) the
//! port does so in UTF-16 code units too.

use jscompat::{
    JsNum, Radix, RegexLimit, is_js_space, js_regex, number_to_string, parse_int, to_number, trim,
};
use ooxml_xml::Utf16Map;
use serde::{Deserialize, Deserializer};

use super::props::merge_cell_para_format;
use super::runs::runs_xml_in;
use super::{escape_xml_text, split_xml_children};
use crate::inline_opaque::ContentControlPart;
use crate::model::{ParaFormat, Run};

/// `xml.indexOf(needle, from)` for an ASCII needle: a match always starts on
/// a character boundary, and `from` need not be one.
fn index_of(xml: &str, needle: &str, from: usize) -> Option<usize> {
    let hay = xml.as_bytes();
    let needle = needle.as_bytes();
    if from > hay.len() || needle.len() > hay.len() - from {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| from + at)
}

/// A field that is absent stays `None`; a field that is `null` is `Some(None)`.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

// ---- protected field / formula token patching ----

struct XmlTextNode<'a> {
    start: usize,
    end: usize,
    open: &'a str,
    close: &'a str,
    text: String,
}

fn code_point_or_reference(cp: f64, reference: &str) -> String {
    if !cp.is_finite() || cp < 0.0 || cp > 1_114_111.0 || (55_296.0..=57_343.0).contains(&cp) {
        return reference.to_owned();
    }
    char::from_u32(cp as u32).map_or_else(|| reference.to_owned(), String::from)
}

fn decode_xml_text(text: &str) -> String {
    let text = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    let text = js_regex!(r"&#(\d+);", "g").replace_all(&text, |m| {
        code_point_or_reference(to_number(m.get(1).unwrap_or_default()), m.as_str())
    });
    let text = js_regex!(r"&#x([0-9a-fA-F]+);", "g").replace_all(&text, |m| {
        code_point_or_reference(
            parse_int(m.get(1).unwrap_or_default(), Radix::Sixteen),
            m.as_str(),
        )
    });
    text.replace("&amp;", "&")
}

fn text_nodes<'a>(xml: &'a str, tag: &str) -> Vec<XmlTextNode<'a>> {
    let mut nodes = Vec::new();
    let paired = if tag == "w:t" {
        js_regex!(r"<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>", "g")
    } else {
        js_regex!(r"<m:t(?:\s[^>]*)?>([\s\S]*?)<\/m:t>", "g")
    };
    let close_tag = format!("</{tag}>");
    for m in paired.find_iter(xml) {
        let whole = m.as_str();
        let open_end = whole.find('>').map_or(0, |at| at + 1);
        let close_start = whole.rfind(&close_tag).unwrap_or(0);
        nodes.push(XmlTextNode {
            start: m.start(),
            end: m.end(),
            open: &whole[..open_end],
            close: &whole[close_start..],
            text: decode_xml_text(m.get(1).unwrap_or_default()),
        });
    }
    // Only for w:t: mathTokensOf tokenizes paired <m:t> only.
    if tag == "w:t" {
        for m in js_regex!(r"<w:t(?:\s[^>]*)?\/>", "g").find_iter(xml) {
            nodes.push(XmlTextNode {
                start: m.start(),
                end: m.end(),
                open: m.as_str(),
                close: "",
                text: String::new(),
            });
        }
        nodes.sort_by_key(|node| node.start);
    }
    nodes
}

/// `value.slice(from, to)` in UTF-16 code units.
fn slice16(value: &[u16], from: usize, to: usize) -> String {
    let to = to.min(value.len());
    let from = from.min(to);
    String::from_utf16_lossy(&value[from..to])
}

fn distribute_text(value: &str, nodes: &[&XmlTextNode<'_>]) -> Vec<String> {
    let value: Vec<u16> = value.encode_utf16().collect();
    let mut parts = Vec::with_capacity(nodes.len());
    let mut cursor = 0;
    for (i, node) in nodes.iter().enumerate() {
        if i == nodes.len() - 1 {
            parts.push(slice16(&value, cursor, value.len()));
            break;
        }
        let length = node.text.encode_utf16().count();
        parts.push(slice16(&value, cursor, cursor + length));
        cursor += length;
    }
    parts
}

fn replace_text_nodes(xml: &str, replacements: &[(&XmlTextNode<'_>, String)]) -> String {
    if replacements.is_empty() {
        return xml.to_owned();
    }
    let map = Utf16Map::new(xml);
    let mut ordered: Vec<&(&XmlTextNode<'_>, String)> = replacements.iter().collect();
    ordered.sort_by_key(|replacement| std::cmp::Reverse(replacement.0.start));
    let mut out: Vec<u16> = xml.encode_utf16().collect();
    for (node, text) in ordered {
        // wtText drops edge whitespace without xml:space="preserve"
        let has_edge_ws = !text.is_empty()
            && (js_regex!(r"^\s|\s$").test(text)
                || text.starts_with('\u{200B}')
                || text.ends_with('\u{200B}'));
        let open = if js_regex!(r"xml:space\s*=").test(node.open) || !has_edge_ws {
            node.open.to_owned()
        } else {
            replace_first(
                js_regex!(r"<w:t(?=[\s>/])"),
                node.open,
                "<w:t xml:space=\"preserve\"",
            )
        };
        let close = if node.close.is_empty() {
            "</w:t>"
        } else {
            node.close
        };
        let open_paired = if node.close.is_empty() {
            replace_first(js_regex!(r"\/>$"), &open, ">")
        } else {
            open
        };
        let replacement = format!("{open_paired}{}{close}", escape_xml_text(text));
        let start = (map.to_utf16(node.start) as usize).min(out.len());
        let end = (map.to_utf16(node.end) as usize).min(out.len());
        let mut next = Vec::with_capacity(out.len() + replacement.len());
        next.extend_from_slice(&out[..start]);
        next.extend(replacement.encode_utf16());
        next.extend_from_slice(&out[end..]);
        out = next;
    }
    String::from_utf16_lossy(&out)
}

/// `text.replace(regex, literal)` without the `g` flag.
fn replace_first(regex: &jscompat::JsRegex, text: &str, with: &str) -> String {
    match regex.exec(text) {
        Some(m) => format!("{}{with}{}", &text[..m.start()], &text[m.end()..]),
        None => text.to_owned(),
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FieldTextPatch {
    #[serde(default)]
    pub left: Option<String>,
    #[serde(default)]
    pub right: Option<String>,
}

/// `^\S{1,15}$` counted in UTF-16 code units, as JavaScript without `u` does.
fn short_spaceless(text: &str) -> bool {
    let units = text.encode_utf16().count();
    (1..=15).contains(&units) && !text.chars().any(is_js_space)
}

/// Patch only cached visible w:t text in a field paragraph.
pub fn patch_field_paragraph_xml(xml: &str, patch: &FieldTextPatch) -> String {
    let nodes = text_nodes(xml, "w:t");
    if nodes.is_empty() {
        return xml.to_owned();
    }
    let tab_starts: Vec<usize> = js_regex!(r"<w:tab\s*\/>|<w:tab>\s*<\/w:tab>", "g")
        .find_iter(xml)
        .map(|m| m.start())
        .collect();
    let last_tab = tab_starts.last().copied();
    if patch.right.is_some() && last_tab.is_none() {
        return xml.to_owned();
    }
    let mut left_from: Option<usize> = None;
    if tab_starts.len() >= 2 {
        let first: String = nodes
            .iter()
            .filter(|node| node.start < tab_starts[0])
            .map(|node| node.text.as_str())
            .collect();
        if short_spaceless(trim(&first)) {
            left_from = Some(tab_starts[0]);
        }
    }
    let (left_nodes, right_nodes): (Vec<&XmlTextNode<'_>>, Vec<&XmlTextNode<'_>>) = match last_tab {
        None => (nodes.iter().collect(), Vec::new()),
        Some(last) => (
            nodes
                .iter()
                .filter(|node| left_from.is_none_or(|from| node.start > from) && node.start < last)
                .collect(),
            nodes.iter().filter(|node| node.start > last).collect(),
        ),
    };
    if patch.left.is_some() && left_nodes.is_empty() {
        return xml.to_owned();
    }
    if patch.right.is_some() && right_nodes.is_empty() {
        return xml.to_owned();
    }
    let mut replacements: Vec<(&XmlTextNode<'_>, String)> = Vec::new();
    if let Some(left) = &patch.left {
        for (i, text) in distribute_text(left, &left_nodes).into_iter().enumerate() {
            replacements.push((left_nodes[i], text));
        }
    }
    if let Some(right) = &patch.right {
        for (i, text) in distribute_text(right, &right_nodes).into_iter().enumerate() {
            replacements.push((right_nodes[i], text));
        }
    }
    replace_text_nodes(xml, &replacements)
}

/// Patch OMML leaf token text; the token count must stay unchanged.
pub fn patch_math_tokens(xml: &str, tokens: &[String]) -> String {
    let nodes = text_nodes(xml, "m:t");
    if nodes.is_empty() || nodes.len() != tokens.len() {
        return xml.to_owned();
    }
    let replacements: Vec<(&XmlTextNode<'_>, String)> = nodes
        .iter()
        .zip(tokens)
        .map(|(node, token)| (node, token.clone()))
        .collect();
    replace_text_nodes(xml, &replacements)
}

// ---- table cell text patching ----

/// One top-level segment, in UTF-8 byte offsets of the text scanned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XmlSegment {
    pub start: usize,
    pub end: usize,
}

/// Top-level segments of `tag` between [from, to), depth-aware for nesting.
pub fn xml_segments(xml: &str, tag: &str, from: usize, to: usize) -> Vec<XmlSegment> {
    let open_prefix = format!("<{tag}");
    let close_tag = format!("</{tag}>");
    let bytes = xml.as_bytes();
    let mut segs = Vec::new();
    let mut depth = 0i64;
    let mut seg_start = 0;
    let mut i = from;
    while i < to {
        let o = index_of(xml, &open_prefix, i).filter(|&o| o < to);
        let c = index_of(xml, &close_tag, i).filter(|&c| c < to);
        // a trailing self-closing element (Word's empty <w:p/>) has no close tag after it
        match (o, c) {
            (None, None) => break,
            (Some(o), c) if c.is_none_or(|c| o < c) => {
                let after = bytes.get(o + open_prefix.len()).copied();
                if !matches!(after, Some(b'>' | b' ' | b'/')) {
                    i = o + open_prefix.len(); // prefix of a longer tag (w:tr vs w:trPr)
                    continue;
                }
                let gt = index_of(xml, ">", o);
                if let Some(gt) = gt.filter(|&gt| gt > 0 && bytes[gt - 1] == b'/') {
                    if depth == 0 {
                        segs.push(XmlSegment {
                            start: o,
                            end: gt + 1,
                        });
                    }
                    i = gt + 1;
                    continue;
                }
                if depth == 0 {
                    seg_start = o;
                }
                depth += 1;
                i = o + open_prefix.len();
            }
            (_, Some(c)) => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                if depth == 0 {
                    segs.push(XmlSegment {
                        start: seg_start,
                        end: c + close_tag.len(),
                    });
                }
                i = c + close_tag.len();
            }
            (Some(_), None) => unreachable!("an open tag with no close tag takes the branch above"),
        }
    }
    segs
}

fn segment_texts<'a>(xml: &'a str, tag: &str, from: usize, to: usize) -> Vec<&'a str> {
    xml_segments(xml, tag, from, to)
        .into_iter()
        .map(|seg| &xml[seg.start..seg.end])
        .collect()
}

fn first_match<'t>(regex: &jscompat::JsRegex, text: &'t str) -> &'t str {
    regex.exec(text).map_or("", |m| m.as_str())
}

fn p_pr_of(p_xml: &str) -> &str {
    first_match(js_regex!(r"<w:pPr[\s\S]*?<\/w:pPr>|<w:pPr[^>]*\/>"), p_xml)
}

fn media_r_ids(xml: &str) -> Vec<&str> {
    js_regex!(
        r#"<(?:a:blip|v:imagedata)\b[^>]*\br:(?:embed|link|id)="([^"]+)""#,
        "g"
    )
    .find_iter(xml)
    .map(|m| m.get(1).unwrap_or_default())
    .collect()
}

const DRAWING_TAGS: [&str; 4] = ["mc:AlternateContent", "w:drawing", "w:pict", "w:object"];

/// Drawing payloads of a paragraph the run model cannot re-emit, carried over.
fn carried_runs_of(p_xml: &str, emitted_media: &[&str]) -> Result<String, RegexLimit> {
    // a payload is a twin of an emitted image when all its media is already
    // re-emitted and it carries no textbox text of its own
    let is_twin = |payload: &str| {
        let ids = media_r_ids(payload);
        !ids.is_empty()
            && ids.iter().all(|id| emitted_media.contains(id))
            && !js_regex!(r"<w:txbxContent[\s>]|<v:textbox[\s>]").test(payload)
    };
    segment_texts(p_xml, "w:r", 0, p_xml.len())
        .into_iter()
        .filter(|r| js_regex!(r"<wp:anchor[\s>]|<w:pict[\s>]|<w:object[\s>]").test(r))
        .map(|r| {
            let Some(open) = js_regex!(r"^<w:r(?:\s[^>]*)?>").exec(r) else {
                return Ok(String::new());
            };
            let from = open.end();
            let to = r.len().saturating_sub("</w:r>".len());
            let inner = if to > from { &r[from..to] } else { "" };
            let kept: String = split_xml_children(inner)?
                .into_iter()
                .filter(|(name, xml)| DRAWING_TAGS.contains(&name.as_str()) && !is_twin(xml))
                .map(|(_, xml)| xml)
                .collect();
            Ok(if kept.is_empty() {
                String::new()
            } else {
                format!("<w:r>{kept}</w:r>")
            })
        })
        .collect()
}

/// Rebuild one cell's paragraphs, keeping tcPr. `None` when the cell is too
/// complex to patch safely (nested table).
fn patch_cell_xml(
    tc_xml: &str,
    paras: &[Option<CellParaPatch>],
    part: &ContentControlPart,
) -> Result<Option<String>, RegexLimit> {
    if index_of(tc_xml, "<w:tbl", 1).is_some() {
        return Ok(None);
    }
    let Some(open_tag) = js_regex!(r"^<w:tc(?: [^>]*)?>").exec(tc_xml) else {
        return Ok(None);
    };
    let open_tag = open_tag.as_str();
    let tc_pr = first_match(
        js_regex!(r"<w:tcPr[\s\S]*?<\/w:tcPr>|<w:tcPr[^>]*\/>"),
        tc_xml,
    );
    let originals = segment_texts(tc_xml, "w:p", open_tag.len(), tc_xml.len());
    let first = originals.first().copied().unwrap_or("");
    let first_p_pr = p_pr_of(first);
    let first_run = first_match(js_regex!(r"<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>"), first);
    let r_pr = first_match(js_regex!(r"<w:rPr[\s\S]*?<\/w:rPr>"), first_run);
    // picture runs are not part of the text model; carry them over verbatim
    let drawing_runs: String = if tc_xml.contains("<w:drawing") {
        segment_texts(tc_xml, "w:r", 0, tc_xml.len())
            .into_iter()
            .filter(|r| r.contains("<w:drawing"))
            .collect()
    } else {
        String::new()
    };
    let aligned = paras.len() == originals.len();
    let mut body = String::new();
    for (i, entry) in paras.iter().enumerate() {
        match entry {
            None => body.push_str(originals.get(i).copied().unwrap_or("")),
            Some(CellParaPatch::Text(text)) => {
                let keep = if i == 0 { drawing_runs.as_str() } else { "" };
                if text.is_empty() {
                    body.push_str(&format!("<w:p>{first_p_pr}{keep}</w:p>"));
                } else {
                    body.push_str(&format!(
                        "<w:p>{first_p_pr}<w:r>{r_pr}{}</w:r>{keep}</w:p>",
                        cell_run_content_xml(text)
                    ));
                }
            }
            Some(CellParaPatch::Rich(rich)) => {
                let template = if originals.is_empty() {
                    ""
                } else {
                    originals[i.min(originals.len() - 1)]
                };
                let p_pr = match &rich.format {
                    Some(format) => {
                        merge_cell_para_format(p_pr_of(template), format, rich.original.as_ref())?
                    }
                    None => p_pr_of(template).to_owned(),
                };
                let emitted = match &rich.xml {
                    Some(xml) => xml.clone(),
                    None => runs_xml_in(&rich.runs, part)?,
                };
                let emitted_media = media_r_ids(&emitted);
                let keep = if aligned {
                    carried_runs_of(template, &emitted_media)?
                } else if i == 0 {
                    originals
                        .iter()
                        .map(|p| carried_runs_of(p, &emitted_media))
                        .collect::<Result<_, _>>()?
                } else {
                    String::new()
                };
                body.push_str(&format!("<w:p>{p_pr}{emitted}{keep}</w:p>"));
            }
        }
    }
    Ok(Some(format!("{open_tag}{tc_pr}{body}</w:tc>")))
}

/// Cell paragraph texts carry tabs/breaks as control chars; they go back as
/// real elements, not literal characters inside w:t.
fn cell_run_content_xml(text: &str) -> String {
    let control = |c: char| match c {
        '\t' => Some("<w:tab/>"),
        '\n' => Some("<w:br/>"),
        '\u{c}' => Some("<w:br w:type=\"page\"/>"),
        '\u{b}' => Some("<w:br w:type=\"column\"/>"),
        '\u{1e}' => Some("<w:br w:type=\"textWrapping\" w:clear=\"all\"/>"),
        '\u{2011}' => Some("<w:noBreakHyphen/>"),
        '\u{ad}' => Some("<w:softHyphen/>"),
        _ => None,
    };
    let mut out = String::new();
    let mut piece_start = 0;
    let flush = |out: &mut String, piece: &str| {
        if !piece.is_empty() {
            out.push_str(&format!(
                "<w:t xml:space=\"preserve\">{}</w:t>",
                escape_xml_text(piece)
            ));
        }
    };
    for (at, c) in text.char_indices() {
        if let Some(xml) = control(c) {
            flush(&mut out, &text[piece_start..at]);
            out.push_str(xml);
            piece_start = at + c.len_utf8();
        }
    }
    flush(&mut out, &text[piece_start..]);
    out
}

/// A rich cell paragraph: runs regenerated against its own original pPr.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CellRichPara {
    pub runs: Vec<Run>,
    /// pre-rendered run XML (fields etc.) used instead of runsXml(runs)
    #[serde(default)]
    pub xml: Option<String>,
    #[serde(default)]
    pub format: Option<ParaFormat>,
    #[serde(default)]
    pub original: Option<ParaFormat>,
}

/// One cell paragraph; `None` around it keeps the original paragraph bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CellParaPatch {
    Text(String),
    Rich(Box<CellRichPara>),
}

/// `texts[row][cell]` of patchTableCellTexts.
pub type TableTexts = Vec<Option<Vec<Option<CellTextsPatch>>>>;

/// Per-cell patch: paragraph patches, or nested-table cell texts by nested index.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CellTextsPatch {
    Paras(Vec<Option<CellParaPatch>>),
    Nested(NestedCellTexts),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NestedCellTexts {
    /// read by no code path of the TypeScript either
    #[serde(default)]
    pub paras: Option<Vec<String>>,
    #[serde(default)]
    pub nested: Option<Vec<Option<TableTexts>>>,
}

/// `patchTableCellTexts(tableXml, texts)`: replace cell texts inside a
/// <w:tbl> fragment, the content controls written from runs given way to by
/// the ids the fragment holds.
pub fn patch_table_cell_texts(
    table_xml: &str,
    texts: &[Option<Vec<Option<CellTextsPatch>>>],
) -> Result<String, RegexLimit> {
    let scope = ContentControlPart::new(&[table_xml], None);
    scope.finish(&patch_table_cell_texts_with(table_xml, texts, &scope)?)
}

/// `patchTableCellTexts(tableXml, texts, part)`: the fragment is a piece of
/// `part`, whose caller finishes it.
pub fn patch_table_cell_texts_with(
    table_xml: &str,
    texts: &[Option<Vec<Option<CellTextsPatch>>>],
    part: &ContentControlPart,
) -> Result<String, RegexLimit> {
    let mut out = String::new();
    let mut cursor = 0;
    for (r, tr) in xml_segments(table_xml, "w:tr", 0, table_xml.len())
        .into_iter()
        .enumerate()
    {
        let Some(Some(row_texts)) = texts.get(r) else {
            continue;
        };
        for (c, tc) in xml_segments(table_xml, "w:tc", tr.start, tr.end)
            .into_iter()
            .enumerate()
        {
            let Some(Some(entry)) = row_texts.get(c) else {
                continue;
            };
            let tc_xml = &table_xml[tc.start..tc.end];
            let patched = match entry {
                CellTextsPatch::Paras(paras) => patch_cell_xml(tc_xml, paras, part)?,
                CellTextsPatch::Nested(nested) => {
                    patch_nested_in_cell(tc_xml, nested.nested.as_deref(), part)?
                }
            };
            let Some(patched) = patched else { continue };
            out.push_str(&table_xml[cursor..tc.start]);
            out.push_str(&patched);
            cursor = tc.end;
        }
    }
    out.push_str(&table_xml[cursor..]);
    Ok(out)
}

/// Patch the cell's direct nested tables' cell texts.
fn patch_nested_in_cell(
    tc_xml: &str,
    nested: Option<&[Option<TableTexts>]>,
    part: &ContentControlPart,
) -> Result<Option<String>, RegexLimit> {
    let Some(nested) = nested.filter(|nested| !nested.is_empty()) else {
        return Ok(None);
    };
    let Some(open_tag) = js_regex!(r"^<w:tc(?: [^>]*)?>").exec(tc_xml) else {
        return Ok(None);
    };
    let tbl_segs = xml_segments(tc_xml, "w:tbl", open_tag.as_str().len(), tc_xml.len());
    if tbl_segs.is_empty() {
        return Ok(None);
    }
    let mut out = String::new();
    let mut cursor = 0;
    for (i, seg) in tbl_segs.into_iter().enumerate() {
        let Some(Some(grid)) = nested.get(i) else {
            continue;
        };
        out.push_str(&tc_xml[cursor..seg.start]);
        out.push_str(&patch_table_cell_texts_with(
            &tc_xml[seg.start..seg.end],
            grid,
            part,
        )?);
        cursor = seg.end;
    }
    out.push_str(&tc_xml[cursor..]);
    Ok(Some(out))
}

// ---- textbox paragraph patching ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextboxAlign {
    Left,
    Center,
    Right,
    Justify,
    Distribute,
}

impl TextboxAlign {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Center => "center",
            Self::Right => "right",
            Self::Justify => "justify",
            Self::Distribute => "distribute",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextboxNumPr {
    pub num_id: String,
    pub ilvl: JsNum,
}

/// Replacement content for one textbox paragraph.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextboxParaPatch {
    pub runs: Vec<Run>,
    #[serde(default, deserialize_with = "double_option")]
    pub align: Option<Option<TextboxAlign>>,
    #[serde(default, deserialize_with = "double_option")]
    pub num_pr: Option<Option<TextboxNumPr>>,
    #[serde(default, deserialize_with = "double_option")]
    pub indent_left: Option<Option<JsNum>>,
}

/// Plain text of one w:p fragment (w:t + tabs/breaks), for change detection.
pub(crate) fn para_plain_text(p_xml: &str) -> String {
    let mut out = String::new();
    let re = js_regex!(
        r"<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:tab>\s*<\/w:tab>|<w:br\/>|<w:cr\/>",
        "g"
    );
    for m in re.find_iter(p_xml) {
        let whole = m.as_str();
        if whole.starts_with("<w:tab") {
            out.push('\t');
        } else if whole == "<w:br/>" || whole == "<w:cr/>" {
            out.push('\n');
        } else {
            out.push_str(
                &m.get(1)
                    .unwrap_or_default()
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
                    .replace("&apos;", "'")
                    .replace("&amp;", "&"),
            );
        }
    }
    out
}

fn paired_p_pr(p_pr: &str) -> String {
    js_regex!(r"<w:pPr([^>]*)\/>").exec(p_pr).map_or_else(
        || p_pr.to_owned(),
        |m| {
            format!(
                "{}<w:pPr{}></w:pPr>{}",
                &p_pr[..m.start()],
                m.get(1).unwrap_or_default(),
                &p_pr[m.end()..]
            )
        },
    )
}

/// `text.slice(0, at) + insert + text.slice(at)` where `at` may be -1.
fn insert_at(text: &str, at: Option<usize>, insert: &str) -> String {
    let at = at.unwrap_or_else(|| text.char_indices().next_back().map_or(0, |(at, _)| at));
    format!("{}{insert}{}", &text[..at], &text[at..])
}

/// Set or clear w:numPr in a paragraph's pPr.
fn p_pr_with_num_pr(p_pr: &str, num_pr: Option<&TextboxNumPr>) -> String {
    let out = paired_p_pr(p_pr);
    let stripped = replace_first(js_regex!(r"<w:numPr>[\s\S]*?<\/w:numPr>"), &out, "");
    let stripped = replace_first(js_regex!(r"<w:numPr\/>"), &stripped, "");
    let Some(num_pr) = num_pr else {
        return if stripped == "<w:pPr></w:pPr>" {
            String::new()
        } else {
            stripped
        };
    };
    let num = format!(
        "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
        number_to_string(num_pr.ilvl.0),
        num_pr.num_id
    );
    let after_style = stripped
        .find("<w:pStyle ")
        .and_then(|style| index_of(&stripped, "/>", style));
    let at = match after_style {
        Some(after) => after + 2,
        None => match stripped.find('>') {
            Some(open) => open + 1,
            None => return format!("<w:pPr>{num}</w:pPr>"),
        },
    };
    insert_at(&stripped, Some(at), &num)
}

/// Set or clear the left indent on the paragraph's w:ind.
fn p_pr_with_ind_left(p_pr: &str, left: Option<f64>) -> String {
    let mut out = paired_p_pr(p_pr);
    let value = match left {
        None => String::new(),
        Some(left) => {
            let left = number_to_string(left);
            format!(" w:left=\"{left}\" w:leftChars=\"0\"")
        }
    };
    if let Some(ind) = js_regex!(r"<w:ind\b([^>]*)\/>").exec(&out) {
        let attrs = js_regex!(r#"\s+w:(left|start|leftChars|startChars)="[^"]*""#, "g")
            .replace_all(ind.get(1).unwrap_or_default(), |_| String::new());
        let next = format!("{attrs}{value}");
        let tag = if trim(&next).is_empty() {
            String::new()
        } else {
            format!("<w:ind{next}/>")
        };
        let (start, end) = (ind.start(), ind.end());
        out = format!("{}{tag}{}", &out[..start], &out[end..]);
    } else if left.is_some() {
        let tag = format!("<w:ind{value}/>");
        if out.is_empty() {
            return format!("<w:pPr>{tag}</w:pPr>");
        }
        let at = [out.find("<w:jc "), out.find("<w:rPr")]
            .into_iter()
            .flatten()
            .min();
        let at = at.or_else(|| out.rfind("</w:pPr>"));
        out = insert_at(&out, at, &tag);
    }
    if out == "<w:pPr></w:pPr>" {
        String::new()
    } else {
        out
    }
}

fn p_pr_with_jc(p_pr: &str, align: Option<TextboxAlign>) -> String {
    let out = replace_first(js_regex!(r"<w:jc [^>]*\/>"), &paired_p_pr(p_pr), "");
    let Some(align) = align else {
        return if out == "<w:pPr></w:pPr>" {
            String::new()
        } else {
            out
        };
    };
    let jc_val = if align == TextboxAlign::Justify {
        "both"
    } else {
        align.as_str()
    };
    let jc = format!("<w:jc w:val=\"{jc_val}\"/>");
    if out.is_empty() {
        return format!("<w:pPr>{jc}</w:pPr>");
    }
    // w:jc must precede the paragraph-mark rPr inside pPr
    let at = out.find("<w:rPr").or_else(|| out.rfind("</w:pPr>"));
    insert_at(&out, at, &jc)
}

/// Rebuild the paragraphs of one w:txbxContent.
fn patch_txbx_content(
    seg_xml: &str,
    paras: &[Option<TextboxParaPatch>],
    part: &ContentControlPart,
) -> Result<String, RegexLimit> {
    let Some(open) = js_regex!(r"^<w:txbxContent(?: [^>]*)?>").exec(seg_xml) else {
        return Ok(seg_xml.to_owned());
    };
    let open = open.as_str();
    let to = seg_xml.len().saturating_sub("</w:txbxContent>".len());
    let originals = segment_texts(seg_xml, "w:p", open.len(), to);
    if originals.is_empty() {
        return Ok(seg_xml.to_owned());
    }
    let mut out = String::from(open);
    for (i, patch) in paras.iter().enumerate() {
        let Some(patch) = patch else {
            if let Some(original) = originals.get(i) {
                out.push_str(original);
            }
            continue;
        };
        let template = originals[i.min(originals.len() - 1)];
        let mut p_pr = p_pr_of(template).to_owned();
        if let Some(num_pr) = &patch.num_pr {
            p_pr = p_pr_with_num_pr(&p_pr, num_pr.as_ref());
        }
        if let Some(indent_left) = patch.indent_left {
            p_pr = p_pr_with_ind_left(&p_pr, indent_left.map(|n| n.0));
        }
        if let Some(align) = patch.align {
            p_pr = p_pr_with_jc(&p_pr, align);
        }
        // no rel allocation inside textboxes
        out.push_str(&format!(
            "<w:p>{p_pr}{}</w:p>",
            runs_xml_in(&patch.runs, part)?
        ));
    }
    out.push_str("</w:txbxContent>");
    Ok(out)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeTextInject {
    pub shape_id: String,
    pub paras: Vec<TextboxParaPatch>,
}

/// Text patches for the anchored boxes of one paragraph fragment.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextboxParasPatchSet {
    #[serde(default)]
    pub by_index: Option<Vec<Option<Vec<Option<TextboxParaPatch>>>>>,
    #[serde(default)]
    pub inject: Option<Vec<ShapeTextInject>>,
}

/// Replace textbox paragraphs inside a paragraph fragment; fallback twins
/// take the patch of the preceding visible box.
pub fn patch_textbox_paras(
    paragraph_xml: &str,
    patches: &TextboxParasPatchSet,
) -> Result<String, RegexLimit> {
    let part = ContentControlPart::new(&[paragraph_xml], None);
    let by_index = patches.by_index.as_deref().unwrap_or_default();
    let segs = xml_segments(paragraph_xml, "w:txbxContent", 0, paragraph_xml.len());
    let mut xml = paragraph_xml.to_owned();
    if !segs.is_empty() && !by_index.is_empty() {
        let fallbacks: Vec<(usize, usize)> =
            js_regex!(r"<mc:Fallback>[\s\S]*?<\/mc:Fallback>", "g")
                .find_iter(paragraph_xml)
                .map(|m| (m.start(), m.end()))
                .collect();
        let in_fallback = |pos: usize| {
            fallbacks
                .iter()
                .any(|&(start, end)| pos >= start && pos < end)
        };
        let mut out = String::new();
        let mut cursor = 0;
        let mut ordinal = 0;
        let mut current: Option<&Vec<Option<TextboxParaPatch>>> = None;
        for seg in segs {
            if !in_fallback(seg.start) {
                current = by_index.get(ordinal).and_then(Option::as_ref);
                ordinal += 1;
            }
            let Some(paras) = current else { continue };
            out.push_str(&paragraph_xml[cursor..seg.start]);
            out.push_str(&patch_txbx_content(
                &paragraph_xml[seg.start..seg.end],
                paras,
                &part,
            )?);
            cursor = seg.end;
        }
        out.push_str(&paragraph_xml[cursor..]);
        xml = out;
    }
    for entry in patches.inject.as_deref().unwrap_or_default() {
        xml = inject_shape_text(&xml, entry, &part)?;
    }
    part.finish(&xml)
}

/// First text on a shape that has no <w:txbxContent>.
fn inject_shape_text(
    paragraph_xml: &str,
    entry: &ShapeTextInject,
    part: &ContentControlPart,
) -> Result<String, RegexLimit> {
    for seg in xml_segments(paragraph_xml, "wps:wsp", 0, paragraph_xml.len()) {
        let mut shape_xml = paragraph_xml[seg.start..seg.end].to_owned();
        let id = js_regex!(r#"<wps:cNvPr\b[^>]*\bid="([^"]+)""#)
            .exec(&shape_xml)
            .and_then(|m| m.get(1));
        if id != Some(entry.shape_id.as_str()) {
            continue;
        }
        if shape_xml.contains("<wps:txbx") {
            let Some(content) = xml_segments(&shape_xml, "w:txbxContent", 0, shape_xml.len())
                .into_iter()
                .next()
            else {
                return Ok(paragraph_xml.to_owned());
            };
            let paras: Vec<Option<TextboxParaPatch>> =
                entry.paras.iter().cloned().map(Some).collect();
            shape_xml = format!(
                "{}{}{}",
                &shape_xml[..content.start],
                patch_txbx_content(&shape_xml[content.start..content.end], &paras, part)?,
                &shape_xml[content.end..]
            );
        } else {
            let body: String = entry
                .paras
                .iter()
                .map(|p| {
                    let p_pr = p_pr_with_jc(
                        &p_pr_with_ind_left("", p.indent_left.flatten().map(|n| n.0)),
                        p.align.flatten(),
                    );
                    Ok(format!("<w:p>{p_pr}{}</w:p>", runs_xml_in(&p.runs, part)?))
                })
                .collect::<Result<_, RegexLimit>>()?;
            let txbx = format!("<wps:txbx><w:txbxContent>{body}</w:txbxContent></wps:txbx>");
            shape_xml = match js_regex!(r"<wps:bodyPr[\s/>]")
                .exec(&shape_xml)
                .map(|m| m.start())
            {
                None => shape_xml.replacen(
                    "</wps:wsp>",
                    &format!("{txbx}<wps:bodyPr anchor=\"ctr\"/></wps:wsp>"),
                    1,
                ),
                Some(at) => format!(
                    "{}{txbx}{}",
                    &shape_xml[..at],
                    replace_first(
                        js_regex!(r#"<wps:bodyPr\b(?![^>]*\banchor=")"#),
                        &shape_xml[at..],
                        "<wps:bodyPr anchor=\"ctr\""
                    )
                ),
            };
        }
        return Ok(format!(
            "{}{shape_xml}{}",
            &paragraph_xml[..seg.start],
            &paragraph_xml[seg.end..]
        ));
    }
    Ok(paragraph_xml.to_owned())
}
