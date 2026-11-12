//! The functions of this slice of `docx_engine::save`: the redline, the mail
//! merge, content controls, the docProps and Zotero writers, and the chart,
//! bibliography, theme and watermark writers. A function over XML takes its
//! text; a Map crosses as its entries; one that writes into a zip answers
//! the parts of the zip after the call.

use docx_engine::model::{
    Block, NewChartSeriesItem, ParsedDocFull, SourceInfo, ThemeColors, ThemeFonts,
};
use docx_engine::save::features::chart_write::{self, ChartPatch};
use docx_engine::save::features::compare::{self, CompareOptions};
use docx_engine::save::features::content_control::{self, ContentControlSpec};
use docx_engine::save::features::doc_properties_write::{self, PropertyChanges};
use docx_engine::save::features::mail_merge::{self, MergeData, MergeRecord};
use docx_engine::save::features::{
    index_exports, sources_write, theme_write, watermark_write, zotero_doc_props,
};
use docx_engine::watermark::{BoxPt, PictureWatermarkSpec, Watermark};
use jscompat::JsNum;
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, Package, load_package};
use serde_json::{Value, json};

use super::super::{Returned, arg, package, required, value};

/// None: not a function of this module.
pub fn dispatch(function: &str, text: &str, args: &Value) -> Option<Returned> {
    let call: fn(&str, &Value) -> Returned = match function {
        "compareBlocks" => compare_blocks,
        "splitInstruction" => |text, _| value(mail_merge::split_instruction(text)),
        "mergeFieldName" => |text, _| value(mail_merge::merge_field_name(text)),
        "placeholderText" => |text, _| value(mail_merge::placeholder_text(text)),
        "mergeFieldInstruction" => |text, _| value(mail_merge::merge_field_instruction(text)),
        "mergeOutputFileName" => |text, args| {
            value(mail_merge::merge_output_file_name(
                text,
                &required::<MergeRecord>(args, "record")?,
                &required::<Vec<String>>(args, "fields")?,
            ))
        },
        "mergeFieldSwitches" => |text, _| value(mail_merge::merge_field_switches(text)),
        "mergeFieldText" => |text, args| {
            value(mail_merge::merge_field_text(
                text,
                &required::<MergeRecord>(args, "record")?,
            ))
        },
        "valueOf" => |text, args| {
            value(mail_merge::value_of(
                &required::<MergeRecord>(args, "record")?,
                text,
            ))
        },
        "compareOperands" => |_, args| {
            value(
                mail_merge::compare_operands(
                    &required::<String>(args, "left")?,
                    &required::<String>(args, "op")?,
                    &required::<String>(args, "right")?,
                    &required::<MergeRecord>(args, "record")?,
                )
                .map_err(|limit| limit.to_string())?,
            )
        },
        "conditionHolds" => |text, args| {
            value(
                mail_merge::condition_holds(text, &required::<MergeRecord>(args, "record")?)
                    .map_err(|limit| limit.to_string())?,
            )
        },
        "ifBranch" => |text, args| {
            value(
                mail_merge::if_branch(text, &required::<MergeRecord>(args, "record")?)
                    .map_err(|limit| limit.to_string())?,
            )
        },
        "controlEffect" => |text, args| {
            value(
                mail_merge::control_effect(text, &required::<MergeRecord>(args, "record")?)
                    .map_err(|limit| limit.to_string())?,
            )
        },
        "mergeRecords" => |_, args| {
            let blocks: Vec<Block> = required(args, "blocks")?;
            let start: Option<usize> = arg(args, "startIndex")?;
            let (blocks, cursor) = mail_merge::merge_records(
                &blocks,
                &required::<MergeData>(args, "data")?,
                start.unwrap_or(0),
            )
            .map_err(|limit| limit.to_string())?;
            value(json!({ "blocks": blocks, "cursor": cursor }))
        },
        "mergeBlockTree" => |_, args| {
            value(
                mail_merge::merge_block_tree(
                    &required::<Vec<Block>>(args, "blocks")?,
                    &required::<MergeData>(args, "data")?,
                )
                .map_err(|limit| limit.to_string())?,
            )
        },
        "mergeDataFromRows" => |_, args| {
            value(mail_merge::merge_data_from_rows(&required::<
                Vec<Vec<String>>,
            >(
                args, "rows"
            )?))
        },
        "buildContentControlXml" => |_, args| {
            value(content_control::build_content_control_xml(&required::<
                ContentControlSpec,
            >(
                args, "spec",
            )?)?)
        },
        "nextContentControlId" => {
            |text, _| value(JsNum(content_control::next_content_control_id(text)?))
        }
        "isContentControlLock" => |_, args| {
            value(
                args.get("value")
                    .and_then(Value::as_str)
                    .is_some_and(content_control::is_content_control_lock),
            )
        },
        "patchZoteroDocumentDataXml" => |text, args| {
            let absent: Option<bool> = arg(args, "absent")?;
            value(
                zotero_doc_props::patch_zotero_document_data_xml(
                    (absent != Some(true)).then_some(text),
                    &required::<String>(args, "data")?,
                )
                .map_err(|error| error.to_string())?,
            )
        },
        "patchCorePropertiesXml" => |text, args| {
            value(
                doc_properties_write::patch_core_properties_xml(text, &required(args, "changes")?)
                    .map_err(|limit| limit.to_string())?,
            )
        },
        "patchAppPropertiesXml" => |text, args| {
            value(
                doc_properties_write::patch_app_properties_xml(text, &required(args, "changes")?)
                    .map_err(|limit| limit.to_string())?,
            )
        },
        "patchCustomPropertiesXml" => |text, args| {
            let changes: PropertyChanges = serde_json::from_value(json!({
                "custom": required::<Value>(args, "changes")?,
            }))
            .map_err(|error| error.to_string())?;
            value(
                doc_properties_write::patch_custom_properties_xml(
                    text,
                    &changes.custom.unwrap_or_default(),
                )
                .map_err(|error| error.to_string())?,
            )
        },
        "parsePropertyChanges" => |_, args| {
            let changes =
                doc_properties_write::parse_property_changes(&required::<Value>(args, "input")?)?;
            value(changes.to_json())
        },
        "applyPropertyChanges" => |_, args| {
            let mut package = package(args)?;
            doc_properties_write::apply_property_changes(
                &mut package,
                &required::<PropertyChanges>(args, "changes")?,
            )?;
            value(parts_of(&package)?)
        },
        "buildChartPartXml" => |_, args| {
            let r_id: Option<String> = arg(args, "externalDataRId")?;
            value(chart_write::build_chart_part_xml(
                &required(args, "chart")?,
                r_id.as_deref().unwrap_or(""),
            )?)
        },
        "patchChartPartXml" => |text, args| {
            value(
                chart_write::patch_chart_part_xml(text, &required::<ChartPatch>(args, "patch")?)
                    .map_err(|limit| limit.to_string())?,
            )
        },
        "buildChartWorkbookXlsxBase64" => |_, args| {
            let base64 = chart_write::build_chart_workbook_xlsx_base64(
                &required::<Vec<String>>(args, "categories")?,
                &required::<Vec<NewChartSeriesItem>>(args, "series")?,
                CLOCK_MS,
            )?;
            value(workbook_parts(&base64)?)
        },
        "patchChartWorkbookXlsxBase64" => |_, args| {
            let patched = chart_write::patch_chart_workbook_xlsx_base64(
                &required::<String>(args, "base64")?,
                &required::<Vec<String>>(args, "categories")?,
                &required::<Vec<NewChartSeriesItem>>(args, "series")?,
                CLOCK_MS,
            );
            match patched {
                Some(base64) => value(workbook_parts(&base64)?),
                None => value(Value::Null),
            }
        },
        "buildSourcesXml" => |text, args| {
            let absent: Option<bool> = arg(args, "absent")?;
            value(sources_write::build_sources_xml(
                &required::<Vec<SourceInfo>>(args, "sources")?,
                (absent != Some(true)).then_some(text),
            )?)
        },
        "constants" => |_, args| match required::<String>(args, "name")?.as_str() {
            "buildSourcesItemPropsXml" => value(sources_write::build_sources_item_props_xml()),
            name => Err(format!("no constant {name}")),
        },
        "applyThemeFonts" => |text, args| {
            value(theme_write::apply_theme_fonts(
                text,
                &required::<ThemeFonts>(args, "fonts")?,
            )?)
        },
        "applyThemeColors" => |text, args| {
            value(theme_write::apply_theme_colors(
                text,
                &required::<ThemeColors>(args, "colors")?,
            )?)
        },
        "buildThemeXml" => |_, args| {
            value(theme_write::build_theme_xml(
                &required::<ThemeFonts>(args, "fonts")?,
                &required::<ThemeColors>(args, "colors")?,
            )?)
        },
        "parseLazyMediaUrl" => |text, _| {
            value(
                docx_engine::lazy_media::parse_lazy_media_url(text)
                    .map_err(|limit| limit.to_string())?
                    .map(|url| json!({ "hash": url.hash, "partPath": url.part_path })),
            )
        },
        "revisionDateBefore" => |text, args| {
            let absent: Option<bool> = arg(args, "absent")?;
            value(index_exports::revision_date_before(
                (absent != Some(true)).then_some(text),
                to_number_arg(args, "beforeMs")?,
            ))
        },
        "watermarkParagraphXml" => |_, args| {
            value(watermark_write::watermark_paragraph_xml(&required::<
                Watermark,
            >(
                args, "spec"
            )?)?)
        },
        "pictureWatermarkParagraphXml" => |_, args| {
            let spec: PictureWatermarkSpec = required(args, "spec")?;
            value(watermark_write::picture_watermark_paragraph_xml(
                &Watermark::Picture(spec),
                &required::<String>(args, "rId")?,
                arg::<BoxPt>(args, "marginBox")?.as_ref(),
            )?)
        },
        _ => return None,
    };
    Some(call(text, args))
}

/// A number argument that crosses as `null` where it is NaN.
fn to_number_arg(args: &Value, key: &str) -> Result<f64, String> {
    Ok(arg::<JsNum>(args, key)?.map_or(f64::NAN, |number| number.0))
}

/// The clock of a call: the TypeScript stamps the entries of a workbook it
/// zips with the time it runs at, which the comparison does not read.
const CLOCK_MS: f64 = 1_700_000_000_000.0;

/// `compareDocuments` over two parsed documents (each its model and its
/// bytes): the redline as a docx and the summary as JSON.
pub fn compare_documents(
    original: ParsedDocFull,
    revised: ParsedDocFull,
    options: Option<&Value>,
    now_ms: f64,
) -> Result<(Vec<u8>, Value), String> {
    let (bytes, summary) = compare::compare_documents(
        &original,
        &revised,
        &CompareOptions::from_json(options),
        now_ms,
    )?;
    let summary = serde_json::to_value(summary).map_err(|error| error.to_string())?;
    Ok((bytes, summary))
}

fn compare_blocks(_text: &str, args: &Value) -> Returned {
    let options = CompareOptions::from_json(args.get("options"));
    let document_xml: String = arg(args, "documentXml")?.unwrap_or_default();
    value(compare::compare_block_lists(
        &required::<Vec<Block>>(args, "original")?,
        &required::<Vec<Block>>(args, "revised")?,
        &document_xml,
        &options,
        // every input of the comparison names its date
        "1970-01-01T00:00:00.000Z",
    ))
}

/// The entries of a package, in order: `[name, text]`, `null` for a folder.
fn parts_of(package: &Package) -> Result<Vec<(String, Option<String>)>, String> {
    package
        .parts()
        .iter()
        .map(|part| {
            let text = if part.is_dir {
                None
            } else {
                Some(part.text().map_err(|error| error.to_string())?.to_owned())
            };
            Ok((part.name.to_string(), text))
        })
        .collect()
}

/// The parts of a workbook a function answers in base64: what its zip holds,
/// since the compressed bytes are the deflater's own.
fn workbook_parts(base64: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let bytes = jscompat::atob(base64).map_err(|error| error.to_string())?;
    let package = load_package(&bytes, &DEFAULT_ZIP_LIMITS, |_| Ok(()))?;
    parts_of(&package)
}
