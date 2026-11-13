//! Fakes of the slides hosts for tests and for `ipc-probe`: a tiny
//! in-memory deck (slides with text elements, notes and a hidden flag) that
//! can be opened, edited by a few ops, snapshotted and saved, and a shell
//! that records what it was asked. Each call pushes one JSON array named
//! after the TypeScript function it stands for to the probe's log, when the
//! hosts hold one.

use std::any::Any;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use shell_contract::{IpcValue, ViewId, WindowId};

use super::engine::{
    DeckId, DeckSize, Display, EngineError, GeneratedPage, Isolation, PdfExportAnswer,
    PictureMedia, PreparedOpen, SlideRef, SlidesEngine, SlidesEngineHost, SlidesShell,
    SlidesShellHost, Snapshot, TakenHandoff, TxnFailure, TxnRecord, TxnRequest, TxnResult,
};
use super::fixtures::{Fixtures, ipc_of, normalize_sections, spid_of};
use crate::value::{as_num, as_str, field, num, obj, string};

/// the one master part of a fake deck
const MASTER_PART: &str = "ppt/slideMasters/slideMaster1.xml";

/// ops that make an element the executor answers with its id
const CREATING: &[&str] = &[
    "addTable",
    "addChart",
    "addSmartArt",
    "addModel3d",
    "addMedia",
    "groupElements",
    "pasteElements",
];

/// the probe's call log
pub type CallLog = Arc<Mutex<Vec<Value>>>;

#[derive(Clone, Debug, PartialEq)]
struct FakeElement {
    id: String,
    text: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct FakeSlide {
    path: String,
    elements: Vec<FakeElement>,
    hidden: bool,
    comments: Vec<(String, String)>,
    // what a probe case's fixtures put into the slide (fixtures.rs)
    notes: String,
    transition: Option<String>,
    advance_ms: Option<f64>,
    narration: Vec<i64>,
    animations: Vec<Value>,
    header_footer: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
struct FakeDeck {
    slides: Vec<FakeSlide>,
    cx: f64,
    cy: f64,
    next_id: u32,
    dirty: bool,
    meta_dirty: bool,
    master: Vec<FakeElement>,
    /// the fill and stroke master ops set, by element id
    master_fill: HashMap<String, IpcValue>,
    master_stroke: HashMap<String, IpcValue>,
}

impl FakeDeck {
    fn blank(count: usize) -> Self {
        FakeDeck {
            slides: (1..=count)
                .map(|n| FakeSlide {
                    path: format!("ppt/slides/slide{n}.xml"),
                    ..Default::default()
                })
                .collect(),
            cx: 9_144_000.0,
            cy: 5_143_500.0,
            next_id: 1,
            dirty: false,
            meta_dirty: false,
            master: vec![FakeElement {
                id: "m0".into(),
                text: "Title".into(),
            }],
            master_fill: HashMap::new(),
            master_stroke: HashMap::new(),
        }
    }

    /// the bytes `savePptx` writes: a line per slide
    fn to_bytes(&self) -> Vec<u8> {
        let mut text = format!("FAKEPPTX {} {} {}\n", self.cx, self.cy, self.next_id);
        for slide in &self.slides {
            let elements: Vec<String> = slide
                .elements
                .iter()
                .map(|e| format!("{}={}", e.id, e.text.replace('|', "/")))
                .collect();
            text.push_str(&format!(
                "{} {} {}\n",
                slide.path,
                u8::from(slide.hidden),
                elements.join("|")
            ));
        }
        text.into_bytes()
    }

    fn from_bytes(bytes: &[u8]) -> Option<FakeDeck> {
        let text = std::str::from_utf8(bytes).ok()?;
        let mut lines = text.lines();
        let mut head = lines.next()?.strip_prefix("FAKEPPTX ")?.split(' ');
        let cx = head.next()?.parse().ok()?;
        let cy = head.next()?.parse().ok()?;
        let next_id = head.next()?.parse().ok()?;
        let mut slides = Vec::new();
        for line in lines {
            let mut parts = line.splitn(3, ' ');
            let path = parts.next()?.to_owned();
            let hidden = parts.next()? == "1";
            let elements = parts
                .next()
                .unwrap_or("")
                .split('|')
                .filter(|e| !e.is_empty())
                .filter_map(|e| {
                    let (id, text) = e.split_once('=')?;
                    Some(FakeElement {
                        id: id.to_owned(),
                        text: text.to_owned(),
                    })
                })
                .collect();
            slides.push(FakeSlide {
                path,
                elements,
                hidden,
                ..Default::default()
            });
        }
        Some(FakeDeck {
            slides,
            cx,
            cy,
            next_id,
            dirty: false,
            meta_dirty: false,
            master: vec![FakeElement {
                id: "m0".into(),
                text: "Title".into(),
            }],
            master_fill: HashMap::new(),
            master_stroke: HashMap::new(),
        })
    }
}

/// The fake deck engine
pub struct FakeEngine {
    decks: Mutex<HashMap<u64, FakeDeck>>,
    next: Mutex<u64>,
    blank_slides: usize,
    fx: Fixtures,
    log: Option<CallLog>,
}

impl FakeEngine {
    /// `el.type` of an element: a fixture's media or 3D model makes it a picture
    fn kind_of(&self, id: &str) -> &'static str {
        if self.fx.by("media", id).is_null() && self.fx.by("models", id).is_null() {
            "text"
        } else {
            "picture"
        }
    }

    fn record(&self, call: Value) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(call);
        }
    }

    fn with<R>(&self, deck: DeckId, f: impl FnOnce(&mut FakeDeck) -> R) -> R {
        let mut decks = self.decks.lock().unwrap();
        f(decks.get_mut(&deck.0).expect("a deck the fake opened"))
    }

    /// The text of an element, for tests
    pub fn text_of(&self, deck: DeckId, slide: usize, id: &str) -> Option<String> {
        self.with(deck, |d| {
            d.slides
                .get(slide)?
                .elements
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.text.clone())
        })
    }

    fn render(d: &FakeDeck, index: usize) -> IpcValue {
        let slide = &d.slides[index];
        obj([
            ("partPath", string(slide.path.as_str())),
            ("hidden", IpcValue::Bool(slide.hidden)),
            (
                "elements",
                IpcValue::Array(
                    slide
                        .elements
                        .iter()
                        .map(|e| {
                            obj([
                                ("id", string(e.id.as_str())),
                                ("text", string(e.text.as_str())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }

    /// the failure of one op against `d`, if it cannot apply
    fn check(d: &FakeDeck, op: &IpcValue) -> Option<String> {
        let name = as_str(field(op, "op")).unwrap_or("");
        let target = field(op, "target");
        if let Some(part) = as_str(field(target, "part")) {
            if part != MASTER_PART {
                return Some("part not found".into());
            }
            return match name {
                "addElement" => None,
                "setText" | "deleteElement" | "setFill" | "setStroke" => {
                    let id = as_str(field(target, "el")).unwrap_or("");
                    (!d.master.iter().any(|e| e.id == id))
                        .then(|| format!("element {id} not found"))
                }
                other => Some(format!("unsupported op {other}")),
            };
        }
        let slide = as_num(field(target, "slide"));
        let slide_ok =
            slide.is_some_and(|s| s.fract() == 0.0 && s >= 0.0 && (s as usize) < d.slides.len());
        match name {
            "addElement" | "setHidden" | "deleteSlide" | "duplicateSlide" | "addComment"
            | "addPicture"
                if !slide_ok =>
            {
                Some("slide not found".into())
            }
            "setText" | "deleteElement" => {
                if !slide_ok {
                    return Some("slide not found".into());
                }
                let id = as_str(field(target, "el")).unwrap_or("");
                let found = d.slides[slide.unwrap() as usize]
                    .elements
                    .iter()
                    .any(|e| e.id == id);
                (!found).then(|| format!("element {id} not found"))
            }
            "deleteComment" => {
                if !slide_ok {
                    return Some("slide not found".into());
                }
                let idx = as_num(field(op, "idx")).unwrap_or(-1.0);
                let count = d.slides[slide.unwrap() as usize].comments.len() as f64;
                (!(idx >= 0.0 && idx < count)).then(|| "no such comment".to_owned())
            }
            "addElement" | "setHidden" | "deleteSlide" | "duplicateSlide" | "addComment"
            | "addPicture" => None,
            // any other op addresses a slide, and an element of it, or none
            _ => {
                if slide.is_none() && field(target, "slide") == &IpcValue::Undefined {
                    return None;
                }
                if !slide_ok {
                    return Some("slide not found".into());
                }
                match as_str(field(target, "el")) {
                    Some(id)
                        if !d.slides[slide.unwrap() as usize]
                            .elements
                            .iter()
                            .any(|e| e.id == id) =>
                    {
                        Some(format!("element {id} not found"))
                    }
                    _ => None,
                }
            }
        }
    }

    fn apply(d: &mut FakeDeck, op: &IpcValue) -> TxnRecord {
        let name = as_str(field(op, "op")).unwrap_or("");
        let target = field(op, "target");
        if as_str(field(target, "part")).is_some() {
            return Self::apply_master(d, op);
        }
        let slide_given = as_num(field(target, "slide")).is_some();
        let slide = as_num(field(target, "slide")).unwrap_or(0.0) as usize;
        let mut created = None;
        match name {
            "addElement" => {
                let id = format!("e{}", d.next_id);
                d.next_id += 1;
                let text = paragraphs_text(field(op, "paragraphs"));
                d.slides[slide].elements.push(FakeElement {
                    id: id.clone(),
                    text,
                });
                created = Some(vec![id]);
            }
            "setText" => {
                let id = as_str(field(target, "el")).unwrap_or("");
                let text = paragraphs_text(field(op, "paragraphs"));
                if let Some(e) = d.slides[slide].elements.iter_mut().find(|e| e.id == id) {
                    e.text = text;
                }
            }
            "deleteElement" => {
                let id = as_str(field(target, "el")).unwrap_or("").to_owned();
                d.slides[slide].elements.retain(|e| e.id != id);
            }
            "setHidden" => {
                d.slides[slide].hidden = matches!(field(op, "hidden"), IpcValue::Bool(true));
            }
            "deleteSlide" => {
                d.slides.remove(slide);
            }
            "duplicateSlide" => {
                let mut copy = d.slides[slide].clone();
                copy.path = format!("ppt/slides/slide{}.xml", d.next_id + 100);
                d.next_id += 1;
                d.slides.insert(slide + 1, copy);
            }
            "addComment" => {
                let author = as_str(field(op, "author")).unwrap_or("").to_owned();
                let text = as_str(field(op, "text")).unwrap_or("").to_owned();
                d.slides[slide].comments.push((author, text));
            }
            "deleteComment" => {
                let idx = as_num(field(op, "idx")).unwrap_or(0.0) as usize;
                d.slides[slide].comments.remove(idx);
            }
            "clearNarration" => d.slides[slide].narration.clear(),
            "addPicture" => {
                let id = format!("e{}", d.next_id);
                d.next_id += 1;
                let ext = as_str(field(op, "ext")).unwrap_or("");
                d.slides[slide].elements.push(FakeElement {
                    id: id.clone(),
                    text: format!("picture:{ext}"),
                });
                created = Some(vec![id]);
            }
            _ if CREATING.contains(&name) => {
                let id = format!("e{}", d.next_id);
                d.next_id += 1;
                if let Some(s) = d.slides.get_mut(slide) {
                    s.elements.push(FakeElement {
                        id: id.clone(),
                        text: name.to_owned(),
                    });
                }
                created = Some(vec![id]);
            }
            _ => {}
        }
        d.dirty = true;
        let after = match name {
            "applyTheme" => obj([("patched", num(1.0)), ("remapped", num(0.0))]),
            "findReplace" => obj([
                ("count", num(1.0)),
                ("changedSlides", IpcValue::Array(vec![num(0.0)])),
            ]),
            "tableStructure" | "tableMerge" => obj([(
                "elementId",
                string(as_str(field(target, "el")).unwrap_or("")),
            )]),
            "pasteSlide" | "insertSlidePptx" => obj([("index", num((slide + 1) as f64))]),
            "addSection" | "renameSection" | "removeSection" | "moveSection" | "setSections" => {
                obj([("section", string(name))])
            }
            "addPicture" | "replacePicture" | "setBackground" => {
                obj([("mediaPath", string("ppt/media/image1.png"))])
            }
            _ => IpcValue::Undefined,
        };
        TxnRecord {
            op: op.clone(),
            slide_id: slide_given.then(|| format!("slide-{slide}")),
            created,
            after,
        }
    }

    /// ops addressed to the master part (`target.part`)
    fn apply_master(d: &mut FakeDeck, op: &IpcValue) -> TxnRecord {
        let name = as_str(field(op, "op")).unwrap_or("");
        let target = field(op, "target");
        let mut created = None;
        match name {
            "addElement" => {
                let id = format!("m{}", d.next_id);
                d.next_id += 1;
                d.master.push(FakeElement {
                    id: id.clone(),
                    text: paragraphs_text(field(op, "paragraphs")),
                });
                created = Some(vec![id]);
            }
            "setText" => {
                let id = as_str(field(target, "el")).unwrap_or("");
                let text = paragraphs_text(field(op, "paragraphs"));
                if let Some(e) = d.master.iter_mut().find(|e| e.id == id) {
                    e.text = text;
                }
            }
            "deleteElement" => {
                let id = as_str(field(target, "el")).unwrap_or("").to_owned();
                d.master.retain(|e| e.id != id);
            }
            "setFill" => {
                let id = as_str(field(target, "el")).unwrap_or("").to_owned();
                d.master_fill.insert(id, field(op, "fill").clone());
            }
            "setStroke" => {
                let id = as_str(field(target, "el")).unwrap_or("").to_owned();
                d.master_stroke.insert(id, field(op, "stroke").clone());
            }
            _ => {}
        }
        d.dirty = true;
        TxnRecord {
            op: op.clone(),
            slide_id: None,
            created,
            after: IpcValue::Undefined,
        }
    }
}

impl SlidesEngine for FakeEngine {
    fn create_blank_pptx(&self) -> Result<Vec<u8>, EngineError> {
        self.record(json!(["pptx-engine.createBlankPptx"]));
        Ok(FakeDeck::blank(self.blank_slides).to_bytes())
    }

    fn open(&self, bytes: &[u8]) -> Result<DeckId, EngineError> {
        self.record(json!(["pptx-engine.openPptx", bytes.len()]));
        let mut deck =
            FakeDeck::from_bytes(bytes).ok_or_else(|| EngineError("not a pptx".into()))?;
        for (index, slide) in deck.slides.iter_mut().enumerate() {
            let at = |key: &str| self.fx.at(key, index);
            slide.notes = at("notes").as_str().unwrap_or("").to_owned();
            slide.transition = at("transitions").as_str().map(str::to_owned);
            slide.advance_ms = at("advanceMs").as_f64();
            slide.narration = at("narration")
                .as_array()
                .map(|spids| spids.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            slide.animations = at("animations").as_array().cloned().unwrap_or_default();
            slide.header_footer = Some(at("headerFooter").clone()).filter(|v| !v.is_null());
        }
        let mut next = self.next.lock().unwrap();
        *next += 1;
        self.decks.lock().unwrap().insert(*next, deck);
        Ok(DeckId(*next))
    }

    fn release(&self, deck: DeckId) {
        self.decks.lock().unwrap().remove(&deck.0);
    }

    fn set_slide_size(&self, deck: DeckId, cx: f64, cy: f64) {
        self.record(json!(["pptx-engine.setSlideSize", cx, cy]));
        self.with(deck, |d| {
            d.cx = cx;
            d.cy = cy;
        });
    }

    fn size(&self, deck: DeckId) -> DeckSize {
        self.with(deck, |d| DeckSize { cx: d.cx, cy: d.cy })
    }

    fn slide_paths(&self, deck: DeckId) -> Vec<String> {
        self.with(deck, |d| d.slides.iter().map(|s| s.path.clone()).collect())
    }

    fn slide_refs(&self, deck: DeckId) -> Vec<SlideRef> {
        self.with(deck, |d| {
            d.slides
                .iter()
                .map(|s| SlideRef {
                    path: s.path.clone(),
                    has_number: false,
                })
                .collect()
        })
    }

    fn slides_dirty(&self, deck: DeckId) -> bool {
        self.with(deck, |d| d.dirty)
    }

    fn default_font(&self, _deck: DeckId) -> Option<String> {
        Some("Calibri".into())
    }

    fn adopt_embedded_fonts(&self, _deck: DeckId) {}

    fn reset_font_metrics(&self) {
        // `resetFontMetrics` of session-state drops caches; nothing is asked of a host
    }

    fn render_all(&self, deck: DeckId, _fit_width_px: f64) -> Vec<IpcValue> {
        self.with(deck, |d| {
            (0..d.slides.len()).map(|i| Self::render(d, i)).collect()
        })
    }

    fn render_slide(
        &self,
        deck: DeckId,
        index: usize,
        _fit: f64,
        _reparse: bool,
    ) -> Option<IpcValue> {
        self.with(deck, |d| {
            (index < d.slides.len()).then(|| Self::render(d, index))
        })
    }

    fn run_txn(&self, deck: DeckId, request: &TxnRequest) -> TxnResult {
        self.record(json!([
            "pptx-ops.runTxn",
            request.ops.len(),
            request.dry_run
        ]));
        self.with(deck, |d| {
            let mut working = d.clone();
            let mut failures = Vec::new();
            let mut records = Vec::new();
            for (index, op) in request.ops.iter().enumerate() {
                match Self::check(&working, op) {
                    Some(error) => failures.push(TxnFailure { index, error }),
                    None if !request.dry_run => records.push(Self::apply(&mut working, op)),
                    None => {}
                }
            }
            let blocked = match request.isolation {
                Isolation::Atomic => !failures.is_empty(),
                Isolation::PerOp => failures.len() >= request.ops.len(),
            };
            let applied = !request.dry_run && !blocked && !records.is_empty();
            if applied {
                *d = working;
            }
            TxnResult {
                applied,
                failures: (!failures.is_empty()).then_some(failures),
                records: (applied || request.dry_run)
                    .then_some(records)
                    .filter(|r| !r.is_empty()),
                plan: request.dry_run.then(|| IpcValue::Array(Vec::new())),
            }
        })
    }

    fn snapshot(&self, deck: DeckId, meta_dirty: bool) -> Snapshot {
        self.with(deck, |d| {
            let mut copy = d.clone();
            copy.meta_dirty = meta_dirty;
            Snapshot(Rc::new(copy) as Rc<dyn Any>)
        })
    }

    fn restore(&self, deck: DeckId, snapshot: &Snapshot) -> bool {
        let copy = snapshot
            .0
            .downcast_ref::<FakeDeck>()
            .expect("a fake snapshot")
            .clone();
        let meta_dirty = copy.meta_dirty;
        self.with(deck, |d| {
            // the master and the id counter live in the package, which a history step restores
            // only by its entries: the fake keeps them
            let (master, next_id) = (std::mem::take(&mut d.master), d.next_id);
            let (fill, stroke) = (
                std::mem::take(&mut d.master_fill),
                std::mem::take(&mut d.master_stroke),
            );
            *d = copy;
            d.master = master;
            d.master_fill = fill;
            d.master_stroke = stroke;
            d.next_id = next_id;
        });
        meta_dirty
    }

    fn save_bytes(&self, deck: DeckId) -> Result<Vec<u8>, EngineError> {
        self.record(json!(["pptx-engine.savePptx"]));
        Ok(self.with(deck, |d| d.to_bytes()))
    }

    fn save_to_file(&self, deck: DeckId, path: &str) -> Result<(), EngineError> {
        self.record(json!(["pptx-engine.savePptxToFile"]));
        let bytes = self.with(deck, |d| d.to_bytes());
        std::fs::write(path, bytes).map_err(|e| EngineError(e.to_string()))
    }

    fn commit_saved(&self, deck: DeckId) {
        self.with(deck, |d| d.dirty = false);
    }

    fn has_redaction(&self, deck: DeckId) -> bool {
        // a fixture's `redact` marks elements "withheld from the model"
        self.with(deck, |d| {
            d.slides.iter().flat_map(|s| &s.elements).any(|e| {
                self.fx
                    .by("redact", &e.id)
                    .as_str()
                    .is_some_and(|label| !label.is_empty())
            })
        })
    }

    fn encrypt_ooxml(&self, bytes: &[u8], password: &str) -> Result<Vec<u8>, EngineError> {
        let mut out = format!("ENC {password}\n").into_bytes();
        out.extend_from_slice(bytes);
        Ok(out)
    }

    fn is_encrypted_ooxml(&self, bytes: &[u8]) -> bool {
        bytes.starts_with(b"ENC ")
    }

    fn decrypt_office_file(&self, bytes: &[u8], password: &str) -> Result<Vec<u8>, EngineError> {
        let header = format!("ENC {password}\n");
        bytes
            .strip_prefix(header.as_bytes())
            .map(<[u8]>::to_vec)
            .ok_or_else(|| EngineError("wrong password".into()))
    }

    fn picture_media(&self, deck: DeckId, slide: usize, id: &str) -> Option<PictureMedia> {
        let present = self.with(deck, |d| {
            d.slides
                .get(slide)
                .is_some_and(|s| s.elements.iter().any(|e| e.id == id))
        });
        let media = self.fx.by("media", id);
        let target = media["target"].as_str().filter(|t| !t.is_empty())?;
        present.then(|| PictureMedia {
            kind: media["kind"].as_str().unwrap_or("").to_owned(),
            target: target.to_owned(),
            external: media["external"].as_bool().unwrap_or(false),
        })
    }

    fn model3d_target(&self, deck: DeckId, slide: usize, id: &str) -> Option<String> {
        let present = self.with(deck, |d| {
            d.slides
                .get(slide)
                .is_some_and(|s| s.elements.iter().any(|e| e.id == id))
        });
        let target = self.fx.by("models", id)["target"]
            .as_str()
            .filter(|t| !t.is_empty())?;
        present.then(|| target.to_owned())
    }

    fn read_part(&self, _deck: DeckId, path: &str) -> Option<Vec<u8>> {
        self.fx
            .by("parts", path)
            .as_str()
            .map(|text| text.as_bytes().to_vec())
    }

    fn copy_slide(&self, deck: DeckId, index: usize) -> Option<IpcValue> {
        self.with(deck, |d| {
            (index < d.slides.len()).then(|| Self::render(d, index))
        })
    }

    fn copy_elements(&self, deck: DeckId, slide: usize, ids: &[String]) -> Option<Vec<IpcValue>> {
        self.with(deck, |d| {
            let slide = d.slides.get(slide)?;
            Some(
                ids.iter()
                    .filter_map(|id| slide.elements.iter().find(|e| &e.id == id))
                    .map(|e| {
                        obj([
                            ("id", string(e.id.as_str())),
                            ("text", string(e.text.as_str())),
                        ])
                    })
                    .collect(),
            )
        })
    }

    fn template_cover(&self, id: &str, lang: &str, _fit: f64) -> Option<IpcValue> {
        if id != "plain" {
            return None;
        }
        // the template's sample cover goes through the page builder and opens in memory
        let spec = format!("\"{lang}\"");
        self.record(json!(["pipelines.buildPagePptx", spec.len()]));
        let mut deck = FakeDeck::blank(1);
        deck.slides[0].elements.push(FakeElement {
            id: "e0".into(),
            text: spec,
        });
        self.record(json!(["pptx-engine.openPptx", deck.to_bytes().len()]));
        Some(Self::render(&deck, 0))
    }

    fn font_file_families(&self, path: &str) -> Vec<String> {
        self.record(json!(["fonts.fontFileFamilies", path]));
        let name = path.rsplit('/').next().unwrap_or(path);
        vec![name.split('.').next().unwrap_or(name).to_owned()]
    }

    fn parse_file_text(&self, path: &str) -> Result<String, String> {
        self.record(json!(["file-parse.parseFileToText", path]));
        std::fs::read_to_string(path)
            .map_err(|e| main_core::node_fs::node_error(&e, "open", path).message)
    }

    fn diagram_picture_ext_of(&self, _path: &str) -> Option<String> {
        None
    }

    fn generate_page(&self, spec_json: &str, _fonts: &IpcValue) -> Result<GeneratedPage, String> {
        if spec_json.is_empty() {
            return Err("empty page spec".into());
        }
        self.record(json!(["pipelines.buildPagePptx", spec_json.len()]));
        let mut deck = FakeDeck::blank(1);
        deck.slides[0].elements.push(FakeElement {
            id: "e0".into(),
            text: spec_json.to_owned(),
        });
        Ok(GeneratedPage {
            bytes: deck.to_bytes(),
            image_failures: Vec::new(),
        })
    }

    fn assemble_pages(&self, pages: &[Vec<u8>]) -> Result<Vec<u8>, EngineError> {
        let mut decks: Vec<FakeDeck> = pages
            .iter()
            .map(|p| FakeDeck::from_bytes(p).ok_or_else(|| EngineError("not a pptx".into())))
            .collect::<Result<_, _>>()?;
        let mut first = decks.remove(0);
        for (n, deck) in decks.into_iter().enumerate() {
            for mut slide in deck.slides {
                slide.path = format!("ppt/slides/slide{}.xml", first.slides.len() + n + 1);
                first.slides.push(slide);
            }
        }
        Ok(first.to_bytes())
    }

    fn extract_merge_source(&self, bytes: &[u8]) -> Result<Option<IpcValue>, EngineError> {
        Ok(FakeDeck::from_bytes(bytes).map(|d| Self::render(&d, 0)))
    }

    fn sections(&self, _deck: DeckId) -> IpcValue {
        IpcValue::Array(self.fx.list("sections").iter().map(ipc_of).collect())
    }

    fn slide_notes(&self, deck: DeckId, slide: usize) -> String {
        self.with(deck, |d| d.slides[slide].notes.clone())
    }

    fn slide_comments(&self, deck: DeckId, slide: usize) -> IpcValue {
        self.with(deck, |d| {
            IpcValue::Array(
                d.slides[slide]
                    .comments
                    .iter()
                    .enumerate()
                    .map(|(idx, (author, text))| {
                        obj([
                            ("author", string(author.as_str())),
                            ("text", string(text.as_str())),
                            ("idx", num(idx as f64)),
                        ])
                    })
                    .collect(),
            )
        })
    }

    fn element_link(&self, deck: DeckId, slide: &IpcValue, id: &IpcValue) -> IpcValue {
        self.with(deck, |d| {
            let Some(index) = super::session::slide_index(slide, d.slides.len()) else {
                return IpcValue::Null;
            };
            let Some(id) = as_str(id) else {
                return IpcValue::Null;
            };
            if !d.slides[index].elements.iter().any(|e| e.id == id) {
                return IpcValue::Null;
            }
            ipc_of(self.fx.by("links", id))
        })
    }

    fn slide_links(&self, deck: DeckId, slide: &IpcValue) -> IpcValue {
        self.with(deck, |d| {
            let Some(index) = super::session::slide_index(slide, d.slides.len()) else {
                return IpcValue::Array(Vec::new());
            };
            IpcValue::Array(
                d.slides[index]
                    .elements
                    .iter()
                    .filter(|e| !self.fx.by("links", &e.id).is_null())
                    .map(|e| {
                        obj([
                            ("elementId", string(e.id.as_str())),
                            ("target", ipc_of(self.fx.by("links", &e.id))),
                        ])
                    })
                    .collect(),
            )
        })
    }

    fn run_links(&self, deck: DeckId, slide: &IpcValue) -> IpcValue {
        self.with(deck, |d| {
            let Some(index) = super::session::slide_index(slide, d.slides.len()) else {
                return IpcValue::Array(Vec::new());
            };
            let mut items = Vec::new();
            for e in &d.slides[index].elements {
                for link in self
                    .fx
                    .by("runLinks", &e.id)
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let mut entries = vec![("elementId".to_owned(), string(e.id.as_str()))];
                    if let IpcValue::Object(rest) = ipc_of(link) {
                        entries.extend(rest);
                    }
                    items.push(IpcValue::Object(entries));
                }
            }
            IpcValue::Array(items)
        })
    }

    fn header_footer(&self, deck: DeckId, slide: usize) -> IpcValue {
        self.with(deck, |d| match &d.slides[slide].header_footer {
            Some(settings) => ipc_of(settings),
            None => obj([
                ("footer", IpcValue::Null),
                ("slideNum", IpcValue::Bool(false)),
                ("date", IpcValue::Null),
            ]),
        })
    }

    fn slide_transition(&self, deck: DeckId, slide: usize) -> IpcValue {
        self.with(deck, |d| {
            string(d.slides[slide].transition.as_deref().unwrap_or("none"))
        })
    }

    fn show_timing(&self, deck: DeckId, slide: usize) -> IpcValue {
        self.with(deck, |d| {
            let s = &d.slides[slide];
            obj([
                ("advanceMs", s.advance_ms.map_or(IpcValue::Null, num)),
                (
                    "narrationIds",
                    IpcValue::Array(
                        s.elements
                            .iter()
                            .filter(|e| {
                                spid_of(&e.id).is_some_and(|spid| s.narration.contains(&spid))
                            })
                            .map(|e| string(e.id.as_str()))
                            .collect(),
                    ),
                ),
            ])
        })
    }

    fn animations(&self, deck: DeckId, slide: usize, labels: &[(String, String)]) -> IpcValue {
        let label = |kind: &str| {
            labels
                .iter()
                .find(|(k, _)| k == kind)
                .or_else(|| labels.iter().find(|(k, _)| k == "object"))
                .map(|(_, text)| text.clone())
                .unwrap_or_default()
        };
        self.with(deck, |d| {
            let s = &d.slides[slide];
            let mut out = Vec::new();
            for a in &s.animations {
                // the first element with the animation's spid; a deleted target is not echoed back
                let Some(spid) = a["spid"].as_i64() else {
                    continue;
                };
                let Some(el) = s.elements.iter().find(|e| spid_of(&e.id) == Some(spid)) else {
                    continue;
                };
                let mut entries = vec![
                    ("sourceId".to_owned(), string(el.id.as_str())),
                    ("targetName".to_owned(), string(label(self.kind_of(&el.id)))),
                    ("effect".to_owned(), ipc_of(&a["effect"])),
                    ("trigger".to_owned(), ipc_of(&a["trigger"])),
                    ("durationMs".to_owned(), ipc_of(&a["durationMs"])),
                    ("delayMs".to_owned(), ipc_of(&a["delayMs"])),
                ];
                for key in ["direction", "motionPath", "paragraph"] {
                    if !a[key].is_null() {
                        entries.push((key.to_owned(), ipc_of(&a[key])));
                    }
                }
                out.push(IpcValue::Object(entries));
            }
            IpcValue::Array(out)
        })
    }

    fn shape_keys(&self, deck: DeckId, slide: usize) -> IpcValue {
        self.with(deck, |d| {
            IpcValue::Array(
                d.slides[slide]
                    .elements
                    .iter()
                    .map(|e| {
                        obj([
                            ("sourceId", string(e.id.as_str())),
                            (
                                "spid",
                                spid_of(&e.id).map_or(IpcValue::Undefined, |s| num(s as f64)),
                            ),
                            ("name", string("")),
                        ])
                    })
                    .collect(),
            )
        })
    }

    fn has_narration(&self, deck: DeckId, slide: usize) -> bool {
        self.with(deck, |d| !d.slides[slide].narration.is_empty())
    }

    fn section_slide_indices(&self, deck: DeckId, id: &IpcValue) -> Option<Vec<usize>> {
        let total = self.with(deck, |d| d.slides.len());
        let sections = self.fx.list("sections");
        let (lead, ranges) = normalize_sections(&sections, total);
        if matches!(id, IpcValue::Undefined | IpcValue::Null) {
            return Some(lead);
        }
        let at = sections.iter().position(|s| &ipc_of(&s["id"]) == id)?;
        Some(ranges[at].clone())
    }

    fn master_parts(&self, _deck: DeckId) -> Vec<super::engine::MasterPart> {
        vec![super::engine::MasterPart {
            part_path: MASTER_PART.into(),
            kind: string("master"),
            name: string("Office Theme"),
        }]
    }

    fn master_parse(&self, deck: DeckId, part: &str, fit: f64) -> Option<IpcValue> {
        self.master_render(deck, part, fit)
    }

    fn master_render(&self, deck: DeckId, part: &str, _fit: f64) -> Option<IpcValue> {
        (part == MASTER_PART).then(|| {
            self.with(deck, |d| {
                obj([
                    ("partPath", string(MASTER_PART)),
                    (
                        "elements",
                        IpcValue::Array(
                            d.master
                                .iter()
                                .map(|e| {
                                    let mut entries = vec![
                                        ("id".to_owned(), string(e.id.as_str())),
                                        ("text".to_owned(), string(e.text.as_str())),
                                    ];
                                    if let Some(fill) = d.master_fill.get(&e.id) {
                                        entries.push(("fill".to_owned(), fill.clone()));
                                    }
                                    if let Some(stroke) = d.master_stroke.get(&e.id) {
                                        entries.push(("stroke".to_owned(), stroke.clone()));
                                    }
                                    IpcValue::Object(entries)
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
        })
    }

    fn master_has_element(&self, deck: DeckId, part: &str, id: &str) -> bool {
        part == MASTER_PART && self.with(deck, |d| d.master.iter().any(|e| e.id == id))
    }

    fn master_preview_transform(
        &self,
        _deck: DeckId,
        _part: &str,
        _id: &str,
        _offset: [f64; 4],
        _rot: f64,
    ) {
        // the preview moves the live master slide only: nothing the engine is asked
    }

    fn image_info(&self, bytes: &[u8], ext: &str, _path: Option<&str>) -> super::engine::ImageInfo {
        // a tiff goes through the TypeScript's own decoder, which refuses the cases' bytes;
        // everything else asks the desktop for the picture's size
        if ext == "tif" || ext == "tiff" {
            return super::engine::ImageInfo::default();
        }
        self.record(json!(["nativeImage.info", bytes.len()]));
        super::engine::ImageInfo {
            natural: (!bytes.is_empty()).then_some((640.0, 480.0)),
            dpi: None,
        }
    }

    fn video_poster(&self, _path: &str) -> Option<Vec<u8>> {
        None
    }

    fn background_image(&self, _deck: DeckId, _slide: usize) -> Option<String> {
        None
    }

    fn slide_index_of_id(&self, deck: DeckId, slide_id: &str) -> Option<usize> {
        let n: usize = slide_id.strip_prefix("slide-")?.parse().ok()?;
        self.with(deck, |d| (n < d.slides.len()).then_some(n))
    }

    fn materialize_slide(&self, _deck: DeckId, _index: usize) {}

    fn reparse_deck(&self, _deck: DeckId) {}

    fn autofit_resize(
        &self,
        _deck: DeckId,
        _index: usize,
        _id: &str,
        rendered: Option<IpcValue>,
        _fit: f64,
    ) -> Option<IpcValue> {
        rendered
    }

    fn sync_autofit_scale(
        &self,
        _deck: DeckId,
        _index: usize,
        _id: &str,
        rendered: Option<IpcValue>,
        _fit: f64,
    ) -> Option<IpcValue> {
        rendered
    }

    fn map_script_ops(&self, _deck: DeckId, script: &IpcValue) -> Vec<IpcValue> {
        // a step names an op, and an element of the slide when it works on one
        let IpcValue::Array(steps) = field(script, "steps") else {
            return Vec::new();
        };
        steps
            .iter()
            .map(|step| {
                let mut target = vec![("slide".to_owned(), field(script, "slideIndex").clone())];
                if !matches!(field(step, "el"), IpcValue::Undefined) {
                    target.push(("el".to_owned(), field(step, "el").clone()));
                }
                let mut op = vec![
                    (
                        "op".to_owned(),
                        string(as_str(field(step, "op")).unwrap_or("")),
                    ),
                    ("target".to_owned(), IpcValue::Object(target)),
                ];
                if !matches!(field(step, "paragraphs"), IpcValue::Undefined) {
                    op.push(("paragraphs".to_owned(), field(step, "paragraphs").clone()));
                }
                IpcValue::Object(op)
            })
            .collect()
    }

    fn group_child_frame(
        &self,
        _deck: DeckId,
        _slide: usize,
        _group_id: &str,
        _source_id: &str,
    ) -> Option<super::engine::GroupChildFrame> {
        None
    }

    fn element_index(&self, deck: DeckId, slide: usize, source_id: &str) -> Option<usize> {
        self.with(deck, |d| {
            d.slides
                .get(slide)?
                .elements
                .iter()
                .position(|e| e.id == source_id)
        })
    }

    fn element_id_at(&self, deck: DeckId, slide: usize, index: usize) -> Option<String> {
        self.with(deck, |d| {
            d.slides
                .get(slide)?
                .elements
                .get(index)
                .map(|e| e.id.clone())
        })
    }

    fn is_imported_chart(&self, _deck: DeckId, _slide: usize, _id: &str) -> bool {
        false
    }

    fn theme_accents(&self, _deck: DeckId) -> Option<Vec<String>> {
        None
    }

    fn chart_data(&self, _deck: DeckId, _slide: usize, id: &str) -> IpcValue {
        ipc_of(self.fx.by("charts", id))
    }

    fn layouts(&self, _deck: DeckId) -> IpcValue {
        IpcValue::Array(Vec::new())
    }

    fn ensure_builtin_layout(&self, _deck: DeckId, key: &str) -> Option<String> {
        Some(format!("ppt/slideLayouts/builtin-{key}.xml"))
    }

    fn private_font_faces(&self) -> IpcValue {
        IpcValue::Array(self.fx.list("fontFaces").iter().map(ipc_of).collect())
    }

    fn private_font_data(&self, id: &IpcValue) -> IpcValue {
        as_str(id).map_or(IpcValue::Null, |id| ipc_of(self.fx.by("fontData", id)))
    }
}

/// A shell that records what the handlers asked of it
pub struct FakeShell {
    log: Option<CallLog>,
    pub displays: Vec<Display>,
    pub prepared: Mutex<Option<PreparedOpen>>,
    pub microphone: bool,
    pub project_dir: Option<String>,
    pub written: Mutex<Vec<(String, Vec<u8>)>>,
    pub opened: Mutex<Vec<(ViewId, String)>>,
    pub markers: Mutex<HashMap<String, Vec<u8>>>,
    /// the windows in simple fullscreen: the snap is asked only when it changes anything
    pub snapped: Mutex<std::collections::HashSet<u32>>,
    /// the hand-off a case left for the tab, taken once
    pub handoff: Mutex<Option<TakenHandoff>>,
    pub uuids: std::sync::atomic::AtomicU64,
}

impl FakeShell {
    fn record(&self, call: Value) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(call);
        }
    }
}

impl SlidesShell for FakeShell {
    fn opened(&self, view: ViewId, path: &str) {
        self.record(json!(["slidesOpenedHook", view.0, path]));
        self.opened.lock().unwrap().push((view, path.to_owned()));
    }
    fn dialog_parent(&self) -> Option<WindowId> {
        None
    }
    fn host_window_for(&self, view: ViewId) -> Option<WindowId> {
        Some(WindowId(view.0))
    }
    fn is_headless(&self) -> bool {
        false
    }
    fn new_document_dir(&self, _view: ViewId) -> Option<String> {
        self.project_dir.clone()
    }
    fn can_write_new_document(&self) -> bool {
        self.project_dir.is_some()
    }
    fn write_new_document(&self, _view: ViewId, name: &str, bytes: &[u8]) -> Option<String> {
        let dir = self.project_dir.clone()?;
        let path = format!("{dir}/{name}");
        std::fs::write(&path, bytes).ok()?;
        self.written
            .lock()
            .unwrap()
            .push((path.clone(), bytes.to_vec()));
        Some(path)
    }
    fn open_generated_path(&self, _path: &str) -> bool {
        false
    }
    fn is_path_open_elsewhere(&self, _path: &str) -> bool {
        false
    }
    fn take_headless_target(&self, _view: ViewId) -> Option<String> {
        None
    }
    fn headless_export_done(&self, _view: ViewId, _ok: bool, _error: Option<String>) {
        // only a headless export has a waiter to settle; the cases make none
    }
    fn set_bleed(&self, view: ViewId, on: bool) {
        self.record(json!(["showChrome.setBleed", view.0, on]));
    }
    fn show_fullscreen_window(&self, window: WindowId, on: bool) {
        let mut snapped = self.snapped.lock().unwrap();
        let changed = if on {
            snapped.insert(window.0)
        } else {
            snapped.remove(&window.0)
        };
        if changed {
            self.record(json!(["showFullscreenWindow", window.0, on]));
        }
    }
    fn read_clipboard_buffer(&self, format: &str) -> Vec<u8> {
        self.markers
            .lock()
            .unwrap()
            .get(format)
            .cloned()
            .unwrap_or_default()
    }
    fn write_clipboard_buffer(&self, format: &str, bytes: &[u8]) {
        self.record(json!(["clipboard.writeBuffer", format, bytes.len()]));
        self.markers
            .lock()
            .unwrap()
            .insert(format.to_owned(), bytes.to_vec());
    }
    fn normalize_png(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        (!bytes.is_empty()).then(|| bytes.to_vec())
    }
    fn write_image_and_html(&self, _png: &[u8], html: &str) {
        self.record(json!(["clipboard.write", {"html": html, "text": null}]));
    }
    fn native_clipboard(&self, view: ViewId, op: &str) {
        self.record(json!(["webContents.clipboard", view.0, op]));
    }
    fn prepare_for_open(
        &self,
        _parent: Option<WindowId>,
        path: &str,
        done: Box<dyn FnOnce(PreparedOpen) + Send>,
    ) {
        let prepared = self
            .prepared
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| PreparedOpen::Plain(path.to_owned()));
        done(prepared)
    }
    fn export_pdf(&self, op: &IpcValue) -> PdfExportAnswer {
        let path = as_str(field(op, "filePath")).map(str::to_owned);
        self.record(json!(["exportSlidesPdf", path]));
        if let Some(path) = &path {
            let _ = std::fs::write(path, b"%PDF-1.7");
        }
        PdfExportAnswer {
            ok: path.is_some(),
            path,
            error: None,
        }
    }
    fn ask_microphone(&self, done: Box<dyn FnOnce(bool) + Send>) {
        // the status is asked first; only a status that is not `granted` is asked about
        self.record(json!([
            "systemPreferences.getMediaAccessStatus",
            "microphone"
        ]));
        if !self.microphone {
            self.record(json!(["systemPreferences.askForMediaAccess", "microphone"]));
        }
        done(self.microphone)
    }
    fn displays(&self) -> Vec<Display> {
        self.displays.clone()
    }
    fn display_of(&self, window: Option<WindowId>) -> Display {
        let first = self.displays[0];
        match window {
            Some(w) if w.0 >= 100 => self.displays.get(1).copied().unwrap_or(first),
            _ => first,
        }
    }
    fn open_audience_window(&self, display: Display) -> Option<(ViewId, WindowId)> {
        self.record(json!(["BrowserWindow.audience", display.id]));
        Some((ViewId(100), WindowId(100)))
    }
    fn close_audience_window(&self, window: WindowId) {
        self.record(json!(["closeAudienceWindow", window.0]));
    }
    fn fullscreen_on_display(&self, window: WindowId, display: Display) {
        self.record(json!(["fullScreenOnDisplay", window.0, display.id]));
    }
    fn move_presenter_window(&self, window: WindowId, display: Display) {
        self.record(json!(["movePresenterWindow", window.0, display.id]));
    }
    fn set_window_title(&self, _view: ViewId, _title: &str) {
        // only a detached editor window has a title the shell sets; the cases have none
    }
    fn take_generate_handoff(&self, view: ViewId) -> Option<TakenHandoff> {
        self.record(json!([
            "generate-handoff.takeGenerateHandoff",
            "slides",
            view.0
        ]));
        self.handoff.lock().unwrap().take()
    }
    fn report_generate_run_started(&self, view: ViewId, paths: &[String]) -> bool {
        self.record(json!([
            "generate-handoff.reportGenerateRunStarted",
            "slides",
            view.0,
            paths
        ]));
        true
    }
    fn random_uuid(&self) -> String {
        let n = self.uuids.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        format!("00000000-0000-4000-8000-{n:012}")
    }
    fn assert_file_saved(&self, _path: &str) -> Result<(), String> {
        Ok(())
    }
}

/// This app's fake hosts: the engine and the shell, answering from the
/// case's `hosts.d1.slides` value (blankSlides, projectDir, microphone,
/// displays) with fixed defaults when absent
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value) {
    let log = hosts.get::<CallLog>().cloned();
    let slides = &case["slides"];
    super::recovery::FIXED_CLOCK.store(
        slides["clock"].as_u64().unwrap_or(0),
        std::sync::atomic::Ordering::Relaxed,
    );
    let engine: SlidesEngineHost = Arc::new(FakeEngine {
        decks: Mutex::default(),
        next: Mutex::default(),
        blank_slides: slides["blankSlides"].as_u64().unwrap_or(1) as usize,
        fx: Fixtures(slides["fixtures"].clone()),
        log: log.clone(),
    });
    hosts.insert::<SlidesEngineHost>(engine);
    let display = |id: i64| Display {
        id,
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let shell: SlidesShellHost = Arc::new(FakeShell {
        log,
        displays: if slides["externalDisplay"].as_bool().unwrap_or(false) {
            vec![display(1), display(2)]
        } else {
            vec![display(1)]
        },
        prepared: Mutex::default(),
        microphone: slides["microphone"].as_bool().unwrap_or(true),
        project_dir: slides["projectDir"].as_str().map(str::to_owned),
        written: Mutex::default(),
        opened: Mutex::default(),
        markers: Mutex::default(),
        snapped: Mutex::default(),
        handoff: Mutex::new(slides["handoff"].as_object().map(|h| {
            TakenHandoff {
                id: h["id"].as_str().unwrap_or("").to_owned(),
                text: h["text"].as_str().unwrap_or("").to_owned(),
                materials: h["materials"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .map(|m| {
                                (
                                    m["path"].as_str().unwrap_or("").to_owned(),
                                    m["name"].as_str().unwrap_or("").to_owned(),
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })),
        uuids: Default::default(),
    });
    hosts.insert::<SlidesShellHost>(shell);
    let _ = num;
}

/// The text of a paragraph list: the runs' text joined, a line per paragraph
fn paragraphs_text(paragraphs: &IpcValue) -> String {
    match paragraphs {
        IpcValue::Array(items) => items
            .iter()
            .map(|paragraph| match field(paragraph, "runs") {
                IpcValue::Array(runs) => runs
                    .iter()
                    .filter_map(|r| as_str(field(r, "text")))
                    .collect::<String>(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
