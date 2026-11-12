//! The types of patch.ts that `types.ts` does not hold: what `saveDocx` takes
//! beside the parsed document. They read and write the JSON the TypeScript
//! values cross the wire as.

use jscompat::JsNum;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::blank::CustomNumberingLevel;
use crate::model::{
    CommentInfo, DocProtection, GeneratedBlock, HeaderFooter, HeaderFooterNewPicturesValue,
    NewChart, NewImage, NewImageMime, NewInkImage, NoteInfo, RevisionInfo, SectionSettings,
    SourceInfo, ThemeColors, ThemeFonts, WriteProtection,
};
use crate::watermark::Watermark;

pub use super::external::{
    ContentControlSpec, DefaultFonts, PropertyChanges, RemovePartsOptions, StyleUpsert,
};

/// `T | null | undefined`: the outer `Option` is the key, the inner null.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `'ins' | 'del'`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevisionKind {
    Ins,
    Del,
}

impl RevisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ins => "ins",
            Self::Del => "del",
        }
    }
}

/// `{ kind: 'ins' | 'del' } & RevisionInfo`: a top-level tracked insertion or deletion.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveRevision {
    pub kind: RevisionKind,
    pub info: RevisionInfo,
}

impl Serialize for SaveRevision {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(&self.info).map_err(serde::ser::Error::custom)?;
        let mut map = serde_json::Map::new();
        map.insert(
            "kind".to_owned(),
            serde_json::Value::from(self.kind.as_str()),
        );
        if let serde_json::Value::Object(fields) = value.take() {
            map.extend(fields);
        }
        serde_json::Value::Object(map).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SaveRevision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut value = serde_json::Value::deserialize(deserializer)?;
        let kind = value
            .as_object_mut()
            .and_then(|map| map.remove("kind"))
            .ok_or_else(|| serde::de::Error::missing_field("kind"))?;
        let kind: RevisionKind = serde_json::from_value(kind).map_err(serde::de::Error::custom)?;
        let info: RevisionInfo = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self { kind, info })
    }
}

/// `replaceImage` of an `xml` block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplaceImage {
    pub base64: String,
    pub mime: NewImageMime,
}

/// `extentPx` of a chart block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtentPx {
    pub w: JsNum,
    pub h: JsNum,
}

/// The body block a save block stands for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveBlockKind {
    #[serde(rename_all = "camelCase")]
    Original { docx_index: JsNum },
    #[serde(rename_all = "camelCase")]
    Generated {
        block: Box<GeneratedBlock>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        docx_index: Option<JsNum>,
    },
    #[serde(rename_all = "camelCase")]
    Xml {
        xml: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        docx_index: Option<JsNum>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replace_image: Option<ReplaceImage>,
    },
    #[serde(rename_all = "camelCase")]
    Image { image: NewImage },
    #[serde(rename_all = "camelCase")]
    Images { images: Vec<NewImage> },
    #[serde(rename_all = "camelCase")]
    Chart {
        chart: NewChart,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extent_px: Option<ExtentPx>,
    },
}

/// `SaveBlock`: body content in final editor order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaveBlock {
    #[serde(flatten)]
    pub kind: SaveBlockKind,
    /// top-level tracked insertion/deletion wrapper
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<SaveRevision>,
}

impl SaveBlock {
    /// `saveBlockDocxIndex`: the original body block a save block came from, when it has one.
    pub fn docx_index(&self) -> Option<JsNum> {
        match &self.kind {
            SaveBlockKind::Original { docx_index } => Some(*docx_index),
            SaveBlockKind::Generated { docx_index, .. } | SaveBlockKind::Xml { docx_index, .. } => {
                *docx_index
            }
            _ => None,
        }
    }
}

/// `'default' | 'first' | 'even'`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HfVariant {
    Default,
    First,
    Even,
}

impl HfVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::First => "first",
            Self::Even => "even",
        }
    }
}

/// `'header' | 'footer'`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HfKindOpt {
    Header,
    Footer,
}

impl HfKindOpt {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Header => "header",
            Self::Footer => "footer",
        }
    }
}

/// `'accept' | 'reject'`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    Accept,
    Reject,
}

impl Resolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
        }
    }
}

/// `sectionHf[]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionHf {
    pub last_block_index: JsNum,
    pub kind: HfKindOpt,
    pub hf: HeaderFooter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<HfVariant>,
}

/// `sectionHfUnlink[]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionHfUnlink {
    pub last_block_index: JsNum,
    pub kind: HfKindOpt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<HfVariant>,
}

/// `pgNumType`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PgNumType {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fmt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<JsNum>,
}

/// `contentControls.wrap[]`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlWrap {
    pub docx_indexes: Vec<JsNum>,
    pub spec: ContentControlSpec,
}

/// `contentControls.unwrap[]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlUnwrap {
    pub tag: String,
}

/// `contentControls`
#[derive(Debug, Clone, Deserialize)]
pub struct ContentControlsOption {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<Vec<ControlWrap>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unwrap: Option<Vec<ControlUnwrap>>,
}

/// `numbering.newDefs[]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNumberingDef {
    pub num_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub levels: Option<Vec<CustomNumberingLevel>>,
}

/// `numbering.restartNums[]`: `startOverrides` is a record keyed by level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartNum {
    pub num_id: String,
    pub abstract_num_id: String,
    pub start_overrides: crate::model::NumberRecord<JsNum>,
}

/// `numbering.levelEdits[]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelEdit {
    pub abstract_num_id: String,
    pub ilvl: JsNum,
    pub level: CustomNumberingLevel,
}

/// `numbering.picBullets[]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PicBullet {
    pub id: JsNum,
    pub base64: String,
    pub mime: NewImageMime,
}

/// `numbering`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberingOption {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_defs: Option<Vec<NewNumberingDef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_nums: Option<Vec<RestartNum>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level_edits: Option<Vec<LevelEdit>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pic_bullets: Option<Vec<PicBullet>>,
}

/// A record of picture bytes keyed by placeholder token (`newPictures`).
pub type NewPictures = jscompat::JsObject<HeaderFooterNewPicturesValue>;

/// `SaveOptions`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOptions {
    /// save timestamp (ISO), written to docProps/core.xml dcterms:modified; default = now
    #[serde(default)]
    pub saved_at: Option<String>,
    #[serde(default)]
    pub content_controls: Option<ContentControlsOption>,
    #[serde(default)]
    pub revision_id_floor: Option<JsNum>,
    #[serde(default)]
    pub page_count: Option<JsNum>,
    #[serde(default)]
    pub new_pictures: Option<NewPictures>,
    #[serde(default)]
    pub zotero_document_data: Option<String>,
    #[serde(default)]
    pub trailing_sect_pr: Option<String>,
    #[serde(default)]
    pub trailing_sect_pr_change: Option<Resolution>,
    #[serde(default)]
    pub section: Option<SectionSettings>,
    #[serde(default)]
    pub section_start_type: Option<String>,
    #[serde(default)]
    pub pg_num_type: Option<PgNumType>,
    /// hex to set, null to remove, absent to keep
    #[serde(default, deserialize_with = "nullable")]
    pub page_color: Option<Option<String>>,
    #[serde(default)]
    pub header: Option<HeaderFooter>,
    #[serde(default)]
    pub footer: Option<HeaderFooter>,
    #[serde(default)]
    pub header_first: Option<HeaderFooter>,
    #[serde(default)]
    pub footer_first: Option<HeaderFooter>,
    #[serde(default)]
    pub header_even: Option<HeaderFooter>,
    #[serde(default)]
    pub footer_even: Option<HeaderFooter>,
    #[serde(default)]
    pub title_pg: Option<bool>,
    #[serde(default)]
    pub section_hf: Option<Vec<SectionHf>>,
    #[serde(default)]
    pub section_hf_unlink: Option<Vec<SectionHfUnlink>>,
    #[serde(default)]
    pub even_and_odd_headers: Option<bool>,
    #[serde(default)]
    pub mirror_margins: Option<bool>,
    #[serde(default)]
    pub track_revisions: Option<bool>,
    #[serde(default)]
    pub hf_all_sections: Option<bool>,
    #[serde(default)]
    pub numbering: Option<NumberingOption>,
    #[serde(default)]
    pub style_upserts: Option<Vec<StyleUpsert>>,
    #[serde(default)]
    pub default_fonts: Option<DefaultFonts>,
    #[serde(default)]
    pub part_xml: Option<jscompat::JsObject<String>>,
    #[serde(default)]
    pub part_binary: Option<jscompat::JsObject<String>>,
    #[serde(default)]
    pub comments: Option<Vec<CommentInfo>>,
    /// null removes w:documentProtection, absent keeps
    #[serde(default, deserialize_with = "nullable")]
    pub protection: Option<Option<DocProtection>>,
    #[serde(default, deserialize_with = "nullable")]
    pub write_protection: Option<Option<WriteProtection>>,
    #[serde(default)]
    pub remove_personal_info: Option<bool>,
    #[serde(default)]
    pub footnotes: Option<Vec<NoteInfo>>,
    #[serde(default)]
    pub endnotes: Option<Vec<NoteInfo>>,
    /// a spec sets it, null removes it, absent keeps each header's own
    #[serde(default, deserialize_with = "nullable")]
    pub watermark: Option<Option<Watermark>>,
    #[serde(default)]
    pub inks: Option<Vec<NewInkImage>>,
    #[serde(default)]
    pub sources: Option<Vec<SourceInfo>>,
    #[serde(default)]
    pub theme_fonts: Option<ThemeFonts>,
    #[serde(default)]
    pub theme_colors: Option<ThemeColors>,
    #[serde(default)]
    pub properties: Option<PropertyChanges>,
    #[serde(default)]
    pub remove_parts: Option<RemovePartsOptions>,
    #[serde(default)]
    pub drop_orphan_move_ranges: Option<bool>,
}
