//! Port of packages/pptx-engine/src/comments.ts: slide comments (the classic
//! comments part) read/write by archive surgery.
//!
//! Structure: ppt/commentAuthors.xml (author table, referenced by
//! presentation.xml.rels) + one ppt/comments/commentN.xml per slide
//! (referenced by slide rels). A comment is uniquely identified by
//! (authorId, idx).
//!
//! The TypeScript stamps a new comment with `new Date().toISOString()`; the
//! engine reads no clock, so [`add_slide_comment`] takes that text as `dt`.

use jscompat::{JsMap, JsNum, js_regex, number_to_string, replace_first_with, to_number};
use serde::{Deserialize, Serialize};

use crate::deck::OpenedPptx;
use crate::notes::{append_relationship, replace_literal, set_entry, unescape_xml};
use crate::resource_cleanup::remove_relationship_and_collect_owned_target;
use crate::xml_utils::{escape_xml_attr, escape_xml_text, has_content_type_override};
use crate::zip::{PackageArchive, resolve_target};

const XMLDECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";

const COMMENTS_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const AUTHORS_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors";

const COMMENTS_CT: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.comments+xml";
const AUTHORS_CT: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml";

const AUTHORS_PATH: &str = "ppt/commentAuthors.xml";

/// `SlideComment`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideComment {
    pub author_id: JsNum,
    pub author: String,
    pub initials: String,
    /// ISO timestamp (the dt attribute in the part)
    pub dt: String,
    pub idx: JsNum,
    pub text: String,
}

/// The `opts` of `addSlideComment`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideCommentOptions {
    pub author: String,
    pub initials: Option<String>,
    pub text: String,
}

/// The `ref` of `deleteSlideComment`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideCommentRef {
    pub author_id: f64,
    pub idx: f64,
}

/// `addContentTypeOverride` of this file: the replacement is a function, so the part path and
/// content type are written as given.
fn add_content_type_override(archive: &mut PackageArchive, part_path: &str, content_type: &str) {
    let ct_path = "[Content_Types].xml";
    let Some(ct) = archive
        .read_text(ct_path)
        .filter(|ct| !ct.is_empty())
        .map(|ct| ct.into_owned())
    else {
        return;
    };
    if has_content_type_override(&ct, part_path) {
        return;
    }
    let next = replace_literal(
        &ct,
        "</Types>",
        &format!("<Override PartName=\"/{part_path}\" ContentType=\"{content_type}\"/></Types>"),
    );
    set_entry(archive, ct_path, next);
}

/// A row of the author table.
struct Author {
    name: String,
    initials: String,
}

/// `readAuthors`: author table, keyed by the id as a number prints.
fn read_authors(archive: &PackageArchive) -> JsMap<Author> {
    let mut map = JsMap::new();
    let Some(xml) = archive
        .read_text(AUTHORS_PATH)
        .filter(|xml| !xml.is_empty())
    else {
        return map;
    };
    for m in js_regex!(r"<p:cmAuthor\b([^>]*)\/>", "g").find_iter(&xml) {
        let attrs = m.get(1).unwrap_or_default();
        let id = to_number(
            js_regex!(r#"\bid="(\d+)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or("-1"),
        );
        if id < 0.0 {
            continue;
        }
        map.set(
            number_to_string(id),
            Author {
                name: unescape_xml(
                    js_regex!(r#"\bname="([^"]*)""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1))
                        .unwrap_or_default(),
                ),
                initials: unescape_xml(
                    js_regex!(r#"\binitials="([^"]*)""#)
                        .exec(attrs)
                        .and_then(|m| m.get(1))
                        .unwrap_or_default(),
                ),
            },
        );
    }
    map
}

/// `commentsRelationshipForSlide`: relationship id and path of a slide's
/// comments part (`None` when absent).
fn comments_relationship_for_slide(
    archive: &PackageArchive,
    slide_path: &str,
) -> Result<Option<(String, String)>, String> {
    for rel in archive.read_rels(slide_path)?.values() {
        if rel.r#type == COMMENTS_REL {
            return Ok(Some((
                rel.id.clone(),
                resolve_target(slide_path, &rel.target),
            )));
        }
    }
    Ok(None)
}

/// `commentsPathForSlide`: path of a slide's comments part (`None` if the
/// slide has no comments).
fn comments_path_for_slide(
    archive: &PackageArchive,
    slide_path: &str,
) -> Result<Option<String>, String> {
    Ok(comments_relationship_for_slide(archive, slide_path)?.map(|(_, path)| path))
}

/// `getSlideComments`: all comments on a slide (in order of appearance).
pub fn get_slide_comments(
    archive: &PackageArchive,
    slide_path: &str,
) -> Result<Vec<SlideComment>, String> {
    let Some(part_path) = comments_path_for_slide(archive, slide_path)?.filter(|p| !p.is_empty())
    else {
        return Ok(Vec::new());
    };
    let Some(xml) = archive.read_text(&part_path).filter(|xml| !xml.is_empty()) else {
        return Ok(Vec::new());
    };
    let authors = read_authors(archive);
    let mut out = Vec::new();
    for m in js_regex!(r"<p:cm\b([^>]*)>([\s\S]*?)<\/p:cm>", "g").find_iter(&xml) {
        let attrs = m.get(1).unwrap_or_default();
        let author_id = to_number(
            js_regex!(r#"\bauthorId="(\d+)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or("0"),
        );
        let a = authors.get(&number_to_string(author_id));
        out.push(SlideComment {
            author_id: JsNum(author_id),
            author: a.map_or_else(|| "Unknown author".to_owned(), |a| a.name.clone()),
            initials: a.map_or_else(String::new, |a| a.initials.clone()),
            dt: js_regex!(r#"\bdt="([^"]*)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or_default()
                .to_owned(),
            idx: JsNum(to_number(
                js_regex!(r#"\bidx="(\d+)""#)
                    .exec(attrs)
                    .and_then(|m| m.get(1))
                    .unwrap_or("0"),
            )),
            text: unescape_xml(
                js_regex!(r"<p:text>([\s\S]*?)<\/p:text>")
                    .exec(m.get(2).unwrap_or_default())
                    .and_then(|m| m.get(1))
                    .unwrap_or_default(),
            ),
        });
    }
    Ok(out)
}

/// `ensureAuthor`: ensure the author exists and return `(authorId, nextIdx)`
/// (bumping lastIdx). Creates the author table / content type / presentation
/// rel if missing.
fn ensure_author(archive: &mut PackageArchive, name: &str, initials: &str) -> (f64, f64) {
    let xml = match archive
        .read_text(AUTHORS_PATH)
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned())
    {
        Some(xml) => xml,
        None => {
            add_content_type_override(archive, AUTHORS_PATH, AUTHORS_CT);
            append_relationship(
                archive,
                "ppt/presentation.xml",
                AUTHORS_REL,
                "commentAuthors.xml",
            );
            format!("{XMLDECL}<p:cmAuthorLst xmlns:p=\"{NS_P}\"></p:cmAuthorLst>")
        }
    };
    // Existing author with the same name: reuse its id, lastIdx + 1
    for m in js_regex!(r"<p:cmAuthor\b([^>]*)\/>", "g").find_iter(&xml) {
        let attrs = m.get(1).unwrap_or_default();
        let attr_name = unescape_xml(
            js_regex!(r#"\bname="([^"]*)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or_default(),
        );
        if attr_name != name {
            continue;
        }
        let author_id = to_number(
            js_regex!(r#"\bid="(\d+)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or("0"),
        );
        let last_idx = to_number(
            js_regex!(r#"\blastIdx="(\d+)""#)
                .exec(attrs)
                .and_then(|m| m.get(1))
                .unwrap_or("0"),
        );
        let next_idx = last_idx + 1.0;
        let bumped = if m.as_str().contains("lastIdx=\"") {
            replace_first_with(js_regex!(r#"\blastIdx="\d+""#), m.as_str(), |_| {
                format!("lastIdx=\"{}\"", number_to_string(next_idx))
            })
        } else {
            replace_literal(
                m.as_str(),
                "/>",
                &format!(" lastIdx=\"{}\"/>", number_to_string(next_idx)),
            )
        };
        let next = replace_literal(&xml, m.as_str(), &bumped);
        set_entry(archive, AUTHORS_PATH, next);
        return (author_id, next_idx);
    }
    // New author
    let mut max_id = -1.0_f64;
    for m in js_regex!(r#"<p:cmAuthor\b[^>]*\bid="(\d+)""#, "g").find_iter(&xml) {
        max_id = max_id.max(to_number(m.get(1).unwrap_or_default()));
    }
    let author_id = max_id + 1.0;
    let author_id_text = number_to_string(author_id);
    let tag = format!(
        "<p:cmAuthor id=\"{author_id_text}\" name=\"{}\" initials=\"{}\" lastIdx=\"1\" clrIdx=\"{author_id_text}\"/>",
        escape_xml_attr(name),
        escape_xml_attr(initials)
    );
    let next = replace_literal(&xml, "</p:cmAuthorLst>", &format!("{tag}</p:cmAuthorLst>"));
    set_entry(archive, AUTHORS_PATH, next);
    (author_id, 1.0)
}

/// `w[0] ?? ''` of a word: its first UTF-16 code unit. A first character
/// outside the BMP is a lone surrogate there, which a Rust string cannot
/// hold and which `escapeXmlAttr` drops from the part; it reads as '' here.
fn first_unit(word: &str) -> String {
    word.chars()
        .next()
        .filter(|c| c.len_utf16() == 1)
        .map(String::from)
        .unwrap_or_default()
}

/// `addSlideComment`: add a comment; returns the new comment (with assigned
/// authorId/idx). `dt` is `new Date().toISOString()`.
pub fn add_slide_comment(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &SlideCommentOptions,
    dt: &str,
) -> Result<Option<SlideComment>, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(None);
    };
    let slide_path = slide.path.as_deref().unwrap_or("").to_owned();
    let archive = &mut opened.archive;
    let initials = match &opts.initials {
        Some(initials) => initials.clone(),
        None => js_regex!(r"\s+")
            .split(&opts.author)
            .into_iter()
            .map(first_unit)
            .collect::<String>()
            .to_uppercase(),
    };
    let (author_id, next_idx) = ensure_author(archive, &opts.author, &initials);

    let part_path = match comments_path_for_slide(archive, &slide_path)?.filter(|p| !p.is_empty()) {
        Some(path) => path,
        None => {
            let number_pattern = js_regex!(r"^ppt\/comments\/comment(\d+)\.xml$");
            let mut max_num = 0.0_f64;
            for path in archive.entries().keys() {
                if let Some(m) = number_pattern.exec(path) {
                    max_num = max_num.max(to_number(m.get(1).unwrap_or_default()));
                }
            }
            let path = format!(
                "ppt/comments/comment{}.xml",
                number_to_string(max_num + 1.0)
            );
            set_entry(
                archive,
                &path,
                format!("{XMLDECL}<p:cmLst xmlns:p=\"{NS_P}\"></p:cmLst>"),
            );
            add_content_type_override(archive, &path, COMMENTS_CT);
            append_relationship(
                archive,
                &slide_path,
                COMMENTS_REL,
                &format!("../{}", jscompat::slice_utf16(&path, 4.0, None)),
            );
            path
        }
    };
    let Some(xml) = archive
        .read_text(&part_path)
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned())
    else {
        return Ok(None);
    };

    // Positions staggered along the top-left diagonal so comment badges don't overlap
    let count = js_regex!(r"<p:cm\b", "g").find_iter(&xml).count();
    let pos = 10 + (count % 8) * 6;
    let cm = format!(
        "<p:cm authorId=\"{}\" dt=\"{dt}\" idx=\"{}\"><p:pos x=\"{pos}\" y=\"{pos}\"/><p:text>{}</p:text></p:cm>",
        number_to_string(author_id),
        number_to_string(next_idx),
        escape_xml_text(&opts.text)
    );
    let next = replace_literal(&xml, "</p:cmLst>", &format!("{cm}</p:cmLst>"));
    set_entry(archive, &part_path, next);

    Ok(Some(SlideComment {
        author_id: JsNum(author_id),
        author: opts.author.clone(),
        initials,
        dt: dt.to_owned(),
        idx: JsNum(next_idx),
        text: opts.text.clone(),
    }))
}

/// `deleteSlideComment`: delete a comment (by authorId + idx).
pub fn delete_slide_comment(
    opened: &mut OpenedPptx,
    slide_index: usize,
    reference: &SlideCommentRef,
) -> Result<bool, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Ok(false);
    };
    let slide_path = slide.path.as_deref().unwrap_or("").to_owned();
    let archive = &mut opened.archive;
    let Some((relationship_id, part_path)) = comments_relationship_for_slide(archive, &slide_path)?
    else {
        return Ok(false);
    };
    let Some(xml) = archive
        .read_text(&part_path)
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned())
    else {
        return Ok(false);
    };
    for m in js_regex!(r"<p:cm\b([^>]*)>[\s\S]*?<\/p:cm>", "g").find_iter(&xml) {
        let attrs = m.get(1).unwrap_or_default();
        let number = |pattern: &jscompat::JsRegex| {
            to_number(pattern.exec(attrs).and_then(|m| m.get(1)).unwrap_or("-1"))
        };
        if number(js_regex!(r#"\bauthorId="(\d+)""#)) == reference.author_id
            && number(js_regex!(r#"\bidx="(\d+)""#)) == reference.idx
        {
            let next = format!(
                "{}{}",
                xml.get(..m.start()).unwrap_or_default(),
                xml.get(m.end()..).unwrap_or_default()
            );
            set_entry(archive, &part_path, next.clone());
            if !js_regex!(r"<p:cm\b").test(&next) {
                remove_relationship_and_collect_owned_target(
                    archive,
                    &slide_path,
                    &relationship_id,
                )?;
            }
            return Ok(true);
        }
    }
    Ok(false)
}
