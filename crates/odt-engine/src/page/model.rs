//! `page/model.ts`: the page layer's slot in the bridge map (`ext.page`).

use jscompat::JsObject;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::convert::BridgeMap;
use crate::core::styles::{OdtMasterPage, OdtMasterPageRegion, OdtMasterPageRegionName};

/// `PAGE_EXT_KEY`: key of the page layer in `BridgeMap.ext`.
pub const PAGE_EXT_KEY: &str = "page";
/// `PAGE_OWNER`: owner id recorded on header/footer paragraphs.
pub const PAGE_OWNER: &str = "page";

/// `HfRegion`: a header/footer region of a master page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HfRegion {
    #[serde(rename = "header")]
    Header,
    #[serde(rename = "header-left")]
    HeaderLeft,
    #[serde(rename = "header-first")]
    HeaderFirst,
    #[serde(rename = "footer")]
    Footer,
    #[serde(rename = "footer-left")]
    FooterLeft,
    #[serde(rename = "footer-first")]
    FooterFirst,
}

/// `HF_REGIONS`
pub const HF_REGIONS: [HfRegion; 6] = [
    HfRegion::Header,
    HfRegion::HeaderLeft,
    HfRegion::HeaderFirst,
    HfRegion::Footer,
    HfRegion::FooterLeft,
    HfRegion::FooterFirst,
];

impl HfRegion {
    /// The region name as ODF and the ext write it.
    pub fn as_str(self) -> &'static str {
        match self {
            HfRegion::Header => "header",
            HfRegion::HeaderLeft => "header-left",
            HfRegion::HeaderFirst => "header-first",
            HfRegion::Footer => "footer",
            HfRegion::FooterLeft => "footer-left",
            HfRegion::FooterFirst => "footer-first",
        }
    }

    /// The region of a name, if it is one of `HF_REGIONS`.
    pub fn from_name(name: &str) -> Option<HfRegion> {
        HF_REGIONS.into_iter().find(|r| r.as_str() == name)
    }

    /// `HF_REGIONS.indexOf(region)`
    pub fn rank(self) -> usize {
        HF_REGIONS.iter().position(|r| *r == self).unwrap_or(0)
    }
}

/// `'header' | 'footer'`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HfKindName {
    #[serde(rename = "header")]
    Header,
    #[serde(rename = "footer")]
    Footer,
}

impl HfKindName {
    pub fn as_str(self) -> &'static str {
        match self {
            HfKindName::Header => "header",
            HfKindName::Footer => "footer",
        }
    }
}

/// `PageHfPart.fill`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HfFill {
    #[serde(rename = "content")]
    Content,
    #[serde(rename = "fallback")]
    Fallback,
    #[serde(rename = "empty")]
    Empty,
}

/// `PageHfPart`: one header/footer part of the bridge docx.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageHfPart {
    pub r_id: String,
    /// zip path (`word/header1.xml`)
    pub path: String,
    pub kind: HfKindName,
    /// master page the part was made for
    pub master: String,
    /// the master page region whose paragraphs it shows (null for an empty filler)
    pub region: Option<HfRegion>,
    pub fill: HfFill,
    /// bridge paragraph records of the region's paragraphs, in order
    pub paragraphs: Vec<usize>,
    /// the exact part XML written
    pub xml: String,
}

/// `PageRun.startFamily`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StartFamily {
    #[serde(rename = "paragraph")]
    Paragraph,
    #[serde(rename = "table")]
    Table,
}

impl StartFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            StartFamily::Paragraph => "paragraph",
            StartFamily::Table => "table",
        }
    }
}

/// `PageRun`: one run of pages under one master page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRun {
    pub master: Option<String>,
    pub layout: Option<String>,
    pub start_paragraph: Option<usize>,
    pub start_block: Option<usize>,
    pub start_style: Option<String>,
    pub start_family: Option<StartFamily>,
    pub hidden: bool,
    /// header/footer parts by slot (rId)
    pub slots: JsObject<String>,
}

/// `DocxSection`: one section of the bridge docx.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxSection {
    /// index into `PageExt.runs`
    pub run: usize,
    pub region: Option<usize>,
    pub continuous: bool,
    pub first: Option<usize>,
    pub last: Option<usize>,
    pub carrier: Option<usize>,
    /// exact `w:sectPr` written
    pub sect_pr: String,
}

/// `PageExt`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageExt {
    pub version: u32,
    pub default_master: Option<String>,
    pub even_and_odd: bool,
    pub runs: Vec<PageRun>,
    pub sections: Vec<DocxSection>,
    /// header/footer parts by rId
    pub parts: JsObject<PageHfPart>,
}

/// `readPageExt` over the `ext` of a map.
pub fn read_page_ext_in(ext: &serde_json::Map<String, Value>) -> Option<PageExt> {
    let ext: PageExt = serde_json::from_value(ext.get(PAGE_EXT_KEY)?.clone()).ok()?;
    (ext.version == 1).then_some(ext)
}

/// `readPageExt`
pub fn read_page_ext(map: &BridgeMap) -> Option<PageExt> {
    read_page_ext_in(&map.ext)
}

/// `writePageExt` over the `ext` of a map.
pub fn write_page_ext_in(map_ext: &mut serde_json::Map<String, Value>, ext: &PageExt) {
    let value: Value = serde_json::to_value(ext).unwrap_or(Value::Null);
    map_ext.insert(PAGE_EXT_KEY.to_owned(), value);
}

/// `writePageExt`
pub fn write_page_ext(map: &mut BridgeMap, ext: &PageExt) {
    write_page_ext_in(&mut map.ext, ext);
}

/// `master.regions[region]`
pub fn master_region(master: &OdtMasterPage, region: HfRegion) -> Option<&OdtMasterPageRegion> {
    master.region(OdtMasterPageRegionName::parse(region.as_str())?)
}
