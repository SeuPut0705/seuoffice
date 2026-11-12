//! The complex fields of a header/footer part, rewritten for display: PAGE,
//! NUMPAGES and SECTIONPAGES become private-use markers.
//! Offsets are byte offsets of the part text.

use jscompat::js_regex;

use crate::package::Thrown;

/// `TOTAL_PAGES_MARK`: placeholder for NUMPAGES (total pages) fields.
pub const TOTAL_PAGES_MARK: char = '\u{E000}';
/// `PAGE_MARK`
pub const PAGE_MARK: char = '\u{E001}';
/// `SECTION_PAGES_MARK`
pub const SECTION_PAGES_MARK: char = '\u{E002}';

/// How many fields deep a result may hold fields that render. The field
/// markers of a part are siblings in the XML, so no XML depth limit applies,
/// and the TypeScript recurses once per level until V8's stack runs out, a
/// RangeError nothing catches: the part, and with it the document, fails. A
/// real part nests two or three. The wasm stack runs out at about 3 000
/// levels, so the Rust recursion stops at this bound and fails with that same
/// error instead.
const MAX_FIELD_RENDER_DEPTH: usize = 500;

/// What V8 throws when a recursion outgrows its stack.
const STACK_OVERFLOW: &str = "RangeError: Maximum call stack size exceeded";

/// `FieldFrame`: a complex field in the part XML: its own span, its own
/// instruction text and the fields nested inside it (by index into the
/// [`FieldTree`]).
#[derive(Debug, Clone)]
pub struct FieldFrame {
    /// where the begin element starts
    pub start: usize,
    /// where the end element ends; -1 while the field is not closed
    pub end: isize,
    /// the field's own instruction text (its own instrText runs only)
    pub instr: String,
    /// where the field's own separate element starts; -1 when it has none
    pub separate_start: isize,
    /// where the field's own separate element ends; -1 when it has none
    pub separate_end: isize,
    /// the fields nested inside this one, in the order they appear
    pub children: Vec<usize>,
}

/// The fields of a part: every frame, and the ones outside any other.
#[derive(Debug, Default)]
pub struct FieldTree {
    pub frames: Vec<FieldFrame>,
    pub roots: Vec<usize>,
}

/// `parseFieldTree`: the complex fields of a part, as a tree. A field's span
/// runs from its begin to the end that closes it, counting the nested fields,
/// so a child's end does not close the parent (genoffice#2458). Each field
/// carries only its own instruction text: a nested child's instruction belongs
/// to the child.
pub fn parse_field_tree(xml: &str) -> FieldTree {
    let mut tree = FieldTree::default();
    let mut stack: Vec<usize> = Vec::new();
    // the field tokens of a part: the fldChar markers and the instruction runs
    for found in js_regex!(
        r"<w:fldChar\b[^>]*?\/>|<w:fldChar\b[^>]*?>\s*<\/w:fldChar>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>",
        "g"
    )
    .find_iter(xml)
    {
        let token = found.as_str();
        let at = found.start();
        if token.starts_with("<w:instrText") {
            if let Some(&top) = stack.last() {
                let text = js_regex!(r"<[^>]+>", "g").replace_all(token, |_| String::new());
                tree.frames[top].instr.push_str(&text);
            }
            continue;
        }
        let kind = js_regex!(r#"\bw:fldCharType\s*=\s*["'](begin|separate|end)["']"#)
            .exec(token)
            .and_then(|found| found.get(1));
        match kind {
            Some("begin") => {
                let index = tree.frames.len();
                tree.frames.push(FieldFrame {
                    start: at,
                    end: -1,
                    instr: String::new(),
                    separate_start: -1,
                    separate_end: -1,
                    children: Vec::new(),
                });
                match stack.last() {
                    Some(&parent) => tree.frames[parent].children.push(index),
                    None => tree.roots.push(index),
                }
                stack.push(index);
            }
            Some("separate") => {
                if let Some(&top) = stack.last()
                    && tree.frames[top].separate_end < 0
                {
                    tree.frames[top].separate_start = at as isize;
                    tree.frames[top].separate_end = (at + token.len()) as isize;
                }
            }
            Some("end") => {
                if let Some(frame) = stack.pop() {
                    tree.frames[frame].end = (at + token.len()) as isize;
                }
            }
            _ => {}
        }
    }
    tree
}

/// `xml.slice(from, to)` for offsets that may be -1 (a field that was not
/// closed): a negative offset counts from the end.
fn js_slice(xml: &str, from: isize, to: isize) -> &str {
    let resolve = |at: isize| -> usize {
        if at >= 0 {
            return (at as usize).min(xml.len());
        }
        // -1 is the last UTF-16 unit: the last character
        let back = (-at) as usize;
        let mut index = xml.len();
        for _ in 0..back {
            index = xml[..index]
                .char_indices()
                .next_back()
                .map_or(0, |(i, _)| i);
        }
        index
    };
    let (from, to) = (resolve(from), resolve(to));
    if from >= to { "" } else { &xml[from..to] }
}

/// `renderFieldRegion`: a region of the part with the fields inside it
/// rewritten: every nested field is replaced by its display text. `depth` is
/// the number of fields being rendered around the region.
pub fn render_field_region(
    xml: &str,
    from: isize,
    to: isize,
    children: &[usize],
    tree: &FieldTree,
    page: &mut bool,
    depth: usize,
) -> Result<String, Thrown> {
    let mut text = String::new();
    let mut pos = from;
    for &child in children {
        let frame = &tree.frames[child];
        if (frame.start as isize) < from || frame.end > to {
            continue;
        }
        text.push_str(js_slice(xml, pos, frame.start as isize));
        text.push_str(&render_field(xml, frame, tree, page, depth)?);
        pos = frame.end;
    }
    text.push_str(js_slice(xml, pos, to));
    Ok(text)
}

/// `/<w:fldChar[^>]*?(?:\/>|>[\s\S]*?<\/w:fldChar>)/g` replaced by nothing.
fn without_fld_chars(text: &str) -> String {
    js_regex!(r"<w:fldChar[^>]*?(?:\/>|>[\s\S]*?<\/w:fldChar>)", "g")
        .replace_all(text, |_| String::new())
}

/// `renderField`: the display text of one field: a page-number marker for a
/// PAGE/NUMPAGES field, its cached result for anything else. A field's
/// instruction is field code and never displays, so the nested fields inside
/// it drop out with it: only the ones inside the cached result are rewritten.
/// `depth` is the number of fields being rendered around this one (0 for a
/// field outside any other).
pub fn render_field(
    xml: &str,
    field: &FieldFrame,
    tree: &FieldTree,
    page: &mut bool,
    depth: usize,
) -> Result<String, Thrown> {
    if depth >= MAX_FIELD_RENDER_DEPTH {
        return Err(STACK_OVERFLOW.to_owned());
    }
    let span = js_slice(xml, field.start as isize, field.end);
    let cached = if field.separate_end < 0 {
        ""
    } else {
        js_slice(xml, field.separate_end, field.end)
    };
    // Word formats the number with the result run's rPr; the separate run's
    // rPr (first in the span) is only the field-code formatting
    let result_run = js_regex!(r"<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>", "g")
        .find_iter(cached)
        .map(|found| found.as_str())
        .find(|run| run.contains("<w:t"));
    let r_pr_of = |text: &str| -> Option<String> {
        js_regex!(r"<w:rPr>[\s\S]*?<\/w:rPr>")
            .exec(text)
            .map(|found| found.as_str().to_owned())
    };
    let r_pr = result_run
        .and_then(r_pr_of)
        .filter(|r_pr| !r_pr.is_empty())
        .or_else(|| r_pr_of(span))
        .unwrap_or_default();
    // the span starts inside the begin run and ends inside the end run, so
    // the replacement closes/reopens the enclosing w:r to stay balanced
    // (the leftover edge runs end up empty and are dropped later)
    let emit = |inner: &str| format!("</w:r>{inner}<w:r>");
    // classify by the leading keyword: a nested child field's PAGE inside a
    // DOCPROPERTY instruction must not make the parent a PAGE field
    // (genoffice#2458: the span is matched by nesting depth, so the parent's
    // instruction is its own and the child's instruction stays the child's)
    if js_regex!(r"^\s*SECTIONPAGES\b").test(&field.instr) {
        return Ok(emit(&format!(
            "<w:r>{r_pr}<w:t>{SECTION_PAGES_MARK}</w:t></w:r>"
        )));
    }
    if js_regex!(r"^\s*NUMPAGES\b").test(&field.instr) {
        return Ok(emit(&format!(
            "<w:r>{r_pr}<w:t>{TOTAL_PAGES_MARK}</w:t></w:r>"
        )));
    }
    if js_regex!(r"^\s*PAGE\b").test(&field.instr) {
        *page = true;
        return Ok(emit(&format!("<w:r>{r_pr}<w:t>{PAGE_MARK}</w:t></w:r>")));
    }
    // Keep the original run boundaries: separate/result/end may share a run,
    // whose rPr is outside this span. Rewrapping only complete result runs
    // drops those edge fragments and their formatting.
    if field.separate_end < 0 {
        return Ok(emit(""));
    }
    let prefix = js_slice(xml, field.start as isize, field.separate_end);
    let instruction =
        js_regex!(r"<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>", "g").replace_all(prefix, |_| String::new());
    let instruction = js_regex!(r"<w:instrText[^>]*>[\s\S]*?<\/w:instrText>", "g")
        .replace_all(&instruction, |_| String::new());
    let instruction = without_fld_chars(&instruction);
    let result = render_field_region(
        xml,
        field.separate_end,
        field.end,
        &field.children,
        tree,
        page,
        depth + 1,
    )?;
    Ok(instruction + &without_fld_chars(&result))
}
