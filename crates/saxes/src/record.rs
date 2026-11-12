//! The gate's recorder: parses a text with every handler attached and lists
//! each event with the payload and the parser position at that moment.
//!
//! `tools/epub-diff/saxes-cases.ts` runs the real saxes with the same
//! recorder, so the two lists are compared as they stand.
//!
//! Arguments (all optional): `options` (the `SaxesOptions` as JSON, with
//! `resolvePrefix` as a table prefix to URI), `units` (the text as UTF-16
//! code units, for a text a JSON string cannot hold), `chunkSize` (write the
//! text in chunks of that many units), `handlers` (the events to listen to,
//! all by default), `throwAt` (the handler throws after recording that event,
//! counting from 0).
//!
//! A string that is not well formed UTF-16 is `{ "$units": [...] }`.
//! `attributes` and `ns` of a tag are lists of `[name, value]`, in the order
//! JavaScript lists the keys of the object (integer keys first).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::{
    Attribute, Error, Handler, HandlerResult, Ns, Options, Parser, Str, Tag, XmlDecl, units,
};

fn wire_str(text: &[u16]) -> Value {
    match String::from_utf16(text) {
        Ok(text) => Value::String(text),
        Err(_) => json!({ "$units": text }),
    }
}

fn wire_attribute(attr: &Attribute) -> Value {
    let mut out = Map::new();
    out.insert("name".to_owned(), wire_str(&attr.name));
    if let Some(prefix) = &attr.prefix {
        out.insert("prefix".to_owned(), wire_str(prefix));
    }
    if let Some(local) = &attr.local {
        out.insert("local".to_owned(), wire_str(local));
    }
    out.insert("value".to_owned(), wire_str(&attr.value));
    if let Some(uri) = &attr.uri {
        out.insert("uri".to_owned(), wire_str(uri));
    }
    Value::Object(out)
}

/// The entries of a record in the order `Object.entries` lists them: the keys
/// that are array indexes first, ascending, then the rest as written.
fn wire_ns(ns: &Ns) -> Value {
    let mut indexed: Vec<(u32, &(Str, Str))> = Vec::new();
    let mut rest: Vec<&(Str, Str)> = Vec::new();
    for entry in ns.iter() {
        match String::from_utf16(&entry.0)
            .ok()
            .and_then(|key| jscompat::array_index(&key))
        {
            Some(index) => indexed.push((index, entry)),
            None => rest.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    let entries = indexed
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(rest)
        .map(|(key, value)| json!([wire_str(key), wire_str(value)]))
        .collect();
    Value::Array(entries)
}

fn wire_tag(tag: &Tag, start: bool) -> Value {
    let mut out = Map::new();
    out.insert("name".to_owned(), wire_str(&tag.name));
    let attributes = tag
        .attributes
        .iter()
        .map(|attr| {
            let value = if attr.prefix.is_some() {
                wire_attribute(attr)
            } else {
                wire_str(&attr.value)
            };
            json!([wire_str(&attr.name), value])
        })
        .collect();
    out.insert("attributes".to_owned(), Value::Array(attributes));
    if let Some(ns) = &tag.ns {
        out.insert("ns".to_owned(), wire_ns(ns));
    }
    for (key, value) in [
        ("prefix", &tag.prefix),
        ("local", &tag.local),
        ("uri", &tag.uri),
    ] {
        if let Some(value) = value {
            out.insert(key.to_owned(), wire_str(value));
        }
    }
    if !start {
        out.insert("isSelfClosing".to_owned(), Value::Bool(tag.is_self_closing));
    }
    Value::Object(out)
}

fn wire_error(error: &Error) -> Value {
    json!({ "name": error.name, "message": wire_str(&error.message) })
}

struct Recorder {
    events: Vec<Value>,
    handlers: Option<Vec<String>>,
    throw_at: Option<usize>,
}

impl Recorder {
    fn on(&self, name: &str) -> bool {
        self.handlers
            .as_ref()
            .is_none_or(|names| names.iter().any(|n| n == name))
    }

    fn push(&mut self, cx: &Parser, event: &str, data: Option<Value>) -> HandlerResult {
        let mut out = Map::new();
        out.insert("event".to_owned(), Value::String(event.to_owned()));
        if let Some(data) = data {
            out.insert("data".to_owned(), data);
        }
        out.insert("position".to_owned(), json!(cx.position()));
        out.insert("line".to_owned(), json!(cx.line()));
        out.insert("column".to_owned(), json!(cx.column()));
        out.insert("columnIndex".to_owned(), json!(cx.column_index()));
        self.events.push(Value::Object(out));
        if self.throw_at == Some(self.events.len() - 1) {
            return Err(Error {
                name: "Error",
                message: units("stop"),
            });
        }
        Ok(())
    }

    fn string_event(&mut self, cx: &Parser, event: &str, text: &[u16]) -> HandlerResult {
        if self.on(event) {
            self.push(cx, event, Some(wire_str(text)))
        } else {
            Ok(())
        }
    }
}

impl Handler for Recorder {
    fn wants_text(&self) -> bool {
        self.on("text")
    }

    fn wants_error(&self) -> bool {
        self.on("error")
    }

    fn xmldecl(&mut self, cx: &mut Parser, decl: &XmlDecl) -> HandlerResult {
        if !self.on("xmldecl") {
            return Ok(());
        }
        let mut out = Map::new();
        for (key, value) in [
            ("version", &decl.version),
            ("encoding", &decl.encoding),
            ("standalone", &decl.standalone),
        ] {
            if let Some(value) = value {
                out.insert(key.to_owned(), wire_str(value));
            }
        }
        self.push(cx, "xmldecl", Some(Value::Object(out)))
    }

    fn text(&mut self, cx: &mut Parser, text: &[u16]) -> HandlerResult {
        self.string_event(cx, "text", text)
    }

    fn processinginstruction(
        &mut self,
        cx: &mut Parser,
        target: &[u16],
        body: &[u16],
    ) -> HandlerResult {
        if !self.on("processinginstruction") {
            return Ok(());
        }
        let data = json!({ "target": wire_str(target), "body": wire_str(body) });
        self.push(cx, "processinginstruction", Some(data))
    }

    fn doctype(&mut self, cx: &mut Parser, doctype: &[u16]) -> HandlerResult {
        self.string_event(cx, "doctype", doctype)
    }

    fn comment(&mut self, cx: &mut Parser, comment: &[u16]) -> HandlerResult {
        self.string_event(cx, "comment", comment)
    }

    fn opentagstart(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        if self.on("opentagstart") {
            self.push(cx, "opentagstart", Some(wire_tag(tag, true)))
        } else {
            Ok(())
        }
    }

    fn attribute(&mut self, cx: &mut Parser, attribute: &Attribute) -> HandlerResult {
        if self.on("attribute") {
            self.push(cx, "attribute", Some(wire_attribute(attribute)))
        } else {
            Ok(())
        }
    }

    fn opentag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        if self.on("opentag") {
            self.push(cx, "opentag", Some(wire_tag(tag, false)))
        } else {
            Ok(())
        }
    }

    fn closetag(&mut self, cx: &mut Parser, tag: &Tag) -> HandlerResult {
        if self.on("closetag") {
            self.push(cx, "closetag", Some(wire_tag(tag, false)))
        } else {
            Ok(())
        }
    }

    fn cdata(&mut self, cx: &mut Parser, cdata: &[u16]) -> HandlerResult {
        self.string_event(cx, "cdata", cdata)
    }

    fn error(&mut self, cx: &mut Parser, error: &Error) -> HandlerResult {
        self.string_event(cx, "error", &error.message)
    }

    fn end(&mut self, cx: &mut Parser) -> HandlerResult {
        if self.on("end") {
            self.push(cx, "end", None)
        } else {
            Ok(())
        }
    }

    fn ready(&mut self, cx: &mut Parser) -> HandlerResult {
        if self.on("ready") {
            self.push(cx, "ready", None)
        } else {
            Ok(())
        }
    }
}

fn parse_options(options: Option<&Value>) -> Result<Options, String> {
    let mut out = Options::default();
    let Some(options) = options else {
        return Ok(out);
    };
    let Some(map) = options.as_object() else {
        return Err("options is not an object".to_owned());
    };
    for (key, value) in map {
        let flag = || {
            value
                .as_bool()
                .ok_or(format!("option {key} is not a boolean"))
        };
        let string = || {
            value
                .as_str()
                .map(units)
                .ok_or(format!("option {key} is not a string"))
        };
        let table = || -> Result<Vec<(Str, Str)>, String> {
            value
                .as_object()
                .ok_or(format!("option {key} is not an object"))?
                .iter()
                .map(|(name, uri)| {
                    let uri = uri
                        .as_str()
                        .ok_or(format!("option {key} holds a non-string"))?;
                    Ok((units(name), units(uri)))
                })
                .collect()
        };
        match key.as_str() {
            "xmlns" => out.xmlns = flag()?,
            "position" => out.position = flag()?,
            "fragment" => out.fragment = flag()?,
            "forceXMLVersion" => out.force_xml_version = flag()?,
            "fileName" => out.file_name = Some(string()?),
            "defaultXMLVersion" => out.default_xml_version = Some(string()?),
            "additionalNamespaces" => out.additional_namespaces = Some(table()?),
            "resolvePrefix" => {
                let table: HashMap<Str, Str> = table()?.into_iter().collect();
                out.resolve_prefix = Some(Box::new(move |prefix| table.get(prefix).cloned()));
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(out)
}

/// `saxesEvents`: `{ events, thrown }`, `thrown` being the error that ended
/// the parse (the constructor's, a handler's or `fail` without an `error`
/// handler) or `null`.
pub fn run(args: &Value, text: &str) -> Result<Value, String> {
    let all: Str = match args.get("units") {
        Some(Value::Array(list)) => list
            .iter()
            .map(|unit| {
                unit.as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .ok_or("units holds a non-unit".to_owned())
            })
            .collect::<Result<_, _>>()?,
        _ => units(text),
    };
    let chunk_size = args
        .get("chunkSize")
        .and_then(Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    let handlers = match args.get("handlers") {
        Some(Value::Array(names)) => Some(
            names
                .iter()
                .filter_map(|name| name.as_str().map(str::to_owned))
                .collect(),
        ),
        _ => None,
    };
    let throw_at = args
        .get("throwAt")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok());
    let mut recorder = Recorder {
        events: Vec::new(),
        handlers,
        throw_at,
    };
    let options = parse_options(args.get("options"))?;
    let thrown = match Parser::new(options) {
        Err(error) => Some(error),
        Ok(mut parser) => {
            let mut result = Ok(());
            match chunk_size {
                Some(size) if size > 0 => {
                    for chunk in all.chunks(size) {
                        result = parser.write(&mut recorder, chunk);
                        if result.is_err() {
                            break;
                        }
                    }
                }
                _ => result = parser.write(&mut recorder, &all),
            }
            if result.is_ok() {
                result = parser.close(&mut recorder);
            }
            result.err()
        }
    };
    Ok(json!({
        "events": recorder.events,
        "thrown": thrown.as_ref().map_or(Value::Null, wire_error),
    }))
}
