//! text-patch.ts: the paragraph-level surgical text patch (saving edits to
//! rich-text entries such as comments and footnotes).
//!
//! Maps the edited plain text ('\n' between paragraphs, each paragraph the
//! concatenation of its w:t) back onto the original entry XML. Paragraphs whose
//! text is unchanged keep their bytes; a changed one gets a minimal w:t
//! replacement. A changed paragraph count, a changed paragraph without a w:t to
//! anchor to, a change across a run hidden from AI and one that is not, or a
//! failed self-check answers None and the caller rebuilds the entry. Texts are
//! compared in UTF-16 code units, as the TypeScript does. Tags are found in the
//! XML with its comments, CDATA sections and processing instructions blanked
//! (`mask_opaque`), and the bytes are those of the original.

use jscompat::{RegexLimit, js_regex, trim_start, try_js_regex};
use ooxml_xml::mask_opaque;

use crate::generate::escape_xml_text;
use crate::withheld::has_withheld_trace;
use crate::xml_text::decode_entities;

// The patterns below are the TypeScript's `tagPattern(name)` for w:p, w:r and
// w:t, and `RUN_RPR`: a tag's attributes are `(?:[^>"']|"[^"]*"|'[^']*')*`,
// quoted values free to hold `>` and `/>`.

struct ParaSlice {
    start: usize,
    end: usize,
}

/// `paragraphSlices`: depth-aware scan, a paragraph may nest more `<w:p>` inside embedded textbox content.
fn paragraph_slices(xml: &str) -> Result<Vec<ParaSlice>, RegexLimit> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    // tags are found where comments and CDATA cannot fake one
    let masked = mask_opaque(xml);
    for found in try_js_regex!(
        r#"<w:p(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>|<\/w:p\s*>"#,
        "g"
    )
    .try_find_iter(&masked)
    {
        let found = found?;
        let token = found.as_str();
        if token.starts_with("</") {
            if depth == 0 {
                continue;
            }
            depth -= 1;
            if depth == 0
                && let Some(open) = start.take()
            {
                out.push(ParaSlice {
                    start: open,
                    end: found.end(),
                });
            }
        } else if token.ends_with("/>") {
            if depth == 0 {
                out.push(ParaSlice {
                    start: found.start(),
                    end: found.end(),
                });
            }
        } else {
            if depth == 0 {
                start = Some(found.start());
            }
            depth += 1;
        }
    }
    Ok(out)
}

struct TSlice {
    /// the offset of the opening `<w:t ...>` tag
    tag_start: usize,
    /// the offset just past the closing `</w:t>`
    close_end: usize,
    text: Vec<u16>,
}

fn t_slices(para_xml: &str) -> Result<Vec<TSlice>, RegexLimit> {
    let mut out = Vec::new();
    // a w:t is found where a CDATA section or a comment cannot fake its end tag
    let masked = mask_opaque(para_xml);
    // the start and end of the open tag
    let mut open: Option<(usize, usize)> = None;
    for found in try_js_regex!(
        r#"<w:t(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>|<\/w:t\s*>"#,
        "g"
    )
    .try_find_iter(&masked)
    {
        let found = found?;
        let token = found.as_str();
        if token.starts_with("</") {
            let Some((open_start, open_end)) = open.take() else {
                continue;
            };
            out.push(TSlice {
                tag_start: open_start,
                close_end: found.end(),
                text: wt_text(&para_xml[open_end..found.start()])
                    .encode_utf16()
                    .collect(),
            });
        } else if !token.ends_with("/>") {
            open = Some((found.start(), found.end()));
        }
    }
    Ok(out)
}

/// `wtText`: a w:t's text as the parser reads it: CDATA as written, comments dropped, entities decoded.
fn wt_text(inner: &str) -> String {
    let mut text = String::new();
    let mut at = 0;
    for found in js_regex!(r"<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->", "g").find_iter(inner) {
        text.push_str(&decode_entities(&inner[at..found.start()]));
        text.push_str(found.get(1).unwrap_or(""));
        at = found.end();
    }
    text.push_str(&decode_entities(&inner[at..]));
    text
}

fn decoded_text_of(para_xml: &str) -> Result<Vec<u16>, RegexLimit> {
    Ok(t_slices(para_xml)?
        .into_iter()
        .flat_map(|slice| slice.text)
        .collect())
}

/// The text with its leading white space dropped when `strip`, else as it is.
fn leading_stripped(text: Vec<u16>, strip: bool) -> Vec<u16> {
    if !strip {
        return text;
    }
    let as_text = String::from_utf16_lossy(&text);
    // a lone surrogate cannot reach here: the text came from a Rust string
    trim_start(&as_text).encode_utf16().collect()
}

fn para_texts(
    xml: &str,
    paras: &[ParaSlice],
    strip_first: bool,
) -> Result<Vec<Vec<u16>>, RegexLimit> {
    paras
        .iter()
        .enumerate()
        .map(|(i, para)| {
            Ok(leading_stripped(
                decoded_text_of(&xml[para.start..para.end])?,
                i == 0 && strip_first,
            ))
        })
        .collect()
}

fn join_lines(texts: &[Vec<u16>]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, text) in texts.iter().enumerate() {
        if i > 0 {
            out.push(u16::from(b'\n'));
        }
        out.extend_from_slice(text);
    }
    out
}

/// `patchParagraphTexts`
pub fn patch_paragraph_texts(
    entry_xml: &str,
    new_text: &str,
    strip_first_para_leading_space: bool,
) -> Result<Option<String>, RegexLimit> {
    let paras = paragraph_slices(entry_xml)?;
    if paras.is_empty() {
        return Ok(None);
    }
    let new_units: Vec<u16> = new_text.encode_utf16().collect();
    let old_para_texts = para_texts(entry_xml, &paras, strip_first_para_leading_space)?;
    if join_lines(&old_para_texts) == new_units {
        return Ok(Some(entry_xml.to_owned()));
    }
    let new_para_texts: Vec<&str> = new_text.split('\n').collect();
    if new_para_texts.len() != paras.len() {
        return Ok(None);
    }
    let mut out = String::new();
    let mut cursor = 0;
    for (i, para) in paras.iter().enumerate() {
        out.push_str(&entry_xml[cursor..para.start]);
        let new_para: Vec<u16> = new_para_texts[i].encode_utf16().collect();
        let para_xml = &entry_xml[para.start..para.end];
        if old_para_texts[i] == new_para {
            out.push_str(para_xml);
        } else {
            let skip_leading = i == 0 && strip_first_para_leading_space;
            let Some(patched) = patch_one_paragraph(para_xml, &new_para, skip_leading)? else {
                return Ok(None);
            };
            out.push_str(&patched);
        }
        cursor = para.end;
    }
    out.push_str(&entry_xml[cursor..]);
    // Self-check: the re-extracted text must match the target
    let check_paras = paragraph_slices(&out)?;
    let check = para_texts(&out, &check_paras, strip_first_para_leading_space)?;
    Ok((join_lines(&check) == new_units).then_some(out))
}

/// `patchOneParagraph`
fn patch_one_paragraph(
    para_xml: &str,
    new_text: &[u16],
    skip_leading: bool,
) -> Result<Option<String>, RegexLimit> {
    let slices = t_slices(para_xml)?;
    if slices.is_empty() {
        return Ok(None);
    }
    let raw: Vec<u16> = slices
        .iter()
        .flat_map(|slice| slice.text.iter().copied())
        .collect();
    // the first paragraph's leading white space is an immutable prefix
    let lead = if skip_leading {
        raw.len() - leading_stripped(raw.clone(), true).len()
    } else {
        0
    };
    let old_text = &raw[lead..];
    if old_text == new_text {
        return Ok(Some(para_xml.to_owned()));
    }
    let max_common = old_text.len().min(new_text.len());
    let mut prefix = 0;
    while prefix < max_common && old_text[prefix] == new_text[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < max_common - prefix
        && old_text[old_text.len() - 1 - suffix] == new_text[new_text.len() - 1 - suffix]
    {
        suffix += 1;
    }
    // the changed range, relative to the full raw text
    let change_start = lead + prefix;
    let change_end = lead + old_text.len() - suffix;
    let replacement = &new_text[prefix..new_text.len() - suffix];

    // the w:t intersecting the changed range; a pure insertion takes the slice covering its point
    let mut acc = 0usize;
    let mut first: Option<usize> = None;
    let mut last = 0usize;
    let mut bounds: Vec<(usize, usize)> = Vec::new();
    for (i, slice) in slices.iter().enumerate() {
        let start = acc;
        let end = acc + slice.text.len();
        bounds.push((start, end));
        let touches = if change_start == change_end {
            start <= change_start && change_start <= end
        } else {
            start < change_end && end > change_start
        };
        if touches {
            if first.is_none() {
                first = Some(i);
            }
            last = i;
        }
        acc = end;
    }
    // no anchor: the insertion point falls outside every w:t
    let Some(first) = first else {
        return Ok(None);
    };

    // A change that spans a run hidden from AI and a run that is not would move
    // hidden words into the plain run (or plain words under the mark): no patch.
    if first < last {
        let masked = mask_opaque(para_xml);
        let hidden_first = slice_hidden(&masked, slices[first].tag_start)?;
        for slice in &slices[first + 1..=last] {
            if slice_hidden(&masked, slice.tag_start)? != hidden_first {
                return Ok(None);
            }
        }
    }

    // the first takes the prefix remainder, the replacement and the last one's suffix remainder; the rest are emptied
    let mut new_inner: Vec<String> = Vec::new();
    for i in first..=last {
        if i == first {
            let head = &slices[i].text;
            let tail = &slices[last].text;
            let mut joined: Vec<u16> =
                head[..change_start.saturating_sub(bounds[i].0).min(head.len())].to_vec();
            joined.extend_from_slice(replacement);
            joined.extend_from_slice(
                &tail[change_end.saturating_sub(bounds[last].0).min(tail.len())..],
            );
            new_inner.push(escape_xml_text(&String::from_utf16_lossy(&joined)));
        } else {
            new_inner.push(String::new());
        }
    }

    // replace back to front so offsets stay valid; the changed w:t all get xml:space="preserve"
    let mut out = para_xml.to_owned();
    for i in (first..=last).rev() {
        let slice = &slices[i];
        out = format!(
            "{}<w:t xml:space=\"preserve\">{}</w:t>{}",
            &out[..slice.tag_start],
            new_inner[i - first],
            &out[slice.close_end..]
        );
    }
    Ok(Some(out))
}

/// `sliceHidden`: whether the w:t at `tag_start` sits in a run hidden from AI:
/// its own run or any run around it (a text box inside a hidden run) whose
/// properties carry the mark, as `withheldNode` reads it.
fn slice_hidden(masked_para: &str, tag_start: usize) -> Result<bool, RegexLimit> {
    let before = &masked_para[..tag_start];
    let mut open: Vec<usize> = Vec::new();
    for found in try_js_regex!(
        r#"<w:r(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>|<\/w:r\s*>"#,
        "g"
    )
    .try_find_iter(before)
    {
        let found = found?;
        if found.as_str().starts_with("</") {
            open.pop();
        } else if !found.as_str().ends_with("/>") {
            open.push(found.start());
        }
    }
    for start in open {
        let run_rpr = try_js_regex!(
            r#"^<w:r(?:[^>"']|"[^"]*"|'[^']*')*>\s*(<w:rPr(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*\/>|<w:rPr(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/w:rPr\s*>)?"#
        )
        .try_exec(&masked_para[start..tag_start])?
        .and_then(|found| found.get(1));
        if run_rpr.is_some_and(has_withheld_trace) {
            return Ok(true);
        }
    }
    Ok(false)
}
