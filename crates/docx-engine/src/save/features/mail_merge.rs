//! mail-merge.ts: the data source and the substitution walk of a mail merge.
//!
//! The functions that read an instruction with a regular expression whose
//! search may turn past the bound of one search return `RegexLimit` for it.

use jscompat::serde::{Deserialize, Serialize};
use jscompat::{
    JsObject, RegexLimit, is_js_space, js_regex, slice_utf16, to_number, trim, try_js_regex,
};

use crate::inline_opaque::run_copied_elsewhere;
use crate::model::{Block, Run, TableModel};

/// `MergeRecord`: one recipient row; keys are the column headers.
pub type MergeRecord = JsObject<String>;

/// `MergeData`
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(crate = "jscompat::serde")]
pub struct MergeData {
    /// column headers, in file order
    pub fields: Vec<String>,
    pub records: Vec<MergeRecord>,
}

/// `splitInstruction`: split a field instruction into its keyword and the
/// rest: `MERGEFIELD "Postal Address" \* MERGEFORMAT` gives `["MERGEFIELD",
/// "\"Postal Address\" \\* MERGEFORMAT"]`.
pub fn split_instruction(instr: &str) -> (String, String) {
    let trimmed = trim(instr);
    match trimmed.char_indices().find(|(_, c)| is_js_space(*c)) {
        None => (trimmed.to_uppercase(), String::new()),
        Some((at, space)) => (
            trimmed[..at].to_uppercase(),
            trim(&trimmed[at + space.len_utf8()..]).to_owned(),
        ),
    }
}

/// `mergeFieldName`: the column name a MERGEFIELD asks for. Quoted so a header
/// with a space survives; a bare name stops at the first whitespace, which
/// keeps the `\* MERGEFORMAT`-style switches out of the name.
pub fn merge_field_name(instr: &str) -> Option<String> {
    let (keyword, rest) = split_instruction(instr);
    if keyword != "MERGEFIELD" || rest.is_empty() {
        return None;
    }
    if let Some(quoted) = js_regex!(r#"^"([^"]*)""#).exec(&rest) {
        return quoted.get(1).map(str::to_owned);
    }
    Some(
        rest.split(is_js_space)
            .next()
            .unwrap_or_default()
            .to_owned(),
    )
}

/// `placeholderText`
pub fn placeholder_text(name: &str) -> String {
    format!("«{name}»")
}

/// `mergeFieldInstruction`: the field code a merge field carries in a template.
pub fn merge_field_instruction(name: &str) -> String {
    format!("MERGEFIELD \"{}\" \\* MERGEFORMAT", name.replace('"', ""))
}

/// `valueOf`: the value a record holds for `name`, or '' when the column is absent
pub fn value_of<'a>(record: &'a MergeRecord, name: &str) -> &'a str {
    record.get(name).map_or("", String::as_str)
}

/// `mergeOutputFileName`: the name a merged record is written under, derived
/// from the record itself.
///
/// `pattern` names a column of the data source; an empty pattern takes the
/// first one. A pattern that is no column is a literal, and `{Column}` inside
/// it is filled from the record. The result is reduced to what a file name can
/// carry, so a value like "A/B" cannot escape the folder it is written into.
pub fn merge_output_file_name(pattern: &str, record: &MergeRecord, fields: &[String]) -> String {
    let trimmed = trim(pattern);
    let source = if trimmed.is_empty() {
        fields.first().map_or("", String::as_str)
    } else {
        trimmed
    };
    // a pattern naming a column takes that column's value; anything else is literal
    let literal = if fields.iter().any(|field| field == source) {
        value_of(record, source)
    } else {
        source
    };
    let filled = js_regex!(r"\{([^{}]*)\}", "g").replace_all(literal, |found| {
        value_of(record, trim(found.get(1).unwrap_or_default())).to_owned()
    });
    let replaced = js_regex!(r#"[\\/:*?"<>|]"#, "g").replace_all(&filled, |_| "_".to_owned());
    // control characters a pasted value can carry
    let without_controls: String = replaced.chars().filter(|c| !c.is_control()).collect();
    let spaced = js_regex!(r"\s+", "g").replace_all(&without_controls, |_| " ".to_owned());
    // a name that is only dots is not a name on any file system
    let undotted =
        trim(&js_regex!(r"^\.+").replace_all(trim(&spaced), |_| String::new())).to_owned();
    if undotted.is_empty() {
        return "document".to_owned();
    }
    slice_utf16(&undotted, 0.0, Some(120.0))
}

/// `MergeFieldSwitches`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(crate = "jscompat::serde", rename_all = "camelCase")]
pub struct MergeFieldSwitches {
    /// `\b "…"`: text placed before the value, only when the value is non-empty
    pub before: String,
    /// `\f "…"`: text placed after the value, only when the value is non-empty
    pub after: String,
    /// `\* Upper | Lower | FirstCap | Caps`
    pub case_format: Option<String>,
}

/// `mergeFieldSwitches`: Word's Address Block and Greeting Line write `\f " "`
/// on every name part, so dropping the switches runs the parts together
/// ("AdaLovelace").
pub fn merge_field_switches(instr: &str) -> MergeFieldSwitches {
    let mut out = MergeFieldSwitches {
        before: String::new(),
        after: String::new(),
        case_format: None,
    };
    for found in js_regex!(r#"\\([bf*])\s+(?:"([^"]*)"|(\S+))"#, "g").find_iter(instr) {
        let arg = found.get(2).or_else(|| found.get(3)).unwrap_or_default();
        match found.get(1) {
            Some("b") => out.before = arg.to_owned(),
            Some("f") => out.after = arg.to_owned(),
            _ => {
                if !js_regex!(r"^MERGEFORMAT$", "i").test(arg)
                    && !js_regex!(r"^CHARFORMAT$", "i").test(arg)
                {
                    out.case_format = Some(arg.to_owned());
                }
            }
        }
    }
    out
}

/// `applyCaseFormat`
fn apply_case_format(value: &str, format: Option<&str>) -> String {
    match format.map(str::to_lowercase).as_deref() {
        Some("upper") => value.to_uppercase(),
        Some("lower") => value.to_lowercase(),
        Some("firstcap") => {
            // `charAt(0)` is one UTF-16 unit: a character outside the BMP is
            // half of a pair, which `toUpperCase` leaves as it is
            let mut chars = value.chars();
            match chars.next() {
                None => String::new(),
                Some(first) if first.len_utf16() == 2 => {
                    format!("{first}{}", chars.as_str().to_lowercase())
                }
                Some(first) => {
                    format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase())
                }
            }
        }
        Some("caps") => {
            js_regex!(r"(^|[\s-])(\p{L})", "gu").replace_all(&value.to_lowercase(), |found| {
                format!(
                    "{}{}",
                    found.get(1).unwrap_or_default(),
                    found.get(2).unwrap_or_default().to_uppercase()
                )
            })
        }
        _ => value.to_owned(),
    }
}

/// `mergeFieldText`: the text a MERGEFIELD run shows for one record, switches applied
pub fn merge_field_text(instr: &str, record: &MergeRecord) -> String {
    let Some(name) = merge_field_name(instr).filter(|name| !name.is_empty()) else {
        return String::new();
    };
    let switches = merge_field_switches(instr);
    let value = apply_case_format(value_of(record, &name), switches.case_format.as_deref());
    if value.is_empty() {
        return String::new();
    }
    format!("{}{value}{}", switches.before, switches.after)
}

/// `isTruthyOperand`: an IF with no comparison tests one operand: `IF «Paid»
/// "yes" "no"` is true when the column holds anything. A bare word with no
/// guillemets is a literal, so it is true exactly when it is non-empty text.
fn is_truthy_operand(text: &str, record: &MergeRecord) -> Result<bool, RegexLimit> {
    let value = resolve_operand(text, record)?;
    Ok(!value.is_empty() && value != "0")
}

/// `numeric`
fn numeric(text: &str) -> Option<f64> {
    let t = trim(text);
    if t.is_empty() || !js_regex!(r"^[-+]?(\d+\.?\d*|\.\d+)$").test(t) {
        return None;
    }
    Some(to_number(t))
}

/// `compareValues` over two numbers
fn compare_numbers(a: f64, b: f64, op: &str) -> bool {
    match op {
        "=" => a == b,
        "<>" => a != b,
        "<" => a < b,
        "<=" => a <= b,
        ">" => a > b,
        ">=" => a >= b,
        _ => false,
    }
}

/// `compareValues` over two strings: `<` compares UTF-16 code units.
fn compare_strings(a: &str, b: &str, op: &str) -> bool {
    use jscompat::string_less_than as less;
    match op {
        "=" => a == b,
        "<>" => a != b,
        "<" => less(a, b),
        "<=" => !less(b, a),
        ">" => less(b, a),
        ">=" => !less(a, b),
        _ => false,
    }
}

/// `compareOperands`: evaluate an IF / SKIPIF comparison. Word writes `«Field»
/// = "literal"` or `«Field» = «Other»`; both sides are resolved against the
/// record first, so a MERGEFIELD wrapper around a name is invisible here.
pub fn compare_operands(
    left: &str,
    op: &str,
    right: &str,
    record: &MergeRecord,
) -> Result<bool, RegexLimit> {
    let a = resolve_operand(left, record)?;
    let b = resolve_operand(right, record)?;
    // Word compares numerically when both sides are numbers: `IF 9 < 50` is true
    if let (Some(na), Some(nb)) = (numeric(&a), numeric(&b)) {
        return Ok(compare_numbers(na, nb, op));
    }
    Ok(compare_strings(&a, &b, op))
}

/// `resolveOperand`: resolve one comparison operand against the record.
///
/// A bare word is a LITERAL, not a field reference: in `SKIPIF Status =
/// "yes"` `Status` is the text "Status" and `"yes"` is the text "yes", so the
/// test is false for every record. Word only treats an operand as a data
/// column when it is wrapped in guillemets (`«Status»`) or carries the
/// MERGEFIELD keyword.
fn resolve_operand(token: &str, record: &MergeRecord) -> Result<String, RegexLimit> {
    let trimmed = trim(token);
    if let Some(quoted) = try_js_regex!(r#"^"(.*)"$"#, "s").try_exec(trimmed)? {
        return Ok(quoted.get(1).unwrap_or_default().to_owned());
    }
    if let Some(guillemet) = js_regex!(r"^«([^»]*)»$").exec(trimmed) {
        return Ok(value_of(record, guillemet.get(1).unwrap_or_default()).to_owned());
    }
    if let Some(instruction) = js_regex!(r#"^MERGEFIELD\s+(?:"([^"]*)"|(\S+))"#, "i").exec(trimmed)
    {
        let name = instruction
            .get(1)
            .or_else(|| instruction.get(2))
            .unwrap_or_default();
        return Ok(value_of(record, name).to_owned());
    }
    Ok(trimmed.to_owned())
}

/// What `parseComparison` returns.
struct Comparison {
    left: String,
    op: String,
    right: String,
    rest: String,
}

/// `parseComparison`: the first comparison an IF/SKIPIF instruction carries,
/// plus whatever follows it. `right` must stop at the operand's own end: in
/// `Skip = "yes" "hidden" "shown"` the right operand is `"yes"` and the two
/// branch literals are what is left, so the trailing group has to be lazy
/// about where `right` stops and greedy about what it keeps.
fn parse_comparison(instr: &str) -> Result<Option<Comparison>, RegexLimit> {
    let found = try_js_regex!(r#"^(.+?)\s*(<>|=|<=|>=|<|>)\s*("(?:[^"]*)"|\S+)(?:\s+([\s\S]*))?$"#)
        .try_exec(trim(instr))?;
    Ok(found.map(|found| Comparison {
        left: found.get(1).unwrap_or_default().to_owned(),
        op: found.get(2).unwrap_or_default().to_owned(),
        right: found.get(3).unwrap_or_default().to_owned(),
        rest: found.get(4).unwrap_or_default().to_owned(),
    }))
}

/// `conditionHolds`: true when an IF/SKIPIF condition holds for this record
pub fn condition_holds(instr: &str, record: &MergeRecord) -> Result<bool, RegexLimit> {
    let (_, rest) = split_instruction(instr);
    match parse_comparison(&rest)? {
        // no comparison: the FIRST operand is the test (`IF «Paid» "got" "missed"`),
        // not the whole instruction — that is non-empty text for every record, so
        // the false branch would be unreachable
        None => {
            let operands = tokenize_operands(&rest);
            is_truthy_operand(operands.first().map_or("", String::as_str), record)
        }
        Some(cmp) => compare_operands(&cmp.left, &cmp.op, &cmp.right, record),
    }
}

/// `ifBranch`: the branch an IF instruction selects, unwrapped from its quotes.
///
/// Word writes `IF «Field» = "yes" "hidden" "shown"` — the condition comes
/// first, so the branches are whatever follows the comparison, not the first
/// two tokens. An IF with no comparison (`IF «Field» "yes" "no"`) uses the
/// field as the test and takes the two operands as the branches.
pub fn if_branch(instr: &str, record: &MergeRecord) -> Result<String, RegexLimit> {
    let (_, rest) = split_instruction(instr);
    let branches = branches_after_condition(&rest)?;
    let chosen = if condition_holds(instr, record)? {
        branches.first()
    } else {
        branches.get(1)
    }
    .map_or("", String::as_str);
    let unquoted = match try_js_regex!(r#"^"(.*)"$"#, "s").try_exec(chosen)? {
        Some(found) => found.get(1).unwrap_or_default().to_owned(),
        None => chosen.to_owned(),
    };
    Ok(
        js_regex!(r"«([^»]*)»", "g").replace_all(&unquoted, |found| {
            value_of(record, found.get(1).unwrap_or_default()).to_owned()
        }),
    )
}

/// `branchesAfterCondition`: the two branch literals of an IF, with the
/// condition stripped off the front
fn branches_after_condition(rest: &str) -> Result<Vec<String>, RegexLimit> {
    // parseComparison returns everything after the right operand, which for an IF
    // is exactly the two branches; without a comparison the first operand is the
    // test itself, so drop it and take what follows
    Ok(match parse_comparison(rest)? {
        Some(cmp) => tokenize_operands(&cmp.rest),
        None => tokenize_operands(rest).into_iter().skip(1).collect(),
    })
}

/// `tokenizeOperands`: split the IF operands on whitespace but keep a quoted
/// run (with spaces) together: `Skip = "yes" "a b" "c d"` gives 5 tokens.
fn tokenize_operands(rest: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in rest.chars() {
        if ch == '"' {
            quoted = !quoted;
            current.push(ch);
            continue;
        }
        if !quoted && is_js_space(ch) {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// `ControlEffect`: what a control field does to the run that carries it
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(crate = "jscompat::serde", tag = "kind", rename_all = "camelCase")]
pub enum ControlEffect {
    Next,
    Skip,
    SkipNoop,
    If { text: String },
}

/// `controlEffect`
pub fn control_effect(
    instr: &str,
    record: &MergeRecord,
) -> Result<Option<ControlEffect>, RegexLimit> {
    let (keyword, _) = split_instruction(instr);
    Ok(match keyword.as_str() {
        "NEXT" => Some(ControlEffect::Next),
        "SKIPIF" => Some(if condition_holds(instr, record)? {
            ControlEffect::Skip
        } else {
            ControlEffect::SkipNoop
        }),
        "IF" => Some(ControlEffect::If {
            text: if_branch(instr, record)?,
        }),
        _ => None,
    })
}

/// What `mergeRun` returns.
struct MergedRun {
    run: Run,
    effect: Option<ControlEffect>,
    untouched: bool,
}

/// `mergeRun`: substitute one run: a MERGEFIELD becomes its value, a control
/// field becomes its effect, and any other field is reported untouched so the
/// caller keeps it
fn merge_run(run: &Run, record: &MergeRecord) -> Result<MergedRun, RegexLimit> {
    let Some(instr) = run.instr_field.as_deref().filter(|instr| !instr.is_empty()) else {
        return Ok(MergedRun {
            run: run.clone(),
            effect: None,
            untouched: false,
        });
    };
    let (keyword, _) = split_instruction(instr);
    // keep the run's formatting, drop the instruction — the value replaces both
    let mut rest = run.clone();
    rest.instr_field.delete();
    rest.fld_dirty.delete();
    if keyword == "MERGEFIELD" {
        rest.text.set(merge_field_text(instr, record));
        return Ok(MergedRun {
            run: rest,
            effect: None,
            untouched: false,
        });
    }
    let Some(effect) = control_effect(instr, record)? else {
        // an unrelated field (PAGE, DATE, a Zotero citation): leave the run alone
        return Ok(MergedRun {
            run: run.clone(),
            effect: None,
            untouched: true,
        });
    };
    rest.text.set(match &effect {
        ControlEffect::If { text } => text.clone(),
        _ => String::new(),
    });
    Ok(MergedRun {
        run: rest,
        effect: Some(effect),
        untouched: false,
    })
}

/// `MergeCursorState`: the run-position cursor a single template pass walks with
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(crate = "jscompat::serde", rename_all = "camelCase")]
pub struct MergeCursorState {
    /// index into data.records; NEXT moves it forward
    pub index: usize,
    /// a NEXT fired during this pass
    pub next: bool,
    /// a SKIPIF tested true during this pass
    pub skipped: bool,
}

/// `consumedByControlField`: true when every run in the paragraph was consumed
/// by a control field, so the paragraph itself must not survive into the
/// merged output
fn consumed_by_control_field(runs: Option<&[Run]>) -> bool {
    let Some(runs) = runs.filter(|runs| !runs.is_empty()) else {
        return false;
    };
    runs.iter().all(|run| {
        let Some(instr) = run.instr_field.as_deref().filter(|instr| !instr.is_empty()) else {
            return false;
        };
        let (keyword, _) = split_instruction(instr);
        keyword == "NEXT" || keyword == "SKIPIF"
    })
}

/// `mergeRuns`
fn merge_runs(
    runs: Option<&[Run]>,
    data: &MergeData,
    cursor: &mut MergeCursorState,
) -> Result<Vec<Run>, RegexLimit> {
    let Some(runs) = runs.filter(|runs| !runs.is_empty()) else {
        return Ok(Vec::new());
    };
    let empty = MergeRecord::new();
    let mut out = Vec::new();
    for run in runs {
        // a run without a field is the template's own content: an image or an
        // index entry carries its payload beside an empty text and must survive
        // every record's copy
        if run.instr_field.as_deref().is_none_or(str::is_empty) {
            out.push(run.clone());
            continue;
        }
        // `recordAt`: past the last row every field is empty, the way the
        // trailing labels of Word's last sheet come out blank
        let record = data.records.get(cursor.index).unwrap_or(&empty);
        let merged = merge_run(run, record)?;
        // a field this merge knows nothing about (a PAGE, a DATE) is left exactly as
        // it was — it still evaluates in Word, and dropping it would lose the field
        if merged.untouched {
            out.push(run.clone());
            continue;
        }
        match merged.effect {
            // a substituted MERGEFIELD keeps its slot even when the column is empty
            // or absent — the position is the user's layout; only a control field
            // takes its paragraph's content away
            None => out.push(merged.run),
            Some(ControlEffect::Next) => {
                cursor.next = true;
                cursor.index += 1;
            }
            Some(ControlEffect::Skip) => cursor.skipped = true,
            // skipNoop: a SKIPIF that tested false — contributes nothing, marks nothing
            Some(ControlEffect::SkipNoop) => {}
            // IF contributes its chosen branch inline, exactly where the field sat
            Some(ControlEffect::If { text }) => {
                if !text.is_empty() {
                    out.push(merged.run);
                }
            }
        }
    }
    Ok(out)
}

/// `mergeRecords`: walk the template once, substituting fields from `data` as
/// the cursor moves.
///
/// The tree is walked structurally rather than through a serializer, so a
/// field inside a table cell is substituted exactly like one in the body.
/// Floating textboxes are display-only (the save keeps their original bytes),
/// so a field inside one stays as it was — for the same reason as the nested
/// tables below.
pub fn merge_records(
    blocks: &[Block],
    data: &MergeData,
    start_index: usize,
) -> Result<(Vec<Block>, MergeCursorState), RegexLimit> {
    let mut cursor = MergeCursorState {
        index: start_index,
        next: false,
        skipped: false,
    };
    // merge FIRST, drop the paragraph afterwards: a paragraph holding only a NEXT
    // is invisible in the output, but its field still has to advance the cursor —
    // filtering before the walk would leave every record reading the same row
    let mut out = Vec::new();
    for block in blocks {
        let control_only = consumed_by_control_field(block.runs.as_deref());
        let runs = merge_runs(block.runs.as_deref(), data, &mut cursor)?;
        if control_only {
            continue;
        }
        let mut copy = block.clone();
        copy.runs.set(runs);
        // the table is merged with the SAME cursor object, so a NEXT inside a
        // cell advances the body walk too — that is how a label sheet stays in step
        if let Some(table) = block.table.as_ref() {
            copy.table.set(merge_table(table, data, &mut cursor)?);
        }
        out.push(copy);
    }
    Ok((out, cursor))
}

/// `mergeTable`: table cells, their rich paragraphs and any nested table
fn merge_table(
    table: &TableModel,
    data: &MergeData,
    cursor: &mut MergeCursorState,
) -> Result<TableModel, RegexLimit> {
    let mut merged = table.clone();
    // TableModel.rows is a grid of cells (w:tr -> w:tc), not row objects
    for row in &mut merged.rows {
        for cell in row {
            if let Some(rich_paras) = (*cell.rich_paras).clone() {
                let mut paras = Vec::with_capacity(rich_paras.len());
                for para in rich_paras {
                    let mut next = para.clone();
                    next.runs = merge_runs(Some(&para.runs), data, cursor)?;
                    paras.push(next);
                }
                let texts: Vec<String> = paras
                    .iter()
                    .map(|para| {
                        para.runs
                            .iter()
                            .map(|run| run.text.as_deref().unwrap_or(""))
                            .collect()
                    })
                    .collect();
                cell.rich_paras.set(paras);
                cell.paras.set(texts);
            }
            // nestedTables are display-only: the outer table keeps their original
            // bytes on save, so substituting inside one would change what is shown
            // but not what is written — the field would come back on the next open
        }
    }
    Ok(merged)
}

/// `mergeBlockTree`: merge every record into its own copy of the block tree.
///
/// A template with no NEXT yields one set per record — the letter-per-recipient
/// case. A NEXT hands the remainder of the template to the next record, which
/// is what a directory or a label sheet does. A SKIPIF removes the whole
/// record.
///
/// The first set is the template itself with its fields filled in. Every
/// later set is one more copy of the same paragraphs, so it goes without the
/// content controls whose ids belong to the first (runCopiedElsewhere).
pub fn merge_block_tree(blocks: &[Block], data: &MergeData) -> Result<Vec<Vec<Block>>, RegexLimit> {
    let mut out: Vec<Vec<Block>> = Vec::new();
    let mut index = 0;
    let mut round = 0;
    while index < data.records.len() && round <= data.records.len() {
        let (merged, cursor) = merge_records(blocks, data, index)?;
        if !cursor.skipped {
            out.push(if out.is_empty() {
                merged
            } else {
                merged.iter().map(later_copy).collect()
            });
        }
        // a NEXT-driven pass (a label sheet) consumed several records; the next
        // sheet starts after the last one read
        index = cursor.index + 1;
        round += 1;
    }
    Ok(out)
}

/// `laterCopy`: a merged block as a copy after the first: see `mergeBlockTree`
fn later_copy(block: &Block) -> Block {
    let strip = |runs: &[Run]| -> Vec<Run> { runs.iter().map(run_copied_elsewhere).collect() };
    // the report of the controls read from the template no longer describes the copy
    let mut copy = block.clone();
    copy.inline_content_controls.delete();
    if let Some(runs) = block.runs.as_ref() {
        copy.runs.set(strip(runs));
    }
    if let Some(table) = copy.table.as_mut() {
        for row in &mut table.rows {
            for cell in row {
                if let Some(rich_paras) = cell.rich_paras.as_mut() {
                    for para in rich_paras {
                        para.runs = strip(&para.runs);
                    }
                }
            }
        }
    }
    copy
}

/// `mergeDataFromRows`: build a recipient list from already-parsed
/// spreadsheet rows. The first row names the columns; the rest are records.
pub fn merge_data_from_rows(rows: &[Vec<String>]) -> MergeData {
    let Some(first) = rows.first() else {
        return MergeData::default();
    };
    let header: Vec<String> = first.iter().map(|h| trim(h).to_owned()).collect();
    let records = rows[1..]
        .iter()
        .map(|row| {
            let mut record = MergeRecord::new();
            for (i, name) in header.iter().enumerate() {
                record.set(name.clone(), row.get(i).cloned().unwrap_or_default());
            }
            record
        })
        .collect();
    MergeData {
        fields: header,
        records,
    }
}
