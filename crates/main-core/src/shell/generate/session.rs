//! `apps/shell/src/main/generate/session.ts`: one open generate window's
//! state and actions, without Electron: the window module wires the
//! dependencies (file reads, the open tabs, the new tab) and pushes `state()`
//! to the renderer after every change.
//!
//! Rules held here:
//! - "make" re-reads every material first and goes ahead only with at least
//!   one readable material, none open with unsaved changes, and no more than
//!   the cap (8.3, 8.4). Unreadable ones are left out with their reasons.
//! - A document never saved cannot be material; it is listed with that
//!   reason, and once it is saved it becomes a normal row.
//! - "make" opens the new tab with the request queued for it, once, and
//!   closes the window. A second press while one is in flight does nothing.
//! - A conversion without AI (8.6) is offered only while exactly one material
//!   is listed and its type is the conversion's source.
//!
//! The TypeScript class holds its `deps`; here every method takes the host
//! ([`GenerateSessionHost`]) it runs against, so the window can lend its own
//! to a session it also owns. Promises are plain calls, a rejection is a
//! [`Failure`], and `Promise.all` over the rows runs them one after another
//! (the first rejection, in row order, is the answer; every row still runs).
//! The open files and open tabs the TypeScript asks the shell for are the
//! [`OpenSnapshot`] every action is handed. Two awaits wait on a renderer and
//! are steps: an editor's save command and the recheck `setTimeout` of
//! [`GenerateSession::save_begin`] ([`SaveStep`], [`SaveRun`]).

use jscompat::math_round;
use serde_json::{Value, json};

use super::convert::{ConvertResult, ConvertedDocument};
use super::generate_api::{
    AiTargetKind, ConvertKind, ConvertProblem, Failed, GenerateMode, GenerateWindowState,
    MaterialProblem, MaterialState, MaterialView, Notices, SaveAction, StateLimits, ai_target_str,
    convert_kind_str, default_generate_prompt, parse_convert_kind,
};
use super::limits::{MAX_IMAGE_MATERIAL_BYTES, MAX_MATERIAL_BYTES, MAX_MATERIALS};
use super::materials::{
    MaterialStatus, material_key, material_max_bytes, summarize_materials, untitled_material,
};
use super::open_materials::{
    OpenSnapshot, SaveAnswer, SaveMaterialRun, SaveMaterialStep, SaveNeed, SaveOutcome,
};
use super::request::{
    Prepared, available_conversions, is_ai_target_kind, prepare_generate_request,
};
use crate::packages::electron_utils::generate_handoff::{
    GenerateHandoff, GenerateHandoffTarget, Material,
};
use crate::packages::i18n::Lang;
use crate::shell::renderer_disposal::Failure;

/// where a row came from: a file, or an open document that was never saved
#[derive(Debug, Clone, PartialEq)]
pub enum MaterialRef {
    Path(String),
    Untitled { web_contents_id: f64, title: String },
}

/// `GenerateSessionDeps`. A call that rejects is a [`Failure`].
pub trait GenerateSessionHost {
    fn lang(&self) -> Lang;
    /// `deps.inspect(path)`, with the open files the shell gathered
    fn inspect(&mut self, snap: &OpenSnapshot<'_>, path: &str) -> Result<MaterialStatus, Failure>;
    /// For a never-saved document: its path now, `None` while it is still untitled.
    /// (`deps.pathOfUntitled(..).catch(() => null)`: the open tabs are the snapshot's.)
    fn path_of_untitled(&mut self, snap: &OpenSnapshot<'_>, web_contents_id: f64)
    -> Option<String>;
    /// whether this path's open document can be saved in place, or only shown
    fn save_action_for(&mut self, snap: &OpenSnapshot<'_>, path: &str) -> SaveAction;
    /// save the open document behind `path`, up to the editor's save command
    /// (a rejection is [`SaveOutcome::Failed`])
    fn save_material_begin(&mut self, snap: &OpenSnapshot<'_>, path: &str) -> SaveMaterialStep;
    /// the editor answered a [`SaveNeed`]
    fn save_material_resume(&mut self, run: SaveMaterialRun, answer: SaveAnswer) -> SaveOutcome;
    /// bring a never-saved document's tab forward so the user can save it
    fn show_untitled(
        &mut self,
        snap: &OpenSnapshot<'_>,
        web_contents_id: f64,
    ) -> Result<(), Failure>;
    /// open the new untitled tab with the request queued for it (fails when it cannot)
    fn open_target_tab(&mut self, handoff: &GenerateHandoff) -> Result<(), Failure>;
    /// `deps.convert` and `deps.openConvertedTab` were both given: conversions are offered
    fn can_convert(&self) -> bool;
    /// 8.6: run a conversion without AI on one material
    fn convert(&mut self, kind: ConvertKind, path: &str) -> Result<ConvertResult, Failure>;
    /// open a conversion's result as a new unsaved tab (fails when it cannot)
    fn open_converted_tab(&mut self, doc: &ConvertedDocument) -> Result<(), Failure>;
    /// `deps.redactionNotice` was given
    fn has_redaction_notice(&self) -> bool;
    /// whether converting this markdown file carries withheld spans over as their labels
    fn redaction_notice(&mut self, path: &str) -> Result<bool, Failure>;
    fn push(&mut self, state: &GenerateWindowState);
    fn close(&mut self);
    fn new_id(&mut self) -> String;
    fn now(&mut self) -> f64;
    /// a dirty flag can lag a save by a beat: when to look again (`None`: 600 ms)
    fn recheck_delay_ms(&self) -> Option<f64>;
    /// `MAX_OUTLINE_SLIDES` of `apps/shell/src/main/mcp/pptx-outline.ts`
    fn max_convert_slides(&self) -> usize;
}

struct Row {
    /// names this row where the TypeScript compares the object
    id: u64,
    key: String,
    mref: MaterialRef,
    /// `None` while being read
    status: Option<MaterialStatus>,
    save_action: Option<SaveAction>,
    /// a markdown file with withheld spans
    marked: bool,
}

fn key_of(mref: &MaterialRef) -> String {
    match mref {
        MaterialRef::Path(path) => material_key(path),
        MaterialRef::Untitled {
            web_contents_id, ..
        } => format!("untitled:{}", jscompat::number_to_string(*web_contents_id)),
    }
}

/// What the caller carries out for a save in flight, and answers with a
/// [`SessionAnswer`] through [`GenerateSession::save_resume`].
#[derive(Debug, Clone, PartialEq)]
pub enum SessionNeed {
    /// the editor's save command
    Save(SaveNeed),
    /// `await new Promise((r) => setTimeout(r, ms))`: call back after `ms`
    /// milliseconds, other messages landing meanwhile
    Sleep(f64),
}

/// The answer to a [`SessionNeed`].
#[derive(Debug, Clone, PartialEq)]
pub enum SessionAnswer {
    Save(SaveAnswer),
    Slept,
}

#[derive(Debug)]
enum SaveStage {
    Saving(SaveMaterialRun),
    Waiting,
}

/// The continuation of `save` between two calls; the caller keeps it. The
/// row is named by its id, so a row removed meanwhile is left alone.
#[derive(Debug)]
pub struct SaveRun {
    id: u64,
    row_key: String,
    stage: SaveStage,
}

/// One step of `save`.
#[derive(Debug)]
pub enum SaveStep {
    Done(Result<(), Failure>),
    Need(SessionNeed, SaveRun),
}

pub struct GenerateSession {
    rows: Vec<Row>,
    next_row: u64,
    kind: AiTargetKind,
    making: bool,
    closed: bool,
    saving: Vec<String>,
    failure: Option<Failed>,
    convert_problem: Option<ConvertProblem>,
    in_flight: u32,
    mode: GenerateMode,
    convert_kind: Option<ConvertKind>,
}

impl GenerateSession {
    pub fn new(refs: &[MaterialRef], kind: Option<AiTargetKind>) -> Self {
        let mut session = GenerateSession {
            rows: Vec::new(),
            next_row: 0,
            kind: kind.unwrap_or(GenerateHandoffTarget::Slides),
            making: false,
            closed: false,
            saving: Vec::new(),
            failure: None,
            convert_problem: None,
            in_flight: 0,
            mode: GenerateMode::Ai,
            convert_kind: None,
        };
        session.append_refs(refs);
        session
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// start over with a new set of materials (the window was opened again from an entry point)
    pub fn reset<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        refs: &[MaterialRef],
        kind: Option<AiTargetKind>,
    ) -> Result<(), Failure> {
        self.rows = Vec::new();
        if let Some(kind) = kind {
            self.kind = kind;
        }
        self.failure = None;
        self.convert_problem = None;
        self.mode = GenerateMode::Ai;
        self.convert_kind = None;
        self.append_refs(refs);
        self.refresh(host, snap)
    }

    pub fn state<H: GenerateSessionHost>(&self, host: &H) -> GenerateWindowState {
        let statuses: Vec<MaterialStatus> =
            self.rows.iter().filter_map(|r| r.status.clone()).collect();
        let summary = summarize_materials(&statuses, self.kind);
        let checking = self.in_flight > 0 || self.rows.iter().any(|r| r.status.is_none());
        let materials: Vec<MaterialView> = self.rows.iter().map(|row| self.view_of(row)).collect();
        let conversions = self.conversions(host);
        let convert_kind = self.chosen_conversion(&conversions);
        // a conversion picked and then taken away by the list: "make" waits rather than run the AI
        let lost_conversion = self.mode == GenerateMode::Convert && convert_kind.is_none();
        GenerateWindowState {
            lang: host.lang(),
            kind: self.kind,
            mode: if convert_kind.is_some() {
                GenerateMode::Convert
            } else {
                GenerateMode::Ai
            },
            convert_kind,
            conversions,
            redaction_notice: convert_kind == Some(ConvertKind::MarkdownToMindmap)
                && self.listed_rows().first().is_some_and(|row| row.marked),
            materials,
            ready_count: summary.ready.len(),
            total_bytes: summary.total_bytes,
            // no AI, no plan usage: the AI notices do not apply to a conversion
            notices: if convert_kind.is_some() {
                Notices {
                    usage: false,
                    long_material: false,
                }
            } else {
                summary.notices
            },
            too_many: summary.too_many,
            can_make: summary.can_make
                && !checking
                && !self.making
                && self.saving.is_empty()
                && !lost_conversion,
            checking,
            making: self.making,
            saving: self.saving.clone(),
            failure: self.failure,
            convert_problem: if self.failure == Some(Failed::Convert) {
                self.convert_problem
            } else {
                None
            },
            limits: StateLimits {
                max_materials: MAX_MATERIALS,
                max_material_mb: math_round(MAX_MATERIAL_BYTES / 1024.0 / 1024.0),
                max_image_mb: math_round(MAX_IMAGE_MATERIAL_BYTES / 1024.0 / 1024.0),
                max_convert_slides: host.max_convert_slides(),
            },
        }
    }

    fn view_of(&self, row: &Row) -> MaterialView {
        let (name, path) = match &row.mref {
            MaterialRef::Path(path) => (
                row.status
                    .as_ref()
                    .map_or_else(|| path.clone(), |s| s.name.clone()),
                Some(path.clone()).filter(|p| !p.is_empty()),
            ),
            MaterialRef::Untitled { title, .. } => (title.clone(), None),
        };
        let Some(s) = &row.status else {
            return MaterialView {
                key: row.key.clone(),
                name,
                path,
                size_bytes: None,
                state: MaterialState::Checking,
                problem: None,
                limit_mb: None,
                save_action: None,
            };
        };
        let mut view = MaterialView {
            key: row.key.clone(),
            name: s.name.clone(),
            path,
            size_bytes: s.size_bytes,
            state: MaterialState::Ready,
            problem: None,
            limit_mb: None,
            save_action: None,
        };
        if let Some(problem) = s.problem {
            let limit = material_max_bytes(&s.ext);
            view.state = MaterialState::Excluded;
            view.problem = Some(problem);
            if problem == MaterialProblem::TooLarge {
                view.limit_mb = Some(math_round(limit / 1024.0 / 1024.0));
            }
            if problem == MaterialProblem::Untitled {
                view.save_action = Some(SaveAction::Show);
            }
            return view;
        }
        if s.unsaved {
            view.state = MaterialState::Unsaved;
            view.save_action = Some(row.save_action.unwrap_or(SaveAction::Show));
        }
        view
    }

    fn push<H: GenerateSessionHost>(&self, host: &mut H) {
        if !self.closed {
            let state = self.state(&*host);
            host.push(&state);
        }
    }

    /// the rows that count as listed material: not left out (or still being read)
    fn listed_rows(&self) -> Vec<&Row> {
        self.rows
            .iter()
            .filter(|r| r.status.as_ref().is_none_or(|s| s.problem.is_none()))
            .collect()
    }

    /// 8.6: the conversions on offer: exactly one listed material, of a matching type
    fn conversions<H: GenerateSessionHost>(&self, host: &H) -> Vec<ConvertKind> {
        if !host.can_convert() {
            return Vec::new();
        }
        let listed = self.listed_rows();
        if listed.len() != 1 {
            return Vec::new();
        }
        match &listed[0].mref {
            MaterialRef::Path(path) => available_conversions(std::slice::from_ref(path)),
            MaterialRef::Untitled { .. } => Vec::new(),
        }
    }

    /// the chosen conversion while it is still on offer
    fn chosen_conversion(&self, conversions: &[ConvertKind]) -> Option<ConvertKind> {
        match self.convert_kind {
            Some(kind) if self.mode == GenerateMode::Convert && conversions.contains(&kind) => {
                Some(kind)
            }
            _ => None,
        }
    }

    fn append_refs(&mut self, refs: &[MaterialRef]) -> Vec<u64> {
        let mut added = Vec::new();
        for mref in refs {
            if matches!(mref, MaterialRef::Path(path) if path.is_empty()) {
                continue;
            }
            let key = key_of(mref);
            if self.rows.iter().any(|r| r.key == key) {
                continue;
            }
            let id = self.next_row;
            self.next_row += 1;
            self.rows.push(Row {
                id,
                key,
                mref: mref.clone(),
                status: None,
                save_action: None,
                marked: false,
            });
            added.push(id);
        }
        added
    }

    fn has_row(&self, id: u64) -> bool {
        self.rows.iter().any(|r| r.id == id)
    }

    fn row_mut(&mut self, id: u64) -> Option<&mut Row> {
        self.rows.iter_mut().find(|r| r.id == id)
    }

    /// read one row again; a row removed meanwhile is left alone
    fn inspect_row<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        id: u64,
    ) -> Result<(), Failure> {
        let untitled = self
            .rows
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| match &r.mref {
                MaterialRef::Untitled {
                    web_contents_id,
                    title,
                } => Some((*web_contents_id, title.clone())),
                MaterialRef::Path(_) => None,
            });
        if let Some((web_contents_id, title)) = untitled {
            let saved_path = host
                .path_of_untitled(snap, web_contents_id)
                .filter(|path| !path.is_empty());
            match saved_path {
                Some(saved) => {
                    let key = material_key(&saved);
                    if self.rows.iter().any(|r| r.id != id && r.key == key) {
                        self.rows.retain(|r| r.id != id);
                        return Ok(());
                    }
                    if let Some(row) = self.row_mut(id) {
                        row.mref = MaterialRef::Path(saved);
                        row.key = key;
                    }
                }
                None => {
                    if let Some(row) = self.row_mut(id) {
                        row.status = Some(untitled_material(web_contents_id, &title));
                    }
                    return Ok(());
                }
            }
        }
        let path = match self.rows.iter().find(|r| r.id == id).map(|r| &r.mref) {
            Some(MaterialRef::Path(path)) => path.clone(),
            _ => return Ok(()),
        };
        let status = host.inspect(snap, &path)?;
        let save_action = if status.unsaved {
            Some(host.save_action_for(snap, &path))
        } else {
            None
        };
        // only a markdown file that could be converted to a map is asked about its withheld spans
        let marked = if host.has_redaction_notice()
            && status.problem.is_none()
            && !status.unsaved
            && available_conversions(std::slice::from_ref(&path))
                .contains(&ConvertKind::MarkdownToMindmap)
        {
            host.redaction_notice(&path).unwrap_or(false)
        } else {
            false
        };
        if let Some(row) = self.row_mut(id) {
            let mut status = status;
            status.key = row.key.clone();
            row.status = Some(status);
            row.save_action = save_action;
            row.marked = marked;
        }
        Ok(())
    }

    fn inspect_rows<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        rows: &[u64],
    ) -> Result<(), Failure> {
        self.in_flight += 1;
        self.push(host);
        let mut failure: Option<Failure> = None;
        for id in rows {
            if let Err(error) = self.inspect_row(host, snap, *id)
                && failure.is_none()
            {
                failure = Some(error);
            }
        }
        self.in_flight -= 1;
        self.push(host);
        failure.map_or(Ok(()), Err)
    }

    /// read every row again (window focus, after a save, before "make")
    pub fn refresh<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
    ) -> Result<(), Failure> {
        let all: Vec<u64> = self.rows.iter().map(|r| r.id).collect();
        self.inspect_rows(host, snap, &all)
    }

    pub fn set_kind<H: GenerateSessionHost>(&mut self, host: &mut H, kind: Option<&Value>) {
        if !is_ai_target_kind(kind) || self.making {
            return;
        }
        let text = kind.and_then(Value::as_str).unwrap_or_default();
        if let Some(kind) = GenerateHandoffTarget::parse(text) {
            self.kind = kind;
        }
        self.mode = GenerateMode::Ai;
        self.failure = None;
        self.push(host);
    }

    /// 8.6: choose a conversion on offer, or null for back to the AI kinds
    pub fn set_convert<H: GenerateSessionHost>(&mut self, host: &mut H, kind: Option<&Value>) {
        if self.making {
            return;
        }
        if matches!(kind, Some(Value::Null)) {
            self.mode = GenerateMode::Ai;
        } else {
            let parsed = kind.and_then(Value::as_str).and_then(parse_convert_kind);
            let Some(parsed) = parsed.filter(|k| self.conversions(&*host).contains(k)) else {
                return;
            };
            self.mode = GenerateMode::Convert;
            self.convert_kind = Some(parsed);
        }
        self.failure = None;
        self.convert_problem = None;
        self.push(host);
    }

    pub fn add_paths<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        paths: &[Value],
    ) -> Result<(), Failure> {
        if self.making {
            return Ok(());
        }
        self.failure = None;
        let refs: Vec<MaterialRef> = paths
            .iter()
            .filter_map(Value::as_str)
            .filter(|p| !p.is_empty())
            .map(|p| MaterialRef::Path(p.to_owned()))
            .collect();
        let added = self.append_refs(&refs);
        if !added.is_empty() {
            self.inspect_rows(host, snap, &added)
        } else {
            self.push(host);
            Ok(())
        }
    }

    pub fn remove<H: GenerateSessionHost>(&mut self, host: &mut H, key: Option<&Value>) {
        let Some(key) = key.and_then(Value::as_str) else {
            return;
        };
        if self.making {
            return;
        }
        self.rows.retain(|r| r.key != key);
        self.failure = None;
        self.push(host);
    }

    /// `save(key)`, up to the first await that waits on a renderer
    pub fn save_begin<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        key: Option<&Value>,
    ) -> SaveStep {
        let found = key
            .and_then(Value::as_str)
            .and_then(|key| self.rows.iter().find(|r| r.key == key));
        let Some(row) = found else {
            return SaveStep::Done(Ok(()));
        };
        if self.making || self.saving.contains(&row.key) {
            return SaveStep::Done(Ok(()));
        }
        let (id, row_key, mref) = (row.id, row.key.clone(), row.mref.clone());
        self.failure = None;
        let path = match mref {
            MaterialRef::Untitled {
                web_contents_id, ..
            } => {
                if let Err(error) = host.show_untitled(snap, web_contents_id) {
                    return SaveStep::Done(Err(error));
                }
                self.push(host);
                return SaveStep::Done(Ok(()));
            }
            MaterialRef::Path(path) => path,
        };
        self.saving.push(row_key.clone());
        self.push(host);
        match host.save_material_begin(snap, &path) {
            SaveMaterialStep::Done(result) => self.after_save(host, snap, id, &row_key, result),
            SaveMaterialStep::Need(need, run) => SaveStep::Need(
                SessionNeed::Save(need),
                SaveRun {
                    id,
                    row_key,
                    stage: SaveStage::Saving(run),
                },
            ),
        }
    }

    /// the caller carried out a [`SessionNeed`]
    pub fn save_resume<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        run: SaveRun,
        answer: SessionAnswer,
    ) -> SaveStep {
        let SaveRun { id, row_key, stage } = run;
        match (stage, answer) {
            (SaveStage::Saving(save), SessionAnswer::Save(answer)) => {
                let result = host.save_material_resume(save, answer);
                self.after_save(host, snap, id, &row_key, result)
            }
            (SaveStage::Waiting, SessionAnswer::Slept) => {
                if self.has_row(id) {
                    SaveStep::Done(self.inspect_rows(host, snap, &[id]))
                } else {
                    SaveStep::Done(Ok(()))
                }
            }
            // an answer the step did not ask for ends the save
            _ => SaveStep::Done(Ok(())),
        }
    }

    /// what follows `result = await this.deps.saveMaterial(path)`
    fn after_save<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        id: u64,
        row_key: &str,
        result: SaveOutcome,
    ) -> SaveStep {
        self.saving.retain(|k| k != row_key);
        if result == SaveOutcome::Failed {
            self.failure = Some(Failed::Save);
        }
        if let Err(error) = self.inspect_rows(host, snap, &[id]) {
            return SaveStep::Done(Err(error));
        }
        // a tab can report its clean state a moment after the write lands
        let still_unsaved = self
            .rows
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| r.status.as_ref())
            .is_some_and(|s| s.unsaved);
        if result == SaveOutcome::Saved && still_unsaved {
            let delay = host.recheck_delay_ms().unwrap_or(600.0);
            return SaveStep::Need(
                SessionNeed::Sleep(delay),
                SaveRun {
                    id,
                    row_key: row_key.to_owned(),
                    stage: SaveStage::Waiting,
                },
            );
        }
        SaveStep::Done(Ok(()))
    }

    /// "make": read everything again, then open the new tab with the request
    /// queued for it and close the window. False (and nothing opened) when the
    /// materials do not allow it any more.
    pub fn make<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        text: Option<&Value>,
    ) -> bool {
        let Some(text) = text.and_then(Value::as_str) else {
            return false;
        };
        if self.closed || self.making {
            return false;
        }
        self.making = true;
        self.failure = None;
        self.push(host);
        match self.make_run(host, snap, text) {
            Ok(done) => done,
            Err(_) => {
                self.failure = Some(Failed::Make);
                self.stop_making(host, false)
            }
        }
    }

    fn make_run<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        text: &str,
    ) -> Result<bool, Failure> {
        self.refresh(host, snap)?;
        if self.mode == GenerateMode::Convert {
            let chosen = self.chosen_conversion(&self.conversions(&*host));
            return match chosen {
                Some(kind) => self.convert_and_open(host, snap, kind),
                None => Ok(self.stop_making(host, false)),
            };
        }
        let materials: Vec<Value> = self
            .rows
            .iter()
            .filter(|r| r.status.as_ref().is_some_and(|s| s.problem.is_none()))
            .filter_map(|r| match &r.mref {
                MaterialRef::Path(path) => Some(Value::from(path.as_str())),
                MaterialRef::Untitled { .. } => None,
            })
            .collect();
        let raw = json!({
            "mode": "ai",
            "kind": ai_target_str(self.kind),
            "materials": materials,
            "text": text,
        });
        let prepared = prepare_generate_request(&raw, &mut |path| host.inspect(snap, path))?;
        let Prepared::Ready { ready, .. } = prepared else {
            return Ok(self.stop_making(host, false));
        };
        let trimmed = jscompat::trim(text);
        let id = host.new_id();
        let lang = host.lang();
        let created_at = host.now();
        let handoff = GenerateHandoff {
            id,
            mode: "ai".to_owned(),
            target: self.kind,
            materials: ready
                .iter()
                .map(|s| Material {
                    path: s.path.clone().unwrap_or_default(),
                    name: s.name.clone(),
                })
                .collect(),
            text: if trimmed.is_empty() {
                default_generate_prompt(lang, self.kind).to_owned()
            } else {
                trimmed.to_owned()
            },
            default_text: trimmed.is_empty(),
            created_at,
        };
        host.open_target_tab(&handoff)?;
        self.closed = true;
        host.close();
        Ok(true)
    }

    /// 8.6: the one material, read again just now (8.4: not open with unsaved
    /// changes, saved at least once), converted without AI and opened as a new
    /// unsaved tab. A failed conversion opens nothing and keeps the window.
    fn convert_and_open<H: GenerateSessionHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        kind: ConvertKind,
    ) -> Result<bool, Failure> {
        let path = match self.listed_rows().first().map(|row| &row.mref) {
            Some(MaterialRef::Path(path)) if host.can_convert() => Some(path.clone()),
            _ => None,
        };
        let Some(path) = path else {
            return Ok(self.stop_making(host, false));
        };
        let raw = json!({
            "mode": "convert",
            "kind": convert_kind_str(kind),
            "materials": [path],
            "text": "",
        });
        let prepared = prepare_generate_request(&raw, &mut |path| host.inspect(snap, path))?;
        let Prepared::Ready { request, .. } = prepared else {
            return Ok(self.stop_making(host, false));
        };
        let source = request.materials[0].clone();
        match host.convert(kind, &source)? {
            Err(problem) => {
                self.failure = Some(Failed::Convert);
                self.convert_problem = Some(problem);
                Ok(self.stop_making(host, false))
            }
            Ok(content) => {
                let id = host.new_id();
                let created_at = host.now();
                host.open_converted_tab(&ConvertedDocument {
                    id,
                    content,
                    sources: vec![source],
                    created_at,
                })?;
                self.closed = true;
                host.close();
                Ok(true)
            }
        }
    }

    fn stop_making<H: GenerateSessionHost>(&mut self, host: &mut H, result: bool) -> bool {
        self.making = false;
        self.push(host);
        result
    }
}
