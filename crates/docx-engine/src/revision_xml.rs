//! Accept / reject tracked changes in a raw WordprocessingML part
//! (packages/docx-engine/src/revision-xml.ts): headers, footers, footnotes,
//! endnotes, the parts the editor never loads as nodes. Word's Accept All
//! semantics on the markup itself: deleted runs leave, inserted runs stay
//! unwrapped, moved text stays only at its destination, property-change
//! records drop, a deleted paragraph mark joins the paragraph into the next
//! one, a deleted row goes.
//!
//! Every position an edit names is counted in UTF-16 code units, as the
//! TypeScript counts them; an element also keeps its byte offsets for slicing.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use jscompat::{JsRegex, js_regex, number_to_string, trim, truthy};
use serde::Serialize;
use serde_json::{Map, Value};

/// `RevisionXmlType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionXmlType {
    Insertion,
    Deletion,
    Formatting,
    Move,
}

impl RevisionXmlType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Insertion => "insertion",
            Self::Deletion => "deletion",
            Self::Formatting => "formatting",
            Self::Move => "move",
        }
    }
}

/// `RevisionXmlResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RevisionXmlResult<'a> {
    pub xml: Cow<'a, str>,
    /// revisions the mode was applied to
    pub applied: usize,
    /// revisions still in the part afterwards
    pub remaining: usize,
}

/// What `cleanMoveRangeMarkers` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CleanedMoveRanges<'a> {
    pub xml: Cow<'a, str>,
    pub removed: usize,
}

/// `PropChangeRecord`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropChangeRecord<'a> {
    pub author: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_utc: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<&'a str>,
    /// inner XML of the recorded previous properties (empty for records without one)
    pub old_xml: &'a str,
    /// w:cellMerge only: the merge state after / before the revision
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_merge: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_merge_orig: Option<&'a str>,
}

/// A position in the part: UTF-16 code units, and the byte offset of the same place.
#[derive(Debug, Clone, Copy)]
struct Pos {
    unit: usize,
    byte: usize,
}

/// `El`.
#[derive(Debug)]
struct El<'a> {
    name: &'a str,
    attrs: &'a str,
    start: Pos,
    end: Pos,
    inner_start: Pos,
    inner_end: Pos,
    self_closing: bool,
    parent: Option<usize>,
}

fn tag_re() -> &'static JsRegex {
    js_regex!(
        r"<(\/?)([A-Za-z][\w.-]*:?[\w.-]*)((?:\s+[^>]*?)?)(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>"
    )
}

/// `from` moved forward to the byte offset `byte`.
fn advance(xml: &str, from: Pos, byte: usize) -> Pos {
    let gap = xml.get(from.byte..byte).unwrap_or("");
    Pos {
        unit: from.unit + gap.chars().map(char::len_utf16).sum::<usize>(),
        byte,
    }
}

/// `scan`
fn scan(xml: &str) -> Vec<El<'_>> {
    let mut out: Vec<El<'_>> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut at = Pos { unit: 0, byte: 0 };
    for m in tag_re().find_iter(xml) {
        let Some(name) = m.get(2) else { continue };
        let start = advance(xml, at, m.start());
        let end = advance(xml, start, m.end());
        at = end;
        if !m.get(1).unwrap_or("").is_empty() {
            for i in (0..stack.len()).rev() {
                let index = stack[i];
                if out[index].name == name {
                    out[index].inner_end = start;
                    out[index].end = end;
                    stack.truncate(i);
                    break;
                }
            }
            continue;
        }
        let self_closing = !m.get(4).unwrap_or("").is_empty();
        out.push(El {
            name,
            attrs: m.get(3).unwrap_or(""),
            start,
            end,
            inner_start: end,
            inner_end: end,
            self_closing,
            parent: stack.last().copied(),
        });
        if !self_closing {
            stack.push(out.len() - 1);
        }
    }
    out
}

/// `attrOf`: an attribute of a tag, in either quote. It walks the tag, so text
/// inside another value is not taken for it.
fn attr_of<'a>(el: &El<'a>, name: &str) -> Option<&'a str> {
    js_regex!(r#"([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "g")
        .find_iter(el.attrs)
        .find(|found| found.get(1) == Some(name))
        .and_then(|found| found.get(2).or(found.get(3)))
}

fn author_of<'a>(el: &El<'a>) -> Option<&'a str> {
    attr_of(el, "w:author")
}

fn date_of<'a>(el: &El<'a>) -> Option<&'a str> {
    attr_of(el, "w:date")
}

fn id_of<'a>(el: &El<'a>) -> Option<&'a str> {
    attr_of(el, "w:id")
}

/// `PROP_CHANGE[name]` for its own keys. An inherited name (`constructor`)
/// answers in JavaScript, but every use of the answer then behaves as for an
/// absent one: no element name equals a function.
fn prop_change(name: &str) -> Option<&'static str> {
    match name {
        "w:rPrChange" => Some("w:rPr"),
        "w:pPrChange" => Some("w:pPr"),
        "w:sectPrChange" => Some("w:sectPr"),
        "w:tblPrChange" => Some("w:tblPr"),
        "w:tblPrExChange" => Some("w:tblPrEx"),
        "w:trPrChange" => Some("w:trPr"),
        "w:tcPrChange" => Some("w:tcPr"),
        "w:tblGridChange" => Some("w:tblGrid"),
        _ => None,
    }
}

/// `RANGE_MARKERS.has(name)`
fn is_range_marker(name: &str) -> bool {
    matches!(
        name,
        "w:moveFromRangeStart" | "w:moveFromRangeEnd" | "w:moveToRangeStart" | "w:moveToRangeEnd"
    )
}

/// `typeOf`: what a revision element records; `None` = not a revision
fn type_of(el: &El<'_>) -> Option<RevisionXmlType> {
    match el.name {
        "w:ins" | "w:cellIns" => Some(RevisionXmlType::Insertion),
        "w:del" | "w:cellDel" => Some(RevisionXmlType::Deletion),
        "w:moveFrom" | "w:moveTo" => Some(RevisionXmlType::Move),
        "w:numberingChange" | "w:cellMerge" => Some(RevisionXmlType::Formatting),
        name => prop_change(name).map(|_| RevisionXmlType::Formatting),
    }
}

/// The fields of a filter as JavaScript reads them: only an object has any.
fn filter_fields(filter: Option<&Value>) -> Option<&Map<String, Value>> {
    match filter {
        Some(Value::Object(fields)) => Some(fields),
        _ => None,
    }
}

/// `String(value)` of a JSON value.
fn js_string(value: &Value) -> Cow<'_, str> {
    match value {
        Value::String(text) => Cow::Borrowed(text),
        Value::Null => Cow::Borrowed("null"),
        Value::Bool(flag) => Cow::Borrowed(if *flag { "true" } else { "false" }),
        Value::Number(number) => Cow::Owned(number_to_string(number.as_f64().unwrap_or(f64::NAN))),
        Value::Array(items) => {
            let mut out = String::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if !item.is_null() {
                    out.push_str(&js_string(item));
                }
            }
            Cow::Owned(out)
        }
        Value::Object(_) => Cow::Borrowed("[object Object]"),
    }
}

/// `matches`; `Err` where the TypeScript throws on a filter field of the wrong type.
fn matches(
    el: &El<'_>,
    filter: Option<&Map<String, Value>>,
    ty: RevisionXmlType,
) -> Result<bool, String> {
    let Some(filter) = filter else {
        return Ok(true);
    };
    if let Some(wanted) = filter.get("type")
        && wanted.as_str() != Some(ty.as_str())
    {
        return Ok(false);
    }
    if let Some(wanted) = filter.get("author") {
        let author = author_of(el).unwrap_or("");
        let Value::String(wanted) = wanted else {
            return Err("TypeError: filter.author.toLowerCase is not a function".to_owned());
        };
        if author.to_lowercase() != wanted.to_lowercase() {
            return Ok(false);
        }
    }
    if let Some(before) = filter.get("before") {
        // `revisionDateBefore`: a w:date that is no date is never before
        let before_ms = revision_date_ms(&js_string(before));
        if !date_of(el).is_some_and(|date| revision_date_ms(date) < before_ms) {
            return Ok(false);
        }
    }
    if let Some(wanted) = filter.get("date")
        && wanted.as_str() != Some(date_of(el).unwrap_or(""))
    {
        return Ok(false);
    }
    if let Some(ids) = filter.get("ids") {
        let id = id_of(el).unwrap_or("");
        let found = match ids {
            Value::Array(ids) => ids.iter().any(|candidate| candidate.as_str() == Some(id)),
            // String.prototype.includes
            Value::String(ids) => ids.contains(id),
            _ => return Err("TypeError: filter.ids.includes is not a function".to_owned()),
        };
        if !found {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `Edit`: a replacement of the UTF-16 range `start..end`.
#[derive(Debug)]
struct Edit<'a> {
    start: usize,
    end: usize,
    text: Cow<'a, str>,
}

const DROP: Cow<'static, str> = Cow::Borrowed("");

/// `parentOf`
fn parent_of<'e, 'a>(els: &'e [El<'a>], el: &El<'a>) -> Option<&'e El<'a>> {
    el.parent.and_then(|index| els.get(index))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerSlot {
    ParaMark,
    Row,
    Other,
}

/// `markerSlot`: `w:ins` / `w:del` carry the paragraph-mark and row-level
/// records as empty elements
fn marker_slot(els: &[El<'_>], el: &El<'_>) -> Option<MarkerSlot> {
    if !el.self_closing {
        return None;
    }
    let Some(parent) = parent_of(els, el) else {
        return Some(MarkerSlot::Other);
    };
    if parent.name == "w:trPr" {
        return Some(MarkerSlot::Row);
    }
    if parent.name == "w:rPr" && parent_of(els, parent).is_some_and(|p| p.name == "w:pPr") {
        return Some(MarkerSlot::ParaMark);
    }
    Some(MarkerSlot::Other)
}

/// `ancestor`, as an index
fn ancestor(els: &[El<'_>], el: &El<'_>, name: &str) -> Option<usize> {
    let mut at = el.parent;
    while let Some(index) = at {
        let p = els.get(index)?;
        if p.name == name {
            return Some(index);
        }
        at = p.parent;
    }
    None
}

/// `children`: a child always comes after its parent.
fn children<'e, 'a>(
    els: &'e [El<'a>],
    index: usize,
) -> impl Iterator<Item = (usize, &'e El<'a>)> + 'e {
    els.iter()
        .enumerate()
        .skip(index + 1)
        .filter(move |(_, c)| c.parent == Some(index))
}

/// `childOf`
fn child_of<'e, 'a>(els: &'e [El<'a>], index: usize, name: &str) -> Option<&'e El<'a>> {
    children(els, index)
        .map(|(_, c)| c)
        .find(|c| c.name == name)
}

/// `nextParagraph`: the paragraph right after `p` in the same parent (markers
/// like bookmarkEnd may sit between)
fn next_paragraph(els: &[El<'_>], p_index: usize) -> Option<usize> {
    let p = els.get(p_index)?;
    for (i, c) in els.iter().enumerate().skip(p_index + 1) {
        if c.start.unit < p.end.unit {
            continue;
        }
        if c.parent != p.parent {
            return None;
        }
        if c.name == "w:p" {
            return Some(i);
        }
        if !js_regex!(r"^w:(bookmark|commentRange|permStart|permEnd|proofErr)").test(c.name) {
            return None;
        }
    }
    None
}

/// `mergeEdits`: join `p` into the following paragraph: `p` keeps its
/// properties, the next paragraph's open tag and pPr go
fn merge_edits<'a>(els: &[El<'_>], p_index: usize) -> Option<[Edit<'a>; 2]> {
    let next_index = next_paragraph(els, p_index)?;
    let next = &els[next_index];
    if next.self_closing {
        return None;
    }
    let p = &els[p_index];
    let next_p_pr = child_of(els, next_index, "w:pPr");
    let close_start = p.inner_end.unit;
    Some([
        Edit {
            start: close_start,
            end: p.end.unit,
            text: DROP,
        },
        Edit {
            start: next.start.unit,
            end: next_p_pr.map_or(next.inner_start.unit, |pr| pr.end.unit),
            text: DROP,
        },
    ])
}

/// `unwrap`
fn unwrap<'a>(el: &El<'_>) -> [Edit<'a>; 2] {
    [
        Edit {
            start: el.start.unit,
            end: el.inner_start.unit,
            text: DROP,
        },
        Edit {
            start: el.inner_end.unit,
            end: el.end.unit,
            text: DROP,
        },
    ]
}

/// `remove`
fn remove<'a>(el: &El<'_>) -> Edit<'a> {
    Edit {
        start: el.start.unit,
        end: el.end.unit,
        text: DROP,
    }
}

/// `removeMarker`: drop an empty marker element; an rPr / trPr / pPr it
/// leaves empty goes with it
fn remove_marker<'a>(els: &[El<'_>], index: usize) -> Edit<'a> {
    let mut target = index;
    while let Some(parent) = els[target].parent {
        if !js_regex!(r"^w:(?:rPr|trPr|pPr)$").test(els[parent].name)
            || children(els, parent).nth(1).is_some()
        {
            break;
        }
        target = parent;
    }
    remove(&els[target])
}

/// `xml.slice(start, end)` over byte offsets of tag boundaries
fn slice(xml: &str, start: Pos, end: Pos) -> &str {
    xml.get(start.byte..end.byte).unwrap_or("")
}

/// `revertPropChange`: restore the pre-change properties recorded in a
/// *Change element
fn revert_prop_change<'a>(
    els: &[El<'a>],
    xml: &'a str,
    change_index: usize,
    edits: &mut Vec<Edit<'a>>,
) {
    let change = &els[change_index];
    let holder_index = change.parent.filter(|&index| index < els.len());
    let (Some(holder_name), Some(holder_index)) = (prop_change(change.name), holder_index) else {
        edits.push(remove(change));
        return;
    };
    let holder = &els[holder_index];
    if holder.name != holder_name {
        edits.push(remove(change));
        return;
    }
    let old = children(els, change_index)
        .map(|(_, c)| c)
        .find(|c| c.name == holder_name);
    let old_inner = old.map_or("", |old| slice(xml, old.inner_start, old.inner_end));
    if holder_name == "w:pPr" {
        // the paragraph mark's rPr and the sectPr are not part of the record: keep them in place
        let keep_from = children(els, holder_index)
            .find(|&(i, c)| c.name == "w:rPr" || c.name == "w:sectPr" || i == change_index)
            .map_or(change, |(_, c)| c);
        // The record opens the holder: the paragraph has no property of its
        // own left and nothing stands before the record. The TypeScript plans
        // the old properties as an insertion where the record starts and the
        // removal of the record at the same place, and its applyEdits drops
        // the insertion as overlapping, so the old properties are lost. Here
        // the record is replaced by them
        // (divergences.json: `reject-of-a-ppr-change-that-opens-its-ppr`).
        if holder.inner_start.unit == change.start.unit {
            edits.push(Edit {
                start: change.start.unit,
                end: change.end.unit,
                text: Cow::Borrowed(old_inner),
            });
            return;
        }
        edits.push(Edit {
            start: holder.inner_start.unit,
            end: keep_from.start.unit,
            text: Cow::Borrowed(old_inner),
        });
        edits.push(Edit {
            start: change.start.unit,
            end: change.end.unit,
            text: DROP,
        });
        return;
    }
    if holder_name == "w:sectPr" {
        let mut refs: String = children(els, holder_index)
            .filter(|(_, c)| c.name == "w:headerReference" || c.name == "w:footerReference")
            .map(|(_, c)| slice(xml, c.start, c.end))
            .collect();
        refs.push_str(old_inner);
        edits.push(Edit {
            start: holder.inner_start.unit,
            end: holder.inner_end.unit,
            text: Cow::Owned(refs),
        });
        return;
    }
    // the holder's own tracked markers (paragraph-mark / row ins, del, move) are
    // separate revisions: edit around them so their own removal in the same pass
    // is not swallowed by a whole-holder replacement
    let is_marker = |c: &El<'_>| {
        c.self_closing
            && js_regex!(r"^w:(?:ins|del|moveFrom|moveTo|cellIns|cellDel|cellMerge)$").test(c.name)
    };
    if children(els, holder_index).any(|(_, c)| is_marker(c)) {
        edits.extend(
            children(els, holder_index)
                .filter(|(_, c)| !is_marker(c))
                .map(|(_, c)| remove(c)),
        );
        edits.push(Edit {
            start: holder.inner_end.unit,
            end: holder.inner_end.unit,
            text: Cow::Borrowed(old_inner),
        });
        return;
    }
    if trim(old_inner).is_empty() && holder_name != "w:tblPr" && holder_name != "w:tblGrid" {
        edits.push(remove(holder));
        return;
    }
    edits.push(Edit {
        start: holder.inner_start.unit,
        end: holder.inner_end.unit,
        text: Cow::Borrowed(old_inner),
    });
}

/// `act` of `planEdits`
fn act<'a>(els: &[El<'a>], index: usize, drop: bool, mode: &str, edits: &mut Vec<Edit<'a>>) {
    let el = &els[index];
    match marker_slot(els, el) {
        Some(MarkerSlot::ParaMark) => {
            let p = if drop { ancestor(els, el, "w:p") } else { None };
            let merged = p.and_then(|p| merge_edits(els, p));
            edits.push(remove_marker(els, index));
            edits.extend(merged.into_iter().flatten());
            return;
        }
        Some(MarkerSlot::Row) => {
            let row = ancestor(els, el, "w:tr");
            edits.push(match row {
                Some(row) if drop => remove(&els[row]),
                _ => remove_marker(els, index),
            });
            return;
        }
        Some(MarkerSlot::Other) => {
            edits.push(remove_marker(els, index));
            return;
        }
        None => {}
    }
    if drop {
        edits.push(remove(el));
        return;
    }
    edits.extend(unwrap(el));
    if mode == "reject" {
        // the deleted runs come back as live text
        let inner_end = el.inner_end.unit;
        for c in els[index + 1..]
            .iter()
            .take_while(|c| c.start.unit < inner_end)
        {
            let live = match c.name {
                "w:delText" => "w:t",
                "w:delInstrText" => "w:instrText",
                _ => continue,
            };
            // a tag name is ASCII: its length in bytes is its length in code units
            let length = c.name.len();
            edits.push(Edit {
                start: c.start.unit + 1,
                end: c.start.unit + 1 + length,
                text: Cow::Borrowed(live),
            });
            if !c.self_closing {
                edits.push(Edit {
                    start: c.inner_end.unit + 2,
                    end: c.inner_end.unit + 2 + length,
                    text: Cow::Borrowed(live),
                });
            }
        }
    }
}

/// `planEdits`
fn plan_edits<'a>(
    els: &[El<'a>],
    xml: &'a str,
    mode: &str,
    filter: Option<&Map<String, Value>>,
) -> Result<(Vec<Edit<'a>>, usize), String> {
    let mut edits: Vec<Edit<'a>> = Vec::new();
    let mut applied = 0;
    // the end marker of a move range carries no author / date: it goes with its start (same w:id)
    let mut start_ids: HashSet<&str> = HashSet::new();
    for el in els {
        if !is_range_marker(el.name) {
            continue;
        }
        let id = id_of(el).unwrap_or("");
        if el.name.ends_with("Start") {
            if matches(el, filter, RevisionXmlType::Move)? {
                start_ids.insert(id);
                edits.push(remove(el));
            }
        } else if start_ids.contains(id) || matches(el, filter, RevisionXmlType::Move)? {
            edits.push(remove(el));
        }
    }
    for (index, el) in els.iter().enumerate() {
        if is_range_marker(el.name) {
            continue;
        }
        let Some(ty) = type_of(el) else { continue };
        if !matches(el, filter, ty)? {
            continue;
        }
        applied += 1;
        match el.name {
            "w:ins" | "w:moveTo" => act(els, index, mode == "reject", mode, &mut edits),
            "w:del" | "w:moveFrom" => act(els, index, mode == "accept", mode, &mut edits),
            "w:cellIns" | "w:cellDel" | "w:numberingChange" | "w:cellMerge" => {
                edits.push(remove(el));
            }
            _ => {
                if mode == "accept" {
                    edits.push(remove(el));
                } else {
                    revert_prop_change(els, xml, index, &mut edits);
                }
            }
        }
    }
    Ok((edits, applied))
}

/// The byte offset of the UTF-16 offset `unit`, walking forward from `cursor`
/// (unit, byte); `None` inside a surrogate pair or past the end.
fn byte_at(xml: &str, cursor: &mut (usize, usize), unit: usize) -> Option<usize> {
    while cursor.0 < unit {
        let c = xml.get(cursor.1..)?.chars().next()?;
        cursor.0 += c.len_utf16();
        cursor.1 += c.len_utf8();
    }
    (cursor.0 == unit).then_some(cursor.1)
}

/// `applyEdits`
fn apply_edits(xml: &str, mut edits: Vec<Edit<'_>>) -> String {
    // at one start, insertions (zero length) first in plan order, then the
    // longest replacement: an insertion where a replacement starts is kept
    edits.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then((a.end != a.start).cmp(&(b.end != b.start)))
            .then(b.end.cmp(&a.end))
    });
    // an edit inside a region another edit replaces is moot
    let mut cutoff: Option<usize> = None;
    edits.retain(|e| {
        if cutoff.is_some_and(|cutoff| e.start < cutoff) {
            return false;
        }
        cutoff = Some(cutoff.map_or(e.end, |cutoff| cutoff.max(e.end)));
        true
    });
    // The kept edits are applied from the last one back. Where every range is
    // in order and falls on characters of the text, that is one pass forward.
    let mut cursor = (0, 0);
    let mut ranges = Vec::with_capacity(edits.len());
    for e in &edits {
        let range = if e.start <= e.end {
            byte_at(xml, &mut cursor, e.start)
                .and_then(|start| Some((start, byte_at(xml, &mut cursor, e.end)?)))
        } else {
            None
        };
        let Some(range) = range else {
            return apply_edits_by_unit(xml, &edits);
        };
        ranges.push(range);
    }
    let mut out = String::with_capacity(xml.len());
    let mut copied = 0;
    for (e, (start, end)) in edits.iter().zip(ranges) {
        out.push_str(&xml[copied..start]);
        out.push_str(&e.text);
        copied = end;
    }
    out.push_str(&xml[copied..]);
    out
}

/// `applyEdits` code unit by code unit, for an edit past the end of the text,
/// inside a surrogate pair or with its end before its start. A lone surrogate
/// it leaves becomes U+FFFD: a Rust string cannot hold one.
fn apply_edits_by_unit(xml: &str, edits: &[Edit<'_>]) -> String {
    let mut out: Vec<u16> = xml.encode_utf16().collect();
    for e in edits.iter().rev() {
        let length = out.len();
        let start = e.start.min(length);
        let end = e.end.min(length);
        let mut next = Vec::with_capacity(start + e.text.len() + (length - end));
        next.extend_from_slice(&out[..start]);
        next.extend(e.text.encode_utf16());
        next.extend_from_slice(&out[end..]);
        out = next;
    }
    String::from_utf16_lossy(&out)
}

/// `text.replace(pattern, '')` with the `g` flag; the text itself where nothing matches.
fn replace_with_nothing(text: String, pattern: &JsRegex) -> String {
    if pattern.test(&text) {
        pattern.replace_all(&text, |_| String::new())
    } else {
        text
    }
}

/// `countTrackedChangesXml`: pending tracked changes in a part (range markers not counted)
pub fn count_tracked_changes_xml(xml: &str) -> usize {
    if !js_regex!(
        r"<w:(?:ins|del|moveFrom|moveTo|cellIns|cellDel|cellMerge|numberingChange|\w+Change)[\s/>]"
    )
    .test(xml)
    {
        return 0;
    }
    scan(xml).iter().filter(|el| type_of(el).is_some()).count()
}

/// `checkFilter`: a `before` the engine can compare against is a string that
/// is a date; anything else is refused, by name, before a part is touched.
fn check_filter(filter: Option<&Value>) -> Result<(), String> {
    let Some(before) = filter
        .and_then(Value::as_object)
        .and_then(|f| f.get("before"))
    else {
        return Ok(());
    };
    match before {
        Value::String(text) if !revision_date_ms(text).is_nan() => Ok(()),
        _ => Err(format!(
            "Error: revision filter: before must be an ISO date such as 2026-09-01 or 2026-09-01T12:00:00Z, got {}",
            serde_json::to_string(before).unwrap_or_default()
        )),
    }
}

/// `revisionDateMs`: epoch ms of a revision date, NaN when it is no date. An
/// ISO date-time without a zone designator is UTC; any other form is read as
/// `Date.parse` reads it.
pub fn revision_date_ms(iso: &str) -> f64 {
    let s = trim(iso);
    let Some(date_time) = js_regex!(
        r"^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d(?::?\d\d)?)?$",
        "i"
    )
    .exec(s) else {
        return jscompat::date_parse(s);
    };
    let t = s.replacen(' ', "T", 1);
    if date_time.get(1).is_some() {
        jscompat::date_parse(&t)
    } else {
        jscompat::date_parse(&format!("{t}Z"))
    }
}

/// `applyTrackedChangesXml`. `mode` is any string, as at run time: one that is
/// neither `accept` nor `reject` unwraps every change and reverts every record.
/// `filter` is the JSON value the TypeScript receives; `Err` where it throws.
pub fn apply_tracked_changes_xml<'a>(
    xml: &'a str,
    mode: &str,
    filter: Option<&Value>,
) -> Result<RevisionXmlResult<'a>, String> {
    check_filter(filter)?;
    if count_tracked_changes_xml(xml) == 0 {
        // nothing countable is left, but a part whose move markup lost its partner
        // (the move was resolved earlier, e.g. in the body) still gets the orphan
        // markers back instead of shipping markup Word never resolves
        let cleaned = clean_move_range_markers(xml);
        return Ok(RevisionXmlResult {
            xml: cleaned.xml,
            applied: 0,
            remaining: 0,
        });
    }
    let els = scan(xml);
    let (edits, applied) = plan_edits(&els, xml, mode, filter_fields(filter))?;
    // a property holder emptied by independent edits (markers and record both resolved) goes
    let out: Cow<'a, str> = if edits.is_empty() {
        Cow::Borrowed(xml)
    } else {
        Cow::Owned(replace_with_nothing(
            apply_edits(xml, edits),
            js_regex!(r"<w:(rPr|trPr)><\/w:\1>"),
        ))
    };
    let cleaned = match clean_move_range_markers(&out).xml {
        Cow::Owned(cleaned) => Some(cleaned),
        Cow::Borrowed(_) => None,
    };
    let xml = cleaned.map_or(out, Cow::Owned);
    let remaining = count_tracked_changes_xml(&xml);
    Ok(RevisionXmlResult {
        xml,
        applied,
        remaining,
    })
}

/// `applyRevisionResolutions`: the editor's accept / reject decisions replayed
/// on the part's original bytes. `resolutions` is the JSON value the
/// TypeScript receives: `for...of` over it, `Err` where that throws.
pub fn apply_revision_resolutions<'a>(
    xml: &'a str,
    resolutions: Option<&Value>,
) -> Result<Cow<'a, str>, String> {
    let mut out = Cow::Borrowed(xml);
    let apply = |out: &mut Cow<'a, str>, mode: &str, filter: Option<&Value>| {
        let next = match apply_tracked_changes_xml(out, mode, filter)?.xml {
            Cow::Owned(next) => Some(next),
            Cow::Borrowed(_) => None,
        };
        if let Some(next) = next {
            *out = Cow::Owned(next);
        }
        Ok::<(), String>(())
    };
    match resolutions {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            for r in items {
                match r {
                    Value::Null => {
                        return Err(
                            "TypeError: Cannot read properties of null (reading 'mode')".to_owned()
                        );
                    }
                    Value::Object(fields) => apply(
                        &mut out,
                        fields.get("mode").and_then(Value::as_str).unwrap_or(""),
                        fields.get("filter"),
                    )?,
                    // a primitive has neither property
                    _ => apply(&mut out, "", None)?,
                }
            }
        }
        // a string iterates by code point, each one without mode or filter
        Some(Value::String(text)) => {
            for _ in text.chars() {
                apply(&mut out, "", None)?;
            }
        }
        Some(_) => return Err("TypeError: resolutions is not iterable".to_owned()),
    }
    Ok(out)
}

/// `xml.includes('<' + name)`
fn includes_open(xml: &str, name: &str) -> bool {
    xml.match_indices('<')
        .any(|(at, _)| xml[at + 1..].starts_with(name))
}

/// `readPropChangeXml`: the first `change_name` record (w:tblPrChange,
/// w:trPrChange, w:tcPrChange, w:tblGridChange, w:tblPrExChange,
/// w:sectPrChange, w:numberingChange, w:cellMerge) in a property fragment.
pub fn read_prop_change_xml<'a>(xml: &'a str, change_name: &str) -> Option<PropChangeRecord<'a>> {
    if !includes_open(xml, change_name) {
        return None;
    }
    let els = scan(xml);
    let change_index = els.iter().position(|el| el.name == change_name)?;
    let change = &els[change_index];
    let old =
        prop_change(change_name).and_then(|holder_name| child_of(&els, change_index, holder_name));
    Some(PropChangeRecord {
        author: author_of(change).unwrap_or(""),
        date: truthy(date_of(change)),
        date_utc: truthy(attr_of(change, "w16du:dateUtc")),
        id: truthy(id_of(change)),
        old_xml: old.map_or("", |old| slice(xml, old.inner_start, old.inner_end)),
        v_merge: truthy(attr_of(change, "w:vMerge")),
        v_merge_orig: truthy(attr_of(change, "w:vMergeOrig")),
    })
}

/// `resolvePropChangeXml`: resolve one property-change record inside a
/// property fragment (a raw tblPr / trPr / tcPr / tblGrid / tblPrEx /
/// pPr-with-sectPr slice): accept drops the record, reject puts the recorded
/// previous properties back. Records without a previous-properties payload
/// (numberingChange, cellMerge) just drop.
pub fn resolve_prop_change_xml<'a>(xml: &'a str, change_name: &str, mode: &str) -> Cow<'a, str> {
    if !includes_open(xml, change_name) {
        return Cow::Borrowed(xml);
    }
    let els = scan(xml);
    let Some(change_index) = els.iter().position(|el| el.name == change_name) else {
        return Cow::Borrowed(xml);
    };
    let mut edits = Vec::new();
    // an inherited name (`constructor`) is truthy in PROP_CHANGE and reverts,
    // which removes the record all the same
    if mode == "accept" || prop_change(change_name).is_none() {
        edits.push(remove(&els[change_index]));
    } else {
        revert_prop_change(&els, xml, change_index, &mut edits);
    }
    Cow::Owned(replace_with_nothing(
        apply_edits(xml, edits),
        js_regex!(r"<w:(rPr|trPr|tcPr|tblPrEx)><\/w:\1>"),
    ))
}

/// `cleanMoveRangeMarkers`: drop orphaned move-range markers: an end whose
/// start is gone, and defensively a start whose end is gone. A range pairs by
/// side and w:id, and an end closes the nearest still-open start of its side.
/// The order markers are dropped in does not matter: the edits are sorted.
pub fn clean_move_range_markers(xml: &str) -> CleanedMoveRanges<'_> {
    if !js_regex!(r"<w:move(?:From|To)Range(?:Start|End)[\s/>]").test(xml) {
        return CleanedMoveRanges {
            xml: Cow::Borrowed(xml),
            removed: 0,
        };
    }
    let els = scan(xml);
    let mut open: HashMap<(bool, &str), Vec<usize>> = HashMap::new();
    let mut dropped: Vec<usize> = Vec::new();
    for (index, el) in els.iter().enumerate() {
        if !is_range_marker(el.name) {
            continue;
        }
        let from_side = el.name.starts_with("w:moveFrom");
        let id = js_regex!(r#"\bw:id\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
            .exec(el.attrs)
            .and_then(|found| found.get(1).or(found.get(2)))
            .unwrap_or("");
        if el.name.ends_with("Start") {
            open.entry((from_side, id)).or_default().push(index);
        } else {
            // an end pairs with the nearest still-open start of the same side and
            // w:id; a shared id across moveFrom / moveTo is two independent ranges
            let start = open.get_mut(&(from_side, id)).and_then(Vec::pop);
            if start.is_none() {
                dropped.push(index);
            }
        }
    }
    for stack in open.into_values() {
        dropped.extend(stack);
    }
    if dropped.is_empty() {
        return CleanedMoveRanges {
            xml: Cow::Borrowed(xml),
            removed: 0,
        };
    }
    let removed = dropped.len();
    let edits = dropped.iter().map(|&index| remove(&els[index])).collect();
    CleanedMoveRanges {
        xml: Cow::Owned(apply_edits(xml, edits)),
        removed,
    }
}
