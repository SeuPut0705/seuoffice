//! text-patch.ts: the paragraph-level surgical text patch (saving edits to
//! rich-text entries such as comments and footnotes).
//!
//! Maps the edited plain text ('\n' between paragraphs, each paragraph the
//! concatenation of its w:t) back onto the original entry XML. Paragraphs whose
//! text is unchanged keep their bytes; a changed one gets a minimal w:t
//! replacement. A changed paragraph count, a changed paragraph without a w:t to
//! anchor to, or a failed self-check answers None and the caller rebuilds the
//! entry. Texts are compared in UTF-16 code units, as the TypeScript does.

use jscompat::{js_regex, trim_start};

use crate::generate::escape_xml_text;
use crate::xml_text::decode_entities;

struct ParaSlice {
    start: usize,
    end: usize,
}

/// `paragraphSlices`: depth-aware scan, a paragraph may nest more `<w:p>` inside embedded textbox content.
fn paragraph_slices(xml: &str) -> Vec<ParaSlice> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    for found in js_regex!(r"<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>|<\/w:p>", "g").find_iter(xml) {
        let token = found.as_str();
        if token == "</w:p>" {
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
    out
}

struct TSlice {
    /// the end of the inner content within the paragraph XML
    inner_end: usize,
    /// the offset of the opening `<w:t ...>` tag
    tag_start: usize,
    text: Vec<u16>,
}

fn t_slices(para_xml: &str) -> Vec<TSlice> {
    js_regex!(r"<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>", "g")
        .find_iter(para_xml)
        .map(|found| {
            let inner = found.get(2).unwrap_or_default();
            let inner_start = found.end() - "</w:t>".len() - inner.len();
            TSlice {
                tag_start: found.start(),
                inner_end: inner_start + inner.len(),
                text: decode_entities(inner).encode_utf16().collect(),
            }
        })
        .collect()
}

fn decoded_text_of(para_xml: &str) -> Vec<u16> {
    t_slices(para_xml)
        .into_iter()
        .flat_map(|slice| slice.text)
        .collect()
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

fn para_texts(xml: &str, paras: &[ParaSlice], strip_first: bool) -> Vec<Vec<u16>> {
    paras
        .iter()
        .enumerate()
        .map(|(i, para)| {
            leading_stripped(
                decoded_text_of(&xml[para.start..para.end]),
                i == 0 && strip_first,
            )
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
) -> Option<String> {
    let paras = paragraph_slices(entry_xml);
    if paras.is_empty() {
        return None;
    }
    let new_units: Vec<u16> = new_text.encode_utf16().collect();
    let old_para_texts = para_texts(entry_xml, &paras, strip_first_para_leading_space);
    if join_lines(&old_para_texts) == new_units {
        return Some(entry_xml.to_owned());
    }
    let new_para_texts: Vec<&str> = new_text.split('\n').collect();
    if new_para_texts.len() != paras.len() {
        return None;
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
            out.push_str(&patch_one_paragraph(para_xml, &new_para, skip_leading)?);
        }
        cursor = para.end;
    }
    out.push_str(&entry_xml[cursor..]);
    // Self-check: the re-extracted text must match the target
    let check_paras = paragraph_slices(&out);
    let check = para_texts(&out, &check_paras, strip_first_para_leading_space);
    (join_lines(&check) == new_units).then_some(out)
}

/// `patchOneParagraph`
fn patch_one_paragraph(para_xml: &str, new_text: &[u16], skip_leading: bool) -> Option<String> {
    let slices = t_slices(para_xml);
    if slices.is_empty() {
        return None;
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
        return Some(para_xml.to_owned());
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
    let first = first?;

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
        let close_end = slice.inner_end + "</w:t>".len();
        out = format!(
            "{}<w:t xml:space=\"preserve\">{}</w:t>{}",
            &out[..slice.tag_start],
            new_inner[i - first],
            &out[close_end..]
        );
    }
    Some(out)
}
