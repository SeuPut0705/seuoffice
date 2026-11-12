//! `apps/sheets/src/main/workbook-save-resolve.ts`.

use jscompat::{JsMap, number_to_string, value_to_string, value_truthy};
use serde_json::{Map, Value};

/// What `resolveWorkbookSave` throws: an `Error` with this message (a
/// `TypeError` of a request that lacks a list, with V8's words).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveError(pub String);

fn fail<T>(message: impl Into<String>) -> Result<T, ResolveError> {
    Err(ResolveError(message.into()))
}

/// `value[key]` of a JSON value (`None` is `undefined`)
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// `key in value`
fn has(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|map| map.contains_key(key))
}

/// A `Map` key by SameValueZero: what two ids must share to be the same key.
fn key_of(value: Option<&Value>) -> String {
    match value {
        None => "u".to_owned(),
        Some(Value::Null) => "z".to_owned(),
        Some(Value::Bool(flag)) => format!("b{flag}"),
        Some(Value::Number(n)) => format!("n{}", number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(text)) => format!("s{text}"),
        Some(other) => format!("o{other}"),
    }
}

/// The items of a list the request holds, for a `for...of` (`method` `None`)
/// or a `.map` / `.some` call (`method` the name). A request that lacks the
/// list throws as V8 words it.
fn list<'a>(
    request: &'a Value,
    path: &str,
    key: &str,
    method: Option<&str>,
) -> Result<&'a [Value], ResolveError> {
    match get(request, key) {
        Some(Value::Array(items)) => Ok(items),
        found => match (method, found) {
            (None, _) => fail(format!("{path} is not iterable")),
            (Some(method), None) => fail(format!(
                "Cannot read properties of undefined (reading '{method}')"
            )),
            (Some(method), Some(Value::Null)) => fail(format!(
                "Cannot read properties of null (reading '{method}')"
            )),
            (Some(method), Some(_)) => fail(format!("{path}.{method} is not a function")),
        },
    }
}

/// The object literal of the TypeScript: a field whose value is `undefined`
/// is left out.
fn obj(fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            map.insert(key.to_owned(), value);
        }
    }
    Value::Object(map)
}

fn field(value: &Value, key: &str) -> Option<Value> {
    get(value, key).cloned()
}

/// `{ sheetName, ...rest }` of a destructured `({ sheetId, ...rest }) =>`:
/// the rest object has the keys but `sheetId`
fn name_then_rest(sheet_name: Value, item: &Value) -> Value {
    let mut map = Map::new();
    map.insert("sheetName".to_owned(), sheet_name);
    if let Some(items) = item.as_object() {
        for (key, value) in items {
            if key != "sheetId" {
                map.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(map)
}

/// `{ ...rest, sheetName }` of a destructured `({ sheetId, ...rest }) =>`
fn rest_then_name(sheet_name: Value, item: &Value) -> Value {
    let mut map = Map::new();
    if let Some(items) = item.as_object() {
        for (key, value) in items {
            if key != "sheetId" {
                map.insert(key.clone(), value.clone());
            }
        }
    }
    map.insert("sheetName".to_owned(), sheet_name);
    Value::Object(map)
}

struct Added {
    name: Option<Value>,
}

/// The ids of the session and of the sheets this save adds, to file names.
struct Sheets {
    names: JsMap<String>,
    added: JsMap<Added>,
}

impl Sheets {
    /// `resolveSheetName(sheetId)`
    fn resolve(&self, sheet_id: Option<&Value>) -> Result<Value, ResolveError> {
        let key = key_of(sheet_id);
        let added = self
            .added
            .get(&key)
            .and_then(|added| added.name.as_ref())
            .filter(|name| !name.is_null());
        let sheet_name = match added {
            Some(name) => Some(name.clone()),
            None => self.names.get(&key).map(|name| Value::String(name.clone())),
        };
        match sheet_name {
            Some(name) if value_truthy(Some(&name)) => Ok(name),
            _ => fail(format!("Unknown worksheet {}.", value_to_string(sheet_id))),
        }
    }
}

/// Sheet ops and cell edits grouped by the sheet they belong to, the sheets in
/// the order they first appear.
struct ByName<T> {
    groups: JsMap<(Value, Vec<T>)>,
}

impl<T> ByName<T> {
    fn new() -> Self {
        ByName {
            groups: JsMap::new(),
        }
    }

    fn push(&mut self, sheet_name: &Value, item: T) {
        let key = key_of(Some(sheet_name));
        match self.groups.get_mut(&key) {
            Some((_, items)) => items.push(item),
            None => self.groups.set(key, (sheet_name.clone(), vec![item])),
        }
    }

    /// `[...map].map(([sheetName, items]) => ({ sheetName, [field]: items }))`
    fn into_list(self, field: &str, wrap: impl Fn(Vec<T>) -> Value) -> Value {
        Value::Array(
            self.groups
                .into_iter()
                .map(|(_, (sheet_name, items))| {
                    let mut map = Map::new();
                    map.insert("sheetName".to_owned(), sheet_name);
                    map.insert(field.to_owned(), wrap(items));
                    Value::Object(map)
                })
                .collect(),
        )
    }
}

fn structural_op(op: &Value) -> Value {
    let kind = field(op, "kind");
    if has(op, "range") {
        obj(vec![("kind", kind), ("range", field(op, "range"))])
    } else if has(op, "size") {
        obj(vec![
            ("kind", kind),
            ("start", field(op, "start")),
            ("end", field(op, "end")),
            ("size", field(op, "size")),
        ])
    } else if has(op, "level") {
        obj(vec![
            ("kind", kind),
            ("start", field(op, "start")),
            ("end", field(op, "end")),
            ("level", field(op, "level")),
            ("collapsed", field(op, "collapsed")),
        ])
    } else if has(op, "summaryBelow") {
        obj(vec![
            ("kind", kind),
            ("summaryBelow", field(op, "summaryBelow")),
            ("summaryRight", field(op, "summaryRight")),
        ])
    } else if has(op, "hidden") {
        obj(vec![
            ("kind", kind),
            ("start", field(op, "start")),
            ("end", field(op, "end")),
            ("hidden", field(op, "hidden")),
        ])
    } else if has(op, "style") {
        obj(vec![
            ("kind", kind),
            ("start", field(op, "start")),
            ("end", field(op, "end")),
            ("style", field(op, "style")),
        ])
    } else if has(op, "before") {
        obj(vec![
            ("kind", kind),
            ("index", field(op, "index")),
            ("count", field(op, "count")),
            ("before", field(op, "before")),
        ])
    } else {
        obj(vec![
            ("kind", kind),
            ("index", field(op, "index")),
            ("count", field(op, "count")),
        ])
    }
}

fn is_kind(op: &Value, kind: &str) -> bool {
    get(op, "kind").and_then(Value::as_str) == Some(kind)
}

/// `resolveWorkbookSave(sheetNames, request)`: a save request's sheet ops and
/// sheet ids (Univer ids) resolved to the file's sheet names. `sheet_names` is
/// the entries of the `Map` (id, file name); `request` is the
/// `WorkbookSaveRequest` as JSON. The answer is the `ResolvedWorkbookSave`
/// as JSON: a field the TypeScript leaves `undefined` is left out.
pub fn resolve_workbook_save(
    sheet_names: &[(String, String)],
    request: &Value,
) -> Result<Value, ResolveError> {
    let mut sheets = Sheets {
        names: JsMap::new(),
        added: JsMap::new(),
    };
    for (id, name) in sheet_names {
        sheets.names.set(format!("s{id}"), name.clone());
    }
    // Added sheet id → file name of the sheet whose part seeds the new part.
    let mut duplicate_sources: JsMap<Value> = JsMap::new();
    // (sheetName, newName)
    let mut renames: Vec<(Value, Option<Value>)> = Vec::new();
    let mut removals: Vec<Value> = Vec::new();
    // (sheetName, hidden)
    let mut hidden_changes: Vec<(Value, Option<Value>)> = Vec::new();
    // (sheetName, color)
    let mut tab_color_states: Vec<(Value, Option<Value>)> = Vec::new();
    let mut order_changed = false;
    let sheet_ops = list(request, "request.sheetOps", "sheetOps", None)?;
    for op in sheet_ops {
        let sheet_id = get(op, "sheetId");
        if is_kind(op, "add-sheet") {
            sheets.added.set(
                key_of(sheet_id),
                Added {
                    name: field(op, "name"),
                },
            );
            continue;
        }
        if is_kind(op, "duplicate-sheet") {
            let source_id = get(op, "sourceSheetId");
            let source_name = sheets.names.get(&key_of(source_id));
            let Some(source_name) = source_name.filter(|name| !name.is_empty()) else {
                return fail(format!(
                    "Unknown duplicate source {}.",
                    value_to_string(source_id)
                ));
            };
            sheets.added.set(
                key_of(sheet_id),
                Added {
                    name: field(op, "name"),
                },
            );
            duplicate_sources.set(key_of(sheet_id), Value::String(source_name.clone()));
            continue;
        }
        if is_kind(op, "reorder-sheets") {
            order_changed = true;
            continue;
        }
        let sheet_name = sheets.resolve(sheet_id)?;
        if is_kind(op, "rename-sheet") {
            renames.push((sheet_name, field(op, "newName")));
        } else if is_kind(op, "set-sheet-hidden") {
            hidden_changes.push((sheet_name, field(op, "hidden")));
        } else if is_kind(op, "set-sheet-tab-color") {
            tab_color_states.push((sheet_name, field(op, "color")));
        } else {
            removals.push(sheet_name);
        }
    }
    let mut rename_by_original: JsMap<Option<Value>> = JsMap::new();
    for (sheet_name, new_name) in &renames {
        rename_by_original.set(key_of(Some(sheet_name)), new_name.clone());
    }
    let pair = |key: &str, (sheet_name, value): &(Value, Option<Value>)| {
        obj(vec![
            ("sheetName", Some(sheet_name.clone())),
            (key, value.clone()),
        ])
    };
    let mut sheet_plan: Option<Value> = None;
    if sheet_ops
        .iter()
        .any(|op| !is_kind(op, "set-sheet-tab-color"))
    {
        let additions: Vec<Value> = sheets
            .added
            .iter()
            .map(|(key, added)| {
                obj(vec![
                    ("name", added.name.clone()),
                    ("sourceSheetName", duplicate_sources.get(key).cloned()),
                ])
            })
            .collect();
        let mut order = Vec::new();
        for sheet_id in list(request, "request.sheetOrder", "sheetOrder", Some("map"))? {
            let original = sheets.resolve(Some(sheet_id))?;
            if sheets.added.has(&key_of(Some(sheet_id))) {
                order.push(original);
            } else {
                let renamed = rename_by_original
                    .get(&key_of(Some(&original)))
                    .cloned()
                    .flatten()
                    .filter(|name| !name.is_null());
                order.push(renamed.unwrap_or(original));
            }
        }
        sheet_plan = Some(obj(vec![
            (
                "renames",
                Some(Value::Array(
                    renames.iter().map(|r| pair("newName", r)).collect(),
                )),
            ),
            ("additions", Some(Value::Array(additions))),
            ("removals", Some(Value::Array(removals.clone()))),
            (
                "hiddenChanges",
                Some(Value::Array(
                    hidden_changes.iter().map(|h| pair("hidden", h)).collect(),
                )),
            ),
            ("orderChanged", Some(Value::Bool(order_changed))),
            ("order", Some(Value::Array(order))),
        ]));
    }

    let mut edits = Vec::new();
    for edit in list(request, "request.edits", "edits", Some("map"))? {
        edits.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(edit, "sheetId"))?)),
            ("row", field(edit, "row")),
            ("column", field(edit, "column")),
            ("writeValue", field(edit, "writeValue")),
            (
                "cell",
                Some(obj(vec![
                    ("value", field(edit, "value")),
                    ("formula", field(edit, "formula")),
                ])),
            ),
            ("style", field(edit, "style")),
            ("rich", field(edit, "rich")),
            ("styleReset", field(edit, "styleReset")),
        ]));
    }
    let mut bulk_constant_fills = Vec::new();
    // `(request.bulkConstantFills ?? []).map(...)`
    if let Some(fills) = get(request, "bulkConstantFills").filter(|v| !v.is_null()) {
        let Some(fills) = fills.as_array() else {
            return fail("request.bulkConstantFills.map is not a function");
        };
        for fill in fills {
            let sheet_name = sheets.resolve(get(fill, "sheetId"))?;
            bulk_constant_fills.push(name_then_rest(sheet_name, fill));
        }
    }
    let mut ops_by_sheet: ByName<Value> = ByName::new();
    for op in list(request, "request.structuralOps", "structuralOps", None)? {
        let sheet_name = sheets.resolve(get(op, "sheetId"))?;
        ops_by_sheet.push(&sheet_name, structural_op(op));
    }
    let structural_ops = ops_by_sheet.into_list("ops", Value::Array);
    let mut filter_states = Vec::new();
    for state in list(request, "request.filterStates", "filterStates", Some("map"))? {
        filter_states.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(state, "sheetId"))?)),
            ("filter", field(state, "filter")),
            ("hiddenRows", field(state, "hiddenRows")),
            ("visibilityRange", field(state, "visibilityRange")),
        ]));
    }
    let mut links_by_sheet: ByName<Value> = ByName::new();
    for link in list(request, "request.hyperlinkEdits", "hyperlinkEdits", None)? {
        let sheet_name = sheets.resolve(get(link, "sheetId"))?;
        links_by_sheet.push(
            &sheet_name,
            obj(vec![
                ("row", field(link, "row")),
                ("column", field(link, "column")),
                ("target", field(link, "target")),
            ]),
        );
    }
    let hyperlink_edits = links_by_sheet.into_list("edits", Value::Array);
    let mut cf_states = Vec::new();
    for state in list(request, "request.cfStates", "cfStates", Some("map"))? {
        cf_states.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(state, "sheetId"))?)),
            ("rules", field(state, "rules")),
        ]));
    }
    let mut dv_states = Vec::new();
    for state in list(request, "request.dvStates", "dvStates", Some("map"))? {
        dv_states.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(state, "sheetId"))?)),
            ("rules", field(state, "rules")),
        ]));
    }
    let mut sheet_protections = Vec::new();
    for state in list(
        request,
        "request.sheetProtections",
        "sheetProtections",
        Some("map"),
    )? {
        let sheet_name = sheets.resolve(get(state, "sheetId"))?;
        sheet_protections.push(name_then_rest(sheet_name, state));
    }
    let mut protected_range_states = Vec::new();
    for state in list(
        request,
        "request.protectedRangeStates",
        "protectedRangeStates",
        Some("map"),
    )? {
        protected_range_states.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(state, "sheetId"))?)),
            ("ranges", field(state, "ranges")),
        ]));
    }
    let mut page_setup_states = Vec::new();
    for state in list(
        request,
        "request.pageSetupStates",
        "pageSetupStates",
        Some("map"),
    )? {
        let sheet_name = sheets.resolve(get(state, "sheetId"))?;
        page_setup_states.push(name_then_rest(sheet_name, state));
    }
    let mut note_states = Vec::new();
    for state in list(request, "request.noteStates", "noteStates", Some("map"))? {
        note_states.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(state, "sheetId"))?)),
            ("notes", field(state, "notes")),
        ]));
    }
    let mut visual_additions = Vec::new();
    for addition in list(
        request,
        "request.visualAdditions",
        "visualAdditions",
        Some("map"),
    )? {
        visual_additions.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(addition, "sheetId"))?)),
            ("anchor", field(addition, "anchor")),
            ("chart", field(addition, "chart")),
            ("shape", field(addition, "shape")),
            ("image", field(addition, "image")),
        ]));
    }
    let mut cell_image_additions = Vec::new();
    if let Some(additions) = get(request, "cellImageAdditions").filter(|v| !v.is_null()) {
        let Some(additions) = additions.as_array() else {
            return fail("request.cellImageAdditions.map is not a function");
        };
        for addition in additions {
            let sheet_name = sheets.resolve(get(addition, "sheetId"))?;
            cell_image_additions.push(name_then_rest(sheet_name, addition));
        }
    }
    let mut table_additions = Vec::new();
    for table in list(
        request,
        "request.tableAdditions",
        "tableAdditions",
        Some("map"),
    )? {
        table_additions.push(obj(vec![
            ("sheetName", Some(sheets.resolve(get(table, "sheetId"))?)),
            ("area", field(table, "area")),
            ("name", field(table, "name")),
            ("columnNames", field(table, "columnNames")),
            ("style", field(table, "style")),
            ("bandedRows", field(table, "bandedRows")),
            (
                "options",
                Some(obj(vec![
                    ("headerRow", field(table, "headerRow")),
                    ("totalsRow", field(table, "totalsRow")),
                    ("firstColumn", field(table, "firstColumn")),
                    ("lastColumn", field(table, "lastColumn")),
                    ("bandedColumns", field(table, "bandedColumns")),
                    ("filterButton", field(table, "filterButton")),
                ])),
            ),
        ]));
    }
    let mut table_edits = Vec::new();
    if let Some(edits) = get(request, "tableEdits").filter(|v| !v.is_null()) {
        let Some(edits) = edits.as_array() else {
            return fail("request.tableEdits.map is not a function");
        };
        for edit in edits {
            let sheet_name = sheets.resolve(get(edit, "sheetId"))?;
            table_edits.push(rest_then_name(sheet_name, edit));
        }
    }
    let mut pivot_additions = Vec::new();
    for pivot in list(
        request,
        "request.pivotAdditions",
        "pivotAdditions",
        Some("map"),
    )? {
        let sheet_name = sheets.resolve(get(pivot, "sheetId"))?;
        let source_sheet_name = sheets.resolve(get(pivot, "sourceSheetId"))?;
        pivot_additions.push(obj(vec![
            ("sheetName", Some(sheet_name)),
            ("sourceSheetName", Some(source_sheet_name)),
            ("sourceArea", field(pivot, "sourceArea")),
            ("location", field(pivot, "location")),
            ("name", field(pivot, "name")),
            ("fieldNames", field(pivot, "fieldNames")),
            ("rowFieldIndices", field(pivot, "rowFieldIndices")),
            ("columnFieldIndex", field(pivot, "columnFieldIndex")),
            ("pageFieldIndices", field(pivot, "pageFieldIndices")),
            ("pageLevelItems", field(pivot, "pageLevelItems")),
            ("pageItems", field(pivot, "pageItems")),
            ("rowItems", field(pivot, "rowItems")),
            ("rowLevelItems", field(pivot, "rowLevelItems")),
            ("rowLines", field(pivot, "rowLines")),
            ("columnItems", field(pivot, "columnItems")),
            ("columnFieldIndices", field(pivot, "columnFieldIndices")),
            ("colLevelItems", field(pivot, "colLevelItems")),
            ("colLines", field(pivot, "colLines")),
            ("groupings", field(pivot, "groupings")),
            ("filters", field(pivot, "filters")),
            ("rowHiddenItems", field(pivot, "rowHiddenItems")),
            ("colHiddenItems", field(pivot, "colHiddenItems")),
            ("values", field(pivot, "values")),
        ]));
    }
    let mut sparkline_additions = Vec::new();
    for group in list(
        request,
        "request.sparklineAdditions",
        "sparklineAdditions",
        Some("map"),
    )? {
        let sheet_name = sheets.resolve(get(group, "sheetId"))?;
        sparkline_additions.push(name_then_rest(sheet_name, group));
    }
    // Slicer panels: same sheetId → sheet name mapping as the other
    // additions; part paths stay package-absolute.
    let slicer_state = match get(request, "slicerState") {
        Some(Value::Null) => Value::Null,
        None => {
            return fail("Cannot read properties of undefined (reading 'slicers')");
        }
        Some(state) => {
            let mut slicers = Vec::new();
            for control in list(state, "request.slicerState.slicers", "slicers", Some("map"))? {
                let sheet_name = sheets.resolve(get(control, "sheetId"))?;
                slicers.push(rest_then_name(sheet_name, control));
            }
            let removals = list(state, "request.slicerState.removals", "removals", None)?;
            obj(vec![
                ("slicers", Some(Value::Array(slicers))),
                ("removals", Some(Value::Array(removals.to_vec()))),
            ])
        }
    };
    // Recalculated formula values: sheetId → file sheet name, the same
    // resolution the cell edits use.
    let mut formula_values_by_sheet: ByName<Value> = ByName::new();
    for cell in list(request, "request.formulaValues", "formulaValues", None)? {
        let sheet_name = sheets.resolve(get(cell, "sheetId"))?;
        formula_values_by_sheet.push(
            &sheet_name,
            obj(vec![
                ("row", field(cell, "row")),
                ("column", field(cell, "column")),
                ("value", field(cell, "value")),
            ]),
        );
    }
    let formula_values = formula_values_by_sheet.into_list("cells", Value::Array);
    // The redaction part is keyed by sheet NAME, so there is nothing to
    // resolve here. null = the renderer never loaded the marks.
    let redaction_states = match get(request, "redactionStates") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Array(states)) => {
            let mut out = Vec::new();
            for state in states {
                let marks = list(state, "state.marks", "marks", Some("map"))?;
                let marks = marks
                    .iter()
                    .map(|mark| {
                        let previous_fill = if has(mark, "previousFill") {
                            Some(
                                field(mark, "previousFill")
                                    .filter(|v| !v.is_null())
                                    .unwrap_or(Value::Null),
                            )
                        } else {
                            None
                        };
                        obj(vec![
                            ("startRow", field(mark, "startRow")),
                            ("endRow", field(mark, "endRow")),
                            ("startColumn", field(mark, "startColumn")),
                            ("endColumn", field(mark, "endColumn")),
                            ("label", field(mark, "label")),
                            ("previousFill", previous_fill),
                        ])
                    })
                    .collect();
                out.push(obj(vec![
                    ("sheetName", field(state, "sheetName")),
                    ("marks", Some(Value::Array(marks))),
                ]));
            }
            Value::Array(out)
        }
        Some(_) => return fail("request.redactionStates?.map is not a function"),
    };
    // Output-area expansion from layout growth: sheetId → sheet name; the part
    // path is resolved by the gateway.
    let mut pivot_refresh_updates = Vec::new();
    for update in list(
        request,
        "request.pivotRefreshUpdates",
        "pivotRefreshUpdates",
        Some("map"),
    )? {
        let cache_path = field(update, "cachePath");
        let sheet_name = sheets.resolve(get(update, "sheetId"))?;
        let new_output_ref = field(update, "newOutputRef");
        let relayout = match get(update, "relayout") {
            None => None,
            Some(relayout) if relayout.is_object() => {
                let mut rest = Map::new();
                for (key, value) in relayout.as_object().into_iter().flatten() {
                    if key != "sheetId" && key != "sourceSheetId" {
                        rest.insert(key.clone(), value.clone());
                    }
                }
                let source_sheet_name = sheets.resolve(get(relayout, "sourceSheetId"))?;
                rest.insert("sourceSheetName".to_owned(), source_sheet_name);
                Some(Value::Object(rest))
            }
            Some(_) => {
                return fail("Cannot destructure property 'sheetId' of 'undefined' or 'null'.");
            }
        };
        pivot_refresh_updates.push(obj(vec![
            ("cachePath", cache_path),
            ("sheetName", Some(sheet_name)),
            ("newOutputRef", new_output_ref),
            ("relayout", relayout),
        ]));
    }
    let tab_colors: Vec<Value> = tab_color_states.iter().map(|t| pair("color", t)).collect();
    Ok(obj(vec![
        ("edits", Some(Value::Array(edits))),
        ("bulkConstantFills", Some(Value::Array(bulk_constant_fills))),
        ("structuralOps", Some(structural_ops)),
        ("chartEdits", field(request, "chartEdits")),
        // Located by package-absolute drawingPath, so no sheet-name mapping.
        ("visualEdits", field(request, "visualEdits")),
        ("sheetPlan", sheet_plan),
        ("filterStates", Some(Value::Array(filter_states))),
        ("hyperlinkEdits", Some(hyperlink_edits)),
        ("cfStates", Some(Value::Array(cf_states))),
        ("dvStates", Some(Value::Array(dv_states))),
        ("sheetProtections", Some(Value::Array(sheet_protections))),
        ("tabColorStates", Some(Value::Array(tab_colors))),
        ("definedNamesState", field(request, "definedNamesState")),
        ("themeState", field(request, "themeState")),
        (
            "workbookProtectionState",
            field(request, "workbookProtectionState"),
        ),
        (
            "protectedRangeStates",
            Some(Value::Array(protected_range_states)),
        ),
        ("visualAdditions", Some(Value::Array(visual_additions))),
        (
            "cellImageAdditions",
            Some(Value::Array(cell_image_additions)),
        ),
        ("pageSetupStates", Some(Value::Array(page_setup_states))),
        ("noteStates", Some(Value::Array(note_states))),
        ("tableAdditions", Some(Value::Array(table_additions))),
        ("tableEdits", Some(Value::Array(table_edits))),
        ("pivotAdditions", Some(Value::Array(pivot_additions))),
        (
            "sparklineAdditions",
            Some(Value::Array(sparkline_additions)),
        ),
        ("slicerState", Some(slicer_state)),
        ("formulaValues", Some(formula_values)),
        (
            "pivotCacheRefreshPaths",
            field(request, "pivotCacheRefreshPaths"),
        ),
        (
            "pivotRefreshUpdates",
            Some(Value::Array(pivot_refresh_updates)),
        ),
        ("redactionStates", Some(redaction_states)),
        ("externalLinkOps", field(request, "externalLinkOps")),
    ]))
}
