//! The session-bound reads of sheets-main.ts: ranges, formulas, find, row
//! outline, recalculation, external links, media and the gateway readers over
//! a session's snapshot. Each validates its request, checks the session, and
//! asks the [`super::engine::WorkbookEngine`].

use jscompat::JsonValue;
use jscompat::node_path::host::dirname;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::core::Env;
use super::dialogs::{dialog_options, dialog_parent, json_filter, open_dialog};
use super::engine::{RecalcEdit, RecalcRead};
use super::open::WORKBOOK_EXTS;
use super::save::session_for;
use super::schema::{self, Ty};
use super::session::SessionInfo;
use crate::value::{field, num, obj, string, thrown};

const MAX_RANGE_CELLS: f64 = 100_000.0;

fn session_id_of(input: &IpcValue) -> String {
    match field(input, "sessionId") {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    }
}

fn number_of(value: &IpcValue) -> f64 {
    match value {
        IpcValue::Number(x) => *x,
        _ => 0.0,
    }
}

/// `sessionFor`, `schema.parse(input)`, then the session of the request
fn bound(env: &Env, view: ViewId, input: &IpcValue, schema: &Ty) -> Result<SessionInfo, IpcError> {
    bound_with(env, view, input, schema, |_| Ok(()))
}

/// as [`bound`], with the `superRefine` of the schema between parse and session
fn bound_with(
    env: &Env,
    view: ViewId,
    input: &IpcValue,
    schema: &Ty,
    refine: impl FnOnce(&IpcValue) -> Result<(), IpcError>,
) -> Result<SessionInfo, IpcError> {
    env.core(move |core| core.ensure_tab(view));
    schema::parse(schema, input)?;
    refine(input)?;
    session_for(env, view, &session_id_of(input))
}

fn only_session() -> Ty {
    schema::strict(vec![("sessionId", schema::uuid())])
}

fn session_and_sheet() -> Ty {
    schema::strict(vec![
        ("sessionId", schema::uuid()),
        ("sheetId", schema::string().min(1)),
    ])
}

fn range_bounds(max_row: Option<usize>, max_col: Option<usize>) -> Ty {
    let row = |t: Ty| match max_row {
        Some(max) => t.max(max),
        None => t,
    };
    let col = |t: Ty| match max_col {
        Some(max) => t.max(max),
        None => t,
    };
    schema::strict(vec![
        ("startRow", row(schema::int().nonneg())),
        ("endRow", row(schema::int().nonneg())),
        ("startColumn", col(schema::int().nonneg())),
        ("endColumn", col(schema::int().nonneg())),
    ])
}

fn bounds_of(range: &IpcValue) -> (f64, f64, f64, f64) {
    (
        number_of(field(range, "startRow")),
        number_of(field(range, "endRow")),
        number_of(field(range, "startColumn")),
        number_of(field(range, "endColumn")),
    )
}

/// `readWorkbookRange`
pub fn read_range(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    bound_with(
        env,
        view,
        &input,
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("sheetId", schema::string().min(1)),
            ("range", range_bounds(None, None)),
        ]),
        |input| {
            let (start_row, end_row, start_col, end_col) = bounds_of(field(input, "range"));
            if start_row > end_row || start_col > end_col {
                return Err(schema::custom_issue("Range boundaries are reversed."));
            }
            if (end_row - start_row + 1.0) * (end_col - start_col + 1.0) > MAX_RANGE_CELLS {
                return Err(schema::custom_issue(&format!(
                    "Range exceeds {} cells.",
                    MAX_RANGE_CELLS as u64
                )));
            }
            Ok(())
        },
    )?;
    env.engine.read_range(&input)
}

pub fn read_formulas(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    bound(env, view, &input, &session_and_sheet())?;
    env.engine.read_formula_cells(&input)
}

pub fn read_row_outline(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    bound(env, view, &input, &session_and_sheet())?;
    env.engine.read_row_outline(&input)
}

pub fn find_cells(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    bound(
        env,
        view,
        &input,
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("sheetId", schema::string().min(1).optional()),
            ("query", schema::string().min(1).max(10_000)),
            ("matchCase", schema::boolean()),
            ("matchEntireCell", schema::boolean()),
            (
                "lookIn",
                schema::one_of(&["values", "formulas", "formulas_only", "both"]),
            ),
            ("wildcards", schema::boolean()),
            (
                "resumeAt",
                schema::strict(vec![
                    ("sheetId", schema::string().min(1)),
                    ("row", schema::int().nonneg()),
                    ("column", schema::int().nonneg()),
                ])
                .optional(),
            ),
            ("limit", schema::int().positive().max(100_000)),
        ]),
    )?;
    env.engine.find_cells(&input)
}

pub fn read_media(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    bound(
        env,
        view,
        &input,
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("visualId", schema::string().min(1)),
        ]),
    )?;
    env.engine.read_media(&input)
}

/// `recalcWorkbook`
pub fn recalc(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let edit = schema::strict(vec![
        ("sheetId", schema::string().min(1)),
        ("row", schema::int().nonneg().max(1_048_575)),
        ("column", schema::int().nonneg().max(16_383)),
        ("input", schema::string().max(32_767)),
    ]);
    let read = schema::strict(vec![
        ("sheetId", schema::string().min(1)),
        ("range", range_bounds(Some(1_048_575), Some(16_383))),
    ]);
    let items = |key: &str| match field(&input, key) {
        IpcValue::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    let reads = items("reads");
    let session = bound_with(
        env,
        view,
        &input,
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("edits", schema::array(edit).max(10_000)),
            ("reads", schema::array(read).max(200)),
        ]),
        |_| {
            let mut total = 0.0;
            for read in &reads {
                let (start_row, end_row, start_col, end_col) = bounds_of(field(read, "range"));
                if start_row > end_row || start_col > end_col {
                    return Err(schema::custom_issue("Range boundaries are reversed."));
                }
                total += (end_row - start_row + 1.0) * (end_col - start_col + 1.0);
            }
            if total > MAX_RANGE_CELLS {
                return Err(schema::custom_issue(&format!(
                    "Recalc read exceeds {} cells.",
                    MAX_RANGE_CELLS as u64
                )));
            }
            Ok(())
        },
    )?;
    let file_sheet_name = |sheet_id: &IpcValue| -> Result<String, IpcError> {
        let id = match sheet_id {
            IpcValue::String(id) => id.as_str(),
            _ => "",
        };
        session
            .sheet_names
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, name)| name.clone())
            .ok_or_else(|| thrown(format!("Unknown sheet for recalculation: {id}")))
    };
    let mut edits = Vec::new();
    for edit in items("edits") {
        edits.push(RecalcEdit {
            sheet: file_sheet_name(field(&edit, "sheetId"))?,
            row: number_of(field(&edit, "row")),
            column: number_of(field(&edit, "column")),
            input: match field(&edit, "input") {
                IpcValue::String(text) => text.clone(),
                _ => String::new(),
            },
        });
    }
    let mut read_list = Vec::new();
    for read in &reads {
        read_list.push(RecalcRead {
            sheet: file_sheet_name(field(read, "sheetId"))?,
            range: field(read, "range").clone(),
        });
    }
    // The snapshot, not the live path: recalculated values come from the session's own bytes
    let result = env
        .engine
        .recalc_cells(&session.snapshot_path, &edits, &read_list)?;
    // sheet name to id: a later sheet of the same name overwrites the earlier
    let id_for = |name: &str| {
        session
            .sheet_names
            .iter()
            .rev()
            .find(|(_, n)| n == name)
            .map(|(id, _)| id.clone())
    };
    let mut cells = Vec::new();
    for cell in result {
        let Some(sheet_id) = id_for(&cell.sheet) else {
            continue;
        };
        let mut entries = vec![
            ("sheetId".to_owned(), string(sheet_id)),
            ("row".to_owned(), num(cell.row)),
            ("column".to_owned(), num(cell.column)),
            ("formatted".to_owned(), string(cell.formatted)),
        ];
        if let Some(number) = cell.number {
            entries.push(("number".to_owned(), num(number)));
        }
        if cell.is_error {
            entries.push(("isError".to_owned(), IpcValue::Bool(true)));
        }
        entries.push(("isFormula".to_owned(), IpcValue::Bool(cell.is_formula)));
        cells.push(IpcValue::Object(entries));
    }
    Ok(obj([("cells", IpcValue::Array(cells))]))
}

/// the folder a workbook's relative link targets start from
fn external_link_base_dir(session: &SessionInfo) -> String {
    dirname(session.restore_target.as_deref().unwrap_or(&session.path))
}

pub fn list_external_links(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine
        .list_external_links(&session.path, &external_link_base_dir(&session))
}

pub fn update_external_links(
    env: &Env,
    view: ViewId,
    input: IpcValue,
) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine
        .update_external_links(&session.path, &external_link_base_dir(&session))
}

pub fn read_external_link_usage(
    env: &Env,
    view: ViewId,
    input: IpcValue,
) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine.read_external_link_usage(&session.path)
}

/// `selectExternalLinkSource`: the host picks the new source file itself
pub fn select_external_link_source(env: &Env, view: ViewId) -> Result<IpcValue, IpcError> {
    let picked = open_dialog(
        env,
        dialog_parent(env, view),
        &dialog_options(&[
            ("properties", super::dialogs::json_strings(&["openFile"])),
            (
                "filters",
                JsonValue::Array(vec![json_filter(
                    &env.tm.t("filterSpreadsheets"),
                    &WORKBOOK_EXTS,
                )]),
            ),
        ]),
    );
    Ok(match picked.paths.first() {
        Some(path) if !picked.canceled => string(path.clone()),
        _ => IpcValue::Null,
    })
}

fn part_path(text: &str) -> bool {
    text.starts_with("xl/")
        && text.ends_with(".xml")
        && text.len() > "xl/.xml".len()
        && text["xl/".len()..text.len() - ".xml".len()]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

const PART_PATTERN: &str = "/^xl\\/[A-Za-z0-9._/-]+\\.xml$/";

/// `readPivotDefinition`: read from the session snapshot
pub fn read_pivot_definition(
    env: &Env,
    view: ViewId,
    input: IpcValue,
) -> Result<IpcValue, IpcError> {
    let session = bound(
        env,
        view,
        &input,
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("path", schema::pattern(part_path, PART_PATTERN)),
            ("cachePath", schema::pattern(part_path, PART_PATTERN)),
        ]),
    )?;
    let get = |key: &str| match field(&input, key) {
        IpcValue::String(text) => text.clone(),
        _ => String::new(),
    };
    env.engine
        .read_pivot_definition(&session.snapshot_path, &get("path"), &get("cachePath"))
}

pub fn read_slicer_state(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine.read_slicer_state(&session.snapshot_path)
}

pub fn list_connections(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine.list_connections(&session.snapshot_path)
}

pub fn refresh_connection(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let session = bound(
        env,
        view,
        &input,
        &schema::strict(vec![
            ("sessionId", schema::uuid()),
            ("connectionId", schema::string().min(1).max(200)),
        ]),
    )?;
    let id = match field(&input, "connectionId") {
        IpcValue::String(id) => id.clone(),
        _ => String::new(),
    };
    env.engine.refresh_connection(&session.snapshot_path, &id)
}

pub fn read_queries(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine.read_queries(&session.snapshot_path)
}

pub fn read_redactions(env: &Env, view: ViewId, input: IpcValue) -> Result<IpcValue, IpcError> {
    let session = bound(env, view, &input, &only_session())?;
    env.engine.read_redactions(&session.snapshot_path)
}
