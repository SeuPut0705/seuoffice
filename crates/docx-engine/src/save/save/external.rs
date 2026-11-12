//! What the save takes from the other slices of `crate::save`, and the
//! constants of the TypeScript modules whose write halves they port. One
//! place to name them: a signature that moves is changed here only.

use std::collections::HashSet;

use ooxml_pkg::Package;

use crate::model::{NewChart, ThemeColors, ThemeFonts};

pub use crate::save::features::content_control::ContentControlSpec;
pub use crate::save::features::doc_properties_write::PropertyChanges;
pub use crate::save::parts::remove_parts::RemovePartsOptions;
pub use crate::save::parts::style_upsert::{DefaultFonts, StyleUpsert};

/// `CUSTOM_PROPERTIES_PATH`, `CUSTOM_PROPERTIES_REL_TYPE`, `CUSTOM_PROPERTIES_CONTENT_TYPE` (zotero-doc-props.ts)
pub use crate::save::features::zotero_doc_props::{
    CUSTOM_PROPERTIES_CONTENT_TYPE, CUSTOM_PROPERTIES_PATH, CUSTOM_PROPERTIES_REL_TYPE,
};

/// `patchZoteroDocumentDataXml`
pub fn patch_zotero_document_data_xml(xml: Option<&str>, data: &str) -> Result<String, String> {
    crate::save::features::zotero_doc_props::patch_zotero_document_data_xml(xml, data)
        .map_err(|error| error.to_string())
}

/// The opening and closing bytes of a block-level content control.
pub struct ControlShell {
    pub open_xml: String,
    pub close_xml: String,
}

/// `buildContentControlXml({ ...spec, id })`
pub fn build_content_control_shell(
    spec: &ContentControlSpec,
    id: String,
) -> Result<ControlShell, String> {
    let mut spec = spec.clone();
    spec.id = Some(id);
    let shell = crate::save::features::content_control::build_content_control_xml(&spec)?;
    Ok(ControlShell {
        open_xml: shell.open_xml,
        close_xml: shell.close_xml,
    })
}

/// `nextContentControlId`
pub fn next_content_control_id(xml: &str) -> Result<f64, String> {
    crate::save::features::content_control::next_content_control_id(xml)
}

/// `buildChartPartXml`
pub fn build_chart_part_xml(chart: &NewChart, workbook_r_id: &str) -> Result<String, String> {
    crate::save::features::chart_write::build_chart_part_xml(chart, workbook_r_id)
}

/// `buildChartWorkbookXlsxBase64`
pub fn build_chart_workbook_xlsx_base64(chart: &NewChart, now_ms: f64) -> Result<String, String> {
    crate::save::features::chart_write::build_chart_workbook_xlsx_base64(
        &chart.categories,
        &chart.series,
        now_ms,
    )
}

pub use crate::save::features::chart_write::CHART_WORKBOOK_REL_TYPE;

/// `buildSourcesXml`
pub fn build_sources_xml(
    sources: &[crate::model::SourceInfo],
    original_xml: Option<&str>,
) -> Result<String, String> {
    crate::save::features::sources_write::build_sources_xml(sources, original_xml)
}

/// `buildSourcesItemPropsXml`
pub fn build_sources_item_props_xml() -> String {
    crate::save::features::sources_write::build_sources_item_props_xml()
}

pub use crate::save::features::theme_write::{THEME_CONTENT_TYPE, THEME_REL_TYPE};

/// `applyThemeFonts`
pub fn apply_theme_fonts(xml: &str, fonts: &ThemeFonts) -> Result<String, String> {
    crate::save::features::theme_write::apply_theme_fonts(xml, fonts)
}

/// `applyThemeColors`
pub fn apply_theme_colors(xml: &str, colors: &ThemeColors) -> Result<String, String> {
    crate::save::features::theme_write::apply_theme_colors(xml, colors)
}

/// `buildThemeXml`
pub fn build_theme_xml(fonts: &ThemeFonts, colors: &ThemeColors) -> Result<String, String> {
    crate::save::features::theme_write::build_theme_xml(fonts, colors)
}

/// `applyPropertyChanges`
pub fn apply_property_changes(zip: &mut Package, changes: &PropertyChanges) -> Result<(), String> {
    crate::save::features::doc_properties_write::apply_property_changes(zip, changes)
}

/// `watermarkParagraphXml`
pub fn watermark_paragraph_xml(watermark: &crate::watermark::Watermark) -> Result<String, String> {
    crate::save::features::watermark_write::watermark_paragraph_xml(watermark)
}

/// `pictureWatermarkParagraphXml`
pub fn picture_watermark_paragraph_xml(
    watermark: &crate::watermark::Watermark,
    r_id: &str,
    margin_box_pt: Option<&crate::watermark::BoxPt>,
) -> Result<String, String> {
    crate::save::features::watermark_write::picture_watermark_paragraph_xml(
        watermark,
        r_id,
        margin_box_pt,
    )
}

/// `builtInHeadingStyleUpsert`
pub fn built_in_heading_style_upsert(
    level: f64,
    default_paragraph_style_id: Option<&str>,
) -> StyleUpsert {
    crate::save::parts::style_upsert::built_in_heading_style_upsert(
        level,
        default_paragraph_style_id,
    )
}

/// `upsertStyleXml`
pub fn upsert_style_xml(xml: &str, up: &StyleUpsert) -> Result<String, String> {
    crate::save::parts::style_upsert::upsert_style_xml(xml, up)
}

/// `mergeDefaultFontsXml`
pub fn merge_default_fonts_xml(xml: &str, fonts: &DefaultFonts) -> Result<String, String> {
    crate::save::parts::style_upsert::merge_default_fonts_xml(xml, fonts)
}

/// What `planRemoveParts` found: the parts it would remove and the structural ones it refuses.
pub struct RemovePlan {
    pub removed_paths: Vec<String>,
    pub refused_paths: Vec<String>,
}

/// `planRemoveParts`
pub fn plan_remove_parts(bytes: &[u8], options: &RemovePartsOptions) -> Result<RemovePlan, String> {
    let plan = crate::save::parts::remove_parts::plan_remove_parts(bytes, options)?;
    Ok(RemovePlan {
        removed_paths: plan.removed_paths,
        refused_paths: plan.refused_paths,
    })
}

/// `removePartsRefusalMessageFor`
pub fn remove_parts_refusal_message_for(paths: &[String]) -> String {
    crate::save::parts::remove_parts::remove_parts_refusal_message_for(paths)
}

/// `applyRemoveParts`
pub fn apply_remove_parts(zip: &mut Package, options: &RemovePartsOptions) -> Result<(), String> {
    crate::save::parts::remove_parts::apply_remove_parts(zip, options).map(|_| ())
}

/// `cleanupDocxOwnedResources`
pub fn cleanup_docx_owned_resources(
    zip: &mut Package,
    document_path: &str,
    source_referenced_ids: Option<&HashSet<String>>,
) -> Result<(), String> {
    crate::save::parts::resource_cleanup::cleanup_docx_owned_resources(
        zip,
        document_path,
        source_referenced_ids,
    )
}

/// `referencedRelationshipIds`
pub fn referenced_relationship_ids(xml: &str) -> Result<HashSet<String>, String> {
    crate::save::parts::resource_cleanup::referenced_relationship_ids(xml)
}
