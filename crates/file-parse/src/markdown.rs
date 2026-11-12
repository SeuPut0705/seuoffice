//! packages/file-parse/src/markdown-redaction.ts: withheld spans in a file the
//! markdown editor saves. The module comment of the TypeScript says what can
//! and cannot be known about where a span ends.
//!
//! Offsets are bytes. Every place a scan stops is an ASCII character or the
//! end, so it lands where the UTF-16 offset of the original lands and the
//! comparisons between offsets agree. The budget counts UTF-16 code units, as
//! the original does.

use jscompat::{JsRegex, is_js_space, js_regex, trim, truthy};

use crate::redaction::{placeholder_source, redaction_error};

/// the opening tag of a persisted span, as the editor's parser patch matches it
fn open_re() -> &'static JsRegex {
    js_regex!(r"<span\b[^>]*\bdata-redaction\b[^>]*>", "i")
}

fn label_re() -> &'static JsRegex {
    js_regex!(r#"\bdata-label\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "i")
}

/// any raw closing tag; whether it is a plain one is checked where it is found
fn close_re() -> &'static JsRegex {
    js_regex!(r"<\/span\b", "i")
}

/// `/<\/span[ \t\r\n]*>/iy`. regress has no sticky flag: anchored, and run on
/// the text that starts where the original sets `lastIndex`.
fn plain_close_re() -> &'static JsRegex {
    js_regex!(r"^<\/span[ \t\r\n]*>", "i")
}

/// the attribute that makes a span a withheld one, wherever it is spelled
fn mark_name_re() -> &'static JsRegex {
    js_regex!(r"data-redaction", "i")
}

fn span_start_re() -> &'static JsRegex {
    js_regex!(r"<span\b", "i")
}

fn blank_line_re() -> &'static JsRegex {
    js_regex!(r"\r?\n[ \t]*\r?\n")
}

fn char_at(src: &str, i: usize) -> Option<char> {
    src.get(i..).and_then(|rest| rest.chars().next())
}

fn char_before(src: &str, i: usize) -> Option<char> {
    src[..i].chars().next_back()
}

/// `/[\p{L}\p{N}]/u` over one UTF-16 code unit: half of a pair outside the BMP
/// is neither.
fn is_alnum(c: Option<char>) -> bool {
    c.is_some_and(|c| {
        c <= '\u{FFFF}' && js_regex!(r"[\p{L}\p{N}]", "u").test(c.encode_utf8(&mut [0; 4]))
    })
}

fn units(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

/// Tag scanning is bounded: a file built to make every `<` rescan the rest of
/// the text is refused instead of being scanned in quadratic time.
struct Budget {
    left: i64,
}

fn spend(budget: &mut Budget, chars: i64) -> Result<(), String> {
    budget.left -= chars;
    if budget.left < 0 {
        return Err(redaction_error(
            "the markup around a withheld span is too tangled",
        ));
    }
    Ok(())
}

/// Where a start or end tag whose name begins at `i` ends, the way an HTML
/// tokenizer delimits it: quoted attribute values may hold anything, `>` ends
/// the tag anywhere else. With `stop_at_lt`, an unquoted `<` ends it too: no
/// markdown parser takes such a thing for a tag, so nothing can hide behind it.
fn tag_end(
    src: &str,
    mut i: usize,
    stop_at_lt: bool,
    budget: &mut Budget,
) -> Result<usize, String> {
    let n = src.len();
    let from = i;
    // the original spends in a `finally`: what was scanned up to `i`, whichever
    // `return` was taken
    let end = 'scan: {
        while let Some(c) = char_at(src, i) {
            if is_js_space(c) || c == '/' || c == '>' {
                break;
            }
            if stop_at_lt && c == '<' {
                break 'scan i;
            }
            i += c.len_utf8();
        }
        loop {
            while let Some(c) = char_at(src, i).filter(|&c| is_js_space(c) || c == '/') {
                i += c.len_utf8();
            }
            if i >= n {
                break 'scan n;
            }
            if src.as_bytes()[i] == b'>' {
                break 'scan i + 1;
            }
            // an attribute name, which may be empty in front of a stray "="
            while let Some(c) = char_at(src, i) {
                if is_js_space(c) || c == '/' || c == '>' || c == '=' {
                    break;
                }
                if stop_at_lt && c == '<' {
                    break 'scan i;
                }
                i += c.len_utf8();
            }
            while let Some(c) = char_at(src, i).filter(|&c| is_js_space(c)) {
                i += c.len_utf8();
            }
            if char_at(src, i) != Some('=') {
                continue;
            }
            i += 1;
            while let Some(c) = char_at(src, i).filter(|&c| is_js_space(c)) {
                i += c.len_utf8();
            }
            let quote = char_at(src, i);
            if let Some(quote @ ('"' | '\'')) = quote {
                let Some(close) = src[i + 1..].find(quote) else {
                    break 'scan n;
                };
                i += 1 + close + 1;
            } else {
                while let Some(c) = char_at(src, i) {
                    if is_js_space(c) || c == '>' {
                        break;
                    }
                    if stop_at_lt && c == '<' {
                        break 'scan i;
                    }
                    i += c.len_utf8();
                }
            }
        }
    };
    spend(budget, units(&src[from..i]))?;
    Ok(end)
}

fn end_after(src: &str, terminator: &str, from: usize) -> usize {
    src[from..]
        .find(terminator)
        .map_or(src.len(), |at| from + at + terminator.len())
}

/// The furthest a construct starting at the `<` at `at` can reach: a comment, a
/// processing instruction, a declaration, a CDATA section or a tag. `at` itself
/// when the `<` starts none of them.
fn construct_end(src: &str, at: usize, budget: &mut Budget) -> Result<usize, String> {
    let bytes = src.as_bytes();
    if src[at..].starts_with("<!--") {
        return Ok(end_after(src, "-->", at + 4));
    }
    if src[at..].starts_with("<![CDATA[") {
        return Ok(end_after(src, "]]>", at + 9));
    }
    if bytes.get(at + 1) == Some(&b'?') {
        return Ok(end_after(src, "?>", at + 2));
    }
    if bytes.get(at + 1) == Some(&b'!') {
        return Ok(end_after(src, ">", at + 2));
    }
    let name = if bytes.get(at + 1) == Some(&b'/') {
        at + 2
    } else {
        at + 1
    };
    if !bytes.get(name).is_some_and(u8::is_ascii_alphabetic) {
        return Ok(at);
    }
    tag_end(src, name, true, budget)
}

/// true when `text` holds `char` outside a backslash escape. Bytes stand for
/// code units here: what follows a backslash is skipped by one unit in the
/// original and by one byte here, and the bytes left of a longer character
/// are never ASCII.
fn has_unescaped(text: &str, char: u8) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 1;
        } else if bytes[i] == char {
            return true;
        }
        i += 1;
    }
    false
}

fn ambiguous() -> String {
    redaction_error("where a withheld span ends cannot be told")
}

/// Rules 2 and 3 of the module comment, for the text `from..close` of one span
/// whose closing tag ends at `close_end`.
///
/// The text is walked the way the inline parser reads plain text: a backslash
/// takes the next character with it, and every character that can open a
/// construct is noted. A construct only swallows the closing tag if it is still
/// open there, which needs its closing character somewhere after the tag and
/// before the paragraph ends, so that is what each noted opener is held against.
/// Walked by bytes, as [`has_unescaped`] is.
fn assert_closes_here(
    src: &str,
    from: usize,
    close: usize,
    close_end: usize,
) -> Result<(), String> {
    let bytes = src.as_bytes();
    let mut code = false;
    let mut star = false;
    let mut underscore = false;
    let mut tilde = false;
    let mut label = 0usize;
    let mut destination = false;
    let mut formula = false;
    let mut i = from;
    while i < close {
        match bytes[i] {
            b'\\' => {
                // the last character before the tag: the tag itself is the escaped text
                if i + 1 >= close {
                    return Err(ambiguous());
                }
                i += 1;
                if bytes[i] == b'\n' {
                    formula = false;
                }
            }
            // a tag, a comment, an autolink, a nested span: the editor never writes one
            // inside a span, and each of them can hold the closing tag
            b'<' => return Err(ambiguous()),
            b'`' => code = true,
            b'*' => star = true,
            b'~' => tilde = true,
            // between two letters or digits an underscore opens nothing
            b'_' => {
                underscore =
                    underscore || !(is_alnum(char_before(src, i)) && is_alnum(char_at(src, i + 1)));
            }
            b'[' => label += 1,
            b']' => {
                label = label.saturating_sub(1);
                if bytes.get(i + 1) == Some(&b'(') {
                    destination = destination || !destination_ends_before(src, i + 2, close);
                }
            }
            // a formula stays on one line
            b'$' => formula = true,
            b'\n' => formula = false,
            _ => {}
        }
        i += 1;
    }
    if !(code || star || underscore || tilde || label > 0 || destination || formula) {
        return Ok(());
    }

    let blank = blank_line_re().find_from(src, close_end).next();
    let rest = &src[close_end..blank.map_or(src.len(), |m| m.start())];
    let rest_of_line = &rest[..rest.find('\n').unwrap_or(rest.len())];
    if (code && rest.contains('`'))
        || (star && has_unescaped(rest, b'*'))
        || (underscore && has_unescaped(rest, b'_'))
        || (tilde && has_unescaped(rest, b'~'))
        || (label > 0 && has_unescaped(rest, b']'))
        || (destination && rest.contains(')'))
        || (formula && rest_of_line.contains('$'))
    {
        return Err(ambiguous());
    }
    Ok(())
}

/// True when the link destination starting at `i` (just past `](`) is closed by
/// its own `)` before `limit`. Whitespace counts as not closed: a title may
/// follow, and a quoted title can hold anything.
fn destination_ends_before(src: &str, mut i: usize, limit: usize) -> bool {
    let mut open = 1usize;
    while i < limit {
        let Some(c) = char_at(src, i) else { break };
        i += c.len_utf8();
        if c == '\\' {
            // the original skips one code unit; the rest of a pair it splits
            // matches nothing below
            i += char_at(src, i).map_or(1, char::len_utf8);
        } else if is_js_space(c) {
            return false;
        } else if c == '(' {
            open += 1;
        } else if c == ')' {
            open -= 1;
            if open == 0 {
                return true;
            }
        }
    }
    false
}

/// the text with every withheld span replaced by its `{{label}}` marker
pub fn redact_markdown_source(source: &str) -> Result<String, String> {
    if !mark_name_re().test(source) {
        return Ok(source.to_owned());
    }
    let mut budget = Budget {
        left: units(source) * 16 + 4096,
    };
    let mut out = String::with_capacity(source.len());
    // the stretches of the file that stay as written
    let mut kept: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0;
    // how far any HTML construct starting before `next_lt` reaches
    let mut reach = 0;
    let mut next_lt = source.find('<');
    // One pass of each pattern, where the original restarts at `lastIndex`.
    // The cursor stands after a ">" and neither pattern matches across one,
    // so a match that begins before the cursor ends before it, and the first
    // match of the pass at or after the cursor is the one a restart finds.
    let mut opens = open_re().find_iter(source);
    let mut closes = close_re().find_iter(source);
    while let Some(start) = opens.by_ref().find(|open| open.start() >= cursor) {
        let open_end = start.end();
        // rule 1: a tag or comment that began earlier and has not ended yet would be
        // the token the editor reads, and its end, not this tag's, starts the span
        while let Some(lt) = next_lt.filter(|&lt| lt < start.start()) {
            // once something reaches the end of the file nothing can reach further
            if reach < source.len() {
                reach = reach.max(construct_end(source, lt, &mut budget)?);
            }
            next_lt = source[lt + 1..].find('<').map(|at| lt + 1 + at);
        }
        if reach > start.start() {
            return Err(ambiguous());
        }
        // the pattern ends the tag at the first ">", a parser at the first one
        // outside a quoted value: they have to agree
        if tag_end(source, start.start() + 1, true, &mut budget)? != open_end {
            return Err(ambiguous());
        }

        let Some(end) = closes.by_ref().find(|close| close.start() >= open_end) else {
            return Err(redaction_error("a withheld span is never closed"));
        };
        // the closing tag ends at the first ">" or is not a plain one
        let closing = &source[end.start()..];
        let closing = &closing[..closing.find('>').map_or(closing.len(), |gt| gt + 1)];
        let Some(tag) = plain_close_re().exec(closing) else {
            return Err(ambiguous());
        };
        let close_end = end.start() + tag.end();
        assert_closes_here(source, open_end, end.start(), close_end)?;

        let found = label_re().exec(start.as_str());
        let label = found
            .as_ref()
            .and_then(|m| m.get(1).or(m.get(2)))
            .unwrap_or("private");
        let label = truthy(Some(trim(label))).unwrap_or("private");
        kept.push((cursor, start.start()));
        out.push_str(&source[cursor..start.start()]);
        out.push_str(&placeholder_source(label));
        cursor = close_end;
    }
    kept.push((cursor, source.len()));
    out.push_str(&source[cursor..]);
    assert_no_unread_mark(source, &kept, &mut budget)?;
    Ok(out)
}

/// The spans above were found by the editor's own pattern, which is all its
/// inline reading has. An HTML block is read by a real parser instead, and that
/// one also sees the attribute behind a `>` inside a quoted value, where the
/// pattern stops. So a mark name left standing inside the extent of a span's
/// start tag, as a parser would delimit it, is a mark that was not read. A name
/// anywhere else is only text.
fn assert_no_unread_mark(
    source: &str,
    kept: &[(usize, usize)],
    budget: &mut Budget,
) -> Result<(), String> {
    let names: Vec<usize> = mark_name_re()
        .find_iter(source)
        .map(|m| m.start())
        .filter(|&at| kept.iter().any(|&(from, to)| at >= from && at < to))
        .collect();
    let Some(&last) = names.last() else {
        return Ok(());
    };
    for s in span_start_re().find_iter(source) {
        if s.start() >= last {
            break;
        }
        let end = tag_end(source, s.start() + 1, false, budget)?;
        if names.iter().any(|&at| at > s.start() && at < end) {
            return Err(redaction_error(
                "a withheld span is written in a form that cannot be read",
            ));
        }
    }
    Ok(())
}
