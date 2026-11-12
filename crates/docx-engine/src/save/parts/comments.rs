//! The comment part writers of patch.ts: `word/comments.xml` rebuilt from the
//! comment list (unchanged comments keep their bytes), `commentsExtended.xml`
//! and the body markers of the comments that are gone.

use std::collections::{HashMap, HashSet};

use jscompat::js_regex;

use super::markup::{opaque_markup_end, xml_tag_end};
use super::text_patch::patch_paragraph_texts;
use super::thrown;
use crate::generate::{escape_xml_attr, escape_xml_text};
use crate::model::CommentInfo;
use crate::notes::root_attributes;

const COMMENTS_NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\"";

/// What a text field means in a condition: `if (c.initials)` is false for `""`.
fn truthy(text: Option<&str>) -> Option<&str> {
    text.filter(|text| !text.is_empty())
}

/// `buildCommentsXml`: surgical rebuild of comments.xml. Existing comments
/// whose text is unchanged keep their original bytes; only new or edited ones
/// fall back to a rebuild. `image_runs` maps a comment id to the picture's run
/// XML (its drawing rides the comment's last paragraph); `kept_image_runs` the
/// run of the picture a comment already carries, for when the text edit cannot
/// be patched in place and the comment regenerates.
pub fn build_comments_xml(
    comments: &[CommentInfo],
    original_xml: Option<&str>,
    image_runs: Option<&HashMap<String, String>>,
    kept_image_runs: Option<&HashMap<String, String>>,
) -> Result<String, String> {
    let mut originals: HashMap<&str, (String, &str)> = HashMap::new();
    if let Some(original_xml) = truthy(original_xml) {
        for found in
            js_regex!(r"<w:comment\s[^>]*>[\s\S]*?<\/w:comment>", "g").find_iter(original_xml)
        {
            let comment = found.as_str();
            let id = js_regex!(r#"w:id="([^"]+)""#)
                .exec(comment)
                .and_then(|id| id.get(1));
            if let Some(id) = id {
                originals.insert(id, (comment_plain_text(comment), comment));
            }
        }
    }
    let has_image = |id: &str| image_runs.is_some_and(|runs| runs.contains_key(id));
    let mut body = String::new();
    for c in comments {
        let original = originals.get(c.id.as_str());
        // a picture-bearing comment always regenerates: the byte-preserved and
        // w:t-patch paths carry no drawing
        if let Some((text, xml)) = original
            && *text == c.text
            && !has_image(&c.id)
        {
            body.push_str(xml);
            continue;
        }
        if let Some((_, xml)) = original
            && !has_image(&c.id)
        {
            // in-paragraph w:t-level patch: text edits keep the rich formatting, the
            // paragraphs and the inline links
            if let Some(patched) = patch_paragraph_texts(xml, &c.text, false) {
                body.push_str(&patched);
                continue;
            }
        }
        let mut attrs = format!(
            "w:id=\"{}\" w:author=\"{}\"",
            escape_xml_attr(&c.id),
            escape_xml_attr(&c.author)
        );
        if let Some(initials) = truthy(c.initials.as_deref()) {
            attrs.push_str(&format!(" w:initials=\"{}\"", escape_xml_attr(initials)));
        }
        if let Some(date) = truthy(c.date.as_deref()) {
            attrs.push_str(&format!(" w:date=\"{}\"", escape_xml_attr(date)));
        }
        let lines: Vec<&str> = c.text.split('\n').collect();
        let mut paras: Vec<String> = lines
            .iter()
            .enumerate()
            .map(|(i, line)| {
                // the last paragraph carries w14:paraId (the commentsExtended link key)
                let pid = match truthy(c.para_id.as_deref()) {
                    Some(para_id) if i == lines.len() - 1 => {
                        format!(" w14:paraId=\"{}\"", escape_xml_attr(para_id))
                    }
                    _ => String::new(),
                };
                format!(
                    "<w:p{pid}><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    escape_xml_text(line)
                )
            })
            .collect();
        // the picture rides inline at the end of the last paragraph, keeping the
        // commentsExtended link key on the final w:p
        let run = image_runs
            .and_then(|runs| runs.get(&c.id))
            .or_else(|| kept_image_runs.and_then(|runs| runs.get(&c.id)));
        if let Some(run) = run
            && let Some(last) = paras.last_mut()
        {
            // `replace(/<\/w:p>$/, ...)`: every paragraph built above ends with the tag
            last.truncate(last.len() - "</w:p>".len());
            last.push_str(run);
            last.push_str("</w:p>");
        }
        body.push_str(&format!(
            "<w:comment {attrs}>{}</w:comment>",
            paras.concat()
        ));
    }
    // Rebuilt comments always emit w14:paraId, so w14 must be bound even when the
    // original root never declared it. A picture-bearing rebuild draws with wp:/r:
    // prefixed elements, so those bind too.
    let mut required = vec![(
        "w14".to_owned(),
        "http://schemas.microsoft.com/office/word/2010/wordml".to_owned(),
    )];
    if image_runs.is_some_and(|runs| !runs.is_empty())
        || kept_image_runs.is_some_and(|runs| !runs.is_empty())
    {
        required.push((
            "wp".to_owned(),
            "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing".to_owned(),
        ));
        required.push((
            "r".to_owned(),
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships".to_owned(),
        ));
    }
    let ns = root_attributes(original_xml, "w:comments", COMMENTS_NS, &required).map_err(thrown)?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:comments {ns}>{body}</w:comments>"
    ))
}

/// `buildCommentsExtendedXml`: one commentEx per comment (reply parent-child and resolved flag).
pub fn build_comments_extended_xml(comments: &[CommentInfo]) -> String {
    let para_id_of: HashMap<&str, Option<&str>> = comments
        .iter()
        .map(|c| (c.id.as_str(), c.para_id.as_deref()))
        .collect();
    let mut body = String::new();
    for c in comments {
        let Some(para_id) = truthy(c.para_id.as_deref()) else {
            continue;
        };
        let parent = truthy(c.parent_id.as_deref())
            .and_then(|parent| para_id_of.get(parent).copied().flatten())
            .and_then(|id| truthy(Some(id)));
        body.push_str(&format!(
            "<w15:commentEx w15:paraId=\"{}\"",
            escape_xml_attr(para_id)
        ));
        if let Some(parent) = parent {
            body.push_str(&format!(
                " w15:paraIdParent=\"{}\"",
                escape_xml_attr(parent)
            ));
        }
        body.push_str(&format!(
            " w15:done=\"{}\"/>",
            if c.done == Some(true) { "1" } else { "0" }
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w15:commentsEx xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:w15=\"http://schemas.microsoft.com/office/word/2012/wordml\" mc:Ignorable=\"w15\">{body}</w15:commentsEx>"
    )
}

/// `commentPlainText`: aligned with parseComments' textOf, each w:p's w:t text with '\n' between paragraphs.
pub fn comment_plain_text(comment_xml: &str) -> String {
    let mut paras: Vec<String> = Vec::new();
    // the self-closing form first: the open-to-close alternative would swallow it
    for p in js_regex!(r"<w:p(?:\s[^>]*)?\/>|<w:p[\s>][\s\S]*?<\/w:p>", "g").find_iter(comment_xml)
    {
        let texts: String = js_regex!(r"<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>", "g")
            .find_iter(p.as_str())
            .map(|t| t.get(1).unwrap_or_default())
            .collect();
        paras.push(
            texts
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&amp;", "&"),
        );
    }
    paras.join("\n")
}

/// `removeDeletedCommentMarkers`: a comment-list edit is authoritative, so the
/// body markers of ids no longer present go even when their paragraphs were
/// copied through as original XML.
pub fn remove_deleted_comment_markers(
    xml: &str,
    live_ids: &HashSet<String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    while cursor < xml.len() {
        let Some(offset) = xml[cursor..].find('<') else {
            out.push_str(&xml[cursor..]);
            return Ok(out);
        };
        let start = cursor + offset;
        out.push_str(&xml[cursor..start]);
        if let Some(opaque_end) = opaque_markup_end(xml, start) {
            out.push_str(&xml[start..opaque_end]);
            cursor = opaque_end;
            continue;
        }
        let end = xml_tag_end(xml, start);
        let tag = &xml[start..end];
        let name = js_regex!(r"^<w:(commentRangeStart|commentRangeEnd|commentReference)\b")
            .exec(tag)
            .and_then(|found| found.get(1));
        let id = js_regex!(r#"\bw:id\s*=\s*(?:"([^"]*)"|'([^']*)')"#).exec(tag);
        if let (Some(name), Some(id)) = (name, id) {
            let id = id.get(1).or_else(|| id.get(2)).unwrap_or_default();
            if !live_ids.contains(id) {
                if tag.ends_with("/>") {
                    cursor = end;
                    continue;
                }
                let close = match name {
                    "commentRangeStart" => js_regex!(r"^\s*<\/w:commentRangeStart\s*>"),
                    "commentRangeEnd" => js_regex!(r"^\s*<\/w:commentRangeEnd\s*>"),
                    _ => js_regex!(r"^\s*<\/w:commentReference\s*>"),
                };
                if let Some(close) = close.exec(&xml[end..]) {
                    cursor = end + close.end();
                    continue;
                }
            }
        }
        out.push_str(tag);
        cursor = end;
    }
    Ok(out)
}
