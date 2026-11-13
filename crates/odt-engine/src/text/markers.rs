//! `text/markers.ts`: places the markers (bookmarks, form fields, kept inline
//! elements) of one or more original paragraphs onto one or more edited
//! paragraphs.
//!
//! The editor splits paragraphs (Enter) and joins them (Backspace), so the
//! text a marker belongs to may end up in another paragraph than the one that
//! carries the original's identity. The originals are therefore treated as
//! one text, the edited paragraphs as another; markers are mapped across that
//! text and land in whichever edited paragraph holds their mapped offset. A
//! bookmark pair never spans paragraphs: when its text was split, the pair
//! stays in the paragraph holding most of it (a warning says so).
//!
//! Every offset here counts UTF-16 code units of the paragraph texts (`U16`).

use std::rc::Rc;

use crate::core::convert::{
    Attach, BridgeMarker, BridgeMarkerKind, BridgeParagraph, OoxmlToOdfContext,
};
use crate::core::styles::OdtStylePart;
use crate::core::xml::slice;
use crate::offset::{IndexedText, U16, u16_len};

use super::align::{Bias, align_texts};

/// `Placement`: a marker's original XML, placed at an offset of one edited paragraph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub offset: U16,
    pub xml: String,
    /// `Next`: sits in the spans of the text after it; `Prev`: of the text before it
    pub attach: Attach,
    /// document order among placements at the same offset
    pub seq: usize,
    /// characters of the edited text the XML replaces (an intact text field)
    pub replaces: Option<U16>,
}

/// `SequencePlacements`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequencePlacements {
    /// placements per edited paragraph
    pub placements: Vec<Vec<Placement>>,
}

/// `placeMarkers` over the part strings and a warning list instead of the
/// context: `part_xml` answers the decoded part a paragraph's offsets index.
/// Returns the placements and the warnings in the order `rctx.warn` was called.
pub fn place_markers_in(
    part_xml: &dyn Fn(OdtStylePart) -> Rc<IndexedText>,
    originals: &[&BridgeParagraph],
    edited: &[String],
) -> (SequencePlacements, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let mut bases: Vec<usize> = Vec::new();
    let mut original = String::new();
    let mut original_len = 0usize;
    for p in originals {
        bases.push(original_len);
        original.push_str(&p.text);
        original_len += u16_len(&p.text).0 as usize;
    }
    let mut starts: Vec<usize> = Vec::new();
    let mut text = String::new();
    let mut text_len = 0usize;
    for t in edited {
        starts.push(text_len);
        text.push_str(t);
        text_len += u16_len(t).0 as usize;
    }
    let ends: Vec<usize> = edited
        .iter()
        .enumerate()
        .map(|(i, t)| starts[i] + u16_len(t).0 as usize)
        .collect();
    let align = align_texts(&original, &text);
    let mut out: Vec<Vec<Placement>> = edited.iter().map(|_| Vec::new()).collect();

    let last = edited.len() as i64 - 1;
    // the paragraph for an offset that starts something (the later one at a boundary)
    let start_piece = |off: usize| -> usize {
        let mut k = last;
        while k >= 0 {
            if starts[k as usize] <= off {
                return k as usize;
            }
            k -= 1;
        }
        0
    };
    // the paragraph for an offset that ends something (the earlier one at a boundary)
    let end_piece = |off: usize| -> usize {
        let mut k = 0i64;
        while k <= last {
            let ku = k as usize;
            if starts[ku] < off && off <= ends[ku] {
                return ku;
            }
            k += 1;
        }
        start_piece(off)
    };
    let put = |out: &mut Vec<Vec<Placement>>,
               piece: usize,
               offset: usize,
               xml: String,
               attach: Attach,
               seq: usize,
               replaces: Option<usize>| {
        out[piece].push(Placement {
            offset: U16((offset as i64 - starts[piece] as i64) as u32),
            xml,
            attach,
            seq,
            replaces: replaces.filter(|r| *r != 0).map(|r| U16(r as u32)),
        });
    };

    for (pi, p) in originals.iter().enumerate() {
        let xml = part_xml(p.part);
        let source = |m: &BridgeMarker| -> String {
            slice(&xml.text, xml.to_byte(m.start), xml.to_byte(m.end)).to_owned()
        };
        let base = bases[pi];
        let seq_of = |i: usize| pi * 1_000_000 + i;
        for (i, m) in p.markers.iter().enumerate() {
            let at = |offset: U16, bias: Bias| {
                align.map(U16((base + offset.0 as usize) as u32), bias).0 as usize
            };
            match m.kind {
                BridgeMarkerKind::BookmarkStart => {
                    let Some(pair) = m.pair else {
                        let a = at(m.offset, Bias::Start);
                        put(
                            &mut out,
                            start_piece(a),
                            a,
                            source(m),
                            Attach::Next,
                            seq_of(i),
                            None,
                        );
                        continue;
                    };
                    let end = &p.markers[pair];
                    let mut a = at(m.offset, Bias::Start);
                    let mut b = a.max(at(end.offset, Bias::End));
                    let mut pa = start_piece(a);
                    let pb = if b > a { end_piece(b) } else { pa };
                    if pa != pb {
                        // never a pair across paragraphs: keep it where most of its text is
                        let in_a = ends[pa] as i64 - a as i64;
                        let in_b = b as i64 - starts[pb] as i64;
                        if in_a >= in_b {
                            b = ends[pa];
                        } else {
                            a = starts[pb];
                            pa = pb;
                        }
                        warnings.push(format!(
                            "bookmark \"{}\" was split by a new paragraph; kept with most of its text",
                            m.name
                        ));
                    }
                    put(&mut out, pa, a, source(m), Attach::Next, seq_of(i), None);
                    put(
                        &mut out,
                        pa,
                        b,
                        source(end),
                        Attach::Prev,
                        seq_of(pair),
                        None,
                    );
                }
                BridgeMarkerKind::BookmarkEnd => {
                    if m.pair.is_some() {
                        continue;
                    }
                    let b = at(m.offset, Bias::End);
                    put(
                        &mut out,
                        end_piece(b),
                        b,
                        source(m),
                        Attach::Prev,
                        seq_of(i),
                        None,
                    );
                }
                BridgeMarkerKind::Bookmark | BridgeMarkerKind::Keep => {
                    let a = at(m.offset, Bias::Start);
                    put(
                        &mut out,
                        start_piece(a),
                        a,
                        source(m),
                        Attach::Next,
                        seq_of(i),
                        None,
                    );
                }
                BridgeMarkerKind::Text => {
                    let a = at(m.offset, Bias::Start);
                    let piece = start_piece(a);
                    let from = U16((base + m.offset.0 as usize) as u32);
                    if align.intact(from, m.length) && a + m.length.0 as usize <= ends[piece] {
                        put(
                            &mut out,
                            piece,
                            a,
                            source(m),
                            Attach::Next,
                            seq_of(i),
                            Some(m.length.0 as usize),
                        );
                    } else {
                        warnings.push(format!("an edited {} became plain text", m.name));
                    }
                }
                // 'handler' markers belong to their converters (run writers, injectors)
                BridgeMarkerKind::Handler => {}
            }
        }
    }
    (SequencePlacements { placements: out }, warnings)
}

/// `placeMarkers`: maps the markers of `originals` (consecutive, in order) onto
/// the edited texts `edited` (consecutive, in order).
pub fn place_markers(
    rctx: &mut OoxmlToOdfContext,
    originals: &[&BridgeParagraph],
    edited: &[String],
) -> SequencePlacements {
    let content = rctx.part(OdtStylePart::ContentXml);
    let styles = rctx.part(OdtStylePart::StylesXml);
    let (placed, warnings) = place_markers_in(
        &|part| match part {
            OdtStylePart::ContentXml => Rc::clone(&content.xml),
            OdtStylePart::StylesXml => Rc::clone(&styles.xml),
        },
        originals,
        edited,
    );
    for message in &warnings {
        rctx.warn(message);
    }
    placed
}

/// `keptCharacters`: how many characters of each original survive in the edited texts.
pub fn kept_characters(originals: &[&BridgeParagraph], edited: &[String]) -> Vec<usize> {
    let original: String = originals.iter().map(|p| p.text.as_str()).collect();
    let align = align_texts(&original, &edited.concat());
    let mut base = 0usize;
    originals
        .iter()
        .map(|p| {
            let len = u16_len(&p.text).0 as usize;
            let mut n = 0usize;
            for k in 0..len {
                if align.intact(U16((base + k) as u32), U16(1)) {
                    n += 1;
                }
            }
            base += len;
            n
        })
        .collect()
}
