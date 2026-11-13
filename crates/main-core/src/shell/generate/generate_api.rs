//! The runtime parts of `apps/shell/src/shared/generate-api.ts`,
//! `generate-home-channels.ts` and `generate-default-prompts.ts`: the kinds,
//! the channel names, and the shapes the generate window's state and request
//! are written in. The TypeScript interfaces become structs whose fields are
//! in the order of the literals that build them.

use serde::Serialize;

use crate::packages::electron_utils::generate_handoff::{
    GenerateConvertKind, GenerateConvertTarget, GenerateHandoffTarget,
};
use crate::packages::i18n::Lang;

/// what the AI can make; each is a new untitled tab of that editor
pub type AiTargetKind = GenerateHandoffTarget;

/// conversions without AI (8.6)
pub type ConvertKind = GenerateConvertKind;

/// `AI_TARGET_KINDS`
pub const AI_TARGET_KINDS: [AiTargetKind; 3] = [
    GenerateHandoffTarget::Slides,
    GenerateHandoffTarget::Html,
    GenerateHandoffTarget::Mindmap,
];

/// `CONVERT_KINDS`
pub const CONVERT_KINDS: [ConvertKind; 3] = [
    GenerateConvertKind::MindmapToMarkdown,
    GenerateConvertKind::MindmapToSlides,
    GenerateConvertKind::MarkdownToMindmap,
];

pub fn ai_target_str(kind: AiTargetKind) -> &'static str {
    match kind {
        GenerateHandoffTarget::Slides => "slides",
        GenerateHandoffTarget::Html => "html",
        GenerateHandoffTarget::Mindmap => "mindmap",
    }
}

pub fn convert_kind_str(kind: ConvertKind) -> &'static str {
    match kind {
        GenerateConvertKind::MindmapToMarkdown => "mindmap-to-markdown",
        GenerateConvertKind::MindmapToSlides => "mindmap-to-slides",
        GenerateConvertKind::MarkdownToMindmap => "markdown-to-mindmap",
    }
}

pub fn parse_convert_kind(value: &str) -> Option<ConvertKind> {
    CONVERT_KINDS
        .iter()
        .copied()
        .find(|kind| convert_kind_str(*kind) == value)
}

pub fn convert_target_str(target: GenerateConvertTarget) -> &'static str {
    match target {
        GenerateConvertTarget::Markdown => "markdown",
        GenerateConvertTarget::Slides => "slides",
        GenerateConvertTarget::Mindmap => "mindmap",
    }
}

/// `CONVERT_TARGETS[kind]`: the editor each conversion's result opens in
pub fn convert_target(kind: ConvertKind) -> GenerateConvertTarget {
    match kind {
        GenerateConvertKind::MindmapToMarkdown => GenerateConvertTarget::Markdown,
        GenerateConvertKind::MindmapToSlides => GenerateConvertTarget::Slides,
        GenerateConvertKind::MarkdownToMindmap => GenerateConvertTarget::Mindmap,
    }
}

/// `GenerateMode`: `ai` is an editor's AI writing the new document, `convert` is no AI (8.6)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GenerateMode {
    #[serde(rename = "ai")]
    Ai,
    #[serde(rename = "convert")]
    Convert,
}

/// the `kind` of a [`GenerateRequest`]: an AI target or a conversion
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RequestKind {
    Ai(AiTargetKind),
    Convert(ConvertKind),
}

/// 8.1: the one shape every entry point builds
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GenerateRequest {
    pub mode: GenerateMode,
    pub kind: RequestKind,
    /// absolute file paths; at least one
    pub materials: Vec<String>,
    /// what the user wrote; may be empty. Always empty for `convert`
    pub text: String,
}

/// Why a conversion did not happen (nothing opens).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ConvertProblem {
    #[serde(rename = "unreadable")]
    Unreadable,
    #[serde(rename = "redaction")]
    Redaction,
    #[serde(rename = "too-many-slides")]
    TooManySlides,
    #[serde(rename = "failed")]
    Failed,
}

/// why a file was left out of the materials
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MaterialProblem {
    #[serde(rename = "missing")]
    Missing,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(rename = "too-large")]
    TooLarge,
    #[serde(rename = "unreadable")]
    Unreadable,
    #[serde(rename = "untitled")]
    Untitled,
}

/// `MaterialView.state`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MaterialState {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "unsaved")]
    Unsaved,
    #[serde(rename = "excluded")]
    Excluded,
    #[serde(rename = "checking")]
    Checking,
}

/// how the window helps with an unsaved or untitled row
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SaveAction {
    #[serde(rename = "save")]
    Save,
    #[serde(rename = "show")]
    Show,
}

/// one row of the window's material list
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaterialView {
    pub key: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(rename = "sizeBytes", skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<f64>,
    pub state: MaterialState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<MaterialProblem>,
    /// with `too-large`: the cap this file is over, in MB
    #[serde(rename = "limitMb", skip_serializing_if = "Option::is_none")]
    pub limit_mb: Option<f64>,
    #[serde(rename = "saveAction", skip_serializing_if = "Option::is_none")]
    pub save_action: Option<SaveAction>,
}

/// 8.7: neither blocks "make"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Notices {
    pub usage: bool,
    #[serde(rename = "longMaterial")]
    pub long_material: bool,
}

/// `GenerateWindowState.failure`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Failed {
    #[serde(rename = "make")]
    Make,
    #[serde(rename = "save")]
    Save,
    #[serde(rename = "convert")]
    Convert,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StateLimits {
    #[serde(rename = "maxMaterials")]
    pub max_materials: usize,
    #[serde(rename = "maxMaterialMb")]
    pub max_material_mb: f64,
    #[serde(rename = "maxImageMb")]
    pub max_image_mb: f64,
    /// the most slides a map to PPT conversion makes
    #[serde(rename = "maxConvertSlides")]
    pub max_convert_slides: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GenerateWindowState {
    pub lang: Lang,
    pub kind: AiTargetKind,
    /// `convert` while a conversion without AI is chosen (and still offered)
    pub mode: GenerateMode,
    /// the chosen conversion in `convert` mode, null otherwise
    #[serde(rename = "convertKind")]
    pub convert_kind: Option<ConvertKind>,
    /// 8.6: the conversions the listed material allows
    pub conversions: Vec<ConvertKind>,
    /// the chosen conversion's markdown source has withheld spans
    #[serde(rename = "redactionNotice")]
    pub redaction_notice: bool,
    pub materials: Vec<MaterialView>,
    /// rows in state `ready`
    #[serde(rename = "readyCount")]
    pub ready_count: usize,
    /// total size of the ready rows
    #[serde(rename = "totalBytes")]
    pub total_bytes: f64,
    pub notices: Notices,
    /// more rows than the count cap
    #[serde(rename = "tooMany")]
    pub too_many: bool,
    #[serde(rename = "canMake")]
    pub can_make: bool,
    /// a status read is running
    pub checking: bool,
    /// "make" was pressed and the tab is being opened
    pub making: bool,
    /// keys of rows whose save is running
    pub saving: Vec<String>,
    pub failure: Option<Failed>,
    /// with `failure: 'convert'`: why nothing was converted
    #[serde(rename = "convertProblem")]
    pub convert_problem: Option<ConvertProblem>,
    pub limits: StateLimits,
}

/// `GENERATE_CHANNELS`, in the order of the literal
pub mod channels {
    pub const GET_STATE: &str = "generate:get-state";
    pub const GET_THEME: &str = "generate:get-theme";
    pub const SET_KIND: &str = "generate:set-kind";
    pub const SET_CONVERT: &str = "generate:set-convert";
    pub const ADD_MATERIALS: &str = "generate:add-materials";
    pub const REMOVE_MATERIAL: &str = "generate:remove-material";
    pub const SAVE_MATERIAL: &str = "generate:save-material";
    pub const REFRESH: &str = "generate:refresh";
    pub const MAKE: &str = "generate:make";
    pub const CANCEL: &str = "generate:cancel";
    pub const STATE: &str = "generate:state";
    /// `GENERATE_HOME_CHANNELS.openWithPaths`
    pub const HOME_OPEN_WITH_PATHS: &str = "generate:open-with-paths";
    /// `GENERATE_HOME_CHANNELS.openWithGroup`
    pub const HOME_OPEN_WITH_GROUP: &str = "generate:open-with-group";
}

/// `DEFAULT_GENERATE_PROMPTS[lang][kind]`: the request a generate run starts
/// with when the user leaves the box empty, in the UI language
fn default_prompt(lang: Lang, kind: AiTargetKind) -> &'static str {
    match (lang, kind) {
        (Lang::En, GenerateHandoffTarget::Slides) => {
            "Make a presentation from the attached material. Organize the main points into slides with clear titles."
        }
        (Lang::En, GenerateHandoffTarget::Html) => {
            "Make a web page (HTML) from the attached material. Lay out the main points so they are easy to read."
        }
        (Lang::En, GenerateHandoffTarget::Mindmap) => {
            "Make a mind map from the attached material. Put the main topic in the center and organize the key points as branches."
        }
        (Lang::Ko, GenerateHandoffTarget::Slides) => {
            "첨부한 자료로 발표 자료를 만들어 주세요. 핵심 내용을 정리해 제목이 분명한 슬라이드로 구성해 주세요."
        }
        (Lang::Ko, GenerateHandoffTarget::Html) => {
            "첨부한 자료로 웹 페이지(HTML)를 만들어 주세요. 핵심 내용을 읽기 쉽게 배치해 주세요."
        }
        (Lang::Ko, GenerateHandoffTarget::Mindmap) => {
            "첨부한 자료로 마인드맵을 만들어 주세요. 중심 주제를 가운데에 두고 핵심 내용을 가지로 정리해 주세요."
        }
    }
}

/// `defaultGeneratePrompt(lang, kind)`
pub fn default_generate_prompt(lang: Lang, kind: AiTargetKind) -> &'static str {
    default_prompt(lang, kind)
}
