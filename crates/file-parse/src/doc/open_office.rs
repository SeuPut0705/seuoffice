//! `open-office-extractor.js` of word-extractor 1.0.4: what `extract` does
//! with a buffer that starts like a zip. The parts are read in the order
//! the extractor reads them, each through a saxes parser fed 4,096 bytes at a
//! time as `readStream.read(0x1000)` hands them out.
//!
//! `this._context` and `this._pieces` are fields of the extractor, so they
//! outlive a part, and a handler that throws makes the parser fail with the
//! message (`parser.fail(e.message)`): every `TypeError` of a missing context
//! is reproduced with its text.

use super::word::Text;
use super::zip::ZipFile;
use crate::compound_gate::Thrown;
use saxes::{Attribute, Handler, HandlerResult, Options, Parser, Tag, units};
use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::rc::Rc;

type Pieces = Rc<RefCell<Vec<Text>>>;

/// A value of `this._context` or `this._pieces`.
#[derive(Clone)]
enum Item {
    Undefined,
    Str(String),
    Pieces(Pieces),
}

impl Item {
    fn is(&self, name: &str) -> bool {
        matches!(self, Item::Str(text) if text == name)
    }
}

/// `this._context`.
enum Context {
    Undefined,
    Null,
    Array(VecDeque<Item>),
}

const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

const STREAM_TYPES: [&str; 8] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
    "application/vnd.openxmlformats-package.relationships+xml",
];

/// `this._streamTypes[key]` is truthy.
fn stream_type(key: &str) -> bool {
    STREAM_TYPES.contains(&key) || OBJECT_PROTOTYPE.contains(&key)
}

fn type_error(message: String) -> Thrown {
    Thrown::Type(message)
}

fn reading(base: &str, property: &str) -> Thrown {
    type_error(format!(
        "Cannot read properties of {base} (reading '{property}')"
    ))
}

/// `path.posix.extname(filename).replace(/^\./, '')`.
fn extension(path: &str) -> String {
    let units: Vec<char> = path.chars().collect();
    let (mut start_dot, mut start_part, mut end): (i64, i64, i64) = (-1, 0, -1);
    let mut matched_slash = true;
    let mut pre_dot_state = 0_i32;
    let mut i = units.len() as i64 - 1;
    while i >= 0 {
        let code = units[i as usize];
        if code == '/' {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            i -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        if code == '.' {
            if start_dot == -1 {
                start_dot = i;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        i -= 1;
    }
    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return String::new();
    }
    let ext: String = units[start_dot as usize..end as usize].iter().collect();
    ext.strip_prefix('.').unwrap_or(&ext).to_owned()
}

/// The extractor's own state.
struct Extractor {
    actions: HashSet<String>,
    /// An action set under the name `__proto__` became the prototype.
    proto_action: bool,
    defaults: Vec<(String, Option<String>)>,
    context: Context,
    pieces: Item,
    body: Text,
    textboxes: Text,
    /// The first `error` event.
    rejected: Option<saxes::Error>,
}

fn name_is(name: &[u16], text: &str) -> bool {
    name.len() == text.len() && name.iter().copied().eq(text.encode_utf16())
}

fn lossy(text: &[u16]) -> String {
    String::from_utf16_lossy(text)
}

/// `node.attributes[name]`: the last attribute of that name.
fn attribute<'t>(tag: &'t Tag, name: &str) -> Option<&'t Attribute> {
    tag.attributes
        .iter()
        .rev()
        .find(|attribute| name_is(&attribute.name, name))
}

impl Extractor {
    fn new() -> Self {
        Self {
            actions: HashSet::from(["[Content_Types].xml".to_owned()]),
            proto_action: false,
            defaults: Vec::new(),
            context: Context::Undefined,
            pieces: Item::Undefined,
            body: Vec::new(),
            textboxes: Vec::new(),
            rejected: None,
        }
    }

    /// `shouldProcess(filename)`.
    fn should_process(&self, filename: &str) -> bool {
        if self.actions.contains(filename)
            || OBJECT_PROTOTYPE.contains(&filename)
            || (self.proto_action && (filename == "action" || filename == "type"))
        {
            return true;
        }
        let extension = extension(filename);
        if extension.is_empty() {
            return false;
        }
        let default = self
            .defaults
            .iter()
            .rev()
            .find(|(key, _)| *key == extension)
            .and_then(|(_, value)| value.as_deref());
        // an inherited name gives a function or an object, never a content type
        default.is_some_and(|default| !default.is_empty() && stream_type(default))
    }

    fn context_array(&mut self, property: &str) -> Result<&mut VecDeque<Item>, Thrown> {
        match &mut self.context {
            Context::Array(array) => Ok(array),
            Context::Undefined => Err(reading("undefined", property)),
            Context::Null => Err(reading("null", property)),
        }
    }

    /// `this._context[0]`.
    fn first(&self) -> Result<Item, Thrown> {
        match &self.context {
            Context::Array(array) => Ok(array.front().cloned().unwrap_or(Item::Undefined)),
            Context::Undefined => Err(reading("undefined", "0")),
            Context::Null => Err(reading("null", "0")),
        }
    }

    fn pieces_array(&self, method: &str) -> Result<Pieces, Thrown> {
        match &self.pieces {
            Item::Pieces(pieces) => Ok(pieces.clone()),
            Item::Undefined => Err(reading("undefined", method)),
            Item::Str(_) => Err(type_error(format!(
                "this._pieces.{method} is not a function"
            ))),
        }
    }

    fn push_piece(&self, text: Text) -> Result<(), Thrown> {
        self.pieces_array("push")?.borrow_mut().push(text);
        Ok(())
    }

    fn join_pieces(&self) -> Result<Text, Thrown> {
        Ok(self
            .pieces_array("join")?
            .borrow()
            .iter()
            .flatten()
            .copied()
            .collect())
    }

    fn start_document(&mut self, kind: &str) {
        self.context = Context::Array(VecDeque::from([
            Item::Str("content".into()),
            Item::Str(kind.into()),
        ]));
        self.pieces = Item::Pieces(Rc::default());
    }

    /// `handleOpenTag`.
    fn open_tag(&mut self, tag: &Tag) -> Result<(), Thrown> {
        let name = &tag.name;
        let is = |text: &str| name_is(name, text);
        if is("Override") {
            let content_type = attribute(tag, "ContentType").map(|a| lossy(&a.value));
            let key = content_type.as_deref().unwrap_or("undefined");
            if stream_type(key) {
                let Some(part) = attribute(tag, "PartName") else {
                    return Err(reading("undefined", "replace"));
                };
                let part = lossy(&part.value);
                let part = part.trim_start_matches('/').to_owned();
                if part == "__proto__" {
                    self.proto_action = true;
                } else {
                    self.actions.insert(part);
                }
            }
        } else if is("Default") {
            let extension = attribute(tag, "Extension")
                .map_or_else(|| "undefined".to_owned(), |a| lossy(&a.value));
            let content_type = attribute(tag, "ContentType").map(|a| lossy(&a.value));
            // a string given to `__proto__` is dropped
            if extension != "__proto__" {
                self.defaults.push((extension, content_type));
            }
        } else if is("Relationship") {
            // `_relationships` is never read
        } else if is("w:document") || is("w:footnotes") || is("w:endnotes") || is("w:comments") {
            self.start_document("body");
        } else if is("w:hdr") || is("w:ftr") {
            self.start_document("header");
        } else if is("w:endnote") || is("w:footnote") {
            let given = attribute(tag, "w:type").filter(|a| !a.value.is_empty());
            let kind = match given {
                Some(given) => Item::Str(lossy(&given.value)),
                None => self.first()?,
            };
            self.context_array("unshift")?.push_front(kind);
        } else if is("w:tab") && self.first()?.is("content") {
            self.push_piece("\t".encode_utf16().collect())?;
        } else if is("w:br") && self.first()?.is("content") {
            self.push_piece("\n".encode_utf16().collect())?;
        } else if is("w:del") || is("w:instrText") {
            self.context_array("unshift")?
                .push_front(Item::Str("deleted".into()));
        } else if is("w:tabs") {
            self.context_array("unshift")?
                .push_front(Item::Str("tabs".into()));
        } else if is("w:tc") {
            self.context_array("unshift")?
                .push_front(Item::Str("cell".into()));
        } else if is("w:drawing") {
            self.context_array("unshift")?
                .push_front(Item::Str("drawing".into()));
        } else if is("w:txbxContent") {
            let saved = self.pieces.clone();
            let array = self.context_array("unshift")?;
            array.push_front(saved);
            array.push_front(Item::Str("textbox".into()));
            self.pieces = Item::Pieces(Rc::default());
        }
        Ok(())
    }

    /// `handleCloseTag`.
    fn close_tag(&mut self, tag: &Tag) -> Result<(), Thrown> {
        let name = &tag.name;
        let is = |text: &str| name_is(name, text);
        if is("w:document") {
            self.context = Context::Null;
            self.body = self.join_pieces()?;
        } else if is("w:footnote") || is("w:endnote") {
            self.context_array("shift")?.pop_front();
        } else if is("w:footnotes")
            || is("w:endnotes")
            || is("w:comments")
            || is("w:hdr")
            || is("w:ftr")
        {
            self.context = Context::Null;
            self.join_pieces()?;
        } else if is("w:p") {
            let first = self.first()?;
            if first.is("content") || first.is("cell") || first.is("textbox") {
                self.push_piece("\n".encode_utf16().collect())?;
            }
        } else if is("w:del") || is("w:instrText") || is("w:tabs") || is("w:drawing") {
            self.context_array("shift")?.pop_front();
        } else if is("w:tc") {
            self.pieces_array("pop")?.borrow_mut().pop();
            self.push_piece("\t".encode_utf16().collect())?;
            self.context_array("shift")?.pop_front();
        } else if is("w:tr") {
            self.push_piece("\n".encode_utf16().collect())?;
        } else if is("w:txbxContent") {
            let text_box = self.join_pieces()?;
            let context = self
                .context_array("shift")?
                .pop_front()
                .unwrap_or(Item::Undefined);
            if !context.is("textbox") {
                return Err(Thrown::Error("Invalid textbox context".into()));
            }
            self.pieces = self
                .context_array("shift")?
                .pop_front()
                .unwrap_or(Item::Undefined);
            if self.first()?.is("drawing") {
                return Ok(());
            }
            if text_box.is_empty() {
                return Ok(());
            }
            let in_header = self
                .context_array("includes")?
                .iter()
                .any(|item| item.is("header"));
            if !in_header {
                if self.textboxes.is_empty() {
                    self.textboxes = text_box;
                } else {
                    self.textboxes.push(0x0a);
                    self.textboxes.extend(text_box);
                }
            }
        }
        Ok(())
    }
}

struct Events<'e> {
    extractor: &'e mut Extractor,
}

impl Events<'_> {
    fn fail(cx: &mut Parser, error: &Thrown) -> HandlerResult {
        cx.fail(&units(error.message()))
    }
}

impl Handler for Events<'_> {
    fn wants_text(&self) -> bool {
        true
    }

    fn wants_error(&self) -> bool {
        true
    }

    fn opentag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        match self.extractor.open_tag(tag) {
            Ok(()) => Ok(()),
            Err(error) => Self::fail(cx, &error),
        }
    }

    fn closetag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        match self.extractor.close_tag(tag) {
            Ok(()) => Ok(()),
            Err(error) => Self::fail(cx, &error),
        }
    }

    fn text(&mut self, cx: &mut Parser, text: &[u16]) -> HandlerResult {
        let result = (|| {
            if matches!(self.extractor.context, Context::Undefined | Context::Null) {
                return Ok(());
            }
            let first = self.extractor.first()?;
            if first.is("content") || first.is("cell") || first.is("textbox") {
                self.extractor.push_piece(text.to_vec())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => Ok(()),
            Err(error) => Self::fail(cx, &error),
        }
    }

    fn error(&mut self, _cx: &mut Parser, error: &saxes::Error) -> HandlerResult {
        if self.extractor.rejected.is_none() {
            self.extractor.rejected = Some(error.clone());
        }
        Ok(())
    }
}

/// `new OpenOfficeExtractor().extract(reader)`: the body and the text boxes.
pub fn extract(data: &[u8]) -> Result<(Text, Text), Thrown> {
    let zip = ZipFile::open(data)?;
    let mut extractor = Extractor::new();
    let mut names: Vec<String> = zip.entries.iter().map(|e| e.file_name.clone()).collect();
    let Some(index) = names.iter().position(|name| name == "[Content_Types].xml") else {
        return Err(Thrown::Error(
            "Invalid Open Office XML: missing content types".into(),
        ));
    };
    names.remove(index);
    names.insert(0, "[Content_Types].xml".to_owned());
    for name in &names {
        if !extractor.should_process(name) {
            continue;
        }
        // `entryTable[name]`: the last entry of that name
        let Some(entry) = zip.entries.iter().rev().find(|e| e.file_name == *name) else {
            continue;
        };
        handle_entry(&zip, entry, &mut extractor)?;
    }
    let mut textboxes = std::mem::take(&mut extractor.textboxes);
    if !textboxes.is_empty() {
        textboxes.push(0x0a);
    }
    Ok((std::mem::take(&mut extractor.body), textboxes))
}

fn rejected(error: &saxes::Error) -> Thrown {
    match error.name {
        "TypeError" => Thrown::Type(error.message_lossy()),
        "RangeError" => Thrown::Range(error.message_lossy()),
        _ => Thrown::Error(error.message_lossy()),
    }
}

/// `handleEntry`.
fn handle_entry(
    zip: &ZipFile<'_>,
    entry: &super::zip::Entry,
    extractor: &mut Extractor,
) -> Result<(), Thrown> {
    let data = zip.open_read_stream(entry)?;
    let delivery = data.deliver();
    let mut parser = Parser::new(Options::default()).map_err(|e| rejected(&e))?;
    let mut events = Events { extractor };
    let mut pending: Vec<u8> = Vec::new();
    let feed = |parser: &mut Parser, events: &mut Events<'_>, bytes: &[u8]| -> Result<(), Thrown> {
        let text = String::from_utf8_lossy(bytes);
        parser.write_str(events, &text).map_err(|e| rejected(&e))?;
        match events.extractor.rejected.as_ref() {
            Some(error) => Err(rejected(error)),
            None => Ok(()),
        }
    };
    for chunk in delivery.chunks {
        pending.extend_from_slice(&chunk);
        while pending.len() >= 0x1000 {
            let piece: Vec<u8> = pending.drain(..0x1000).collect();
            feed(&mut parser, &mut events, &piece)?;
        }
    }
    delivery.end?;
    if !pending.is_empty() {
        feed(&mut parser, &mut events, &pending)?;
    }
    parser.close(&mut events).map_err(|e| rejected(&e))?;
    match events.extractor.rejected.as_ref() {
        Some(error) => Err(rejected(error)),
        None => Ok(()),
    }
}
