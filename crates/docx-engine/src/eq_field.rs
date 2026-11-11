//! Legacy EQ field instructions (`EQ \f(a,b)`, `EQ \a \al (x,y)` ...) laid out
//! as OMML so the math renderer draws them (packages/docx-engine/src/eq-field.ts).
//! Word computes these fields live and stores no cached result.
//!
//! The parser walks UTF-16 code units, as the original indexes its string: a
//! backslash escapes one unit, which is half of a character outside the BMP.

use jscompat::{Radix, js_regex, parse_int, trim, truthy};
use serde::Serialize;

use crate::xml_text::decode_entities;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EqField {
    pub omml: String,
    /// linear text of the layout (previews, word count)
    pub text: String,
}

#[derive(Debug, Clone, Default)]
struct Piece {
    omml: String,
    text: String,
}

struct Parser {
    src: Vec<u16>,
    i: usize,
    depth: usize,
}

const MAX_DEPTH: usize = 64;

const CHAR_SWITCHES: [&str; 5] = ["lc", "rc", "bc", "fc", "vc"];

const BACKSLASH: u16 = b'\\' as u16;
const SPACE: u16 = b' ' as u16;
const OPEN: u16 = b'(' as u16;
const CLOSE: u16 = b')' as u16;
const COMMA: u16 = b',' as u16;

/// `escapeXmlText`, and with `attribute` `escapeXmlAttr`, of xml-utils.ts.
fn escape_xml(text: &str, attribute: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' => {}
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

fn ascii_letter(unit: u16) -> Option<u8> {
    u8::try_from(unit)
        .ok()
        .filter(|byte| byte.is_ascii_alphabetic())
}

fn run(text: &str) -> Piece {
    if text.is_empty() {
        return Piece::default();
    }
    Piece {
        omml: format!(
            r#"<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">{}</m:t></m:r>"#,
            escape_xml(text, false)
        ),
        text: text.to_owned(),
    }
}

fn join(pieces: &[Piece], sep: &str) -> Piece {
    let omml_sep = if sep.is_empty() {
        String::new()
    } else {
        run(sep).omml
    };
    Piece {
        omml: pieces
            .iter()
            .map(|piece| piece.omml.as_str())
            .collect::<Vec<_>>()
            .join(&omml_sep),
        text: pieces
            .iter()
            .map(|piece| piece.text.as_str())
            .collect::<Vec<_>>()
            .join(sep),
    }
}

fn slot(name: &str, piece: &Piece) -> String {
    format!("<m:{name}>{}</m:{name}>", piece.omml)
}

fn val(name: &str, v: &str) -> String {
    format!(r#"<m:{name} m:val="{}"/>"#, escape_xml(v, true))
}

/// Element sequence up to an unbalanced `)` or a top-level `,` (only inside args).
fn parse_seq(p: &mut Parser, in_args: bool) -> Option<Vec<Piece>> {
    fn flush(pieces: &mut Vec<Piece>, text: &mut Vec<u16>) {
        if !text.is_empty() {
            // a backslash never splits a surrogate pair that reaches a run
            pieces.push(run(&String::from_utf16_lossy(text)));
        }
        text.clear();
    }

    let mut pieces = Vec::new();
    let mut text: Vec<u16> = Vec::new();
    let mut depth = 0usize;
    while let Some(&ch) = p.src.get(p.i) {
        if ch == BACKSLASH {
            let next = p.src.get(p.i + 1).copied();
            if next.and_then(ascii_letter).is_some() {
                flush(&mut pieces, &mut text);
                let cmd = parse_command(p)?;
                pieces.push(cmd);
                continue;
            }
            // escaped literal (`\,` `\(` `\)` `\\`)
            text.extend(next);
            p.i += 2;
            continue;
        }
        if in_args {
            if ch == OPEN {
                depth += 1;
            } else if ch == CLOSE {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            } else if ch == COMMA && depth == 0 {
                break;
            }
        }
        text.push(ch);
        p.i += 1;
    }
    flush(&mut pieces, &mut text);
    Some(pieces)
}

fn parse_args(p: &mut Parser) -> Option<Vec<Piece>> {
    while p.src.get(p.i) == Some(&SPACE) {
        p.i += 1;
    }
    if p.src.get(p.i) != Some(&OPEN) {
        return None;
    }
    p.i += 1;
    let mut args = Vec::new();
    loop {
        let seq = parse_seq(p, true)?;
        args.push(join(&seq, ""));
        match p.src.get(p.i) {
            Some(&COMMA) => p.i += 1,
            Some(&CLOSE) => {
                p.i += 1;
                return Some(args);
            }
            _ => return None,
        }
    }
}

fn parse_command(p: &mut Parser) -> Option<Piece> {
    if p.depth >= MAX_DEPTH {
        return None;
    }
    p.depth += 1;
    let piece = parse_command_inner(p);
    p.depth -= 1;
    piece
}

/// `/^\\([A-Za-z]{2})(-?\d*)/` at `at`: the switch name, its argument and the
/// units matched.
fn switch_at(src: &[u16], at: usize) -> Option<(String, String, usize)> {
    if src.get(at) != Some(&BACKSLASH) {
        return None;
    }
    let first = src.get(at + 1).copied().and_then(ascii_letter)?;
    let second = src.get(at + 2).copied().and_then(ascii_letter)?;
    let mut end = at + 3;
    if src.get(end) == Some(&(b'-' as u16)) {
        end += 1;
    }
    while src
        .get(end)
        .is_some_and(|&unit| (b'0' as u16..=b'9' as u16).contains(&unit))
    {
        end += 1;
    }
    let name = String::from_utf8_lossy(&[first, second]).into_owned();
    Some((name, String::from_utf16_lossy(&src[at + 3..end]), end - at))
}

fn parse_command_inner(p: &mut Parser) -> Option<Piece> {
    let cmd = p
        .src
        .get(p.i + 1)
        .copied()
        .and_then(ascii_letter)?
        .to_ascii_lowercase();
    p.i += 2;
    let mut switches: Vec<(String, String)> = Vec::new();
    loop {
        while p.src.get(p.i) == Some(&SPACE) {
            p.i += 1;
        }
        let Some((name, mut arg, length)) = switch_at(&p.src, p.i) else {
            break;
        };
        let name = name.to_lowercase();
        p.i += length;
        if CHAR_SWITCHES.contains(&&*name) {
            if p.src.get(p.i) != Some(&BACKSLASH) {
                return None;
            }
            arg = p
                .src
                .get(p.i + 1)
                .map_or_else(String::new, |&unit| String::from_utf16_lossy(&[unit]));
            p.i += 2;
        }
        switches.push((name, arg));
    }
    let args = parse_args(p)?;
    let has = |name: &str| switches.iter().any(|(switch, _)| switch == name);
    let arg_of = |name: &str| {
        switches
            .iter()
            .find(|(switch, _)| switch == name)
            .map(|(_, arg)| arg.as_str())
    };
    let empty = Piece::default();
    let nth = |index: usize| args.get(index).unwrap_or(&empty);
    match cmd {
        b'a' => {
            // \co arrives from the file: a huge count fills each row's padding
            // loop and writes an invalid m:count.
            let raw_cols = parse_int(arg_of("co").unwrap_or("1"), Radix::Ten);
            let cols = if raw_cols.is_finite() {
                raw_cols.clamp(1.0, 64.0)
            } else {
                1.0
            };
            let width = cols as usize;
            let jc = if has("al") {
                "left"
            } else if has("ar") {
                "right"
            } else {
                "center"
            };
            let mut rows = String::new();
            let mut lines: Vec<String> = Vec::new();
            for row in args.chunks(width) {
                let mut cells: Vec<&Piece> = row.iter().collect();
                while cells.len() < width {
                    cells.push(&empty);
                }
                rows.push_str("<m:mr>");
                for cell in &cells {
                    rows.push_str(&slot("e", cell));
                }
                rows.push_str("</m:mr>");
                lines.push(
                    cells
                        .iter()
                        .map(|cell| cell.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            Some(Piece {
                omml: format!(
                    "<m:m><m:mPr><m:mcs><m:mc><m:mcPr>{}{}</m:mcPr></m:mc></m:mcs></m:mPr>{rows}</m:m>",
                    val("count", &width.to_string()),
                    val("mcJc", jc),
                ),
                text: lines.join("\n"),
            })
        }
        b'b' => {
            let both = arg_of("bc");
            let beg = both.or_else(|| arg_of("lc")).unwrap_or("(");
            let end = match truthy(both) {
                Some(both) => closing_of(both),
                None => arg_of("rc").unwrap_or(")"),
            };
            let body = join(&args, ",");
            Some(Piece {
                omml: format!(
                    "<m:d><m:dPr>{}{}</m:dPr>{}</m:d>",
                    val("begChr", beg),
                    val("endChr", end),
                    slot("e", &body)
                ),
                text: format!("{beg}{}{end}", body.text),
            })
        }
        b'f' => {
            let (num, den) = (nth(0), nth(1));
            Some(Piece {
                omml: format!("<m:f>{}{}</m:f>", slot("num", num), slot("den", den)),
                text: format!("{}/{}", num.text, den.text),
            })
        }
        b'i' => {
            let chr = arg_of("fc")
                .or_else(|| arg_of("vc"))
                .unwrap_or(if has("su") {
                    "\u{2211}"
                } else if has("pr") {
                    "\u{220F}"
                } else {
                    "\u{222B}"
                });
            let (lo, hi, body) = (nth(0), nth(1), nth(2));
            let lim_loc = if has("in") || chr == "\u{222B}" {
                "subSup"
            } else {
                "undOvr"
            };
            let sub_hide = if lo.text.is_empty() {
                val("subHide", "1")
            } else {
                String::new()
            };
            let sup_hide = if hi.text.is_empty() {
                val("supHide", "1")
            } else {
                String::new()
            };
            Some(Piece {
                omml: format!(
                    "<m:nary><m:naryPr>{}{}{sub_hide}{sup_hide}</m:naryPr>{}{}{}</m:nary>",
                    val("chr", chr),
                    val("limLoc", lim_loc),
                    slot("sub", lo),
                    slot("sup", hi),
                    slot("e", body)
                ),
                text: format!("{chr}{}{} {}", lo.text, hi.text, body.text),
            })
        }
        b'l' => Some(join(&args, ",")),
        // overlay has no OMML counterpart; the pieces render side by side
        b'o' => Some(join(&args, "")),
        b'r' => {
            if args.len() >= 2 {
                let (deg, body) = (nth(0), nth(1));
                return Some(Piece {
                    omml: format!("<m:rad>{}{}</m:rad>", slot("deg", deg), slot("e", body)),
                    text: format!("{}\u{221A}({})", deg.text, body.text),
                });
            }
            let body = nth(0);
            Some(Piece {
                omml: format!(
                    "<m:rad><m:radPr>{}</m:radPr><m:deg/>{}</m:rad>",
                    val("degHide", "1"),
                    slot("e", body)
                ),
                text: format!("\u{221A}({})", body.text),
            })
        }
        b's' => {
            if args.len() == 1 && (has("up") || has("do")) {
                let (tag, script) = if has("up") {
                    ("sSup", "sup")
                } else {
                    ("sSub", "sub")
                };
                return Some(Piece {
                    omml: format!("<m:{tag}><m:e/>{}</m:{tag}>", slot(script, nth(0))),
                    text: nth(0).text.clone(),
                });
            }
            Some(Piece {
                omml: format!(
                    "<m:eqArr>{}</m:eqArr>",
                    args.iter().map(|arg| slot("e", arg)).collect::<String>()
                ),
                text: args
                    .iter()
                    .map(|arg| arg.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            })
        }
        b'x' => {
            const SIDES: [(&str, &str); 4] = [
                ("to", "hideTop"),
                ("bo", "hideBot"),
                ("le", "hideLeft"),
                ("ri", "hideRight"),
            ];
            let named: Vec<&str> = SIDES
                .iter()
                .map(|(key, _)| *key)
                .filter(|key| has(key))
                .collect();
            let hidden: String = if named.is_empty() {
                String::new()
            } else {
                SIDES
                    .iter()
                    .filter(|(key, _)| !named.contains(key))
                    .map(|(_, tag)| val(tag, "1"))
                    .collect()
            };
            let body = join(&args, ",");
            Some(Piece {
                omml: format!(
                    "<m:borderBox><m:borderBoxPr>{hidden}</m:borderBoxPr>{}</m:borderBox>",
                    slot("e", &body)
                ),
                text: body.text,
            })
        }
        _ => None,
    }
}

fn closing_of(open: &str) -> &str {
    match open {
        "(" => ")",
        "[" => "]",
        "{" => "}",
        "<" => ">",
        "\u{27E8}" => "\u{27E9}",
        _ => open,
    }
}

/// `None` when the instruction is not an EQ field or uses an unsupported switch.
pub fn eq_field_to_omml(instr: &str) -> Option<EqField> {
    let found = js_regex!(r"^\s*EQ\b\s*([\s\S]*?)\s*$", "i").exec(instr)?;
    // general switches (\* MERGEFORMAT ...) are not part of the layout
    let body =
        js_regex!(r"\\\*\s*[A-Za-z]+").replace_all(found.get(1).unwrap_or(""), |_| String::new());
    let mut p = Parser {
        src: trim(&body).encode_utf16().collect(),
        i: 0,
        depth: 0,
    };
    let seq = parse_seq(&mut p, false)?;
    if p.i < p.src.len() {
        return None;
    }
    let body = join(&seq, "");
    if body.omml.is_empty() {
        return None;
    }
    Some(EqField {
        omml: format!("<m:oMath>{}</m:oMath>", body.omml),
        text: body.text,
    })
}

/// `text.slice(start, end)`: empty where the range is reversed.
fn slice(text: &str, start: usize, end: usize) -> &str {
    if start >= end { "" } else { &text[start..end] }
}

/// Paragraph XML with every renderable EQ field replaced by a plain run of its
/// linear text (in the field code's rPr), so the field-result text and size
/// scans see the layout Word would compute.
pub fn inline_eq_field_results(xml: &str) -> String {
    if !js_regex!(r"<w:instrText[^>]*>\s*EQ\b", "i").test(xml) {
        return xml.to_owned();
    }
    let mut out = String::new();
    let mut cursor = 0;
    let mut depth = 0usize;
    let mut span_start: Option<usize> = None;
    let fld_char = js_regex!(
        r#"<w:fldChar[^>]*w:fldCharType=(?:"(begin|separate|end)"|'(begin|separate|end)')"#
    );
    for found in fld_char.find_iter(xml) {
        match found.get(1).or_else(|| found.get(2)) {
            Some("begin") => {
                if depth == 0 {
                    span_start = run_start_before(xml, found.start());
                }
                depth += 1;
            }
            Some("end") => {
                depth = depth.saturating_sub(1);
                let Some(start) = span_start.filter(|_| depth == 0) else {
                    continue;
                };
                // without a later </w:r> the original's span is the first five
                // units of the paragraph, which hold no instruction: no EQ
                let Some(close) = xml[found.start()..].find("</w:r>") else {
                    span_start = None;
                    continue;
                };
                let span_end = found.start() + close + "</w:r>".len();
                let span = slice(xml, start, span_end);
                let instr = decode_entities(
                    &js_regex!(r"<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>")
                        .find_iter(span)
                        .map(|found| found.get(1).unwrap_or(""))
                        .collect::<String>(),
                );
                if let Some(eq) = eq_field_to_omml(&instr) {
                    let r_pr = js_regex!(r"<w:rPr>[\s\S]*?<\/w:rPr>")
                        .exec(span)
                        .map_or("", |found| found.as_str());
                    out.push_str(slice(xml, cursor, start));
                    out.push_str(&format!(
                        r#"<w:r>{r_pr}<w:t xml:space="preserve">{}</w:t></w:r>"#,
                        escape_xml(&eq.text, false)
                    ));
                    cursor = span_end;
                }
                span_start = None;
            }
            _ => {}
        }
    }
    out.push_str(&xml[cursor..]);
    out
}

fn run_start_before(xml: &str, index: usize) -> Option<usize> {
    let head = &xml[..index];
    head.rfind("<w:r>").max(head.rfind("<w:r "))
}
