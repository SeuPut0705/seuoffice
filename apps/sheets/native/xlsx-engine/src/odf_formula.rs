//! Formula translation between Excel syntax and OpenFormula, in both
//! directions the `.ods` bridge needs.
//!
//! An ODS cell keeps its formula in the `table:formula` attribute, written in
//! OpenFormula: `of:=SUM([.B1:.B2])`, with references in brackets, arguments
//! separated by `;` and an `of:` namespace ahead of the `=`. calamine hands
//! that text over verbatim, and an .xlsx carrying it does not calculate:
//! Excel matches `[.B1:.B2]` to nothing and shows the cached value forever.
//! `translate_with` rewrites that text for the import, and `to_odf_with`
//! writes the export's `table:formula` back the other way (decision 0119).
//!
//! Both directions translate the pieces the two dialects can both say and
//! refuse the rest (decision 0119). A refused formula leaves the cell with
//! its cached value only, and the count of refused cells travels back to the
//! caller as `formulasDropped`. Refusing is the safe direction: a wrong
//! translation would silently change the numbers in the document.

use std::collections::HashSet;

use crate::odf_functions::{EXCEL_ONLY, ODF_ONLY, RENAMED, XLFN, XLWS};

/// The defined names a document carries on both sides of the conversion. A
/// bare word in a formula is only translatable when it is one of them; names
/// compare without case, as Excel compares them.
#[derive(Default)]
pub(crate) struct Names(HashSet<String>);

impl Names {
    pub(crate) fn insert(&mut self, name: &str) {
        self.0.insert(name.to_uppercase());
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.0.contains(&name.to_uppercase())
    }
}

/// Translates one `table:formula` value into Excel syntax, for a document with
/// no defined names.
#[cfg(test)]
pub(crate) fn translate(raw: &str) -> Option<String> {
    translate_with(raw, &Names::default())
}

/// Translates one `table:formula` value into Excel syntax.
///
/// `None` means "not confidently translatable" — the caller keeps the cached
/// value and counts the cell. A formula is refused rather than guessed when it
/// carries a namespace Excel has no spelling for (`oooc:`, `msoxl:`), a name
/// the document does not define, a union in a place Excel would read as an
/// argument separator, or a function only ODF knows.
pub(crate) fn translate_with(raw: &str, names: &Names) -> Option<String> {
    let body = formula_body(raw.trim())?;
    let translated = expression(body, names)?;
    if translated.is_empty() {
        return None;
    }
    Some(translated)
}

/// Translates the body of a named expression (`table:expression`), which has
/// no `of:=` in front of it.
pub(crate) fn translate_expression(raw: &str, names: &Names) -> Option<String> {
    let body = raw.trim();
    let body = formula_body(body).unwrap_or(body);
    let translated = expression(body, names)?;
    (!translated.is_empty()).then_some(translated)
}

/// A `table:cell-range-address` (`$Data.$C$2:.$C$5`) in Excel's spelling
/// (`Data!$C$2:$C$5`).
pub(crate) fn excel_range(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() {
        return None;
    }
    reference(address)
}

/// The expression behind the namespace: `of:=SUM(…)` → `SUM(…)`.
///
/// OpenFormula puts a namespace ahead of the `=`, and only `of` (the shared
/// OpenFormula set) has an Excel spelling. `oooc` holds LibreOffice-only
/// functions and `msoxl` holds Excel functions written with `_xlfn`-style
/// names; neither survives a translation this code can vouch for.
fn formula_body(raw: &str) -> Option<&str> {
    let namespace_len = raw
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric())
        .count();
    if raw.as_bytes().get(namespace_len..namespace_len + 2) == Some(b":=") {
        let body = &raw[namespace_len + 2..];
        return match &raw[..namespace_len] {
            "of" => Some(body.trim_start()),
            _ => None,
        };
    }
    raw.strip_prefix('=').map(str::trim_start)
}

/// Walks the expression once, copying what both dialects spell the same way
/// and translating the pieces that differ.
fn expression(text: &str, names: &Names) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    // One entry per open `(`: true when it starts a function call's argument
    // list, false when it only groups an expression. A union is only
    // translatable inside a group: Excel spells it with the comma that
    // separates arguments everywhere else.
    let mut calls: Vec<bool> = Vec::new();
    let mut after_call_name = false;
    let mut in_array = false;
    while let Some(character) = rest.chars().next() {
        let was_call_name = std::mem::take(&mut after_call_name);
        match character {
            '"' => {
                let (literal, remainder) = string_literal(rest)?;
                out.push_str(literal);
                rest = remainder;
            }
            '[' => {
                let (inner, remainder) = bracketed(rest)?;
                out.push_str(&reference(inner)?);
                rest = remainder;
            }
            '(' => {
                calls.push(was_call_name);
                out.push('(');
                rest = &rest[1..];
            }
            ')' => {
                calls.pop()?;
                out.push(')');
                rest = &rest[1..];
            }
            // Arguments, and the columns of an inline array: OpenFormula
            // separates both with `;`.
            ';' => {
                out.push(',');
                rest = &rest[1..];
            }
            // The rows of an inline array.
            '|' => {
                if !in_array {
                    return None;
                }
                out.push(';');
                rest = &rest[1..];
            }
            '{' => {
                if in_array {
                    return None;
                }
                in_array = true;
                out.push('{');
                rest = &rest[1..];
            }
            '}' => {
                if !in_array {
                    return None;
                }
                in_array = false;
                out.push('}');
                rest = &rest[1..];
            }
            // Union: Excel's comma, which only reads as a union inside
            // grouping parentheses. Anywhere else it would turn one argument
            // into two.
            '~' => {
                if in_array || calls.last() != Some(&false) {
                    return None;
                }
                out.push(',');
                rest = &rest[1..];
            }
            // Intersection: Excel's space between two references.
            '!' => {
                if in_array {
                    return None;
                }
                out.push(' ');
                rest = &rest[1..];
            }
            // A quoted sheet name outside a reference, and bare `$` or `#`
            // (an error literal), have no reading here.
            '\'' | '$' | '#' => return None,
            '.' => {
                if !rest[1..]
                    .chars()
                    .next()
                    .is_some_and(|next| next.is_ascii_digit())
                {
                    return None;
                }
                let end = number_end(rest);
                out.push_str(&rest[..end]);
                rest = &rest[end..];
            }
            character if character.is_ascii_digit() => {
                let end = number_end(rest);
                out.push_str(&rest[..end]);
                rest = &rest[end..];
            }
            character if is_identifier_start(character) => {
                let end = identifier_end(rest);
                let name = &rest[..end];
                let after = &rest[end..];
                let trimmed = after.trim_start();
                let is_call = trimmed.starts_with('(');
                out.push_str(&function_or_value(name, is_call, names)?);
                after_call_name = is_call;
                rest = if is_call { trimmed } else { after };
            }
            // Layout only. Copying it through could put a space between two
            // references, which Excel reads as an intersection.
            character if character.is_whitespace() => {
                rest = rest.trim_start();
            }
            _ => {
                out.push(character);
                rest = &rest[character.len_utf8()..];
            }
        }
    }
    if !calls.is_empty() || in_array {
        return None;
    }
    Some(out)
}

fn is_identifier_start(character: char) -> bool {
    character.is_alphabetic() || character == '_'
}

/// The end of a word in an Excel formula: a function name may carry a dot
/// (`ERROR.TYPE`) and a reference may carry `$` markers.
fn word_end(text: &str) -> usize {
    let mut end = 0;
    for character in text.chars() {
        if !(character.is_alphanumeric() || character == '_' || character == '.' || character == '$')
        {
            break;
        }
        end += character.len_utf8();
    }
    end
}

/// Function names may carry a namespace (`COM.MICROSOFT.`), so a dot is part
/// of the name rather than the end of it.
fn identifier_end(text: &str) -> usize {
    let mut end = 0;
    for character in text.chars() {
        if !(character.is_alphanumeric() || character == '_' || character == '.') {
            break;
        }
        end += character.len_utf8();
    }
    end
}

/// The end of a numeric literal: digits, an optional fraction, an optional
/// exponent. A `+` or `-` belongs to the number only right after the `e`.
fn number_end(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut end = 0;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let mut exponent = end + 1;
        if exponent < bytes.len() && (bytes[exponent] == b'+' || bytes[exponent] == b'-') {
            exponent += 1;
        }
        let digits = exponent;
        while exponent < bytes.len() && bytes[exponent].is_ascii_digit() {
            exponent += 1;
        }
        if exponent > digits {
            end = exponent;
        }
    }
    end
}

/// A string literal and what follows it. Both dialects escape an embedded
/// quote by doubling it, so the literal is copied through unchanged.
fn string_literal(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    let mut index = 1;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            if bytes.get(index + 1) == Some(&b'"') {
                index += 2;
                continue;
            }
            return Some((&text[..index + 1], &text[index + 1..]));
        }
        index += 1;
    }
    None
}

/// The text inside `[` … `]` and what follows it. A quoted sheet name may hold
/// a bracket, so the closing bracket is only taken outside single quotes.
fn bracketed(text: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (index, character) in text.char_indices().skip(1) {
        match character {
            '\'' => quoted = !quoted,
            ']' if !quoted => return Some((&text[1..index], &text[index + 1..])),
            _ => {}
        }
    }
    None
}

/// One endpoint of a reference as OpenFormula spells it: an optional sheet
/// name and the address inside it.
struct CellReference {
    sheet: Option<String>,
    address: String,
    kind: AddressKind,
}

/// How an address names its target. A whole column or row is only a reference
/// as one half of `A:B` / `1:2`; alone it would read as a name in Excel.
#[derive(Clone, Copy, PartialEq)]
enum AddressKind {
    Cell,
    Column,
    Row,
}

/// `[.B1]` → `B1`, `[.B1:.B2]` → `B1:B2`, `[Sheet1.B1]` → `Sheet1!B1`,
/// `[$Sheet1.$B$1]` → `Sheet1!$B$1`.
fn reference(inner: &str) -> Option<String> {
    let (first_text, second_text) = match split_range(inner) {
        Some((first, second)) => (first, Some(second)),
        None => (inner, None),
    };
    let first = endpoint(first_text)?;
    let mut out = String::new();
    if let Some(sheet) = &first.sheet {
        out.push_str(&sheet_prefix(sheet));
    }
    match second_text {
        None => {
            if first.kind != AddressKind::Cell {
                return None;
            }
            out.push_str(&first.address);
        }
        Some(second_text) => {
            let second = endpoint(second_text)?;
            // A range across two sheets is a 3-D reference, which Excel spells
            // with the sheets joined (`Sheet1:Sheet2!A1`). Refusing is cheaper
            // than proving this translation right.
            if second.sheet.is_some() && second.sheet != first.sheet {
                return None;
            }
            if second.kind != first.kind {
                return None;
            }
            out.push_str(&first.address);
            out.push(':');
            out.push_str(&second.address);
        }
    }
    Some(out)
}

fn split_range(inner: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (index, character) in inner.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            ':' if !quoted => return Some((&inner[..index], &inner[index + 1..])),
            _ => {}
        }
    }
    None
}

fn endpoint(text: &str) -> Option<CellReference> {
    // `[$Sheet1.…]`: the `$` locks the sheet, not part of its name.
    let text = text.strip_prefix('$').unwrap_or(text);
    let (sheet, address) = if let Some(rest) = text.strip_prefix('\'') {
        let (name, rest) = quoted_name(rest)?;
        (Some(name), rest.strip_prefix('.')?)
    } else {
        let dot = text.find('.')?;
        let name = &text[..dot];
        (
            (!name.is_empty()).then(|| name.to_string()),
            &text[dot + 1..],
        )
    };
    let (address, kind) = cell_address(address)?;
    Some(CellReference {
        sheet,
        address,
        kind,
    })
}

/// A sheet name that was quoted with `'`, with `''` standing for one quote.
fn quoted_name(text: &str) -> Option<(String, &str)> {
    let bytes = text.as_bytes();
    let mut name = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\'' {
            if bytes.get(index + 1) == Some(&b'\'') {
                name.push('\'');
                index += 2;
                continue;
            }
            return Some((name, &text[index + 1..]));
        }
        let character = text[index..].chars().next()?;
        name.push(character);
        index += character.len_utf8();
    }
    None
}

/// A cell, whole-column or whole-row address in Excel's A1 spelling, with the
/// `$` markers kept. `None` for anything outside the grid.
fn cell_address(text: &str) -> Option<(String, AddressKind)> {
    let mut rest = text;
    let column_absolute = rest.starts_with('$');
    if column_absolute {
        rest = &rest[1..];
    }
    let column_end = rest
        .find(|character: char| !character.is_ascii_alphabetic())
        .unwrap_or(rest.len());
    let column = &rest[..column_end];
    let mut rest = &rest[column_end..];
    // With no column in front of it (`$1`), the marker locks the row.
    let mut row_absolute = column.is_empty() && column_absolute;
    if rest.starts_with('$') {
        row_absolute = true;
        rest = &rest[1..];
    }
    let row = rest;
    if column.len() > 3 || !row.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let kind = match (column.is_empty(), row.is_empty()) {
        (false, false) => AddressKind::Cell,
        (false, true) => AddressKind::Column,
        (true, false) => AddressKind::Row,
        (true, true) => return None,
    };
    if !column.is_empty() {
        let number = column.chars().fold(0u32, |total, character| {
            total * 26 + (character.to_ascii_uppercase() as u32 - 'A' as u32 + 1)
        });
        if !(1..=16_384).contains(&number) {
            return None;
        }
    }
    if !row.is_empty() {
        let number: u32 = row.parse().ok()?;
        if !(1..=1_048_576).contains(&number) {
            return None;
        }
    }
    let mut address = String::with_capacity(text.len());
    if column_absolute && !column.is_empty() {
        address.push('$');
    }
    address.push_str(column);
    if row_absolute && !row.is_empty() {
        address.push('$');
    }
    address.push_str(row);
    Some((address, kind))
}

/// `Sheet1!` or `'My Sheet'!` — Excel needs the quotes for a name holding a
/// space or another special character, and an embedded quote doubles.
fn sheet_prefix(name: &str) -> String {
    if needs_quotes(name) {
        format!("'{}'!", name.replace('\'', "''"))
    } else {
        format!("{name}!")
    }
}

fn needs_quotes(name: &str) -> bool {
    name.is_empty()
        || name.starts_with(|character: char| character.is_ascii_digit())
        || name
            .chars()
            .any(|character| !(character.is_alphanumeric() || character == '_'))
        || cell_address(name).is_some()
}

fn function_or_value(name: &str, is_call: bool, names: &Names) -> Option<String> {
    if name.eq_ignore_ascii_case("TRUE") || name.eq_ignore_ascii_case("FALSE") {
        return Some(name.to_owned());
    }
    if !is_call {
        // A bare word is a defined name, which only travels when the
        // document's own names carry it across.
        return names.contains(name).then(|| name.to_owned());
    }
    excel_function(name)
}

/// The Excel spelling of an OpenFormula function name, with the storage
/// marker Excel expects in front of the functions it added after 2007.
fn excel_function(name: &str) -> Option<String> {
    let upper = name.to_ascii_uppercase();
    if ODF_ONLY.contains(&upper.as_str()) {
        return None;
    }
    let (excel, newer) = if let Some((excel, _)) = RENAMED.iter().find(|(_, odf)| *odf == upper)
    {
        ((*excel).to_owned(), false)
    } else if let Some(stripped) = upper.strip_prefix("COM.MICROSOFT.") {
        // An Excel function the table predates: the namespace alone says it
        // is one Excel stores behind its marker.
        if stripped.is_empty() {
            return None;
        }
        (stripped.to_owned(), true)
    } else if upper.contains('.') {
        // The dotted names both dialects spell alike; every other dotted name
        // belongs to a namespace Excel does not have.
        if !SHARED_DOTTED_FUNCTIONS.contains(&upper.as_str()) {
            return None;
        }
        (upper, false)
    } else {
        (name.to_owned(), false)
    };
    let key = excel.to_ascii_uppercase();
    if XLWS.contains(&key.as_str()) {
        return Some(format!("_xlfn._xlws.{excel}"));
    }
    if newer || XLFN.contains(&key.as_str()) {
        return Some(format!("_xlfn.{excel}"));
    }
    Some(excel)
}

/// Dotted function names that are the same word in both dialects.
const SHARED_DOTTED_FUNCTIONS: [&str; 2] = ["ERROR.TYPE", "BINOM.DIST.RANGE"];

/// Translates one Excel formula into OpenFormula, for a workbook with no
/// defined names.
#[cfg(test)]
pub(crate) fn to_odf(raw: &str) -> Option<String> {
    to_odf_with(raw, &Names::default())
}

/// Translates one Excel formula into the OpenFormula value a `table:formula`
/// attribute carries: `SUM(B1:B2)` → `of:=SUM([.B1:.B2])`.
///
/// `None` means "not confidently translatable" — the exporter keeps the cell's
/// cached value and counts it in `formulasDropped`. The refused shapes are a
/// name the workbook does not define (or one the export could not write), a
/// structured or external reference, an error literal, the spill and implicit
/// intersection operators, a 3-D reference, and a function OpenFormula has no
/// name for.
pub(crate) fn to_odf_with(raw: &str, names: &Names) -> Option<String> {
    Some(format!("of:={}", odf_expression(raw, names)?))
}

/// The body of a named expression (`table:expression`): the same translation
/// without the `of:=` a cell formula starts with.
pub(crate) fn odf_named_expression(raw: &str, names: &Names) -> Option<String> {
    odf_expression(raw, names)
}

/// `Sheet1!$A$1:$B$2` → `$Sheet1.$A$1:.$B$2`, the address a named range, a
/// print range and a database range take. `None` unless the text is exactly
/// one sheet-qualified cell or range.
pub(crate) fn odf_range_address(raw: &str) -> Option<String> {
    let translated = odf_expression(raw, &Names::default())?;
    let inner = translated.strip_prefix('[')?.strip_suffix(']')?;
    if inner.starts_with('.') || inner.contains('[') || inner.contains(']') {
        return None;
    }
    Some(inner.to_owned())
}

/// An Excel hyperlink location (`#Sheet1!A1`, `#'My Sheet'!B2:C3`, `#A1` or a
/// defined name) as the `#Sheet1.A1` an ODF link points at.
pub(crate) fn odf_internal_link(location: &str, current_sheet: &str) -> Option<String> {
    let location = location.trim().trim_start_matches('#');
    if location.is_empty() {
        return None;
    }
    let Some(translated) = odf_expression(location, &Names::default()) else {
        // Not an address: a defined name keeps its own spelling.
        let plain = location
            .chars()
            .all(|character| character.is_alphanumeric() || character == '_');
        return plain.then(|| format!("#{location}"));
    };
    let inner = translated.strip_prefix('[')?.strip_suffix(']')?;
    if inner.contains('[') {
        return None;
    }
    match inner.strip_prefix('.') {
        Some(address) => Some(format!(
            "#{}.{}",
            odf_sheet_name(current_sheet),
            address.replace(":.", ":")
        )),
        None => Some(format!(
            "#{}",
            inner.strip_prefix('$').unwrap_or(inner).replace(":.", ":")
        )),
    }
}

fn odf_expression(raw: &str, names: &Names) -> Option<String> {
    let body = raw.trim_start();
    let body = body.strip_prefix('=').map(str::trim_start).unwrap_or(body);
    if body.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(body.len() + 8);
    let mut rest = body;
    // True when the last token can end a reference expression: a reference, a
    // defined name or a closing parenthesis. Excel's intersection operator is
    // a space between two such operands; a space anywhere else is layout.
    let mut previous_operand = false;
    // One entry per open `(`: true when it starts a function call's argument
    // list, false when it only groups an expression. The two spell a comma
    // differently — `SUM(A1,B1)` separates arguments, `SUM((A1,B1))` joins two
    // references into a union — so the difference has to be remembered.
    let mut calls: Vec<bool> = Vec::new();
    // Set by a function name and read by the `(` that follows it (a space
    // between the two is layout, so the flag survives the whitespace arm).
    let mut after_call_name = false;
    // Inside `{…}` only literals may appear; `,` separates columns and `;`
    // rows, which OpenFormula spells `;` and `|`.
    let mut in_array = false;
    while let Some(character) = rest.chars().next() {
        match character {
            '"' => {
                let (literal, remainder) = string_literal(rest)?;
                out.push_str(literal);
                rest = remainder;
                previous_operand = false;
                after_call_name = false;
            }
            '\'' => {
                if in_array {
                    return None;
                }
                // A quoted name can only be a sheet ahead of `!`; Excel's
                // string literals use double quotes.
                let quoted = rest.strip_prefix('\'')?;
                let (name, remainder) = quoted_name(quoted)?;
                let remainder = remainder.strip_prefix('!')?;
                let (reference, remainder) = reference_at(remainder, Some(&name))?;
                out.push_str(&reference);
                rest = remainder;
                previous_operand = true;
                after_call_name = false;
            }
            character if character.is_whitespace() => {
                rest = rest.trim_start();
                if previous_operand
                    && rest
                        .chars()
                        .next()
                        .is_some_and(|next| next.is_alphabetic() || matches!(next, '$' | '\'' | '_' | '('))
                {
                    // Intersection, which OpenFormula spells `!`.
                    out.push('!');
                    previous_operand = false;
                }
            }
            ',' => {
                if in_array || calls.last() == Some(&true) {
                    // An argument, or the next column of an inline array.
                    out.push(';');
                } else if calls.last() == Some(&false) {
                    // Excel's union operator: a comma inside grouping
                    // parentheses joins two references into one multi-area
                    // reference. OpenFormula spells it `~`.
                    out.push('~');
                } else {
                    return None;
                }
                rest = &rest[1..];
                previous_operand = false;
                after_call_name = false;
            }
            ';' => {
                // The next row of an inline array; anywhere else the stored
                // formula has no use for it.
                if !in_array {
                    return None;
                }
                out.push('|');
                rest = &rest[1..];
            }
            '{' => {
                if in_array {
                    return None;
                }
                in_array = true;
                out.push('{');
                rest = &rest[1..];
                previous_operand = false;
                after_call_name = false;
            }
            '}' => {
                if !in_array {
                    return None;
                }
                in_array = false;
                out.push('}');
                rest = &rest[1..];
                previous_operand = false;
            }
            '(' => {
                if in_array {
                    return None;
                }
                calls.push(after_call_name);
                out.push('(');
                rest = &rest[1..];
                previous_operand = false;
                after_call_name = false;
            }
            ')' => {
                // A close without an open cannot be part of a formula this
                // translation understands.
                calls.pop()?;
                out.push(')');
                rest = &rest[1..];
                previous_operand = true;
                after_call_name = false;
            }
            '.' => {
                if !rest[1..]
                    .chars()
                    .next()
                    .is_some_and(|next| next.is_ascii_digit())
                {
                    return None;
                }
                let end = number_end(rest);
                out.push_str(&rest[..end]);
                rest = &rest[end..];
                previous_operand = false;
                after_call_name = false;
            }
            character if character.is_ascii_digit() => {
                // A whole-row range starts with a digit: `1:2`.
                if let Some((reference, remainder)) =
                    (!in_array).then(|| reference_at(rest, None)).flatten()
                {
                    out.push_str(&reference);
                    rest = remainder;
                    previous_operand = true;
                } else {
                    let end = number_end(rest);
                    out.push_str(&rest[..end]);
                    rest = &rest[end..];
                    previous_operand = false;
                }
                after_call_name = false;
            }
            character if is_identifier_start(character) || character == '$' => {
                if in_array {
                    // The only words an inline array holds are the booleans.
                    let end = word_end(rest);
                    let word = &rest[..end];
                    if !(word.eq_ignore_ascii_case("TRUE") || word.eq_ignore_ascii_case("FALSE")) {
                        return None;
                    }
                    out.push_str(&word.to_ascii_uppercase());
                    rest = &rest[end..];
                    continue;
                }
                let (token, remainder, kind) = word_at(rest, names)?;
                out.push_str(&token);
                rest = remainder;
                previous_operand = matches!(kind, WordKind::Reference);
                after_call_name = matches!(kind, WordKind::Call);
            }
            // Structured and external references, error literals, the spill
            // and implicit-intersection operators, a stray range colon, and
            // the characters only OpenFormula uses.
            '[' | ']' | ':' | '#' | '@' | '!' | '~' | '|' => return None,
            _ => {
                out.push(character);
                rest = &rest[character.len_utf8()..];
                previous_operand = false;
                after_call_name = false;
            }
        }
    }
    if !calls.is_empty() || in_array {
        return None;
    }
    Some(out)
}

/// What a copied word turned out to be. The caller needs the difference to
/// know whether the `(` after it opens an argument list.
enum WordKind {
    Reference,
    Call,
    Value,
}

/// One word and what follows it: a function call, a sheet-qualified
/// reference, a bare `TRUE`/`FALSE`, a reference, or a defined name. The
/// returned kind says what the copied token was: the intersection check needs
/// to know whether it was a reference, and the comma check whether the next
/// `(` opens a call.
fn word_at<'a>(text: &'a str, names: &Names) -> Option<(String, &'a str, WordKind)> {
    let end = word_end(text);
    if end == 0 {
        return None;
    }
    let word = &text[..end];
    let after = text[end..].trim_start();
    if after.starts_with('(') {
        return Some((odf_function(word)?, &text[end..], WordKind::Call));
    }
    if let Some(qualified) = after.strip_prefix('!') {
        let (reference, remainder) = reference_at(qualified, Some(word))?;
        return Some((reference, remainder, WordKind::Reference));
    }
    if word.eq_ignore_ascii_case("TRUE") {
        return Some(("TRUE()".to_owned(), &text[end..], WordKind::Value));
    }
    if word.eq_ignore_ascii_case("FALSE") {
        return Some(("FALSE()".to_owned(), &text[end..], WordKind::Value));
    }
    // A defined name the export also writes. It is looked up before the word
    // is read as an address, because a name may start like one (`Q1_Sales`).
    if names.contains(word) {
        return Some((word.to_owned(), &text[end..], WordKind::Reference));
    }
    let (reference, remainder) = reference_at(text, None)?;
    // An address that ends inside the word was not an address.
    if text.len() - remainder.len() < end {
        return None;
    }
    Some((reference, remainder, WordKind::Reference))
}

/// The OpenFormula spelling of an Excel function name.
fn odf_function(word: &str) -> Option<String> {
    let upper = word.to_ascii_uppercase();
    // The index strips Excel's storage markers before the exporter sees a
    // formula; one that arrives another way may still carry them.
    let name = upper.strip_prefix("_XLFN.").unwrap_or(&upper);
    let name = name.strip_prefix("_XLWS.").unwrap_or(name);
    if name.is_empty() || EXCEL_ONLY.contains(&name) {
        return None;
    }
    if let Some((_, odf)) = RENAMED.iter().find(|(excel, _)| *excel == name) {
        return Some((*odf).to_owned());
    }
    // A dotted name outside the table is one this code has not seen a
    // reader accept.
    if name.contains('.') && !SHARED_DOTTED_FUNCTIONS.contains(&name) {
        return None;
    }
    Some(name.to_owned())
}

/// One endpoint of an Excel reference as written: `$A$1`, `A`, `1`.
struct ExcelEndpoint {
    address: String,
    kind: AddressKind,
}

/// `A1`, `A1:B2`, `$A:$A`, `1:2` → the OpenFormula spelling and what follows.
/// `sheet` is the qualifier the caller already read, if any; the sheet is
/// written absolute because an Excel sheet reference never shifts with the
/// cell.
fn reference_at<'a>(text: &'a str, sheet: Option<&str>) -> Option<(String, &'a str)> {
    let (first, rest) = endpoint_at(text)?;
    let (second, rest) = match rest.strip_prefix(':') {
        Some(after) => {
            let (second, rest) = endpoint_at(after)?;
            if second.kind != first.kind {
                return None;
            }
            (Some(second), rest)
        }
        None => (None, rest),
    };
    // Half of a range is only a reference in Excel; a bare column would read
    // as a defined name.
    if second.is_none() && first.kind != AddressKind::Cell {
        return None;
    }
    let mut out = String::from("[");
    match sheet {
        Some(name) => {
            out.push('$');
            out.push_str(&odf_sheet_name(name));
            out.push('.');
        }
        None => out.push('.'),
    }
    out.push_str(&first.address);
    if let Some(second) = second {
        out.push(':');
        out.push('.');
        out.push_str(&second.address);
    }
    out.push(']');
    Some((out, rest))
}

fn endpoint_at(text: &str) -> Option<(ExcelEndpoint, &str)> {
    let mut rest = text;
    let column_absolute = rest.starts_with('$');
    if column_absolute {
        rest = &rest[1..];
    }
    let column_end = rest
        .find(|character: char| !character.is_ascii_alphabetic())
        .unwrap_or(rest.len());
    let column = &rest[..column_end];
    rest = &rest[column_end..];
    // Excel's last column is XFD; a longer run of letters is a name, not an
    // address (and would overflow the column arithmetic below).
    if column.len() > 3 {
        return None;
    }
    // With no column in front of it (`$1`), the marker locks the row.
    let mut row_absolute = column.is_empty() && column_absolute;
    if rest.starts_with('$') {
        row_absolute = true;
        rest = &rest[1..];
    }
    let row_end = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    let row = &rest[..row_end];
    rest = &rest[row_end..];
    let kind = match (column.is_empty(), row.is_empty()) {
        (false, false) => AddressKind::Cell,
        (false, true) => AddressKind::Column,
        (true, false) => AddressKind::Row,
        (true, true) => return None,
    };
    if !column.is_empty() {
        let number = column.chars().fold(0u32, |total, character| {
            total * 26 + (character.to_ascii_uppercase() as u32 - 'A' as u32 + 1)
        });
        if !(1..=16_384).contains(&number) {
            return None;
        }
    }
    if !row.is_empty() {
        let number: u32 = row.parse().ok()?;
        if !(1..=1_048_576).contains(&number) {
            return None;
        }
    }
    let mut address = String::with_capacity(column.len() + row.len() + 2);
    if column_absolute && !column.is_empty() {
        address.push('$');
    }
    address.push_str(column);
    if row_absolute && !row.is_empty() {
        address.push('$');
    }
    address.push_str(row);
    Some((ExcelEndpoint { address, kind }, rest))
}

/// The sheet name inside a bracketed reference, quoted when it needs to be
/// (the same rule the Excel side follows, with `''` for one quote).
pub(crate) fn odf_sheet_name(name: &str) -> String {
    if needs_quotes(name) {
        format!("'{}'", name.replace('\'', "''"))
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_namespace_and_rewrites_relative_references() {
        assert_eq!(
            translate("of:=SUM([.B1:.B2])").as_deref(),
            Some("SUM(B1:B2)")
        );
        assert_eq!(translate("of:=[.B1]*2+[.C3]").as_deref(), Some("B1*2+C3"));
    }

    #[test]
    fn keeps_absolute_and_sheet_qualified_references() {
        assert_eq!(
            translate("of:=[$Sheet1.$B$1]+[Other.A2]").as_deref(),
            Some("Sheet1!$B$1+Other!A2")
        );
        assert_eq!(
            translate("of:=[Sheet1.A1:.B2]").as_deref(),
            Some("Sheet1!A1:B2")
        );
        assert_eq!(translate("of:=[.$A$1]").as_deref(), Some("$A$1"));
        // An absolute, quoted sheet: the `$` locks the sheet, the quotes are
        // the name's own.
        assert_eq!(
            translate("of:=[$'My Sheet'.$A$1]").as_deref(),
            Some("'My Sheet'!$A$1")
        );
    }

    #[test]
    fn translates_whole_column_and_whole_row_ranges() {
        assert_eq!(
            translate("of:=SUM([.A:.A])").as_deref(),
            Some("SUM(A:A)")
        );
        assert_eq!(translate("of:=SUM([.1:.2])").as_deref(), Some("SUM(1:2)"));
        assert_eq!(
            translate("of:=SUM([.$1:.$2])").as_deref(),
            Some("SUM($1:$2)")
        );
        assert_eq!(
            to_odf("=SUM($1:$2)").as_deref(),
            Some("of:=SUM([.$1:.$2])")
        );
        // Half a reference is not one in Excel: a bare column would read as a
        // defined name.
        assert_eq!(translate("of:=[.A]"), None);
    }

    #[test]
    fn quotes_sheet_names_that_need_it() {
        assert_eq!(
            translate("of:=[My Sheet.A1]").as_deref(),
            Some("'My Sheet'!A1")
        );
        assert_eq!(
            translate("of:=['O''Brien'.$A$1]").as_deref(),
            Some("'O''Brien'!$A$1")
        );
        // A name that reads like a cell address needs quotes as well.
        assert_eq!(translate("of:=[A1.B2]").as_deref(), Some("'A1'!B2"));
    }

    #[test]
    fn rewrites_argument_separators_but_not_inside_strings() {
        assert_eq!(
            translate(r#"of:=IF([.A1]>0;"a;b";"c""d")"#).as_deref(),
            Some(r#"IF(A1>0,"a;b","c""d")"#)
        );
    }

    #[test]
    fn keeps_functions_both_dialects_spell_the_same() {
        assert_eq!(translate("of:=TRUE()").as_deref(), Some("TRUE()"));
        assert_eq!(
            translate("of:=IF(TRUE();1;FALSE())").as_deref(),
            Some("IF(TRUE(),1,FALSE())")
        );
        assert_eq!(
            translate("of:=COM.MICROSOFT.IFS([.A1]>1;2)").as_deref(),
            Some("_xlfn.IFS(A1>1,2)")
        );
        // `ERROR.TYPE` is a dotted name both dialects share.
        assert_eq!(
            translate("of:=ERROR.TYPE([.A1])").as_deref(),
            Some("ERROR.TYPE(A1)")
        );
    }

    #[test]
    fn refuses_what_it_cannot_translate() {
        for raw in [
            "oooc:=SUM(A1:A2)",
            "msoxl:=SUM(A1:A2)",
            "of:=[.A1]~[.A2]",
            "of:=SUM([.A1]~[.A2])",
            "of:={1;{2}}",
            "of:=1|2",
            "of:=MyRange",
            "of:=CHISQDIST([.A1];2)",
            "of:=ORG.LIBREOFFICE.FOO([.A1])",
            "of:=ORG.OPENOFFICE.STYLE([.A1])",
            "of:=STYLE([.A1])",
            "of:=[#This Row]",
            "of:=Sheet1.A1",
            "of:=[.A1",
            "of:=[.A]",
            "",
            "SUM([.A1:.A2])",
        ] {
            assert_eq!(translate(raw), None, "{raw}");
        }
    }

    #[test]
    fn writes_references_and_ranges_for_the_export() {
        assert_eq!(
            to_odf("=SUM(B1:B2)").as_deref(),
            Some("of:=SUM([.B1:.B2])")
        );
        assert_eq!(to_odf("=B1*2+C3").as_deref(), Some("of:=[.B1]*2+[.C3]"));
        assert_eq!(
            to_odf("=SUM($A:$A)").as_deref(),
            Some("of:=SUM([.$A:.$A])")
        );
        assert_eq!(to_odf("=SUM(1:2)").as_deref(), Some("of:=SUM([.1:.2])"));
    }

    #[test]
    fn writes_sheet_qualified_references() {
        assert_eq!(
            to_odf("=Sheet1!$B$1").as_deref(),
            Some("of:=[$Sheet1.$B$1]")
        );
        assert_eq!(
            to_odf("='My Sheet'!A1:B2").as_deref(),
            Some("of:=[$'My Sheet'.A1:.B2]")
        );
        assert_eq!(
            to_odf("='O''Brien'!$A$1*2").as_deref(),
            Some("of:=[$'O''Brien'.$A$1]*2")
        );
        // A name that reads like a cell address needs quotes as well.
        assert_eq!(to_odf("='A1'!B2").as_deref(), Some("of:=[$'A1'.B2]"));
    }

    #[test]
    fn rewrites_argument_separators_for_the_export() {
        assert_eq!(
            to_odf(r#"=IF(A1>0,"a;b","c""d")"#).as_deref(),
            Some(r#"of:=IF([.A1]>0;"a;b";"c""d")"#)
        );
    }

    #[test]
    fn a_comma_separates_arguments_only_inside_a_call() {
        assert_eq!(
            to_odf("=SUM(A1,B1)").as_deref(),
            Some("of:=SUM([.A1];[.B1])")
        );
        assert_eq!(
            to_odf("=IF(A1,SUM(B1,C1),0)").as_deref(),
            Some("of:=IF([.A1];SUM([.B1];[.C1]);0)")
        );
        // A space between the name and its `(` is layout, not a break.
        assert_eq!(
            to_odf("=SUM (A1,B1)").as_deref(),
            Some("of:=SUM([.A1];[.B1])")
        );
        // A comma inside grouping parentheses is Excel's union operator (a
        // multi-area reference), which OpenFormula spells `~`.
        assert_eq!(
            to_odf("=SUM((A1,B1))").as_deref(),
            Some("of:=SUM(([.A1]~[.B1]))")
        );
        assert_eq!(
            to_odf("=SUM((A1:A2,C1),D1)").as_deref(),
            Some("of:=SUM(([.A1:.A2]~[.C1]);[.D1])")
        );
        assert_eq!(to_odf("=A1,B1"), None);
        // Grouping without a comma is an ordinary expression.
        assert_eq!(
            to_odf("=(A1+B1)*2").as_deref(),
            Some("of:=([.A1]+[.B1])*2")
        );
    }

    #[test]
    fn keeps_functions_for_the_export() {
        assert_eq!(to_odf("=TRUE()").as_deref(), Some("of:=TRUE()"));
        assert_eq!(
            to_odf("=IF(TRUE,A1,FALSE)").as_deref(),
            Some("of:=IF(TRUE();[.A1];FALSE())")
        );
        // A function name that also parses as an address is a call first.
        assert_eq!(to_odf("=LOG10(A1)").as_deref(), Some("of:=LOG10([.A1])"));
        assert_eq!(
            to_odf("=ERROR.TYPE(A1)").as_deref(),
            Some("of:=ERROR.TYPE([.A1])")
        );
    }

    #[test]
    fn refuses_what_it_cannot_write() {
        for raw in [
            "=MyRange",
            "=SUM(MyRange)",
            "={1,{2}}",
            "={A1,2}",
            "=1;2",
            "=[1]Sheet1!A1",
            "=Table1[Column]",
            "=#N/A",
            "=@A1",
            "=Sheet1:Sheet2!A1",
            "=A1:B2:C3",
            "=LAMBDA(x,x+1)(A1)",
            "=BAHTTEXT(A1)",
            "=FOO.BAR(A1)",
            "=Q1_Sales",
            "=SUM(A1",
            "=SUM(A1,B1))",
            "=",
        ] {
            assert_eq!(to_odf(raw), None, "{raw}");
        }
    }

    #[test]
    fn the_two_directions_round_trip_the_shared_shapes() {
        for (excel, odf) in [
            ("SUM(B1:B2)", "of:=SUM([.B1:.B2])"),
            ("B1*2+C3", "of:=[.B1]*2+[.C3]"),
            ("Sheet1!$B$1", "of:=[$Sheet1.$B$1]"),
            ("'My Sheet'!A1:B2", "of:=[$'My Sheet'.A1:.B2]"),
            ("SUM($A:$A)", "of:=SUM([.$A:.$A])"),
            ("SUM(1:2)", "of:=SUM([.1:.2])"),
            ("TRUE()", "of:=TRUE()"),
        ] {
            assert_eq!(to_odf(&format!("={excel}")).as_deref(), Some(odf));
            assert_eq!(translate(odf).as_deref(), Some(excel));
        }
    }

    fn names(list: &[&str]) -> Names {
        let mut names = Names::default();
        for name in list {
            names.insert(name);
        }
        names
    }

    #[test]
    fn functions_take_the_name_the_other_dialect_uses() {
        // The same word means different things: OpenFormula's FDIST is the
        // left tail Excel calls F.DIST, and Excel's FDIST is LEGACY.FDIST.
        assert_eq!(
            to_odf("=FDIST(A1,2,3)").as_deref(),
            Some("of:=LEGACY.FDIST([.A1];2;3)")
        );
        assert_eq!(
            to_odf("=F.DIST(A1,2,3,TRUE)").as_deref(),
            Some("of:=FDIST([.A1];2;3;TRUE())")
        );
        assert_eq!(
            translate("of:=FDIST([.A1];2;3;TRUE())").as_deref(),
            Some("_xlfn.F.DIST(A1,2,3,TRUE())")
        );
        assert_eq!(
            translate("of:=LEGACY.FDIST([.A1];2;3)").as_deref(),
            Some("FDIST(A1,2,3)")
        );
        // Excel's CEILING is not OpenFormula's.
        assert_eq!(
            to_odf("=CEILING(A1,5)").as_deref(),
            Some("of:=COM.MICROSOFT.CEILING([.A1];5)")
        );
        assert_eq!(
            translate("of:=COM.MICROSOFT.CEILING([.A1];5)").as_deref(),
            Some("CEILING(A1,5)")
        );
        // Functions Excel added later go out under its namespace and come
        // back behind the marker Excel stores them with.
        for (excel, odf, stored) in [
            ("IFS(A1>0,1)", "of:=COM.MICROSOFT.IFS([.A1]>0;1)", "_xlfn.IFS(A1>0,1)"),
            (
                "XLOOKUP(A1,B1:B2,C1:C2)",
                "of:=COM.MICROSOFT.XLOOKUP([.A1];[.B1:.B2];[.C1:.C2])",
                "_xlfn.XLOOKUP(A1,B1:B2,C1:C2)",
            ),
            ("STDEV.S(A1:A9)", "of:=COM.MICROSOFT.STDEV.S([.A1:.A9])", "_xlfn.STDEV.S(A1:A9)"),
            ("FILTER(A1:A9,B1:B9)", "of:=COM.MICROSOFT.FILTER([.A1:.A9];[.B1:.B9])", "_xlfn._xlws.FILTER(A1:A9,B1:B9)"),
            ("IFNA(A1,0)", "of:=IFNA([.A1];0)", "_xlfn.IFNA(A1,0)"),
            ("FORMULATEXT(A1)", "of:=FORMULA([.A1])", "_xlfn.FORMULATEXT(A1)"),
            (
                "NETWORKDAYS.INTL(A1,B1)",
                "of:=COM.MICROSOFT.NETWORKDAYS.INTL([.A1];[.B1])",
                "NETWORKDAYS.INTL(A1,B1)",
            ),
        ] {
            assert_eq!(to_odf(&format!("={excel}")).as_deref(), Some(odf), "{excel}");
            assert_eq!(translate(odf).as_deref(), Some(stored), "{odf}");
        }
        // A marker that survived to the exporter is not part of the name.
        assert_eq!(
            to_odf("=_xlfn.IFS(A1>0,1)").as_deref(),
            Some("of:=COM.MICROSOFT.IFS([.A1]>0;1)")
        );
        // An Excel function the table predates still gets the marker.
        assert_eq!(
            translate("of:=COM.MICROSOFT.NEWFUNC([.A1])").as_deref(),
            Some("_xlfn.NEWFUNC(A1)")
        );
    }

    #[test]
    fn defined_names_travel_only_when_the_document_carries_them() {
        let known = names(&["TotalQty", "Q1_Sales", "Tax"]);
        assert_eq!(
            to_odf_with("=TotalQty*2", &known).as_deref(),
            Some("of:=TotalQty*2")
        );
        // Names compare without case, and one that starts like an address or
        // reads like a column is still a name.
        assert_eq!(
            to_odf_with("=SUM(totalqty,Q1_Sales)+Tax", &known).as_deref(),
            Some("of:=SUM(totalqty;Q1_Sales)+Tax")
        );
        assert_eq!(to_odf_with("=Other*2", &known), None);
        assert_eq!(
            translate_with("of:=SUM(TotalQty)*[.A1]", &known).as_deref(),
            Some("SUM(TotalQty)*A1")
        );
        assert_eq!(translate_with("of:=Other", &known), None);
    }

    #[test]
    fn unions_intersections_and_inline_arrays_cross_both_ways() {
        for (excel, odf) in [
            ("SUM((A1,B1))", "of:=SUM(([.A1]~[.B1]))"),
            ("SUM(A1:C3 B2:D4)", "of:=SUM([.A1:.C3]![.B2:.D4])"),
            ("SUM({1,2,3})", "of:=SUM({1;2;3})"),
            ("SUM({1,2;3,4}*A1)", "of:=SUM({1;2|3;4}*[.A1])"),
            (r#"MATCH("b",{"a","b;c"},0)"#, r#"of:=MATCH("b";{"a";"b;c"};0)"#),
        ] {
            assert_eq!(to_odf(&format!("={excel}")).as_deref(), Some(odf), "{excel}");
            assert_eq!(translate(odf).as_deref(), Some(excel), "{odf}");
        }
        // A space after a closing parenthesis is an intersection too; it must
        // not vanish and glue two operands together.
        assert_eq!(
            to_odf("=(A1:B2) B1:C3").as_deref(),
            Some("of:=([.A1:.B2])![.B1:.C3]")
        );
        // A space that is only layout disappears on the way in, so it cannot
        // turn into an intersection.
        assert_eq!(translate("of:=[.A1] + [.B1]").as_deref(), Some("A1+B1"));
    }

    #[test]
    fn range_addresses_and_link_targets_take_the_other_spelling() {
        assert_eq!(
            odf_range_address("Data!$C$2:$C$5").as_deref(),
            Some("$Data.$C$2:.$C$5")
        );
        assert_eq!(
            odf_range_address("'My Sheet'!$A$1").as_deref(),
            Some("$'My Sheet'.$A$1")
        );
        assert_eq!(odf_range_address("$A$1:$B$2"), None);
        assert_eq!(odf_range_address("Data!$A$1*2"), None);
        assert_eq!(
            excel_range("$Data.$C$2:.$C$5").as_deref(),
            Some("Data!$C$2:$C$5")
        );
        assert_eq!(
            excel_range("$'My Sheet'.$A$1").as_deref(),
            Some("'My Sheet'!$A$1")
        );
        assert_eq!(
            odf_internal_link("#'My Sheet 2'!A1", "Data").as_deref(),
            Some("#'My Sheet 2'.A1")
        );
        assert_eq!(
            odf_internal_link("#Sheet1!B2:C3", "Data").as_deref(),
            Some("#Sheet1.B2:C3")
        );
        assert_eq!(odf_internal_link("#B7", "Data").as_deref(), Some("#Data.B7"));
        assert_eq!(odf_internal_link("#MyName", "Data").as_deref(), Some("#MyName"));
        assert_eq!(
            translate_expression("[$Data.$1:.$1]", &Names::default()).as_deref(),
            Some("Data!$1:$1")
        );
        assert_eq!(
            odf_named_expression("Data!$B$6*2", &Names::default()).as_deref(),
            Some("[$Data.$B$6]*2")
        );
    }
}
