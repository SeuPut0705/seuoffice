//! `objects/model.ts`: the objects layer's slot in the bridge map
//! (`ext('objects')`) and the names it gives pictures in the bridge docx.
//! Everything here is JSON (the map crosses IPC); every offset is a `U16`.

use jscompat::JsNum;
use serde::{Deserialize, Serialize};

use crate::core::styles::OdtStylePart;
use crate::offset::U16;

/// `OBJECTS_OWNER`: converter id of every objects-layer handler.
pub const OBJECTS_OWNER: &str = "objects";

/// `ODT_KEEP_PREFIX`: `wp:docPr` name prefix of a locked placeholder,
/// `odt-keep:<id>:<kind>`.
pub const ODT_KEEP_PREFIX: &str = "odt-keep:";
/// `ODT_PICTURE_PREFIX`: `wp:docPr` name prefix of an editable ODF picture,
/// `odt-pic:<id>`.
pub const ODT_PICTURE_PREFIX: &str = "odt-pic:";

/// `ObjectKind`: the fixed feature ids of placeholders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObjectKind {
    #[serde(rename = "equation")]
    Equation,
    #[serde(rename = "shape")]
    Shape,
    #[serde(rename = "textbox")]
    Textbox,
    #[serde(rename = "toc")]
    Toc,
    #[serde(rename = "chart")]
    Chart,
    #[serde(rename = "revision")]
    Revision,
    #[serde(rename = "object")]
    Object,
}

/// `OBJECT_KINDS`
pub const OBJECT_KINDS: [ObjectKind; 7] = [
    ObjectKind::Equation,
    ObjectKind::Shape,
    ObjectKind::Textbox,
    ObjectKind::Toc,
    ObjectKind::Chart,
    ObjectKind::Revision,
    ObjectKind::Object,
];

impl ObjectKind {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Equation => "equation",
            Self::Shape => "shape",
            Self::Textbox => "textbox",
            Self::Toc => "toc",
            Self::Chart => "chart",
            Self::Revision => "revision",
            Self::Object => "object",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        OBJECT_KINDS.into_iter().find(|kind| kind.as_str() == name)
    }
}

/// `keepName`
pub fn keep_name(id: &str, kind: ObjectKind) -> String {
    format!("{ODT_KEEP_PREFIX}{id}:{}", kind.as_str())
}

/// `pictureName`
pub fn picture_name(id: &str) -> String {
    format!("{ODT_PICTURE_PREFIX}{id}")
}

/// The result of `parseKeepName`: `{ id, kind }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeepName {
    pub id: String,
    pub kind: ObjectKind,
}

/// `parseKeepName`: `{ id, kind }` of a placeholder `wp:docPr` name, or
/// `None`.
pub fn parse_keep_name(name: &str) -> Option<KeepName> {
    let rest = name.strip_prefix(ODT_KEEP_PREFIX)?;
    let colon = rest.find(':')?;
    if colon == 0 {
        return None;
    }
    let kind = ObjectKind::from_name(&rest[colon + 1..])?;
    Some(KeepName {
        id: rest[..colon].to_string(),
        kind,
    })
}

/// `parsePictureName`: the id of a picture `wp:docPr` name, or `None`.
pub fn parse_picture_name(name: &str) -> Option<String> {
    match name.strip_prefix(ODT_PICTURE_PREFIX) {
        Some(id) if !id.is_empty() => Some(id.to_string()),
        _ => None,
    }
}

/// `ObjectPlaceholder`: a locked placeholder, one uneditable object shown as
/// one picture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPlaceholder {
    /// the `<id>` of `odt-keep:<id>:<kind>`
    pub id: String,
    pub kind: ObjectKind,
    /// the exact `wp:docPr` name
    pub name: String,
    pub part: OdtStylePart,
    /// source range of the object: the inline element, or the whole block
    pub start: U16,
    pub end: U16,
    /// paragraph record that holds an inline object; `None` for a block placeholder
    pub paragraph: Option<usize>,
    /// bridge block of a block placeholder (table of contents, tracked-change paragraph ...)
    pub block: Option<usize>,
    /// bridge element of a block placeholder
    pub element: Option<usize>,
    /// size of the object (and of the placeholder picture)
    pub width_emu: JsNum,
    pub height_emu: JsNum,
    /// the picture is a preview stored in the file; false is the neutral picture
    pub preview: bool,
    /// package entries the object references
    pub entries: Vec<String>,
    /// tracked-change placeholder: the text as shown with every change applied
    pub final_text: Option<String>,
}

/// `ObjectPicture`: an editable picture (`draw:frame` whose content is one
/// `draw:image`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPicture {
    /// the `<id>` of `odt-pic:<id>`
    pub id: String,
    pub name: String,
    pub part: OdtStylePart,
    /// source range of the `draw:frame`
    pub start: U16,
    pub end: U16,
    /// one past the frame's start tag
    pub open_end: U16,
    /// source range of the `draw:image` start tag
    pub image_start: U16,
    pub image_open_end: U16,
    /// `xlink:href` as written (decoded)
    pub href: String,
    /// the package entry it names
    pub entry: String,
    /// relationship id of the picture's media in the bridge docx
    pub r_id: String,
    pub width_emu: JsNum,
    pub height_emu: JsNum,
    /// floating (`wp:anchor`) rather than inline
    pub anchored: bool,
    /// `wp:posOffset` values written for a floating picture (`None` when aligned)
    pub x_emu: Option<JsNum>,
    pub y_emu: Option<JsNum>,
    /// paragraph record that holds the picture
    pub paragraph: Option<usize>,
    /// package entries it references
    pub entries: Vec<String>,
}

/// `ObjectComment`: an existing comment (`office:annotation`), shown as a docx
/// comment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectComment {
    /// docx `w:id`
    pub id: String,
    /// `office:name`
    pub name: Option<String>,
    /// source range of the `office:annotation` element
    pub start: U16,
    pub end: U16,
    /// source range of the matching `office:annotation-end`
    pub end_start: Option<U16>,
    pub end_end: Option<U16>,
    /// paragraph record holding the annotation, and its character offset there
    pub paragraph: usize,
    pub offset: U16,
    /// paragraph record holding the end, and its offset; `None` for a point comment
    pub end_paragraph: Option<usize>,
    pub end_offset: Option<U16>,
    /// the comment covers text
    pub ranged: bool,
    /// the comment's text (paragraphs joined with a line feed)
    pub text: String,
}

/// `NoteKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoteKind {
    #[serde(rename = "footnote")]
    Footnote,
    #[serde(rename = "endnote")]
    Endnote,
}

impl NoteKind {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Footnote => "footnote",
            Self::Endnote => "endnote",
        }
    }
}

/// `ObjectNote`: a footnote or endnote (`text:note`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectNote {
    /// docx `w:id` (unique per kind)
    pub id: String,
    pub kind: NoteKind,
    /// source range of the `text:note`
    pub start: U16,
    pub end: U16,
    /// inner range of `text:note-body` (between its tags)
    pub body_start: U16,
    pub body_end: U16,
    /// `text:note-citation` text as written
    pub citation: String,
    /// the body comes before the citation (Hancom's order)
    pub body_first: bool,
    /// paragraph record holding the citation
    pub paragraph: usize,
    /// paragraph records of the note body, in order
    pub paragraphs: Vec<usize>,
    /// the note text as the docx engine reads it (`NoteInfo.text`)
    pub text: String,
    /// the body holds only paragraphs; otherwise edits of its text are not saved
    pub editable: bool,
}

/// `ObjectsExt`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObjectsExt {
    pub version: u8,
    /// locked placeholders, in conversion order
    pub placeholders: Vec<ObjectPlaceholder>,
    pub pictures: Vec<ObjectPicture>,
    pub comments: Vec<ObjectComment>,
    pub notes: Vec<ObjectNote>,
}

/// `OBJECTS_EXT_KEY`
pub const OBJECTS_EXT_KEY: &str = "objects";

/// `emptyObjectsExt`
pub fn empty_objects_ext() -> ObjectsExt {
    ObjectsExt {
        version: 1,
        placeholders: Vec::new(),
        pictures: Vec::new(),
        comments: Vec::new(),
        notes: Vec::new(),
    }
}
