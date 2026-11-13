//! The readers of word/comments.xml and of the protection settings in
//! word/settings.xml (`parseComments`, `parseProtection`,
//! `parseWriteProtection`, `parseRemovePersonalInfo` of
//! packages/docx-engine/src/parse-package.ts).

use std::collections::HashMap;

use jscompat::{
    JsNum, JsRegex, Radix, RegexLimit, TryJsRegex, base64, js_regex, math_round, parse_int, truthy,
};
use ooxml_pkg::Package;
use ooxml_xml::XNode;
use serde::Serialize;

use crate::package::{Thrown, parse_part, part_text};
use crate::save::parts::text_patch::patch_paragraph_texts;
use crate::withheld::{
    WITHHELD_ENTRY_TEXT, comment_entries, first_mark_label, has_mark_element,
    over_withheld_model_text, parse_entry, runs_text, withheld_node,
};
use crate::xml_text::EMU_PER_PX;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentImage {
    pub mime: &'static str,
    pub base64: String,
    pub width_px: JsNum,
    pub height_px: JsNum,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentInfo {
    pub id: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Plain text, the paragraphs joined with a line feed.
    pub text: String,
    /// The text as a model may read it, each run hidden from AI as its
    /// placeholder; absent when the comment hides nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_text: Option<String>,
    /// The comment's own XML as the file holds it, kept only when it carries a
    /// hidden-from-AI mark: a person's edit of `text` is patched into it on
    /// save. Never shown or sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked_xml: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<CommentImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    /// A reply: the w:id of the parent comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// A comment's text as a model may read it, from the parser's own node: each
/// hidden run as its placeholder, the whole comment withheld when a mark sits
/// where no run accounts for it; `None` when it hides nothing.
fn comment_model_text(node: &XNode) -> Option<String> {
    if !has_mark_element(node) {
        return None;
    }
    Some(match withheld_node(node) {
        None => WITHHELD_ENTRY_TEXT.to_owned(),
        Some(view) => view
            .find_children("w:p")
            .map(runs_text)
            .collect::<Vec<_>>()
            .join("\n"),
    })
}

/// What a model reads of a marked comment once a person's edit has given it
/// `text`: the save patches the text into the comment's own XML, keeping its
/// runs and their marks (`patchParagraphTexts`, as `buildCommentsXml` does). An
/// edit the runs cannot carry is written with every word hidden, and reads so.
///
/// `editedCommentModelText`
pub fn edited_comment_model_text(
    marked_xml: &str,
    text: &str,
) -> Result<Option<String>, RegexLimit> {
    // an edit the runs cannot carry is saved with every word hidden under the
    // first label (buildCommentsXml), and reads that way now
    let node =
        patch_paragraph_texts(marked_xml, text, false)?.and_then(|patched| parse_entry(&patched));
    let model_text = match node {
        Some(node) => comment_model_text(&node),
        None => Some(over_withheld_model_text(
            text,
            &first_mark_label(marked_xml),
        )),
    };
    Ok(model_text.filter(|model_text| model_text != text))
}

/// The first picture a comment carries. The blip's relationship resolves
/// against word/_rels/comments.xml.rels, the bytes come from the media part,
/// the display size from wp:extent. Whatever is missing gives no image.
fn comment_image_of(package: &Package, comment: &XNode) -> Result<Option<CommentImage>, Thrown> {
    fn walk<'a>(node: &'a XNode, blip: &mut Option<&'a XNode>, extent: &mut Option<&'a XNode>) {
        if blip.is_some() {
            return;
        }
        match node.name() {
            Some("a:blip") => {
                *blip = Some(node);
                return;
            }
            Some("wp:extent") => *extent = Some(node),
            _ => {}
        }
        for child in node.children() {
            walk(child, blip, extent);
        }
    }
    let (mut blip, mut extent) = (None, None);
    for para in comment.find_children("w:p") {
        walk(para, &mut blip, &mut extent);
    }
    let Some(rel_id) = truthy(blip.and_then(|blip| blip.attr("r:embed"))) else {
        return Ok(None);
    };
    let Some(rels_xml) = part_text(package, "word/_rels/comments.xml.rels")? else {
        return Ok(None);
    };
    // the id goes into the pattern unescaped, as in the original
    let rel_pattern = TryJsRegex::new(&format!(r#"<Relationship\b[^>]*Id="{rel_id}"[^>]*/>"#), "")
        .map_err(|error| error.to_string())?;
    let Some(rel) = rel_pattern
        .try_exec(rels_xml)
        .map_err(|limit| limit.to_string())?
        .map(|found| found.as_str())
    else {
        return Ok(None);
    };
    let Some(target) = js_regex!(r#"Target="([^"]+)""#)
        .exec(rel)
        .and_then(|found| found.get(1))
        .filter(|_| !rel.contains(r#"TargetMode="External""#))
    else {
        return Ok(None);
    };
    let target = target.strip_prefix('/').unwrap_or(target);
    let media_path = format!("word/{}", target.strip_prefix("word/").unwrap_or(target));
    let Some(media) = package.file(&media_path) else {
        return Ok(None);
    };
    let lower = media_path.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    };
    let px = |key: &str, fallback: f64| {
        let emu = truthy(extent.and_then(|extent| extent.attr(key)));
        let px = emu.map_or(0.0, |emu| {
            math_round(parse_int(emu, Radix::Ten) / EMU_PER_PX)
        });
        JsNum(if px > 0.0 { px } else { fallback })
    };
    Ok(Some(CommentImage {
        mime,
        base64: base64(media.bytes().map_err(|error| error.to_string())?),
        width_px: px("cx", 160.0),
        height_px: px("cy", 120.0),
    }))
}

/// word/comments.xml, with the reply and resolved relations of
/// commentsExtended.xml, as a display list in file order.
pub fn parse_comments(package: &Package) -> Result<Vec<CommentInfo>, Thrown> {
    let Some(text) = part_text(package, "word/comments.xml")? else {
        return Ok(Vec::new());
    };
    let parsed = parse_part(text)?;
    let Some(root) = parsed.iter().find(|node| node.name() == Some("w:comments")) else {
        return Ok(Vec::new());
    };
    // each marked comment's own bytes, for a person's edit to be read against
    let slices: HashMap<String, String> = comment_entries(text)
        .map_err(|limit| limit.to_string())?
        .into_iter()
        .map(|entry| (entry.id, entry.xml))
        .collect();
    let mut out: Vec<CommentInfo> = Vec::new();
    for node in root.find_children("w:comment") {
        let Some(id) = truthy(node.attr("w:id")) else {
            continue;
        };
        let paras: Vec<&XNode> = node.find_children("w:p").collect();
        let para_id = paras
            .last()
            .and_then(|last| truthy(last.attr("w14:paraId")));
        let image = comment_image_of(package, node)?;
        let comment_text: String = paras
            .iter()
            .map(|para| runs_text(para))
            .collect::<Vec<_>>()
            .join("\n");
        out.push(CommentInfo {
            id: id.to_owned(),
            author: node.attr("w:author").unwrap_or("").to_owned(),
            initials: node.attr("w:initials").map(str::to_owned),
            date: node.attr("w:date").map(str::to_owned),
            model_text: comment_model_text(node).filter(|model_text| *model_text != comment_text),
            marked_xml: if has_mark_element(node) {
                slices.get(id).cloned()
            } else {
                None
            },
            text: comment_text,
            para_id: para_id.map(str::to_owned),
            image,
            done: None,
            parent_id: None,
        });
    }
    // commentsExtended.xml: paraId to parent paraId and done
    if let Some(ext_xml) = part_text(package, "word/commentsExtended.xml")? {
        // the last comment of a paraId is the one the relation names
        let by_para_id = |out: &[CommentInfo], para_id: &str| {
            out.iter()
                .rposition(|comment| comment.para_id.as_deref() == Some(para_id))
        };
        for found in js_regex!(r"<w15:commentEx [^>]*\/>").find_iter(ext_xml) {
            let tag = found.as_str();
            let attr = |pattern: &JsRegex| pattern.exec(tag).and_then(|found| found.get(1));
            let para_id = attr(js_regex!(r#"w15:paraId="([^"]+)""#));
            let parent_para_id = attr(js_regex!(r#"w15:paraIdParent="([^"]+)""#));
            let done = js_regex!(r#"w15:done="(?:1|true)""#).test(tag);
            let Some(at) = para_id.and_then(|para_id| by_para_id(&out, para_id)) else {
                continue;
            };
            if done {
                out[at].done = Some(true);
            }
            if let Some(parent) = parent_para_id.and_then(|parent| by_para_id(&out, parent)) {
                out[at].parent_id = Some(out[parent].id.clone());
            }
        }
    }
    Ok(out)
}

/// An attribute of a raw tag, written with either quote. The value must not
/// be empty.
fn quoted<'t>(tag: &'t str, pattern: &JsRegex) -> Option<&'t str> {
    let found = pattern.exec(tag)?;
    found.get(1).or(found.get(2))
}

fn int(value: Option<&str>) -> Option<JsNum> {
    truthy(value).map(|value| JsNum(parse_int(value, Radix::Ten)))
}

/// w:documentProtection of word/settings.xml: the editing restriction.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocProtection {
    pub edit: String,
    pub enforced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spin_count: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algorithm_sid: Option<JsNum>,
}

pub fn parse_protection(package: &Package) -> Result<Option<DocProtection>, Thrown> {
    let Some(xml) = part_text(package, "word/settings.xml")? else {
        return Ok(None);
    };
    let Some(tag) = js_regex!(r"<w:documentProtection\b[^>]*?(?:\/>|>)").exec(xml) else {
        return Ok(None);
    };
    let tag = tag.as_str();
    let Some(edit) = quoted(tag, js_regex!(r#"w:edit=(?:"([^"]+)"|'([^']+)')"#))
        .filter(|edit| !edit.is_empty() && *edit != "none")
    else {
        return Ok(None);
    };
    let enforcement = quoted(tag, js_regex!(r#"w:enforcement=(?:"([^"]+)"|'([^']+)')"#));
    Ok(Some(DocProtection {
        edit: edit.to_owned(),
        enforced: matches!(enforcement, Some("1" | "true" | "on")),
        hash: truthy(quoted(tag, js_regex!(r#"w:hash=(?:"([^"]+)"|'([^']+)')"#)))
            .map(str::to_owned),
        salt: truthy(quoted(tag, js_regex!(r#"w:salt=(?:"([^"]+)"|'([^']+)')"#)))
            .map(str::to_owned),
        spin_count: int(quoted(
            tag,
            js_regex!(r#"w:cryptSpinCount=(?:"(\d+)"|'(\d+)')"#),
        )),
        algorithm_sid: int(quoted(
            tag,
            js_regex!(r#"w:cryptAlgorithmSid=(?:"(\d+)"|'(\d+)')"#),
        )),
    }))
}

/// w:writeProtection of word/settings.xml: a password to modify, or
/// read-only recommended.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteProtection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spin_count: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algorithm_sid: Option<JsNum>,
}

pub fn parse_write_protection(package: &Package) -> Result<Option<WriteProtection>, Thrown> {
    let Some(xml) = part_text(package, "word/settings.xml")? else {
        return Ok(None);
    };
    let Some(tag) = js_regex!(r"<w:writeProtection\b[^>]*?(?:\/>|>)").exec(xml) else {
        return Ok(None);
    };
    let tag = tag.as_str();
    let recommended = js_regex!(r#"w:recommended=(?:"(?:1|true|on)"|'(?:1|true|on)')"#).test(tag);
    let hash = truthy(quoted(tag, js_regex!(r#"w:hash=(?:"([^"]+)"|'([^']+)')"#)));
    if !recommended && hash.is_none() {
        return Ok(None);
    }
    Ok(Some(WriteProtection {
        recommended: recommended.then_some(true),
        hash: hash.map(str::to_owned),
        salt: truthy(quoted(tag, js_regex!(r#"w:salt=(?:"([^"]+)"|'([^']+)')"#)))
            .map(str::to_owned),
        spin_count: int(quoted(
            tag,
            js_regex!(r#"w:cryptSpinCount=(?:"(\d+)"|'(\d+)')"#),
        )),
        algorithm_sid: int(quoted(
            tag,
            js_regex!(r#"w:cryptAlgorithmSid=(?:"(\d+)"|'(\d+)')"#),
        )),
    }))
}

/// A string with the characters that mean something in a pattern escaped.
fn escape_regex(text: &str) -> String {
    js_regex!(r"[.*+?^${}()|[\]\\]").replace_all(text, |found| format!("\\{}", found.as_str()))
}

/// settings.xml w:removePersonalInformation. The namespace prefix and the
/// quote style are whatever the producer chose.
pub fn parse_remove_personal_info(package: &Package) -> Result<bool, Thrown> {
    let Some(xml) = part_text(package, "word/settings.xml")? else {
        return Ok(false);
    };
    let mut prefixes: Vec<&str> = Vec::new();
    for declaration in
        js_regex!(r#"\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])([^"']*)\2"#).find_iter(xml)
    {
        let is_wordprocessingml = matches!(
            declaration.get(3),
            Some(
                "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                    | "http://purl.oclc.org/ooxml/wordprocessingml/main"
            )
        );
        let prefix = declaration.get(1).unwrap_or("");
        if is_wordprocessingml && !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    }
    let escaped_prefixes: Vec<String> = prefixes
        .iter()
        .filter(|prefix| !prefix.is_empty())
        .map(|prefix| escape_regex(prefix))
        .collect();
    let compile = |pattern: String, flags: &str| {
        TryJsRegex::new(&pattern, flags).map_err(|error| error.to_string())
    };
    for prefix in prefixes {
        let q_name = if prefix.is_empty() {
            "removePersonalInformation".to_owned()
        } else {
            format!("{prefix}:removePersonalInformation")
        };
        let escaped_name = escape_regex(&q_name);
        let tag_pattern = compile(
            format!(r"<{escaped_name}\b[^>]*(?:\/\s*>|>\s*<\/{escaped_name}\s*>)"),
            "",
        )?;
        let Some(tag) = tag_pattern
            .try_exec(xml)
            .map_err(|limit| limit.to_string())?
        else {
            continue;
        };
        let val_prefix = if escaped_prefixes.is_empty() {
            String::new()
        } else {
            format!("(?:{}):", escaped_prefixes.join("|"))
        };
        let val = compile(
            format!(r#"(?:^|\s)(?:{val_prefix})?val\s*=\s*(["'])(0|false)\1"#),
            "i",
        )?;
        return Ok(!val
            .try_test(tag.as_str())
            .map_err(|limit| limit.to_string())?);
    }
    Ok(false)
}
