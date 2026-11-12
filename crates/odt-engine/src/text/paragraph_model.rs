//! `text/paragraph-model.ts`: reads one ODF paragraph (`text:p` / `text:h`) into
//! a character model: its text exactly as the bridge shows it, the span/link
//! "frames" around every character, and the markers (bookmarks, kept inline
//! elements) anchored at character offsets.
//!
//! The same walk serves both directions. Forward it also calls registered
//! inline converters; on save it re-reads the ORIGINAL paragraph (taking
//! converter output lengths from the bridge record) to know which style each
//! original character had.
//!
//! White space follows ODF 1.2 section 6.1.2 as LibreOffice applies it: runs of
//! space/tab/CR/LF collapse to one space, leading white space of the paragraph
//! is dropped, `text:s` / `text:tab` / `text:line-break` are literal.
//!
//! Offsets: the element ranges the walk reports are byte offsets of the part
//! string; every offset into the paragraph text (`char_sets` indices, marker
//! offsets and lengths, splice offsets) counts UTF-16 code units, as the bridge
//! stores them, and a marker's `start` / `end` go through the part's
//! `IndexedText` to the `U16` the bridge holds.

use std::collections::HashMap;

use docx_engine::model::{GeneratedBlock, GeneratedBlockType, Run};
use jscompat::{JsMap, JsObject, Radix, js_regex, math_max, math_min, parse_int, slice_utf16};

use crate::core::convert::{
    BridgeMarker, BridgeMarkerKind, BridgeParagraph, InlineElement, InlineEnv, InlineOoxml,
    OdfToOoxmlContext, OdtPartInfo, marker_bookmark_name,
};
use crate::core::errors::OdtError;
use crate::core::styles::{OdtStylePart, OdtStyleTable};
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementRange, ElementVisitor, OpenVerdict, PrefixMap, XmlTokenKind,
    decode_xml_entities, read_attributes, slice, walk_elements,
};
use crate::offset::U16;

use super::props::OdfAttrs;
use super::style_xml::{as_open_tag, tag_name};

/// `Frame`: a span or hyperlink around characters. `open` / `close` are the
/// tags to write back.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Span {
        style: Option<String>,
        open: String,
        close: String,
    },
    A {
        href: String,
        style: Option<String>,
        open: String,
        close: String,
    },
}

impl Frame {
    /// `frame.open`
    pub fn open(&self) -> &str {
        match self {
            Frame::Span { open, .. } | Frame::A { open, .. } => open,
        }
    }

    /// `frame.close`
    pub fn close(&self) -> &str {
        match self {
            Frame::Span { close, .. } | Frame::A { close, .. } => close,
        }
    }

    /// `frame.style`
    pub fn style(&self) -> Option<&str> {
        match self {
            Frame::Span { style, .. } | Frame::A { style, .. } => style.as_deref(),
        }
    }

    /// `frame.kind === 'a'`
    pub fn is_link(&self) -> bool {
        matches!(self, Frame::A { .. })
    }
}

/// `FrameSet`
#[derive(Debug, Clone, PartialEq)]
pub struct FrameSet {
    pub frames: Vec<Frame>,
    pub key: String,
    /// merged own text properties of the frames' styles (outer first, inner wins)
    pub attrs: OdfAttrs,
    /// innermost hyperlink, or `None`
    pub href: Option<String>,
}

/// `ParagraphModel['element']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphElement {
    P,
    H,
}

impl ParagraphElement {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            ParagraphElement::P => "text:p",
            ParagraphElement::H => "text:h",
        }
    }
}

/// One entry of `ParagraphModel.splices`.
#[derive(Debug, Clone, PartialEq)]
pub struct Splice {
    pub offset: U16,
    pub xml: String,
    pub seq: usize,
}

/// `ParagraphModel`
#[derive(Debug, Clone)]
pub struct ParagraphModel {
    pub part: OdtStylePart,
    pub range: ElementRange,
    pub element: ParagraphElement,
    /// element name as written
    pub tag: String,
    /// start tag as written (self-closing paragraphs: rewritten as an open tag)
    pub open_tag: String,
    pub close_tag: String,
    pub style_name: Option<String>,
    pub outline_level: Option<i64>,
    pub text: String,
    /// frame set index per character, one per UTF-16 code unit (-1 for
    /// characters produced by an inline converter)
    pub char_sets: Vec<i64>,
    /// frame sets; index 0 is the empty set
    pub sets: Vec<FrameSet>,
    /// frame set for text typed into an empty paragraph (its empty span)
    pub empty_set: usize,
    pub markers: Vec<BridgeMarker>,
    /// forward: OOXML produced by inline converters, at offsets (document order)
    pub splices: Vec<Splice>,
    /// document order of markers (same numbering as `splices.seq`)
    pub marker_seq: Vec<usize>,
}

/// `ReadParagraphSource`
pub struct ReadParagraphSource<'a> {
    pub info: &'a OdtPartInfo,
    pub styles: &'a OdtStyleTable,
}

/// `ReadParagraphOptions`
#[derive(Default)]
pub struct ReadParagraphOptions<'a> {
    /// forward conversion: calls inline converters (the context and the paragraph id)
    pub forward: Option<(&'a mut OdfToOoxmlContext, usize)>,
    /// re-reading an original paragraph: lengths of converter output come from its record
    pub record: Option<&'a BridgeParagraph>,
}

/// `BOOKMARK_KINDS[name]` for an own key.
fn bookmark_kind(name: &str) -> Option<BridgeMarkerKind> {
    match name {
        "text:bookmark" => Some(BridgeMarkerKind::Bookmark),
        "text:bookmark-start" => Some(BridgeMarkerKind::BookmarkStart),
        "text:bookmark-end" => Some(BridgeMarkerKind::BookmarkEnd),
        _ => None,
    }
}

/// `isInvisibleInline`: inline elements that are never shown as text when no
/// converter takes them.
pub fn is_invisible_inline(name: &str) -> bool {
    if js_regex!(r"^(draw|dr3d|office|form|presentation|chart|table):").test(name) {
        return true;
    }
    js_regex!(r"^text:(note|soft-page-break|change|change-start|change-end|reference-mark|reference-mark-start|reference-mark-end|toc-mark|toc-mark-start|toc-mark-end|alphabetical-index-mark|alphabetical-index-mark-start|alphabetical-index-mark-end|user-index-mark|user-index-mark-start|user-index-mark-end|number|list|p|h|section)$")
        .test(name)
}

/// `isWs`
fn is_ws(c: char) -> bool {
    c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

/// `isFormFieldName`: a Hancom form field ("nurumtul") bookmark name.
pub fn is_form_field_name(name: &str) -> bool {
    js_regex!(r"^NormalField").test(name)
}

/// `attrOf`
fn attr_of(
    xml: &str,
    name_end: usize,
    open_end: usize,
    prefixes: &PrefixMap,
    name: &str,
) -> Option<String> {
    for a in read_attributes(xml, name_end, open_end) {
        if prefixes.canonical(&a.name) == name {
            return Some(decode_xml_entities(&a.raw));
        }
    }
    None
}

/// `textStyleAttrs`: own (automatic) or resolved (common) text properties of a
/// text style as seen from the scope of `src`.
pub fn text_style_attrs(src: &ReadParagraphSource<'_>, name: Option<&str>) -> OdfAttrs {
    let Some(name) = name.filter(|n| !n.is_empty()) else {
        return OdfAttrs::new();
    };
    let Some(style) = src.styles.find(name, "text", src.info.scope) else {
        return OdfAttrs::new();
    };
    if style.automatic {
        return style
            .properties
            .get("style:text-properties")
            .cloned()
            .unwrap_or_default();
    }
    src.styles
        .resolve(name, "text", src.info.scope)
        .and_then(|r| r.properties.get("style:text-properties").cloned())
        .unwrap_or_default()
}

/// `ElementFrame.data` of the walk: the TypeScript's `'frame'` and `{ atomic: true }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Frame,
    Atomic,
}

/// The state of one `readParagraph` walk: the closure variables of the TypeScript.
struct Reader<'a> {
    src: &'a ReadParagraphSource<'a>,
    xml: &'a str,
    prefixes: &'a PrefixMap,
    model: ParagraphModel,
    record: Option<&'a BridgeParagraph>,
    recorded: HashMap<U16, &'a BridgeMarker>,
    forward: Option<(&'a mut OdfToOoxmlContext, usize)>,
    set_index: HashMap<String, usize>,
    attr_cache: HashMap<String, OdfAttrs>,
    stack: Vec<Frame>,
    current: usize,
    empty_chosen: bool,
    ignore_leading: bool,
    seq: usize,
    /// the text so far, and its length in UTF-16 code units
    chars: String,
    units: u32,
    after_object: bool,
    pending_space: Option<usize>,
    error: Option<OdtError>,
}

impl Reader<'_> {
    /// `styleAttrs`
    fn style_attrs(&mut self, name: Option<&str>) -> OdfAttrs {
        let k = name.unwrap_or("").to_owned();
        if let Some(a) = self.attr_cache.get(&k) {
            return a.clone();
        }
        let attrs = text_style_attrs(self.src, name);
        self.attr_cache.insert(k, attrs.clone());
        attrs
    }

    /// `currentSet`
    fn current_set(&mut self) -> usize {
        let key = self
            .stack
            .iter()
            .map(Frame::open)
            .collect::<Vec<_>>()
            .join("\u{1}");
        if let Some(index) = self.set_index.get(&key) {
            return *index;
        }
        let mut attrs = OdfAttrs::new();
        let mut href: Option<String> = None;
        let frames = self.stack.clone();
        for f in &frames {
            attrs.assign(&self.style_attrs(f.style()));
            if let Frame::A { href: h, .. } = f {
                href = Some(h.clone());
            }
        }
        let index = self.model.sets.len();
        self.model.sets.push(FrameSet {
            frames,
            key: key.clone(),
            attrs,
            href,
        });
        self.set_index.insert(key, index);
        index
    }

    /// `flushPending`
    fn flush_pending(&mut self) {
        let Some(set) = self.pending_space.take() else {
            return;
        };
        self.chars.push(' ');
        self.units += 1;
        self.model.char_sets.push(set as i64);
    }

    /// `push`
    fn push(&mut self, text: &str, set: i64) {
        if !text.is_empty() {
            self.flush_pending();
            self.after_object = false;
        }
        for ch in text.chars() {
            self.chars.push(ch);
            for _ in 0..ch.len_utf16() {
                self.model.char_sets.push(set);
            }
            self.units += ch.len_utf16() as u32;
        }
    }

    /// `pushText`
    fn push_text(&mut self, raw: &str) {
        let mut out = String::new();
        for ch in raw.chars() {
            if is_ws(ch) {
                if !self.ignore_leading {
                    out.push(' ');
                } else if self.after_object && self.pending_space.is_none() && out.is_empty() {
                    self.pending_space = Some(self.current);
                }
                self.ignore_leading = true;
            } else {
                out.push(ch);
                self.ignore_leading = false;
            }
        }
        if !out.is_empty() {
            let current = self.current as i64;
            self.push(&out, current);
        }
    }

    /// `offset`
    fn offset(&self) -> U16 {
        U16(self.units)
    }

    /// `isCharacterObject`
    fn is_character_object(&self, el: &ElementFrame<Slot>) -> bool {
        el.name.starts_with("draw:")
            && attr_of(
                self.xml,
                el.name_end,
                el.open_end,
                self.prefixes,
                "text:anchor-type",
            )
            .as_deref()
                == Some("as-char")
    }

    /// `addMarker`: the marker's `ooxml_name` is set here.
    fn add_marker(&mut self, mut marker: BridgeMarker, with_bookmark: bool) {
        let index = self.model.markers.len();
        marker.ooxml_name = match (&self.forward, with_bookmark) {
            (Some((_, paragraph_id)), true) => Some(marker_bookmark_name(*paragraph_id, index)),
            _ => None,
        };
        self.model.markers.push(marker);
        self.model.marker_seq.push(self.seq);
        self.seq += 1;
    }

    fn u16_of(&self, byte: usize) -> U16 {
        self.src.info.xml.to_u16(byte)
    }
}

impl<'a> ElementVisitor for Reader<'a> {
    type Data = Slot;

    fn open(
        &mut self,
        el: &mut ElementFrame<Slot>,
        _parent: Option<&ElementFrame<Slot>>,
    ) -> OpenVerdict {
        if self.error.is_some() {
            return OpenVerdict::Stop;
        }
        let xml = self.xml;
        if el.name == "text:span" || el.name == "text:a" {
            let style = attr_of(
                xml,
                el.name_end,
                el.open_end,
                self.prefixes,
                "text:style-name",
            );
            let source = slice(xml, el.start, el.open_end);
            let open = if el.self_closing {
                as_open_tag(source)
            } else {
                source.to_owned()
            };
            let close = format!("</{}>", el.tag);
            let frame = if el.name == "text:a" {
                Frame::A {
                    href: attr_of(xml, el.name_end, el.open_end, self.prefixes, "xlink:href")
                        .unwrap_or_default(),
                    style,
                    open,
                    close,
                }
            } else {
                Frame::Span { style, open, close }
            };
            self.stack.push(frame);
            self.current = self.current_set();
            if !self.empty_chosen && self.chars.is_empty() && el.name == "text:span" {
                self.model.empty_set = self.current;
                self.empty_chosen = true;
            }
            if el.self_closing {
                self.stack.pop();
                self.current = self.current_set();
            } else {
                el.data = Some(Slot::Frame);
            }
            return OpenVerdict::Continue;
        }
        if el.name == "text:s" {
            let c = parse_int(
                &attr_of(xml, el.name_end, el.open_end, self.prefixes, "text:c")
                    .unwrap_or_else(|| "1".to_owned()),
                Radix::Ten,
            );
            let count = if c.is_finite() && c > 0.0 {
                math_min(c, 100_000.0) as usize
            } else {
                1
            };
            let current = self.current as i64;
            self.push(&" ".repeat(count), current);
            self.ignore_leading = false;
            return OpenVerdict::Skip;
        }
        if el.name == "text:tab" {
            let current = self.current as i64;
            self.push("\t", current);
            self.ignore_leading = false;
            return OpenVerdict::Skip;
        }
        if el.name == "text:line-break" {
            let current = self.current as i64;
            self.push("\n", current);
            self.ignore_leading = false;
            return OpenVerdict::Skip;
        }
        // everything else is atomic: handled when its extent is known (a
        // self-closing element is closed right away; a skipped one is not)
        el.data = Some(Slot::Atomic);
        if el.self_closing {
            OpenVerdict::Continue
        } else {
            OpenVerdict::Skip
        }
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<Slot>,
        _parent: Option<&ElementFrame<Slot>>,
    ) -> CloseVerdict {
        if self.error.is_some() {
            return CloseVerdict::Stop;
        }
        let xml = self.xml;
        if el.data == Some(Slot::Frame) {
            self.stack.pop();
            self.current = self.current_set();
            return CloseVerdict::Continue;
        }
        if el.data != Some(Slot::Atomic) {
            return CloseVerdict::Continue;
        }
        let range = el.range();
        let end = range.end;
        if let Some(bookmark) = bookmark_kind(&el.name) {
            let name = attr_of(xml, el.name_end, el.open_end, self.prefixes, "text:name")
                .unwrap_or_default();
            let marker = BridgeMarker {
                kind: bookmark,
                field: is_form_field_name(&name),
                name,
                offset: self.offset(),
                length: U16(0),
                start: self.u16_of(el.start),
                end: self.u16_of(end),
                pair: None,
                ooxml_name: None,
                owner: None,
            };
            self.add_marker(marker, true);
            return CloseVerdict::Continue;
        }
        let rec = self.recorded.get(&self.u16_of(el.start)).copied();
        if let (Some(record), Some(rec)) = (self.record, rec) {
            if matches!(rec.kind, BridgeMarkerKind::Handler | BridgeMarkerKind::Text) {
                let text = slice_utf16(
                    &record.text,
                    f64::from(rec.offset.0),
                    Some(f64::from(rec.offset.0) + f64::from(rec.length.0)),
                );
                let character = self.is_character_object(el);
                if !text.is_empty() || character {
                    self.flush_pending();
                }
                let at = self.offset();
                let set = if rec.kind == BridgeMarkerKind::Handler {
                    -1
                } else {
                    self.current as i64
                };
                self.push(&text, set);
                if !text.is_empty() {
                    self.ignore_leading = false;
                } else if character {
                    self.after_object = true;
                }
                let mut marker = rec.clone();
                marker.offset = at;
                marker.pair = None;
                self.add_marker(marker, false);
                return CloseVerdict::Continue;
            }
        }
        if self.forward.is_some() {
            let part = self.src.info.part;
            let (registry, paragraph_id) = {
                let (ctx, id) = self.forward.as_ref().expect("forward set");
                (ctx.registry.clone(), *id)
            };
            for converter in registry.inline_for(&el.name) {
                let inline = InlineElement {
                    start: range.start,
                    open_end: range.open_end,
                    close_start: range.close_start,
                    end,
                    self_closing: range.self_closing,
                    name: el.name.clone(),
                    tag: el.tag.clone(),
                    name_end: el.name_end,
                    part,
                    xml: self.src.info.xml.clone(),
                };
                let env = InlineEnv {
                    paragraph_id,
                    offset: self.offset(),
                };
                let result = {
                    let (ctx, _) = self.forward.as_mut().expect("forward set");
                    converter.to_ooxml(ctx, &inline, &env)
                };
                let result = match result {
                    Ok(result) => result,
                    Err(error) => {
                        self.error = Some(error);
                        return CloseVerdict::Stop;
                    }
                };
                let produced: (String, String) = match result {
                    None | Some(InlineOoxml::Keep) => continue,
                    Some(InlineOoxml::Xml { xml, text }) => (xml, text),
                    Some(InlineOoxml::Runs { runs }) => {
                        let text: String = runs
                            .iter()
                            .map(|r| r.text.as_deref().unwrap_or(""))
                            .collect();
                        let rendered = {
                            let (ctx, _) = self.forward.as_mut().expect("forward set");
                            runs_xml(ctx, &runs)
                        };
                        match rendered {
                            Ok(xml) => (xml, text),
                            Err(error) => {
                                self.error = Some(error);
                                return CloseVerdict::Stop;
                            }
                        }
                    }
                };
                let character = self.is_character_object(el);
                if !produced.1.is_empty() || character {
                    self.flush_pending();
                }
                let at = self.offset();
                let seq = self.seq;
                self.model.splices.push(Splice {
                    offset: at,
                    xml: produced.0,
                    seq,
                });
                self.push(&produced.1, -1);
                if !produced.1.is_empty() {
                    self.ignore_leading = false;
                } else if character {
                    self.after_object = true;
                }
                let length = U16(produced.1.encode_utf16().count() as u32);
                let marker = BridgeMarker {
                    kind: BridgeMarkerKind::Handler,
                    name: el.name.clone(),
                    offset: at,
                    length,
                    start: self.u16_of(el.start),
                    end: self.u16_of(end),
                    pair: None,
                    field: false,
                    ooxml_name: None,
                    owner: Some(converter.id().to_owned()),
                };
                self.add_marker(marker, false);
                return CloseVerdict::Continue;
            }
        }
        if !is_invisible_inline(&el.name) {
            let mut ignore_leading = self.ignore_leading;
            let text = visible_text(
                xml,
                self.prefixes,
                range.open_end,
                range.close_start,
                &mut ignore_leading,
                range.self_closing,
            );
            if !text.is_empty() {
                self.flush_pending();
                let at = self.offset();
                let current = self.current as i64;
                self.push(&text, current);
                self.ignore_leading = ignore_leading;
                let marker = BridgeMarker {
                    kind: BridgeMarkerKind::Text,
                    name: el.name.clone(),
                    offset: at,
                    length: U16(text.encode_utf16().count() as u32),
                    start: self.u16_of(el.start),
                    end: self.u16_of(end),
                    pair: None,
                    field: false,
                    ooxml_name: None,
                    owner: None,
                };
                self.add_marker(marker, false);
                return CloseVerdict::Continue;
            }
        }
        if self.is_character_object(el) {
            self.flush_pending();
            self.after_object = true;
        }
        let marker = BridgeMarker {
            kind: BridgeMarkerKind::Keep,
            name: el.name.clone(),
            offset: self.offset(),
            length: U16(0),
            start: self.u16_of(el.start),
            end: self.u16_of(end),
            pair: None,
            field: false,
            ooxml_name: None,
            owner: None,
        };
        self.add_marker(marker, true);
        CloseVerdict::Continue
    }

    fn other(
        &mut self,
        kind: XmlTokenKind,
        start: usize,
        end: usize,
        _parent: Option<&ElementFrame<Slot>>,
    ) {
        let xml = self.xml;
        if kind == XmlTokenKind::Text {
            self.push_text(&decode_xml_entities(slice(xml, start, end)));
        } else if kind == XmlTokenKind::Cdata {
            self.push_text(slice(
                xml,
                start + 9,
                math_max(start as f64 + 9.0, end as f64 - 3.0) as usize,
            ));
        }
    }
}

/// `readParagraph`
pub fn read_paragraph(
    src: &ReadParagraphSource<'_>,
    range: ElementRange,
    options: ReadParagraphOptions<'_>,
) -> Result<ParagraphModel, OdtError> {
    let info = src.info;
    let xml: &str = &info.xml.text;
    let prefixes: &PrefixMap = &info.prefixes;
    let head = slice(xml, range.start, range.open_end);
    let tag = tag_name(head).unwrap_or("text:p").to_owned();
    let canonical = prefixes.canonical(&tag).into_owned();
    let element = if canonical == "text:h" {
        ParagraphElement::H
    } else {
        ParagraphElement::P
    };
    let name_end = range.start + 1 + tag.len();
    let style_name = attr_of(xml, name_end, range.open_end, prefixes, "text:style-name");
    let level_raw = attr_of(
        xml,
        name_end,
        range.open_end,
        prefixes,
        "text:outline-level",
    );
    let outline_level = if element == ParagraphElement::H {
        let parsed = parse_int(level_raw.as_deref().unwrap_or("1"), Radix::Ten);
        // `parseInt(...) || 1`
        let parsed = if parsed.is_nan() || parsed == 0.0 {
            1.0
        } else {
            parsed
        };
        Some(math_min(10.0, math_max(1.0, parsed)) as i64)
    } else {
        None
    };
    let open_tag = if range.self_closing {
        as_open_tag(head)
    } else {
        head.to_owned()
    };

    let model = ParagraphModel {
        part: info.part,
        range,
        element,
        close_tag: format!("</{tag}>"),
        tag,
        open_tag,
        style_name,
        outline_level,
        text: String::new(),
        char_sets: Vec::new(),
        sets: vec![FrameSet {
            frames: Vec::new(),
            key: String::new(),
            attrs: JsObject::new(),
            href: None,
        }],
        empty_set: 0,
        markers: Vec::new(),
        splices: Vec::new(),
        marker_seq: Vec::new(),
    };
    if range.self_closing {
        return Ok(model);
    }

    let ReadParagraphOptions { forward, record } = options;
    let mut recorded: HashMap<U16, &BridgeMarker> = HashMap::new();
    if let Some(record) = record {
        for m in &record.markers {
            recorded.insert(m.start, m);
        }
    }
    let mut set_index = HashMap::new();
    set_index.insert(String::new(), 0usize);
    let mut reader = Reader {
        src,
        xml,
        prefixes,
        model,
        record,
        recorded,
        forward,
        set_index,
        attr_cache: HashMap::new(),
        stack: Vec::new(),
        current: 0,
        empty_chosen: false,
        ignore_leading: true,
        seq: 0,
        chars: String::new(),
        units: 0,
        after_object: false,
        pending_space: None,
        error: None,
    };
    walk_elements(
        xml,
        prefixes,
        &mut reader,
        range.open_end,
        range.close_start,
    );
    if let Some(error) = reader.error.take() {
        return Err(error);
    }
    let mut model = reader.model;
    model.text = reader.chars;
    pair_markers(&mut model.markers);
    Ok(model)
}

/// `pairMarkers`: pairs bookmark starts and ends of one paragraph by name
/// (nearest open start).
pub fn pair_markers(markers: &mut [BridgeMarker]) {
    let mut open: JsMap<Vec<usize>> = JsMap::new();
    for i in 0..markers.len() {
        markers[i].pair = None;
        if markers[i].kind == BridgeMarkerKind::BookmarkStart {
            let name = markers[i].name.clone();
            match open.get_mut(&name) {
                Some(list) => list.push(i),
                None => open.set(name, vec![i]),
            }
        } else if markers[i].kind == BridgeMarkerKind::BookmarkEnd {
            let start = open.get_mut(&markers[i].name).and_then(Vec::pop);
            if let Some(start) = start {
                markers[start].pair = Some(i);
                markers[i].pair = Some(start);
            }
        }
    }
}

/// The visitor of `visibleText`.
struct Visible<'a> {
    xml: &'a str,
    prefixes: &'a PrefixMap,
    out: String,
    ignore_leading: &'a mut bool,
}

impl ElementVisitor for Visible<'_> {
    type Data = ();

    fn open(
        &mut self,
        el: &mut ElementFrame<()>,
        _parent: Option<&ElementFrame<()>>,
    ) -> OpenVerdict {
        if el.name == "text:s" {
            let c = parse_int(
                &attr_of(self.xml, el.name_end, el.open_end, self.prefixes, "text:c")
                    .unwrap_or_else(|| "1".to_owned()),
                Radix::Ten,
            );
            let count = if c.is_finite() && c > 0.0 {
                math_min(c, 100_000.0) as usize
            } else {
                1
            };
            self.out.push_str(&" ".repeat(count));
            *self.ignore_leading = false;
            return OpenVerdict::Skip;
        }
        if el.name == "text:tab" || el.name == "text:line-break" {
            self.out
                .push(if el.name == "text:tab" { '\t' } else { '\n' });
            *self.ignore_leading = false;
            return OpenVerdict::Skip;
        }
        if is_invisible_inline(&el.name) || bookmark_kind(&el.name).is_some() {
            return OpenVerdict::Skip;
        }
        OpenVerdict::Continue
    }

    fn other(
        &mut self,
        kind: XmlTokenKind,
        start: usize,
        end: usize,
        _parent: Option<&ElementFrame<()>>,
    ) {
        if kind != XmlTokenKind::Text {
            return;
        }
        for ch in decode_xml_entities(slice(self.xml, start, end)).chars() {
            if is_ws(ch) {
                if !*self.ignore_leading {
                    self.out.push(' ');
                }
                *self.ignore_leading = true;
            } else {
                self.out.push(ch);
                *self.ignore_leading = false;
            }
        }
    }
}

/// `visibleText`: visible text inside an inline element (fields and the like),
/// with paragraph white-space rules.
fn visible_text(
    xml: &str,
    prefixes: &PrefixMap,
    from: usize,
    to: usize,
    ignore_leading: &mut bool,
    self_closing: bool,
) -> String {
    if self_closing || from >= to {
        return String::new();
    }
    let mut visitor = Visible {
        xml,
        prefixes,
        out: String::new(),
        ignore_leading,
    };
    walk_elements(xml, prefixes, &mut visitor, from, to);
    visitor.out
}

/// `GeneratedBlock` of a plain paragraph holding `runs`, with no other key.
pub(super) fn paragraph_block(runs: Vec<Run>) -> GeneratedBlock {
    GeneratedBlock {
        r#type: GeneratedBlockType::Paragraph,
        level: None,
        outline_only: None,
        style_id: None,
        list: None,
        format: None,
        raw_p_pr: None,
        bookmarks: None,
        hidden_bookmarks: None,
        comment_starts: None,
        comment_ends: None,
        runs,
        sdt_shell: None,
        p_pr_change: None,
        para_mark_del: None,
        para_mark_ins: None,
        para_mark_r_pr_change: None,
        numbering_change: None,
        sect_pr_change: None,
        block_revision: None,
    }
}

/// `runsXml`: OOXML of engine runs (no paragraph wrapper), written by the docx
/// engine's generator.
pub fn runs_xml(ctx: &mut OdfToOoxmlContext, runs: &[Run]) -> Result<String, OdtError> {
    if runs.is_empty() {
        return Ok(String::new());
    }
    let xml = ctx.generate_paragraph_xml(&paragraph_block(runs.to_vec()))?;
    Ok(slice_utf16(
        &xml,
        "<w:p>".len() as f64,
        Some(xml.encode_utf16().count() as f64 - "</w:p>".len() as f64),
    ))
}
