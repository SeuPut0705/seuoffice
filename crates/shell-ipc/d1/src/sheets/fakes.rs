//! Stand-ins for the sheets hosts, for the unit tests and for `ipc-probe`.
//! Answers come from `case["sheets"]` (the case's `hosts.d1`), each call is a
//! line of the shared host log named after the TypeScript function it stands
//! for, and the files the engine would write are small marker files.

use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use jscompat::node_path::host::basename;
use serde_json::Value;
use shell_contract::{Hosts, IpcError, IpcValue, ViewId, WindowId};

use super::conv::serde_to_ipc;
use super::engine::*;
use super::schema;
use crate::value::{num, obj, string};

type Log = Arc<Mutex<Vec<Value>>>;

/// The work folder of an ODS export is named after the process's temp folder
/// and a random suffix; the log writes it as `<ods>`
fn scrub(path: &str) -> String {
    match path.find("seuoffice-ods-export-") {
        Some(at) => {
            let rest = &path[at..];
            let tail = rest.find('/').map_or("", |end| &rest[end..]);
            format!("<ods>{tail}")
        }
        None => path.to_owned(),
    }
}

fn io(path: &str, e: std::io::Error) -> IpcError {
    engine_error(format!("{e}: {path}"))
}

pub struct FakeEngine {
    log: Option<Log>,
    script: Value,
    sessions: AtomicU64,
    exit: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl FakeEngine {
    fn line(&self, items: Vec<Value>) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(Value::Array(items));
        }
    }

    fn answer(&self, name: &str) -> IpcValue {
        match self.script.get(name) {
            Some(value) => serde_to_ipc(value),
            None => obj([("fake", string(name))]),
        }
    }

    fn fails(&self, name: &str) -> Result<(), IpcError> {
        match self
            .script
            .get(name)
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
        {
            Some(message) => Err(engine_error(message)),
            None => Ok(()),
        }
    }

    fn mark(&self, target: &str, bytes: &[u8]) -> EngineResult<()> {
        fs::write(target, bytes).map_err(|e| io(target, e))
    }

    /// the sidecar died: the listener runs, as the engine's process watcher would
    pub fn exit(&self) {
        if let Some(listener) = self.exit.lock().unwrap().as_ref() {
            listener();
        }
    }
}

impl WorkbookEngine for FakeEngine {
    fn open(
        &self,
        path: &str,
        locale: &str,
        short_date: &str,
        _timeout: Option<f64>,
    ) -> EngineResult<OpenedWorkbook> {
        self.line(vec![
            "xlsx.open".into(),
            scrub(path).into(),
            locale.into(),
            short_date.into(),
        ]);
        self.fails("open")?;
        let n = self.sessions.fetch_add(1, Ordering::SeqCst) + 1;
        let session_id = format!("00000000-0000-4000-8000-{n:012}");
        let sheets = vec![OpenedSheet {
            id: "s1".into(),
            name: "Sheet1".into(),
            source_xml_bytes: self
                .script
                .get("sheet")
                .and_then(|s| s.get("sourceXmlBytes"))
                .and_then(Value::as_f64),
        }];
        // the sheet as the sidecar's result schema returns it
        let sheet = match self.script.get("sheet") {
            Some(sheet) => serde_to_ipc(sheet),
            None => obj([("id", string("s1")), ("name", string("Sheet1"))]),
        };
        let value = obj([
            ("sessionId", string(session_id.clone())),
            ("name", string(basename(path, None))),
            ("entryCount", num(1.0)),
            ("sheets", IpcValue::Array(vec![sheet])),
            ("styles", IpcValue::Array(Vec::new())),
            ("dxfStyles", IpcValue::Array(Vec::new())),
            ("visuals", IpcValue::Array(Vec::new())),
            ("definedNames", IpcValue::Array(Vec::new())),
        ]);
        Ok(OpenedWorkbook {
            value,
            session_id,
            sheets,
        })
    }

    fn close(&self, session_id: &str) -> EngineResult<()> {
        self.line(vec!["xlsx.close".into(), session_id.into()]);
        Ok(())
    }

    fn on_process_exit(&self, listener: Box<dyn Fn() + Send + Sync>) {
        *self.exit.lock().unwrap() = Some(listener);
    }

    fn read_range(&self, _request: &IpcValue) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readRange".into()]);
        self.fails("readRange")?;
        Ok(self.answer("readRange"))
    }

    fn read_formula_cells(&self, _request: &IpcValue) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readFormulaCells".into()]);
        Ok(self.answer("readFormulaCells"))
    }

    fn find_cells(&self, _request: &IpcValue) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.findCells".into()]);
        Ok(self.answer("findCells"))
    }

    fn read_row_outline(&self, _request: &IpcValue) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readRowOutline".into()]);
        Ok(self.answer("readRowOutline"))
    }

    fn read_media(&self, _request: &IpcValue) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readMedia".into()]);
        Ok(self.answer("readMedia"))
    }

    fn list_external_links(&self, path: &str, base_dir: &str) -> EngineResult<IpcValue> {
        self.line(vec![
            "xlsx.listExternalLinks".into(),
            path.into(),
            base_dir.into(),
        ]);
        Ok(self.answer("listExternalLinks"))
    }

    fn update_external_links(&self, path: &str, base_dir: &str) -> EngineResult<IpcValue> {
        self.line(vec![
            "xlsx.updateExternalLinks".into(),
            path.into(),
            base_dir.into(),
        ]);
        Ok(self.answer("updateExternalLinks"))
    }

    fn read_external_link_usage(&self, path: &str) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readExternalLinkUsage".into(), path.into()]);
        Ok(self.answer("readExternalLinkUsage"))
    }

    fn recalc_cells(
        &self,
        path: &str,
        edits: &[RecalcEdit],
        reads: &[RecalcRead],
    ) -> EngineResult<Vec<RecalcCell>> {
        self.line(vec![
            "xlsx.recalcCells".into(),
            path.into(),
            edits.len().into(),
            reads.len().into(),
        ]);
        Ok(edits
            .iter()
            .map(|edit| RecalcCell {
                sheet: edit.sheet.clone(),
                row: edit.row,
                column: edit.column,
                formatted: edit.input.clone(),
                number: edit.input.parse().ok(),
                is_error: false,
                is_formula: edit.input.starts_with('='),
            })
            .collect())
    }

    fn read_pivot_definition(
        &self,
        snapshot: &str,
        pivot: &str,
        cache: &str,
    ) -> EngineResult<IpcValue> {
        self.line(vec![
            "xlsx.readPivotDefinition".into(),
            snapshot.into(),
            pivot.into(),
            cache.into(),
        ]);
        Ok(self.answer("readPivotDefinition"))
    }

    fn read_slicer_state(&self, snapshot: &str) -> EngineResult<IpcValue> {
        // a workbook without slicer parts is answered before the parser runs
        let answer = match self.script.get("readSlicerState") {
            Some(value) => serde_to_ipc(value),
            None => IpcValue::Array(Vec::new()),
        };
        if answer != IpcValue::Array(Vec::new()) {
            self.line(vec!["xlsx.readSlicerState".into(), snapshot.into()]);
        }
        Ok(answer)
    }

    fn list_connections(&self, snapshot: &str) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.listConnections".into(), snapshot.into()]);
        Ok(self.answer("listConnections"))
    }

    fn refresh_connection(&self, snapshot: &str, id: &str) -> EngineResult<IpcValue> {
        self.line(vec![
            "xlsx.refreshConnection".into(),
            snapshot.into(),
            id.into(),
        ]);
        let flag = |name: &str| {
            self.script
                .get("refreshOutcome")
                .and_then(|v| v.get(name))
                .and_then(Value::as_bool)
                == Some(true)
        };
        if flag("unknown") {
            return Err(engine_error(
                "This workbook has no refreshable web query with that id.",
            ));
        }
        if flag("noTable") {
            return Err(engine_error("Could not read a table from that address."));
        }
        Ok(self.answer("refreshConnection"))
    }

    fn read_queries(&self, snapshot: &str) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readQueries".into(), snapshot.into()]);
        Ok(self.answer("readQueries"))
    }

    fn read_redactions(&self, snapshot: &str) -> EngineResult<IpcValue> {
        self.line(vec!["xlsx.readRedactions".into(), snapshot.into()]);
        match self.script.get("readRedactions") {
            Some(value) => Ok(serde_to_ipc(value)),
            None => Ok(obj([("status", string("absent"))])),
        }
    }

    fn write_workbook(
        &self,
        source: &str,
        target: &str,
        _resolved: &Value,
    ) -> EngineResult<IpcValue> {
        self.line(vec![
            "xlsx.writeWorkbook".into(),
            scrub(source).into(),
            scrub(target).into(),
        ]);
        self.fails("writeWorkbook")?;
        let mut bytes = fs::read(source).unwrap_or_default();
        bytes.extend_from_slice(b"+edits");
        self.mark(target, &bytes)?;
        Ok(IpcValue::Array(vec![string("xl/worksheets/sheet1.xml")]))
    }

    fn convert_to_ods(&self, source: &str, target: &str) -> EngineResult<OdsConversion> {
        self.line(vec![
            "xlsx.convertToOds".into(),
            scrub(source).into(),
            scrub(target).into(),
        ]);
        self.fails("convertToOds")?;
        self.mark(target, b"ods")?;
        let scripted = self.script.get("convertToOds");
        let formulas = scripted
            .and_then(|v| v.get("formulasDropped"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let dropped: Vec<(&'static str, f64)> = [
            "macros",
            "charts",
            "images",
            "shapes",
            "conditionalFormats",
            "validations",
            "pivots",
            "slicers",
            "sparklines",
            "comments",
        ]
        .into_iter()
        .map(|kind| {
            let count = scripted
                .and_then(|v| v.get("dropped"))
                .and_then(|d| d.get(kind))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            (kind, count)
        })
        .collect();
        Ok(OdsConversion {
            value: obj([
                ("formulasDropped", num(formulas)),
                (
                    "dropped",
                    IpcValue::Object(
                        dropped
                            .iter()
                            .map(|(kind, count)| ((*kind).to_owned(), num(*count)))
                            .collect(),
                    ),
                ),
            ]),
            formulas_dropped: formulas,
            dropped,
        })
    }

    fn convert_workbook(&self, path: &str, target: &str) -> EngineResult<Converted> {
        self.line(vec![
            "xlsx.convertWorkbook".into(),
            scrub(path).into(),
            scrub(target).into(),
        ]);
        self.fails("convertWorkbook")?;
        self.mark(target, b"xlsx")?;
        Ok(Converted {
            sheets: 1.0,
            formulas_dropped: 0.0,
        })
    }

    fn convert_legacy_workbook(
        &self,
        path: &str,
        target: &str,
        charset: Option<&str>,
    ) -> EngineResult<LegacyConversion> {
        self.line(vec![
            "legacy.convertLegacyWorkbook".into(),
            scrub(path).into(),
            scrub(target).into(),
            charset.map_or(Value::Null, Value::from),
        ]);
        self.fails("convertLegacyWorkbook")?;
        self.mark(target, b"xlsx")?;
        Ok(LegacyConversion::Workbook {
            formulas_dropped: 0.0,
        })
    }

    fn csv_to_xlsx_for_open(
        &self,
        csv: &[u8],
        charset: Option<&str>,
        sheet: &str,
        delimiter: Option<char>,
        control: Option<&ImportControl<'_>>,
    ) -> EngineResult<CsvConverted> {
        self.line(vec![
            "csv.csvToXlsxBufferForOpen".into(),
            csv.len().into(),
            charset.map_or(Value::Null, Value::from),
            sheet.into(),
            delimiter.map_or(Value::Null, |c| Value::from(c.to_string())),
        ]);
        if let (Some(control), Some(progress)) = (control, self.script.get("progress")) {
            (control.on_progress)(serde_to_ipc(progress));
        }
        Ok(CsvConverted {
            buffer: b"xlsx".to_vec(),
            empty: csv.is_empty(),
        })
    }

    fn blank_xlsx(&self) -> EngineResult<Vec<u8>> {
        self.line(vec!["csv.blankXlsx".into()]);
        Ok(b"xlsx".to_vec())
    }

    fn sheet_csv_to_xlsx(&self, content: &str, sheet: &str) -> EngineResult<Vec<u8>> {
        self.line(vec![
            "csv.sheetCsvToXlsxBuffer".into(),
            content.into(),
            sheet.into(),
        ]);
        let mut bytes = b"xlsx:".to_vec();
        bytes.extend_from_slice(content.as_bytes());
        Ok(bytes)
    }

    fn promote_file_atomically(&self, from: &str, to: &str) -> EngineResult<()> {
        self.line(vec![
            "xlsx.promoteFileAtomically".into(),
            from.into(),
            to.into(),
        ]);
        fs::rename(from, to).map_err(|e| io(from, e))
    }

    fn is_cfb_header(&self, head: &[u8]) -> bool {
        head.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    }

    fn is_encrypted_office_file(&self, bytes: &[u8]) -> bool {
        self.is_cfb_header(bytes)
    }

    fn encrypt_ooxml(&self, bytes: &[u8], password: &str) -> EngineResult<Vec<u8>> {
        self.line(vec![
            "encryption.encryptOoxml".into(),
            bytes.len().into(),
            password.into(),
        ]);
        let mut out = bytes.to_vec();
        out.extend_from_slice(format!("+enc:{password}").as_bytes());
        Ok(out)
    }

    fn unlock_office_file(
        &self,
        bytes: &[u8],
        ask: &mut dyn FnMut(bool) -> Result<Option<String>, UnlockFailure>,
    ) -> Result<Option<Unlocked>, UnlockFailure> {
        self.line(vec![
            "encryption.unlockOfficeFile".into(),
            bytes.len().into(),
        ]);
        match ask(false)? {
            Some(password) => Ok(Some(Unlocked {
                bytes: b"xlsx".to_vec(),
                password,
                asked: true,
            })),
            None => Ok(None),
        }
    }

    fn render_pdf(&self, html: &str, _request: &IpcValue) -> EngineResult<Vec<u8>> {
        let _ = html;
        self.line(vec!["pdf.renderPdf".into()]);
        Ok(b"%PDF-1.7".to_vec())
    }

    fn parse_save_request(&self, input: &IpcValue) -> EngineResult<IpcValue> {
        // zod's `.default([])` of the request's lists
        const LISTS: [&str; 18] = [
            "sheetOps",
            "sheetOrder",
            "edits",
            "structuralOps",
            "filterStates",
            "hyperlinkEdits",
            "cfStates",
            "dvStates",
            "noteStates",
            "pageSetupStates",
            "pivotAdditions",
            "pivotRefreshUpdates",
            "protectedRangeStates",
            "sheetProtections",
            "sparklineAdditions",
            "tableAdditions",
            "visualAdditions",
            "formulaValues",
        ];
        let IpcValue::Object(entries) = input else {
            return Err(not_an_object(input));
        };
        let mut entries = entries.clone();
        for key in LISTS {
            if !entries.iter().any(|(k, _)| k == key) {
                entries.push((key.to_owned(), IpcValue::Array(Vec::new())));
            }
        }
        if !entries.iter().any(|(k, _)| k == "slicerState") {
            entries.push(("slicerState".to_owned(), IpcValue::Null));
        }
        Ok(IpcValue::Object(entries))
    }

    fn parse_export_pdf_request(&self, input: &IpcValue) -> EngineResult<IpcValue> {
        match input {
            IpcValue::Object(_) => Ok(input.clone()),
            _ => Err(not_an_object(input)),
        }
    }

    fn parse_edits_chunk(&self, edits_json: &str) -> EngineResult<Vec<Value>> {
        // `JSON.parse` then `saveEditsChunkArraySchema` (an array of 1..=100000)
        let value = match serde_json::from_str::<Value>(edits_json) {
            Ok(value) => value,
            Err(_) => {
                let message = if edits_json == "not json" {
                    "Unexpected token 'o', \"not json\" is not valid JSON".to_owned()
                } else {
                    "Unexpected token in JSON".to_owned()
                };
                return Err(IpcError {
                    name: Some("SyntaxError".into()),
                    message,
                });
            }
        };
        match value {
            Value::Array(edits) if !edits.is_empty() => Ok(edits),
            other => {
                // an empty or non-array value is refused with zod's own issues
                let probe = schema::array(schema::string()).min(1).max(100_000);
                match schema::parse(&probe, &serde_to_ipc(&other)) {
                    Err(error) => Err(error),
                    Ok(()) => Ok(Vec::new()),
                }
            }
        }
    }

    fn parse_file_to_text(&self, path: &str) -> ParsedText {
        self.line(vec!["fileParse.parseFileToText".into(), path.into()]);
        // `script["parse"][basename]` is the parser's own answer for that file
        if let Some(scripted) = self
            .script
            .get("parse")
            .and_then(|p| p.get(basename(path, None)))
        {
            return ParsedText {
                ok: scripted.get("ok").and_then(Value::as_bool).unwrap_or(false),
                is_text: scripted.get("kind").and_then(Value::as_str) == Some("text"),
                text: scripted
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                damaged: scripted
                    .get("damaged")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                error: scripted
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
        }
        match fs::read(path) {
            Ok(bytes) => ParsedText {
                ok: true,
                is_text: true,
                text: Some(String::from_utf8_lossy(&bytes).into_owned()),
                ..ParsedText::default()
            },
            Err(_) => ParsedText {
                error: Some("unreadable".into()),
                ..ParsedText::default()
            },
        }
    }

    fn diagram_picture_ext_of(&self, path: &str) -> Option<&'static str> {
        // `script["pictureExt"][basename]`: the diagram name the parser finds in a picture
        match self
            .script
            .get("pictureExt")
            .and_then(|p| p.get(basename(path, None)))
            .and_then(Value::as_str)
        {
            Some("drawio.png") => Some("drawio.png"),
            Some("drawio.svg") => Some("drawio.svg"),
            _ => None,
        }
    }
}

struct FakePrompt(String);

impl PasswordPrompt for FakePrompt {
    fn ask(&self, _retry: bool) -> Option<String> {
        Some(self.0.clone())
    }

    fn close(&self) {}
}

/// a delay and what to run after it
pub type Timer = (u64, Box<dyn FnOnce() + Send>);

pub struct FakeShell {
    log: Option<Log>,
    script: Value,
    /// what `after` was asked to run, by delay
    pub timers: Mutex<Vec<Timer>>,
    pub opened: Mutex<Vec<(ViewId, String)>>,
    uuids: AtomicU64,
}

impl FakeShell {
    fn line(&self, items: Vec<Value>) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(Value::Array(items));
        }
    }

    /// runs the timers scheduled with this delay
    pub fn fire(&self, ms: u64) {
        let due: Vec<_> = {
            let mut timers = self.timers.lock().unwrap();
            let (due, rest): (Vec<_>, Vec<_>) = timers.drain(..).partition(|(at, _)| *at == ms);
            *timers = rest;
            due
        };
        for (_, job) in due {
            job();
        }
    }
}

impl SheetsShell for FakeShell {
    fn workbook_opened(&self, view: ViewId, path: &str) {
        self.line(vec![
            "shell.workbookOpened".into(),
            view.0.into(),
            path.into(),
        ]);
        self.opened.lock().unwrap().push((view, path.to_owned()));
    }

    fn activate_tab(&self, view: ViewId) {
        self.line(vec!["shell.activateTab".into(), view.0.into()]);
    }

    fn password_prompt(
        &self,
        _parent: Option<WindowId>,
        file_name: &str,
    ) -> Option<Box<dyn PasswordPrompt>> {
        self.line(vec!["shell.passwordPrompt".into(), file_name.into()]);
        self.script
            .get("password")
            .and_then(Value::as_str)
            .map(|p| Box::new(FakePrompt(p.to_owned())) as Box<dyn PasswordPrompt>)
    }

    fn startup(&self) -> Startup {
        let list = |key: &str| -> Vec<Value> {
            self.script
                .get("startup")
                .and_then(|s| s.get(key))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let pair = |entry: &Value, second: &str| {
            Some((
                ViewId(entry.get("view")?.as_u64()? as u32),
                entry.get(second)?.as_str()?.to_owned(),
            ))
        };
        Startup {
            queued: list("queued")
                .iter()
                .filter_map(|e| pair(e, "path"))
                .collect(),
            new_blank: self
                .script
                .get("startup")
                .and_then(|s| s.get("newBlank"))
                .and_then(Value::as_bool)
                == Some(true),
            untitled: list("untitled")
                .iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect(),
            mcp_writable: list("mcpWritable")
                .iter()
                .filter_map(|e| pair(e, "path"))
                .collect(),
            headless: list("headless")
                .iter()
                .filter_map(|e| {
                    let view = ViewId(e.get("view")?.as_u64()? as u32);
                    let input = e.get("input").and_then(Value::as_str).unwrap_or("");
                    Some((view, input.to_owned(), e.get("out")?.as_str()?.to_owned()))
                })
                .collect(),
        }
    }

    fn now_ms(&self) -> f64 {
        match self.script.get("clock").and_then(Value::as_f64) {
            Some(clock) => clock,
            None => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_millis() as f64),
        }
    }

    fn random_uuid(&self) -> String {
        let n = self.uuids.fetch_add(1, Ordering::SeqCst) + 1;
        format!("11111111-0000-4000-8000-{n:012}")
    }

    fn is_headless(&self) -> bool {
        self.script.get("headless").and_then(Value::as_bool) == Some(true)
    }

    fn new_document_dir(&self, view: ViewId) -> Option<String> {
        self.line(vec!["shell.newDocumentDir".into(), view.0.into()]);
        self.script
            .get("newDocumentDir")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn write_new_document(
        &self,
        view: ViewId,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, String> {
        self.line(vec![
            "shell.writeNewDocument".into(),
            view.0.into(),
            file_name.into(),
            bytes.len().into(),
        ]);
        let scripted = self.script.get("writeNewDocument");
        if let Some(message) = scripted
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
        {
            return Err(message.to_owned());
        }
        Ok(scripted
            .and_then(|v| v.get("path"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    fn create_document(&self, request: &IpcValue, view: ViewId) -> Option<CreateDocumentAnswer> {
        let _ = request;
        let answer = self.script.get("createDocument").map(serde_to_ipc)?;
        self.line(vec!["shell.createDocument".into(), view.0.into()]);
        Some(answer)
    }

    fn open_generated_path(&self, path: &str) -> bool {
        self.line(vec!["shell.openGeneratedPath".into(), path.into()]);
        false
    }

    fn assert_file_saved(&self, path: &str) -> Result<(), String> {
        match self.script.get("unsaved").and_then(Value::as_array) {
            Some(paths) if paths.iter().any(|p| p.as_str() == Some(path)) => {
                Err("The file has unsaved changes.".into())
            }
            _ => Ok(()),
        }
    }

    fn is_path_open_elsewhere(&self, path: &str) -> bool {
        self.script
            .get("openElsewhere")
            .and_then(Value::as_array)
            .is_some_and(|paths| paths.iter().any(|p| p.as_str() == Some(path)))
    }

    fn short_date_pattern(&self) -> String {
        "m/d/yyyy".into()
    }

    fn requested_locale(&self) -> String {
        "en".into()
    }

    fn delimited_import_limit(&self) -> f64 {
        self.script
            .get("importLimit")
            .and_then(Value::as_f64)
            .unwrap_or(256.0 * 1024.0 * 1024.0)
    }

    fn app_version(&self) -> String {
        "0.0.0-test".into()
    }

    fn after(&self, ms: u64, job: Box<dyn FnOnce() + Send>) {
        self.timers.lock().unwrap().push((ms, job));
    }

    fn template_fonts_dir(&self) -> String {
        "/fonts".into()
    }
}

/// The screens and windows the capturer lists; window `n` is `window:n`
const SOURCES: [(&str, &str); 3] = [
    ("screen:0", "Screen 1"),
    ("window:1", "Window 1"),
    ("window:7", "Notes"),
];

/// `script["screenStatus"]`: the answers of the permission check in turn, then `granted`
pub struct FakeScreen {
    statuses: Mutex<Vec<String>>,
}

impl ScreenCapture for FakeScreen {
    fn media_access_status(&self) -> String {
        let mut statuses = self.statuses.lock().unwrap();
        if statuses.is_empty() {
            "granted".into()
        } else {
            statuses.remove(0)
        }
    }

    fn list_sources(&self, exclude: Option<WindowId>) -> Vec<ScreenSource> {
        let own = exclude.map(|window| format!("window:{}", window.0));
        SOURCES
            .iter()
            .filter(|(id, _)| own.as_deref() != Some(*id))
            .map(|(id, name)| ScreenSource {
                id: (*id).into(),
                name: (*name).into(),
                thumbnail: String::new(),
            })
            .collect()
    }

    fn capture(&self, id: &str) -> Option<ScreenImage> {
        SOURCES
            .iter()
            .any(|(known, _)| *known == id)
            .then(|| ScreenImage {
                png: b"\x89PNG".to_vec(),
                width: 2.0,
                height: 1.0,
            })
    }
}

/// This app's fake hosts: they answer from `case["sheets"]` and log to the
/// shared host log when the probe inserted one
pub fn insert_fakes(hosts: &mut Hosts, case: &Value) {
    let script = case.get("sheets").cloned().unwrap_or(Value::Null);
    let log = hosts.get::<Log>().cloned();
    let engine = Arc::new(FakeEngine {
        log: log.clone(),
        script: script.clone(),
        sessions: AtomicU64::new(0),
        exit: Mutex::new(None),
    });
    let statuses: Vec<String> = script
        .get("screenStatus")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let shell = Arc::new(FakeShell {
        log,
        script,
        timers: Mutex::new(Vec::new()),
        opened: Mutex::new(Vec::new()),
        uuids: AtomicU64::new(0),
    });
    hosts.insert::<WorkbookEngineHost>(engine.clone());
    hosts.insert::<SheetsShellHost>(shell.clone());
    hosts.insert::<ScreenCaptureHost>(Arc::new(FakeScreen {
        statuses: Mutex::new(statuses),
    }));
    hosts.insert::<Arc<FakeEngine>>(engine);
    hosts.insert::<Arc<FakeShell>>(shell);
}

/// What zod says of a request that is not an object
fn not_an_object(input: &IpcValue) -> IpcError {
    match schema::parse(&schema::strict(Vec::new()), input) {
        Err(error) => error,
        Ok(()) => engine_error("request must be an object"),
    }
}
