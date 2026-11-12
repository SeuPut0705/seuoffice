use std::sync::atomic::{AtomicU64, Ordering};

use crate::inline_opaque::ContentControlPart;
use crate::model::{GeneratedBlock, MapEntries};
use jscompat::{JsNum, math_max, math_min, number_to_string, replace_first_string};

use super::{escape_xml_attr as attr, props, runs};

pub struct GenerateContext<'a> {
    pub heading_style_ids: &'a MapEntries<JsNum, String>,
    pub list_paragraph_style_id: Option<&'a str>,
    pub allocate_hyperlink_rel: &'a mut dyn FnMut(&str) -> String,
    pub allocate_bookmark_id: Option<&'a mut dyn FnMut(&str) -> f64>,
    pub allocate_revision_id: Option<&'a mut dyn FnMut() -> String>,
    /// The part the block is written into. With it the run writer checks that
    /// the part root declares the prefixes of the bytes a run carries, and marks
    /// the controls it writes from runs so the part can let a repeated id give
    /// way (`ContentControlPart::finish`, which the caller runs over the part).
    pub part: Option<&'a ContentControlPart>,
}

pub(crate) static STANDALONE_BOOKMARK_SEQ: AtomicU64 = AtomicU64::new(0);

fn bookmarks_xml(ctx: &mut GenerateContext<'_>, names: Option<&[String]>) -> String {
    let mut out = String::new();
    for name in names.unwrap_or_default() {
        let id = ctx.allocate_bookmark_id.as_mut().map_or_else(
            || (STANDALONE_BOOKMARK_SEQ.fetch_add(1, Ordering::Relaxed) + 1) as f64,
            |allocate| allocate(name),
        );
        let id = number_to_string(id);
        out.push_str(&format!(
            "<w:bookmarkStart w:id=\"{id}\" w:name=\"{}\"/><w:bookmarkEnd w:id=\"{id}\"/>",
            attr(name)
        ));
    }
    out
}

pub fn generate_paragraph_xml(
    block: &GeneratedBlock,
    ctx: &mut GenerateContext<'_>,
) -> Result<String, String> {
    let mut content = bookmarks_xml(ctx, block.hidden_bookmarks.as_deref());
    content.push_str(&bookmarks_xml(ctx, block.bookmarks.as_deref()));
    for id in block.comment_starts.as_deref().unwrap_or_default() {
        content.push_str(&format!("<w:commentRangeStart w:id=\"{}\"/>", attr(id)));
    }
    content.push_str(
        &runs::runs_xml_with_revisions(
            &block.runs,
            Some(&mut *ctx.allocate_hyperlink_rel),
            ctx.allocate_revision_id
                .as_mut()
                .map(|callback| &mut **callback as &mut dyn FnMut() -> String),
            ctx.part,
        )
        .map_err(|limit| limit.to_string())?,
    );
    for id in block.comment_ends.as_deref().unwrap_or_default() {
        content.push_str(&format!(
            "<w:commentRangeEnd w:id=\"{0}\"/><w:r><w:commentReference w:id=\"{0}\"/></w:r>",
            attr(id)
        ));
    }
    if let Some(raw) = &block.raw_p_pr {
        return Ok(format!("<w:p>{raw}{content}</w:p>"));
    }

    let mut children = Vec::new();
    let style = match block.r#type.as_str() {
        "heading" => {
            let input = block.level.map_or(1.0, |n| n.0);
            let level = math_min(math_max(input, 1.0), 9.0);
            if block.outline_only.unwrap_or(false) {
                children.push((
                    "w:outlineLvl".to_owned(),
                    format!(
                        "<w:outlineLvl w:val=\"{}\"/>",
                        number_to_string(level - 1.0)
                    ),
                ));
                block.style_id.as_deref()
            } else {
                block.style_id.as_deref().or_else(|| {
                    ctx.heading_style_ids
                        .0
                        .iter()
                        .find(|(key, _)| key.0 == level)
                        .map(|(_, value)| value.as_str())
                })
            }
        }
        "listItem" => block.style_id.as_deref().or(ctx.list_paragraph_style_id),
        _ => block.style_id.as_deref(),
    };
    if let Some(style) = style.filter(|style| !style.is_empty()) {
        children.push((
            "w:pStyle".to_owned(),
            format!("<w:pStyle w:val=\"{}\"/>", attr(style)),
        ));
    }
    if block.r#type.as_str() == "listItem"
        && let Some(list) = &block.list
    {
        let level = math_min(math_max(list.ilvl.0, 0.0), 8.0);
        children.push((
            "w:numPr".to_owned(),
            format!(
                "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
                number_to_string(level),
                attr(&list.num_id)
            ),
        ));
    }
    children.extend(props::format_p_pr_children(block.format.as_ref()));
    if let Some(change) = block
        .p_pr_change
        .as_ref()
        .and_then(|value| value.as_deref())
        .filter(|value| !value.is_empty())
        && let Some(revision) = props::revision_p_pr_change_xml(change)?
    {
        children.push(("w:pPrChange".to_owned(), revision));
    }
    let mut empty_id = || String::new();
    let mint: &mut dyn FnMut() -> String = match ctx.allocate_revision_id.as_mut() {
        Some(allocate) => &mut **allocate,
        None => &mut empty_id,
    };
    let mut mark_revision = props::para_mark_revision_xml(
        "del",
        block.para_mark_del.as_ref().and_then(|v| v.as_deref()),
        mint,
    );
    mark_revision.push_str(&props::para_mark_revision_xml(
        "ins",
        block.para_mark_ins.as_ref().and_then(|v| v.as_deref()),
        mint,
    ));
    if !mark_revision.is_empty() {
        if let Some((_, xml)) = children.iter_mut().find(|(name, _)| name == "w:rPr") {
            // JS replace uses a string replacement; substitution is shared with drawing patches.
            *xml = replace_first_string(xml, "<w:rPr>", &format!("<w:rPr>{mark_revision}"));
        } else {
            children.push((
                "w:rPr".to_owned(),
                format!("<w:rPr>{mark_revision}</w:rPr>"),
            ));
        }
    }
    children.sort_by_key(|(name, _)| {
        props::PPR_CHILD_ORDER
            .iter()
            .position(|tag| *tag == name)
            .map_or(-1, |at| at as i64)
    });
    let p_pr = if children.is_empty() {
        String::new()
    } else {
        format!(
            "<w:pPr>{}</w:pPr>",
            children.into_iter().map(|(_, xml)| xml).collect::<String>()
        )
    };
    Ok(format!("<w:p>{p_pr}{content}</w:p>"))
}
