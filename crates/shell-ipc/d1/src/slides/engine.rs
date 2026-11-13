//! What the slides handlers need that is not in Rust: the deck engine
//! (`@seuoffice/pptx-engine` open/save/reparse, `pptx-ops` `runTxn`,
//! `pptx-render` `buildRenderSlide`) behind [`SlidesEngine`], and the hooks
//! `slides-main.ts` gets from the shell (`runtime`, the opened hook, the
//! host window, the headless export map) behind [`SlidesShell`].
//!
//! Decks live in the engine and are named by a [`DeckId`], so an engine that
//! sits across a process boundary needs no shared object. A render slide, an
//! op, a bundle of a copied slide and every other structure only the engine
//! and the renderer read are [`IpcValue`]s: the handlers move them around as
//! the TypeScript does and look at the few keys the TypeScript looks at.

use std::any::Any;
use std::rc::Rc;
use std::sync::Arc;

use shell_contract::{IpcValue, ViewId, WindowId};

/// A deck the engine holds (`OpenedPptx`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DeckId(pub u64);

/// A call of the engine that threw (`catch (err)` reads `String(err)`)
#[derive(Clone, Debug, PartialEq)]
pub struct EngineError(pub String);

impl EngineError {
    /// `String(err)` of an `Error` is `Error: message`
    pub fn text(&self) -> String {
        format!("Error: {}", self.0)
    }
}

/// `HistorySnapshot`: what the engine copied of a deck. Cloning shares the
/// copy; [`SlidesEngine::restore`] must not hand it to the live deck as is.
#[derive(Clone)]
pub struct Snapshot(pub Rc<dyn Any>);

/// `opened.deck.size`
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DeckSize {
    pub cx: f64,
    pub cy: f64,
}

/// One slide as `buildSlideUpdate` reads it
pub use main_core::slides::session_state::SlideRef;

/// `TxnRequest['isolation']`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    Atomic,
    PerOp,
}

/// `TxnRequest` of `@seuoffice/pptx-ops`
#[derive(Clone, Debug, PartialEq)]
pub struct TxnRequest {
    /// `Op` objects exactly as the TypeScript builds them
    pub ops: Vec<IpcValue>,
    pub isolation: Isolation,
    pub dry_run: bool,
    /// part paths whose live master slide seeds the executor (`parts`)
    pub parts: Vec<String>,
}

impl TxnRequest {
    pub fn atomic(ops: Vec<IpcValue>) -> Self {
        TxnRequest {
            ops,
            isolation: Isolation::Atomic,
            dry_run: false,
            parts: Vec::new(),
        }
    }

    pub fn per_op(ops: Vec<IpcValue>) -> Self {
        TxnRequest {
            isolation: Isolation::PerOp,
            ..Self::atomic(ops)
        }
    }

    pub fn with_parts(mut self, parts: Vec<String>) -> Self {
        self.parts = parts;
        self
    }

    pub fn dry(&self) -> Self {
        TxnRequest {
            dry_run: true,
            ..self.clone()
        }
    }
}

/// `TxnResult['failures'][n]`
#[derive(Clone, Debug, PartialEq)]
pub struct TxnFailure {
    pub index: usize,
    pub error: String,
}

/// `TxnResult['records'][n]`: the applied op, the slide it landed on (the
/// executor-stamped durable id), the element ids it made and what it says
/// afterwards (`after`, `undefined` as `IpcValue::Undefined`)
#[derive(Clone, Debug, PartialEq)]
pub struct TxnRecord {
    pub op: IpcValue,
    pub slide_id: Option<String>,
    pub created: Option<Vec<String>>,
    pub after: IpcValue,
}

/// `TxnResult`; `failures` and `records` are `undefined` when empty
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TxnResult {
    pub applied: bool,
    pub failures: Option<Vec<TxnFailure>>,
    pub records: Option<Vec<TxnRecord>>,
    /// the dry run's plan (`TxnResult.plan`), as the renderer receives it
    pub plan: Option<IpcValue>,
}

impl TxnResult {
    pub fn failure_count(&self) -> usize {
        self.failures.as_ref().map_or(0, Vec::len)
    }
}

/// A picture element's `media` with a target (`kind`, `target`, `external`)
#[derive(Clone, Debug, PartialEq)]
pub struct PictureMedia {
    pub kind: String,
    pub target: String,
    pub external: bool,
}

/// The deck engine. Every method is one call (or one small group of calls)
/// of the TypeScript engine; `deck` is a deck this engine opened.
pub trait SlidesEngine: Send + Sync {
    /// `createBlankPptx()`
    fn create_blank_pptx(&self) -> Result<Vec<u8>, EngineError>;
    /// `openPptx(bytes)`
    fn open(&self, bytes: &[u8]) -> Result<DeckId, EngineError>;
    /// the deck is no longer referenced (garbage collection in the TypeScript)
    fn release(&self, deck: DeckId);
    /// `setSlideSize(opened, cx, cy)`
    fn set_slide_size(&self, deck: DeckId, cx: f64, cy: f64);
    /// `opened.deck.size`
    fn size(&self, deck: DeckId) -> DeckSize;
    /// `opened.deck.slides.map(s => s.path)`
    fn slide_paths(&self, deck: DeckId) -> Vec<String>;
    /// the slides as `buildSlideUpdate` reads them
    fn slide_refs(&self, deck: DeckId) -> Vec<SlideRef>;
    /// the dirty scan of `sessionDirty` over the slides (`structureDirty`,
    /// `dirty`, `dirtyTransform`)
    fn slides_dirty(&self, deck: DeckId) -> bool;
    /// `deckDefaultFont(opened)`
    fn default_font(&self, deck: DeckId) -> Option<String>;
    /// `adoptEmbeddedFonts(opened)`
    fn adopt_embedded_fonts(&self, deck: DeckId);
    /// `resetFontMetrics()`
    fn reset_font_metrics(&self);
    /// `buildAllRenderSlides(opened, fitWidthPx)`
    fn render_all(&self, deck: DeckId, fit_width_px: f64) -> Vec<IpcValue>;
    /// `buildRenderSlide` of one page; `reparse` is `rebuildSlideWithReparse`
    fn render_slide(
        &self,
        deck: DeckId,
        index: usize,
        fit_width_px: f64,
        reparse: bool,
    ) -> Option<IpcValue>;
    /// `runTxn(opened, req)`
    fn run_txn(&self, deck: DeckId, request: &TxnRequest) -> TxnResult;
    /// `takeSnapshot` of the deck half (a deep copy of the slides and entries)
    fn snapshot(&self, deck: DeckId, meta_dirty: bool) -> Snapshot;
    /// the deck half of `restoreSnapshot`: the live deck becomes a copy of
    /// the snapshot; answers the snapshot's `metaDirty`
    fn restore(&self, deck: DeckId, snapshot: &Snapshot) -> bool;
    /// `savePptx(opened)`
    fn save_bytes(&self, deck: DeckId) -> Result<Vec<u8>, EngineError>;
    /// `savePptxToFile(opened, path)`: writes (truncating) the path
    fn save_to_file(&self, deck: DeckId, path: &str) -> Result<(), EngineError>;
    /// `commitSaved(opened)`
    fn commit_saved(&self, deck: DeckId);
    /// `deckHasRedaction(opened)`
    fn has_redaction(&self, deck: DeckId) -> bool;
    /// `encryptOoxml(bytes, password)`
    fn encrypt_ooxml(&self, bytes: &[u8], password: &str) -> Result<Vec<u8>, EngineError>;
    /// `isEncryptedOoxml(bytes)`
    fn is_encrypted_ooxml(&self, bytes: &[u8]) -> bool;
    /// `decryptOfficeFile(bytes, password)`
    fn decrypt_office_file(&self, bytes: &[u8], password: &str) -> Result<Vec<u8>, EngineError>;
    /// the picture element `source_id` of slide `slide`, when it is one
    fn picture_media(&self, deck: DeckId, slide: usize, source_id: &str) -> Option<PictureMedia>;
    /// the picture element's `model3d.target`
    fn model3d_target(&self, deck: DeckId, slide: usize, source_id: &str) -> Option<String>;
    /// `opened.archive.readBytes(path)`
    fn read_part(&self, deck: DeckId, path: &str) -> Option<Vec<u8>>;
    /// `copySlide(opened, index)`: a bundle another deck can paste
    fn copy_slide(&self, deck: DeckId, index: usize) -> Option<IpcValue>;
    /// `copyElementData(opened, slide, el)` of every id found on the slide,
    /// in the order of `source_ids`; `None` when the slide does not exist
    fn copy_elements(
        &self,
        deck: DeckId,
        slide: usize,
        source_ids: &[String],
    ) -> Option<Vec<IpcValue>>;
    /// the page of `renderTemplateCover(id, lang)`: `None` for an id the
    /// catalog does not list or a cover that could not be built
    fn template_cover(&self, id: &str, lang: &str, fit_width_px: f64) -> Option<IpcValue>;
    /// `fontFileFamilies(path)` of `fonts.ts`: the family names in a font
    /// file's name table (the store's install itself is main-core's)
    fn font_file_families(&self, path: &str) -> Vec<String>;
    /// `parseFileToText(path)` of `@seuoffice/file-parse`: the text, or the
    /// message a failed parse gives
    fn parse_file_text(&self, path: &str) -> Result<String, String>;
    /// `diagramPictureExtOf(filePath)` of `file-parse`: `drawio.svg` or
    /// `drawio.png` when the file is named so and holds its diagram
    fn diagram_picture_ext_of(&self, path: &str) -> Option<String>;
    /// `getSections(opened)`: the deck's sections as the renderer receives them
    fn sections(&self, deck: DeckId) -> IpcValue;
    /// `slideDurableId(slide)` lookup: the page that carries the executor's
    /// durable slide id
    fn slide_index_of_id(&self, deck: DeckId, slide_id: &str) -> Option<usize>;
    /// `materializeSlide(opened, index)`: bake pending patches and reparse
    /// the page
    fn materialize_slide(&self, deck: DeckId, index: usize);
    /// `reparseDeck(opened)`: the whole deck reparsed in memory
    fn reparse_deck(&self, deck: DeckId);
    /// `applyAutofitResize(session, slideIndex, elementId, rendered)` of
    /// `autofit-writeback.ts`: the render slide after the shape was fitted to its text
    fn autofit_resize(
        &self,
        deck: DeckId,
        index: usize,
        source_id: &str,
        rendered: Option<IpcValue>,
        fit_width_px: f64,
    ) -> Option<IpcValue>;
    /// `syncAutofitScale(session, slideIndex, elementId, rendered)`
    fn sync_autofit_scale(
        &self,
        deck: DeckId,
        index: usize,
        source_id: &str,
        rendered: Option<IpcValue>,
        fit_width_px: f64,
    ) -> Option<IpcValue>;
    /// `mapScriptOps(opened, script)` of `pptx-ops`
    fn map_script_ops(&self, deck: DeckId, script: &IpcValue) -> Vec<IpcValue>;
    /// `resolveGroupChildId` and `findGroupChild`: the frame of a group's
    /// child; `None` when the group or the child is missing
    fn group_child_frame(
        &self,
        deck: DeckId,
        slide: usize,
        group_id: &str,
        source_id: &str,
    ) -> Option<GroupChildFrame>;
    /// whether the slide has an element with this id (`matchesElementRef`)
    fn element_index(&self, deck: DeckId, slide: usize, source_id: &str) -> Option<usize>;
    /// the id of the element at `index` of the slide after a reparse
    fn element_id_at(&self, deck: DeckId, slide: usize, index: usize) -> Option<String>;
    /// whether the element is a chart that did not come from this app
    /// (`type === 'chart' && descr !== 'aislides-chart'`)
    fn is_imported_chart(&self, deck: DeckId, slide: usize, source_id: &str) -> bool;
    /// `chartColorSchemes`'s theme input: accent1..6 of the first slide's
    /// theme when it has at least three, else `None`
    fn theme_accents(&self, deck: DeckId) -> Option<Vec<String>>;
    /// `getChartElementData(slide, sourceId)`
    fn chart_data(&self, deck: DeckId, slide: usize, source_id: &str) -> IpcValue;
    /// `listSlideLayouts` plus the built-in set when the deck needs it
    fn layouts(&self, deck: DeckId) -> IpcValue;
    /// `ensureBuiltinLayout(archive, size, key)`: the path of the layout
    /// part for a `builtin:<key>`; `None` when the key is unknown
    fn ensure_builtin_layout(&self, deck: DeckId, key: &str) -> Option<String>;
    /// `getSlideNotes(archive, slidePath)` of an existing slide
    fn slide_notes(&self, deck: DeckId, slide: usize) -> String;
    /// `getSlideComments(archive, slidePath)` of an existing slide
    fn slide_comments(&self, deck: DeckId, slide: usize) -> IpcValue;
    /// `getElementLink(opened, slideIndex, sourceId)`; the arguments are the
    /// renderer's, whatever they are
    fn element_link(&self, deck: DeckId, slide: &IpcValue, source_id: &IpcValue) -> IpcValue;
    /// `getSlideLinks(opened, slideIndex)`: `{ elementId, target }` items
    fn slide_links(&self, deck: DeckId, slide: &IpcValue) -> IpcValue;
    /// `getRunLinks(opened, slideIndex)`: `{ elementId, ...rest }` items
    fn run_links(&self, deck: DeckId, slide: &IpcValue) -> IpcValue;
    /// `readHeaderFooter(slide)` of an existing slide
    fn header_footer(&self, deck: DeckId, slide: usize) -> IpcValue;
    /// `getSlideTransition(slide)` of an existing slide
    fn slide_transition(&self, deck: DeckId, slide: usize) -> IpcValue;
    /// `{ advanceMs: getSlideAdvanceTime(slide), narrationIds }` of an existing slide
    fn show_timing(&self, deck: DeckId, slide: usize) -> IpcValue;
    /// the `AnimationItem[]` of an existing slide; `labels` are the localized
    /// names by element type (`text`, `shape`, `picture`, `group`, `table`,
    /// `chart`, `passthrough`, `object` for the fallback)
    fn animations(&self, deck: DeckId, slide: usize, labels: &[(String, String)]) -> IpcValue;
    /// the Morph pairing keys of an existing slide's elements
    fn shape_keys(&self, deck: DeckId, slide: usize) -> IpcValue;
    /// `narrationSpids(slide).length > 0`
    fn has_narration(&self, deck: DeckId, slide: usize) -> bool;
    /// the slides of a section, `normalizeSections` applied: `id` null or
    /// undefined is the lead (sectionless) slides; `None` for an unknown id
    fn section_slide_indices(&self, deck: DeckId, id: &IpcValue) -> Option<Vec<usize>>;
    /// `listMasterParts(archive)`
    fn master_parts(&self, deck: DeckId) -> Vec<MasterPart>;
    /// `parseMasterPart(archive, partPath)` then `buildRenderSlide`: the part
    /// becomes the live master slide the master ops are seeded with; `None`
    /// when it does not parse
    fn master_parse(&self, deck: DeckId, part_path: &str, fit_width_px: f64) -> Option<IpcValue>;
    /// `buildRenderSlide` of the live master slide of `part_path`
    fn master_render(&self, deck: DeckId, part_path: &str, fit_width_px: f64) -> Option<IpcValue>;
    /// the live master slide has an element with this id
    fn master_has_element(&self, deck: DeckId, part_path: &str, source_id: &str) -> bool;
    /// a transform preview: the live master slide's element moves, nothing
    /// is persisted (`el.transform = { ...el.transform, offset, rot }`)
    fn master_preview_transform(
        &self,
        deck: DeckId,
        part_path: &str,
        source_id: &str,
        offset: [f64; 4],
        rot: f64,
    );
    /// the picture's natural size and dpi: `nativeImage` (`tiffToPng` for a
    /// tiff) and `imageDpiFromBytes(bytes)`; `path` when the image is a file
    fn image_info(&self, bytes: &[u8], ext: &str, path: Option<&str>) -> ImageInfo;
    /// `nativeImage.createThumbnailFromPath(path)` as PNG: a video's poster
    fn video_poster(&self, path: &str) -> Option<Vec<u8>>;
    /// `slide.background.mediaRef` when the slide's background is an image
    fn background_image(&self, deck: DeckId, slide: usize) -> Option<String>;
    /// `buildPagePptx` of a page spec the renderer's LLM wrote (`parsePageSpec`
    /// first): the one-slide pptx and the images that failed to load. Runs on
    /// a worker (it fetches images); `Err` is the message the handler
    /// answers as `error`.
    fn generate_page(
        &self,
        spec_json: &str,
        default_fonts: &IpcValue,
    ) -> Result<GeneratedPage, String>;
    /// the replace mode of `slides:land-generated-pages`: the pages (one
    /// pptx each) merged into one deck with the backgrounds promoted and the
    /// text boxes autofitted, as pptx bytes
    fn assemble_pages(&self, pages: &[Vec<u8>]) -> Result<Vec<u8>, EngineError>;
    /// `extractMergeSlideSource(bytes)`: the slide another deck can merge
    fn extract_merge_source(&self, bytes: &[u8]) -> Result<Option<IpcValue>, EngineError>;
    /// `listPrivateFontFaces()` of `fonts.ts`, as the renderer receives it
    fn private_font_faces(&self) -> IpcValue;
    /// `getPrivateFontData(id)` of `fonts.ts`, as the renderer receives it
    fn private_font_data(&self, id: &IpcValue) -> IpcValue;
}

pub type SlidesEngineHost = Arc<dyn SlidesEngine>;

/// `listMasterParts` item: `{ partPath, kind, name }`
#[derive(Clone, Debug, PartialEq)]
pub struct MasterPart {
    pub part_path: String,
    pub kind: IpcValue,
    pub name: IpcValue,
}

/// What the shell knows of a picture's pixels
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ImageInfo {
    /// width and height in px
    pub natural: Option<(f64, f64)>,
    /// horizontal and vertical dpi the file carries
    pub dpi: Option<(f64, f64)>,
}

/// `findGroupChild`'s frame of a child inside a group: the group's offset
/// and, when it has one, the child offset space (`chOff`/`chExt`)
#[derive(Clone, Debug, PartialEq)]
pub struct GroupChildFrame {
    pub child_id: String,
    /// `grp.transform.offset`: x, y, cx, cy
    pub group_offset: [f64; 4],
    /// `grp.childOffset`: x, y, cx, cy
    pub child_offset: Option<[f64; 4]>,
}

/// What `buildPagePptx` answers
#[derive(Clone, Debug, PartialEq)]
pub struct GeneratedPage {
    pub bytes: Vec<u8>,
    pub image_failures: Vec<String>,
}

/// What a tab takes of the generate hand-off
#[derive(Clone, Debug, PartialEq)]
pub struct TakenHandoff {
    pub id: String,
    pub text: String,
    /// `(path, name)` of each material
    pub materials: Vec<(String, String)>,
}

/// What preparing a path for open came to (`preparePresentationForOpen` and
/// `preparePptxOpen`, which ask the user about conversions and passwords)
#[derive(Clone, Debug, PartialEq)]
pub enum PreparedOpen {
    /// nothing to open (cancelled, declined, damaged, told why)
    Rejected,
    /// open the deck at this path
    Plain(String),
    /// an encrypted deck the user unlocked: its plain package and password
    Unlocked {
        path: String,
        bytes: Vec<u8>,
        password: String,
    },
}

/// A PDF export the shell runs in a hidden window (`exportSlidesPdf`)
#[derive(Clone, Debug, PartialEq)]
pub struct PdfExportAnswer {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// One display of the machine (`screen.getAllDisplays()`)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The shell side of `slides-main.ts` and `presenter-show.ts`
pub trait SlidesShell: Send + Sync {
    /// `slidesOpenedHook(wc, path)`
    fn opened(&self, view: ViewId, path: &str);
    /// `dialogParent()`: the focused window, else the shell window
    fn dialog_parent(&self) -> Option<WindowId>;
    /// `hostWindowFor(wc)`: the window a tab view lives in
    fn host_window_for(&self, view: ViewId) -> Option<WindowId>;
    /// `isHeadlessMode()`
    fn is_headless(&self) -> bool;
    /// `runtime.newDocumentDir`: the project folder offered for a new deck
    fn new_document_dir(&self, view: ViewId) -> Option<String>;
    /// `runtime.writeNewDocument` is set
    fn can_write_new_document(&self) -> bool;
    /// `runtime.writeNewDocument(view, name, bytes)`: the path written, or
    /// `None` when no project was chosen
    fn write_new_document(&self, view: ViewId, name: &str, bytes: &[u8]) -> Option<String>;
    /// `runtime.openGeneratedPath(path)`: true when the shell opened it
    fn open_generated_path(&self, path: &str) -> bool;
    /// `isPathOpenElsewhere(path)`: the shell's probe over the other panes
    fn is_path_open_elsewhere(&self, path: &str) -> bool;
    /// `headlessExportTargets.get(id)` then delete: the PDF path the hidden
    /// export window must write
    fn take_headless_target(&self, view: ViewId) -> Option<String>;
    /// `headlessExportWaiters` settle: `slides:headless-export-done`
    fn headless_export_done(&self, view: ViewId, ok: bool, error: Option<String>);
    /// `showChrome.setBleed(wc, on)`
    fn set_bleed(&self, view: ViewId, on: bool);
    /// the window snap of `slides:show-fullscreen` (simpleFullScreen on macOS)
    fn show_fullscreen_window(&self, window: WindowId, on: bool);
    /// `clipboard.readBuffer(format)`
    fn read_clipboard_buffer(&self, format: &str) -> Vec<u8>;
    /// `clipboard.writeBuffer(format, bytes)`
    fn write_clipboard_buffer(&self, format: &str, bytes: &[u8]);
    /// `nativeImage.createFromBuffer(png).toPNG()`; `None` for an empty image
    fn normalize_png(&self, bytes: &[u8]) -> Option<Vec<u8>>;
    /// `clipboard.write({ image, html })`
    fn write_image_and_html(&self, png: &[u8], html: &str);
    /// `webContents.cut()`, `copy()` or `paste()` of the sender
    fn native_clipboard(&self, view: ViewId, op: &str);
    /// the prepare step of `slides:open` and friends, answered through
    /// `done` (from any thread) so a password prompt never blocks the core
    fn prepare_for_open(
        &self,
        parent: Option<WindowId>,
        path: &str,
        done: Box<dyn FnOnce(PreparedOpen) + Send>,
    );
    /// `exportSlidesPdf(...)` in a hidden window, `op` the renderer's
    /// `ExportPdfOp`; runs on a worker, may block
    fn export_pdf(&self, op: &IpcValue) -> PdfExportAnswer;
    /// the microphone permission question (`systemPreferences`), answered
    /// through `done`
    fn ask_microphone(&self, done: Box<dyn FnOnce(bool) + Send>);
    /// `screen.getAllDisplays()`
    fn displays(&self) -> Vec<Display>;
    /// the display the window is mostly on (`getDisplayMatching`), or the primary
    fn display_of(&self, window: Option<WindowId>) -> Display;
    /// creates the audience window on `display` showing the slides renderer in
    /// `mode=audience` and answers its view and window; the shell calls
    /// [`crate::slides::audience_closed`] when it closes
    fn open_audience_window(&self, display: Display) -> Option<(ViewId, WindowId)>;
    /// closes the audience window (leaving simple fullscreen first)
    fn close_audience_window(&self, window: WindowId);
    /// moves the window fullscreen onto a display (`fullScreenOnDisplay`)
    fn fullscreen_on_display(&self, window: WindowId, display: Display);
    /// moves the presenter window onto `display`'s work area, keeping its
    /// fullscreen form
    fn move_presenter_window(&self, window: WindowId, display: Display);
    /// the window title of a detached editor window (`win.setTitle`)
    fn set_window_title(&self, view: ViewId, title: &str);
    /// `takeGenerateHandoff('slides', view)`
    fn take_generate_handoff(&self, view: ViewId) -> Option<TakenHandoff>;
    /// `reportGenerateRunStarted('slides', view, paths)`: recorded
    fn report_generate_run_started(&self, view: ViewId, paths: &[String]) -> bool;
    /// `assertFileSaved(path)`: `Err` carries the message of the throw (the
    /// file is open with unsaved changes)
    fn assert_file_saved(&self, path: &str) -> Result<(), String>;
    /// `randomUUID()` of `node:crypto`: names of the clipboard token, the generated page
    /// files and the untitled recovery copies (production: `jscompat::random_uuid`)
    fn random_uuid(&self) -> String;
}

pub type SlidesShellHost = Arc<dyn SlidesShell>;
