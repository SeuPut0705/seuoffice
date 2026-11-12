//! `objects/state.ts`: per-conversion state of the objects layer. The JSON
//! part lives in the bridge map (`ext('objects')`); everything else (media
//! registry, the lazily assembled notes/comments parts, save bookkeeping) is
//! kept here, keyed by the conversion context.
//!
//! The TypeScript keys a `WeakMap` by the context. Here the state sits in a
//! slot of the context behind `Rc<RefCell<..>>`: a handler takes the `Rc` out
//! of the context, then borrows it for as short a time as the TypeScript uses
//! the object, so the context stays free for the calls in between. The
//! forward slot is the `ext('objects')` slot itself and serializes as its
//! `ObjectsExt`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use docx_engine::model::NoteInfo;
use jscompat::JsMap;
use serde::{Serialize, Serializer};

use crate::core::convert::{DocxExtraPart, DocxPartData, OdfToOoxmlContext, OoxmlToOdfContext};
use crate::core::errors::OdtError;
use crate::core::styles::OdtStylePart;
use crate::offset::{IndexedText, U16};

use super::media::{ImageFormat, NEUTRAL_PLACEHOLDER_PNG, same_bytes};
use super::model::{
    NoteKind, OBJECTS_EXT_KEY, ObjectComment, ObjectNote, ObjectPicture, ObjectPlaceholder,
    ObjectsExt, empty_objects_ext,
};

// ---------------------------------------------------------------------------
// Forward

/// `IMAGE_REL`
const IMAGE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/// A value per note kind (`Record<NoteKind, T>`).
#[derive(Debug, Clone, Default)]
pub struct PerKind<T> {
    pub footnote: T,
    pub endnote: T,
}

impl<T> PerKind<T> {
    pub fn get(&self, kind: NoteKind) -> &T {
        match kind {
            NoteKind::Footnote => &self.footnote,
            NoteKind::Endnote => &self.endnote,
        }
    }

    pub fn get_mut(&mut self, kind: NoteKind) -> &mut T {
        match kind {
            NoteKind::Footnote => &mut self.footnote,
            NoteKind::Endnote => &mut self.endnote,
        }
    }
}

/// `office:annotation` start -> its end element (byte range), from the
/// body-wide pairing.
pub type AnnotationEnds = HashMap<usize, (usize, usize)>;

/// `ForwardState`
pub struct ForwardState {
    pub ext: ObjectsExt,
    /// object id counter (placeholders and pictures share it)
    pub seq: usize,
    pub doc_pr_seq: usize,
    /// bridge media per package entry (or `#neutral`)
    pub media: JsMap<String>,
    pub media_seq: usize,
    /// > 0 while note bodies are converted (objects inside them are kept, not converted)
    pub nested: usize,
    pub note_seq: PerKind<usize>,
    /// paths of the parts this layer created (entries are appended to those only)
    pub lazy_paths: Vec<String>,
    pub comment_seq: usize,
    /// `office:annotation-end` start (byte offset) -> index of its comment record in `ext.comments`
    pub comment_by_end: HashMap<usize, usize>,
    pub annotation_ends: Option<AnnotationEnds>,
    /// sorted byte offsets of `change-start` in content.xml
    pub change_starts: Option<Vec<usize>>,
    pub warned_tracked: bool,
}

impl ForwardState {
    fn new() -> Self {
        Self {
            ext: empty_objects_ext(),
            seq: 0,
            doc_pr_seq: 0,
            media: JsMap::new(),
            media_seq: 0,
            nested: 0,
            note_seq: PerKind::default(),
            lazy_paths: Vec::new(),
            comment_seq: 0,
            comment_by_end: HashMap::new(),
            annotation_ends: None,
            change_starts: None,
            warned_tracked: false,
        }
    }
}

/// The state is the `ext('objects')` slot itself: its JSON is its `ObjectsExt`.
impl Serialize for ForwardState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.ext.serialize(serializer)
    }
}

/// `forwardState`
pub fn forward_state(ctx: &OdfToOoxmlContext) -> Rc<RefCell<ForwardState>> {
    ctx.ext_shared::<ForwardState>(OBJECTS_EXT_KEY, ForwardState::new)
}

/// `bridgeMedia`: relationship id of a picture in the bridge docx (one media
/// part per package entry).
pub fn bridge_media(
    ctx: &mut OdfToOoxmlContext,
    key: &str,
    bytes: &[u8],
    format: &ImageFormat,
) -> String {
    let st = forward_state(ctx);
    if let Some(found) = st.borrow().media.get(key).filter(|found| !found.is_empty()) {
        return found.clone();
    }
    let name = {
        let mut st = st.borrow_mut();
        st.media_seq += 1;
        format!("odt{}.{}", st.media_seq, format.ext)
    };
    ctx.docx.parts.push(DocxExtraPart {
        path: format!("word/media/{name}"),
        data: DocxPartData::Bytes(bytes.to_vec()),
        content_type: None,
    });
    let r_id = ctx.add_relationship(IMAGE_REL, &format!("media/{name}"), false);
    st.borrow_mut().media.set(key, r_id.clone());
    r_id
}

/// `neutralMedia`: relationship id of the neutral placeholder picture.
pub fn neutral_media(ctx: &mut OdfToOoxmlContext) -> String {
    bridge_media(
        ctx,
        "#neutral",
        &NEUTRAL_PLACEHOLDER_PNG,
        &ImageFormat {
            ext: "png".to_string(),
            mime: "image/png".to_string(),
        },
    )
}

/// `lazyPart`: adds a part whose XML is assembled when the bridge docx is
/// built. The TypeScript installs a getter; here the part holds its text, the
/// XML as of no entries (`xml` ends with `suffix`), and `append_to_lazy_part`
/// inserts each entry before the suffix, so the part is complete whenever the
/// docx is built.
pub fn lazy_part(
    ctx: &mut OdfToOoxmlContext,
    path: &str,
    content_type: &str,
    rel_type: &str,
    xml: String,
) {
    if ctx.docx.parts.iter().any(|p| p.path == path) {
        return;
    }
    ctx.docx.parts.push(DocxExtraPart {
        path: path.to_string(),
        data: DocxPartData::Text(xml),
        content_type: Some(content_type.to_string()),
    });
    forward_state(ctx)
        .borrow_mut()
        .lazy_paths
        .push(path.to_string());
    ctx.add_relationship(rel_type, path.strip_prefix("word/").unwrap_or(path), false);
}

/// Appends an entry to a part `lazy_part` created (the TypeScript's getter
/// reads the entries at build time); a part another layer made is left alone.
pub fn append_to_lazy_part(ctx: &mut OdfToOoxmlContext, path: &str, suffix: &str, fragment: &str) {
    if !forward_state(ctx)
        .borrow()
        .lazy_paths
        .iter()
        .any(|p| p == path)
    {
        return;
    }
    if let Some(part) = ctx.docx.parts.iter_mut().find(|p| p.path == path)
        && let DocxPartData::Text(text) = &mut part.data
    {
        text.truncate(text.len() - suffix.len());
        text.push_str(fragment);
        text.push_str(suffix);
    }
}

// ---------------------------------------------------------------------------
// Save

/// `AddedEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct AddedEntry {
    pub path: String,
    pub data: Vec<u8>,
    pub media_type: String,
}

/// `SaveState.editedNames`: docPr names in the edited body XML and in its
/// picture runs.
#[derive(Debug, Clone, Default)]
pub struct EditedNames {
    pub xml: HashSet<String>,
    pub runs: HashSet<String>,
}

/// `SaveState`. The maps of the TypeScript hold the records of `ext`; here
/// they hold the index of the record in its list.
pub struct SaveState {
    pub ext: ObjectsExt,
    pub placeholders: JsMap<usize>,
    pub pictures: JsMap<usize>,
    pub notes: JsMap<usize>,
    pub comments: JsMap<usize>,
    /// new package entries written by this save
    pub added: Vec<AddedEntry>,
    /// lower-cased names taken in the package (existing and added)
    pub taken: HashSet<String>,
    pub emitted_notes: HashSet<String>,
    pub emitted_pictures: HashSet<String>,
    pub emitted_blocks: HashSet<usize>,
    pub claimed_hosts: HashSet<usize>,
    pub comment_started: HashSet<String>,
    pub comment_done: HashSet<String>,
    /// comment ids present anywhere in the edited body (lazy)
    pub surviving: Option<HashSet<String>>,
    /// paragraph records the pre-step forced to be rewritten (a note body changed)
    pub dirty_paragraphs: HashSet<usize>,
    /// bridge element XML replaced by the pre-step, restored afterwards
    pub dirty_elements: Vec<(usize, String)>,
    pub prepared: bool,
    /// next free `draw:z-index` for new frames
    pub z_index: Option<f64>,
    /// `wp:docPr` names already written back
    pub emitted_names: HashSet<String>,
    pub edited_names: Option<EditedNames>,
}

impl SaveState {
    pub fn placeholder(&self, id: &str) -> Option<&ObjectPlaceholder> {
        self.placeholders
            .get(id)
            .map(|&at| &self.ext.placeholders[at])
    }

    pub fn picture(&self, id: &str) -> Option<&ObjectPicture> {
        self.pictures.get(id).map(|&at| &self.ext.pictures[at])
    }

    pub fn note(&self, key: &str) -> Option<&ObjectNote> {
        self.notes.get(key).map(|&at| &self.ext.notes[at])
    }

    pub fn comment(&self, id: &str) -> Option<&ObjectComment> {
        self.comments.get(id).map(|&at| &self.ext.comments[at])
    }
}

/// The save state in the context's typed scratch.
#[derive(Default)]
struct SaveSlot(Option<Rc<RefCell<SaveState>>>);

/// `objectsExtOf`
pub fn objects_ext_of(rctx: &OoxmlToOdfContext) -> Result<Rc<ObjectsExt>, OdtError> {
    Ok(rctx
        .ext::<ObjectsExt>(OBJECTS_EXT_KEY)?
        .unwrap_or_else(|| Rc::new(empty_objects_ext())))
}

/// `noteKey`
pub fn note_key(kind: NoteKind, id: &str) -> String {
    format!("{}:{id}", kind.as_str())
}

/// `saveState`
pub fn save_state(rctx: &OoxmlToOdfContext) -> Result<Rc<RefCell<SaveState>>, OdtError> {
    if let Some(found) = rctx.state::<SaveSlot>().0.clone() {
        return Ok(found);
    }
    let ext = (*objects_ext_of(rctx)?).clone();
    let mut placeholders = JsMap::new();
    for (at, p) in ext.placeholders.iter().enumerate() {
        placeholders.set(p.id.clone(), at);
    }
    let mut pictures = JsMap::new();
    for (at, p) in ext.pictures.iter().enumerate() {
        pictures.set(p.id.clone(), at);
    }
    let mut notes = JsMap::new();
    for (at, n) in ext.notes.iter().enumerate() {
        notes.set(note_key(n.kind, &n.id), at);
    }
    let mut comments = JsMap::new();
    for (at, c) in ext.comments.iter().enumerate() {
        comments.set(c.id.clone(), at);
    }
    let state = Rc::new(RefCell::new(SaveState {
        ext,
        placeholders,
        pictures,
        notes,
        comments,
        added: Vec::new(),
        taken: rctx
            .doc
            .pkg
            .entries
            .iter()
            .map(|e| to_lower(&e.name))
            .collect(),
        emitted_notes: HashSet::new(),
        emitted_pictures: HashSet::new(),
        emitted_blocks: HashSet::new(),
        claimed_hosts: HashSet::new(),
        comment_started: HashSet::new(),
        comment_done: HashSet::new(),
        surviving: None,
        dirty_paragraphs: HashSet::new(),
        dirty_elements: Vec::new(),
        prepared: false,
        z_index: None,
        emitted_names: HashSet::new(),
        edited_names: None,
    }));
    rctx.state::<SaveSlot>().0 = Some(Rc::clone(&state));
    Ok(state)
}

/// `String.prototype.toLowerCase`
fn to_lower(text: &str) -> String {
    text.to_lowercase()
}

/// `text.slice(start, end)` of a part string by UTF-16 offsets.
pub fn slice_u16(text: &IndexedText, start: U16, end: U16) -> &str {
    let (from, to) = (text.to_byte(start), text.to_byte(end));
    if to <= from {
        return "";
    }
    &text.text[from..to]
}

/// `sourceOf`: the source text of a range of an original part.
pub fn source_of(rctx: &OoxmlToOdfContext, part: OdtStylePart, start: U16, end: U16) -> String {
    let info = rctx.part(part);
    slice_u16(&info.xml, start, end).to_string()
}

/// `addPictureEntry`: a new picture entry (shared by identical bytes), named
/// so it collides with nothing.
pub fn add_picture_entry(
    rctx: &OoxmlToOdfContext,
    bytes: &[u8],
    format: &ImageFormat,
) -> Result<String, OdtError> {
    let st = save_state(rctx)?;
    let mut st = st.borrow_mut();
    if let Some(same) = st.added.iter().find(|a| same_bytes(&a.data, bytes)) {
        return Ok(same.path.clone());
    }
    let ext = if format.ext == "jpeg" {
        "jpg"
    } else {
        format.ext.as_str()
    };
    let mut n = 1;
    while st
        .taken
        .contains(&to_lower(&format!("pictures/io_{n}.{ext}")))
    {
        n += 1;
    }
    let path = format!("Pictures/io_{n}.{ext}");
    st.taken.insert(to_lower(&path));
    st.added.push(AddedEntry {
        path: path.clone(),
        data: bytes.to_vec(),
        media_type: format.mime.clone(),
    });
    Ok(path)
}

/// `editedNote`: the edited docx's note list entry for a reference.
pub fn edited_note(rctx: &OoxmlToOdfContext, kind: NoteKind, id: &str) -> Option<NoteInfo> {
    let list = match kind {
        NoteKind::Footnote => &rctx.edited.footnotes,
        NoteKind::Endnote => &rctx.edited.endnotes,
    };
    list.iter().find(|n| n.id == id).cloned()
}
