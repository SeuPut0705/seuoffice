//! The table editing of index.ts, called as `index.<TypeScript name>` on an opened deck.

use pptx_engine::deck::OpenedPptx;
use pptx_engine::deck::tables::{
    TableMergeOp, TableStructureOp, edit_table_cell_text, edit_table_structure, edit_table_style,
    ensure_table_style_part, merge_table_cells, resize_table, set_table_cell_anchor,
    set_table_col_width, set_table_row_height,
};
use pptx_engine::table_edit::TableStyleEdit;
use pptx_engine::types::{Paragraph, Slide, TextAnchor};
use serde_json::{Map, Value};

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, required};

fn slide_mut(opened: &mut OpenedPptx, index: usize) -> Result<&mut Slide, String> {
    opened
        .deck
        .slides
        .get_mut(index)
        .ok_or_else(|| "no such slide".to_owned())
}

fn json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// `{ slide, elementId }` or `null`: what the structure edits return.
fn fresh(opened: &OpenedPptx, slide: usize, id: Option<String>) -> Result<Value, String> {
    let Some(id) = id else {
        return Ok(Value::Null);
    };
    let mut object = Map::new();
    object.insert(
        "slide".to_owned(),
        json(opened.deck.slides.get(slide)).map_err(|e| e.to_string())?,
    );
    object.insert("elementId".to_owned(), Value::String(id));
    Ok(Value::Object(object))
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let s: usize = required(args, "slide")?;
    let e: usize = required(args, "element")?;
    match function {
        "index.editTableCellText" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            let paragraphs: Vec<Paragraph> = required(args, "paragraphs")?;
            let done = edit_table_cell_text(
                slide_mut(opened, s)?,
                &id,
                required(args, "row")?,
                required(args, "col")?,
                &paragraphs,
            );
            json(done)
        }),
        "index.editTableStyle" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            let edit: TableStyleEdit = required(args, "edit")?;
            json(edit_table_style(slide_mut(opened, s)?, &id, &edit))
        }),
        "index.ensureTableStylePart" => deck_op(text, args, |opened| {
            let style_id: String = required(args, "styleId")?;
            let style_def: String = required(args, "styleDefXml")?;
            ensure_table_style_part(opened, &style_id, &style_def);
            Ok(Value::Null)
        }),
        "index.editTableStructure" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            let op: TableStructureOp = required(args, "op")?;
            let result = edit_table_structure(opened, s, &id, &op)?;
            fresh(opened, s, result)
        }),
        "index.mergeTableCells" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            let op: TableMergeOp = required(args, "op")?;
            let result = merge_table_cells(opened, s, &id, &op)?;
            fresh(opened, s, result)
        }),
        "index.setTableColWidth" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            json(set_table_col_width(
                slide_mut(opened, s)?,
                &id,
                required(args, "col")?,
                required(args, "wEmu")?,
            ))
        }),
        "index.setTableRowHeight" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            json(set_table_row_height(
                slide_mut(opened, s)?,
                &id,
                required(args, "row")?,
                required(args, "hEmu")?,
            ))
        }),
        "index.resizeTable" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            json(resize_table(
                slide_mut(opened, s)?,
                &id,
                required(args, "cx")?,
                required(args, "cy")?,
            ))
        }),
        "index.setTableCellAnchor" => deck_op(text, args, |opened| {
            let id = element_id(opened, s, e);
            let anchor: TextAnchor = required(args, "anchor")?;
            json(set_table_cell_anchor(
                slide_mut(opened, s)?,
                &id,
                required(args, "row")?,
                required(args, "col")?,
                anchor,
            ))
        }),
        _ => Err(format!("unknown function {function}")),
    }
}
