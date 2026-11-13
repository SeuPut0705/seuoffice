//! `blockpasses.*`: parse-block-passes.ts. A pass mutates its argument and
//! returns nothing, so each answers with the argument it mutated, as the
//! TypeScript spec does.

use docx_engine::block_passes;
use docx_engine::model::{Block, Run, SectionSettings};
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

pub fn dispatch(function: &str, _text: &str, args: &Value) -> Returned {
    match function {
        "applyProtectedLeadingBreaks" => {
            let mut blocks = required::<Vec<Block>>(args, "blocks")?;
            block_passes::apply_protected_leading_breaks(&mut blocks)
                .map_err(|limit| limit.to_string())?;
            value(blocks)
        }
        "applyBalancedDbcsSpacing" => {
            let mut groups = required::<Vec<Option<Vec<Run>>>>(args, "runGroups")?;
            let default_font = arg::<String>(args, "defaultFont")?;
            block_passes::apply_balanced_dbcs_spacing(
                groups.iter_mut().map(Option::as_mut),
                default_font.as_deref(),
            );
            value(groups)
        }
        "blockRunGroups" => {
            let mut blocks = required::<Vec<Block>>(args, "blocks")?;
            value(block_passes::block_run_groups(&mut blocks))
        }
        "normalizeImageZOrders" => {
            let mut blocks = required::<Vec<Block>>(args, "blocks")?;
            block_passes::normalize_image_z_orders(&mut blocks);
            value(blocks)
        }
        "floatTableColumnSpan" => optional(block_passes::float_table_column_span(
            &required::<Block>(args, "block")?,
            &required::<SectionSettings>(args, "sect")?,
        )),
        "bandWrappedBoxesBeforeTables" => {
            let mut blocks = required::<Vec<Block>>(args, "blocks")?;
            block_passes::band_wrapped_boxes_before_tables(&mut blocks);
            value(blocks)
        }
        _ => Err(format!("no function {function}")),
    }
}
