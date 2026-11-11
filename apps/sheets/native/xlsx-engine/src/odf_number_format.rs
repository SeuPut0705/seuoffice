//! ODF data styles as Excel number format codes, for the `.ods` import.
//!
//! An ODF document describes a number format as markup — `number:number`
//! with its digit counts, `number:text` between the parts, `number:year` and
//! friends for dates — and says "negative values look different" with a
//! `style:map` that points at a second data style. Excel wants one string with
//! up to four `;`-separated sections. Each data style is read into the code of
//! the one section it paints; the maps are put back together when a cell style
//! asks for the whole format.

use std::collections::HashMap;

use roxmltree::Node;

/// What a format is for. A date value shown through a style that is not a date
/// format would read as a bare serial, so the caller needs to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FormatKind {
    Number,
    Date,
    Time,
    Text,
    Boolean,
}

/// One data style: the section it paints by itself and the styles it defers
/// to under a condition.
struct DataStyle {
    section: String,
    /// True when the style has parts and they paint nothing, as opposed to a
    /// style that says nothing at all.
    blank: bool,
    kind: FormatKind,
    /// `(condition, style name)` in document order.
    maps: Vec<(String, String)>,
}

/// Every data style of a document, by name.
#[derive(Default)]
pub(crate) struct DataStyles {
    styles: HashMap<String, DataStyle>,
}

/// `value()>=0` and its relatives.
#[derive(Clone, Copy, PartialEq)]
struct Condition {
    operator: Operator,
    number: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operator {
    Greater,
    GreaterEqual,
    Less,
    LessEqual,
    Equal,
    NotEqual,
}

impl DataStyles {
    /// Reads a `number:*-style` element. Anything else is ignored.
    pub(crate) fn read(&mut self, node: Node<'_, '_>) {
        let kind = match node.tag_name().name() {
            "number-style" | "currency-style" | "percentage-style" => FormatKind::Number,
            "date-style" => FormatKind::Date,
            "time-style" => FormatKind::Time,
            "text-style" => FormatKind::Text,
            "boolean-style" => FormatKind::Boolean,
            _ => return,
        };
        let Some(name) = attribute(node, "name") else {
            return;
        };
        let section = match kind {
            FormatKind::Boolean => String::new(),
            _ => section_code(node, kind),
        };
        let maps = node
            .children()
            .filter(|child| child.tag_name().name() == "map")
            .filter_map(|child| {
                Some((
                    attribute(child, "condition")?.to_owned(),
                    attribute(child, "apply-style-name")?.to_owned(),
                ))
            })
            .collect();
        let blank = section.is_empty()
            && node
                .children()
                .any(|child| child.is_element() && child.tag_name().name() == "text");
        self.styles.insert(
            name.to_owned(),
            DataStyle {
                section,
                blank,
                kind,
                maps,
            },
        );
    }

    /// The Excel format code of a data style and what it is for. `None` is the
    /// General format: an unknown name, a boolean style, or a style that says
    /// nothing a code could carry.
    pub(crate) fn code(&self, name: &str) -> Option<(String, FormatKind)> {
        let style = self.styles.get(name)?;
        if style.kind == FormatKind::Boolean {
            return None;
        }
        let mapped: Vec<(Condition, &DataStyle)> = style
            .maps
            .iter()
            .filter_map(|(condition, target)| {
                Some((parse_condition(condition)?, self.styles.get(target)?))
            })
            .collect();
        if mapped.is_empty() {
            if style.section == "General" || (style.section.is_empty() && !style.blank) {
                return None;
            }
            if style.section.is_empty() {
                // A style that paints nothing hides the value.
                return Some((";;;".to_owned(), style.kind));
            }
            return Some((style.section.clone(), style.kind));
        }
        let kind = mapped
            .iter()
            .map(|(_, mapped)| mapped.kind)
            .find(|kind| *kind != FormatKind::Text)
            .unwrap_or(style.kind);
        Some((join_sections(&mapped, style), kind))
    }
}

/// Puts conditional sections back into Excel's `positive;negative;zero;text`.
/// The conditions Excel implies by position are left unsaid; any other is
/// spelled in brackets, of which a format may hold two.
fn join_sections(mapped: &[(Condition, &DataStyle)], main: &DataStyle) -> String {
    let is = |index: usize, operator: Operator| {
        mapped.get(index).is_some_and(|(condition, _)| {
            condition.operator == operator && condition.number == 0.0
        })
    };
    // A section that paints nothing stays empty: `0;-0;` shows no zero.
    let section = |index: usize| mapped[index].1.section.clone();
    let text_main = main.kind == FormatKind::Text;
    let main_code = main.section.clone();
    let mut sections: Vec<String> = Vec::new();
    if mapped.len() == 1 && is(0, Operator::GreaterEqual) {
        // positive and zero; everything else
        sections.push(section(0));
        if text_main {
            sections.push(format!("-{}", section(0)));
            sections.push(section(0));
        }
    } else if mapped.len() == 2 && is(0, Operator::Greater) && is(1, Operator::Less) {
        sections.push(section(0));
        sections.push(section(1));
        if text_main {
            sections.push(section(0));
        }
    } else if mapped.len() == 2 && is(0, Operator::GreaterEqual) && is(1, Operator::Less) {
        sections.push(section(0));
        sections.push(section(1));
        if text_main {
            sections.push(section(0));
        }
    } else if mapped.len() >= 3
        && is(0, Operator::Greater)
        && is(1, Operator::Less)
        && is(2, Operator::Equal)
    {
        sections.push(section(0));
        sections.push(section(1));
        sections.push(section(2));
        if !text_main {
            // Three conditions cover every number; the style's own section
            // has nothing left to paint.
            return sections.join(";");
        }
    } else {
        for (index, (condition, _)) in mapped.iter().take(2).enumerate() {
            sections.push(format!("{}{}", condition.bracket(), section(index)));
        }
        if text_main {
            // Excel's third section is the "everything else" one.
            sections.push("General".to_owned());
        }
    }
    sections.push(main_code);
    sections.join(";")
}

impl Condition {
    fn bracket(self) -> String {
        let operator = match self.operator {
            Operator::Greater => ">",
            Operator::GreaterEqual => ">=",
            Operator::Less => "<",
            Operator::LessEqual => "<=",
            Operator::Equal => "=",
            Operator::NotEqual => "<>",
        };
        format!("[{operator}{}]", self.number)
    }
}

fn parse_condition(text: &str) -> Option<Condition> {
    let rest = text.trim().strip_prefix("value()")?.trim_start();
    let (operator, rest) = if let Some(rest) = rest.strip_prefix(">=") {
        (Operator::GreaterEqual, rest)
    } else if let Some(rest) = rest.strip_prefix("<=") {
        (Operator::LessEqual, rest)
    } else if let Some(rest) = rest.strip_prefix("!=") {
        (Operator::NotEqual, rest)
    } else if let Some(rest) = rest.strip_prefix("<>") {
        (Operator::NotEqual, rest)
    } else if let Some(rest) = rest.strip_prefix('>') {
        (Operator::Greater, rest)
    } else if let Some(rest) = rest.strip_prefix('<') {
        (Operator::Less, rest)
    } else if let Some(rest) = rest.strip_prefix('=') {
        (Operator::Equal, rest)
    } else {
        return None;
    };
    let number: f64 = rest.trim().parse().ok()?;
    Some(Condition { operator, number })
}

/// The first attribute with this local name, whatever its prefix.
pub(crate) fn attribute<'a>(node: Node<'a, '_>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value())
}

fn count(node: Node<'_, '_>, name: &str) -> Option<usize> {
    attribute(node, name).and_then(|value| value.trim().parse().ok())
}

fn flag(node: Node<'_, '_>, name: &str) -> bool {
    attribute(node, name) == Some("true")
}

fn long(node: Node<'_, '_>) -> bool {
    attribute(node, "style") == Some("long")
}

/// The code of the one section a data style paints.
fn section_code(node: Node<'_, '_>, kind: FormatKind) -> String {
    let date_like = matches!(kind, FormatKind::Date | FormatKind::Time);
    let percentage = node.tag_name().name() == "percentage-style";
    // A time style that does not wrap at 24 hours counts them instead.
    let elapsed = kind == FormatKind::Time && attribute(node, "truncate-on-overflow") == Some("false");
    let mut code = String::new();
    let mut general = false;
    for child in node.children().filter(Node::is_element) {
        match child.tag_name().name() {
            "text" => {
                let text = child.text().unwrap_or("");
                if percentage {
                    // The percent sign is the operator that scales the value,
                    // not a literal.
                    for (index, piece) in text.split('%').enumerate() {
                        if index > 0 {
                            code.push('%');
                        }
                        code.push_str(&literal(piece, date_like));
                    }
                } else {
                    code.push_str(&literal(text, date_like));
                }
            }
            "number" => match number_code(child) {
                Some(number) => code.push_str(&number),
                None => general = true,
            },
            "scientific-number" => code.push_str(&scientific_code(child)),
            "fraction" => code.push_str(&fraction_code(child)),
            "currency-symbol" => code.push_str(&currency_code(child)),
            "text-content" => code.push('@'),
            "fill-character" => {
                if let Some(character) = child.text().and_then(|text| text.chars().next()) {
                    code.push('*');
                    code.push(character);
                }
            }
            "text-properties" => {
                if let Some(color) = attribute(child, "color").and_then(color_name) {
                    code.insert_str(0, &format!("[{color}]"));
                }
            }
            "year" => code.push_str(if long(child) { "yyyy" } else { "yy" }),
            "month" => code.push_str(match (flag(child, "textual"), long(child)) {
                (true, true) => "mmmm",
                (true, false) => "mmm",
                (false, true) => "mm",
                (false, false) => "m",
            }),
            "day" => code.push_str(if long(child) { "dd" } else { "d" }),
            "day-of-week" => code.push_str(if long(child) { "dddd" } else { "ddd" }),
            "era" => code.push_str(if long(child) { "gg" } else { "g" }),
            "hours" => {
                let token = if long(child) { "hh" } else { "h" };
                if elapsed {
                    code.push_str(&format!("[{token}]"));
                } else {
                    code.push_str(token);
                }
            }
            "minutes" => code.push_str(if long(child) { "mm" } else { "m" }),
            "seconds" => {
                code.push_str(if long(child) { "ss" } else { "s" });
                if let Some(places) = count(child, "decimal-places").filter(|places| *places > 0) {
                    code.push('.');
                    code.push_str(&"0".repeat(places.min(9)));
                }
            }
            "am-pm" => code.push_str("AM/PM"),
            // Quarters and week numbers have no Excel token; the rest of the
            // format still reads.
            _ => {}
        }
    }
    if general && code.is_empty() {
        return "General".to_owned();
    }
    if general {
        // A standard number between literal parts.
        return code_with_general(node, date_like);
    }
    if date_like { code } else { pad_edges(&code) }
}

/// A space at either end of a section, spelled as the skip-a-space token.
/// Formats that line numbers up pad with one (`_-`, `_)` in Excel, which ODF
/// keeps as a plain space), and a bare space at the edge of a section is the
/// one literal some readers trim.
fn pad_edges(code: &str) -> String {
    let leading = code.len() - code.trim_start_matches(' ').len();
    let rest = &code[leading..];
    let trailing = rest.len() - rest.trim_end_matches(' ').len();
    let middle = &rest[..rest.len() - trailing];
    if middle.is_empty() {
        return code.to_owned();
    }
    format!("{}{middle}{}", "_ ".repeat(leading), "_ ".repeat(trailing))
}

/// A style whose number is the standard one but has text around it:
/// `General "items"`.
fn code_with_general(node: Node<'_, '_>, date_like: bool) -> String {
    let mut code = String::new();
    for child in node.children().filter(Node::is_element) {
        match child.tag_name().name() {
            "text" => code.push_str(&literal(child.text().unwrap_or(""), date_like)),
            "number" => code.push_str("General"),
            _ => {}
        }
    }
    code
}

/// `number:number` as digit placeholders. `None` is the standard format: no
/// decimal count, no grouping, nothing the placeholders would add.
fn number_code(node: Node<'_, '_>) -> Option<String> {
    let decimals = count(node, "decimal-places");
    let grouping = flag(node, "grouping");
    let min_integer = count(node, "min-integer-digits").unwrap_or(1).min(30);
    let embedded: Vec<(usize, String)> = node
        .children()
        .filter(|child| child.tag_name().name() == "embedded-text")
        .filter_map(|child| Some((count(child, "position")?, child.text()?.to_owned())))
        .collect();
    let factor = attribute(node, "display-factor")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(1.0);
    if decimals.is_none() && !grouping && embedded.is_empty() && factor == 1.0 && min_integer <= 1 {
        return None;
    }
    let decimals = decimals.unwrap_or(0).min(30);
    let min_decimals = count(node, "min-decimal-places")
        .unwrap_or(decimals)
        .min(decimals);

    // Integer digits right to left: required ones are `0`, the rest `#`.
    let widest_embedded = embedded.iter().map(|(position, _)| *position).max().unwrap_or(0);
    let digits = min_integer
        .max(if grouping { 4 } else { 1 })
        .max(widest_embedded + 1);
    let mut integer = String::new();
    for position in (0..digits).rev() {
        integer.push(if position < min_integer { '0' } else { '#' });
        if let Some((_, text)) = embedded.iter().find(|(at, _)| *at == position && position > 0) {
            integer.push_str(&literal(text, false));
        } else if grouping && position > 0 && position % 3 == 0 {
            integer.push(',');
        }
    }
    let mut code = integer;
    if decimals > 0 {
        code.push('.');
        code.push_str(&"0".repeat(min_decimals));
        code.push_str(&"#".repeat(decimals - min_decimals));
    }
    // Each thousand the value is divided by is one trailing comma.
    let mut scale = factor;
    while scale >= 1000.0 {
        code.push(',');
        scale /= 1000.0;
    }
    Some(code)
}

fn scientific_code(node: Node<'_, '_>) -> String {
    let decimals = count(node, "decimal-places").unwrap_or(0).min(30);
    let min_decimals = count(node, "min-decimal-places")
        .unwrap_or(decimals)
        .min(decimals);
    let min_integer = count(node, "min-integer-digits").unwrap_or(1).clamp(1, 30);
    let exponent = count(node, "min-exponent-digits").unwrap_or(2).clamp(1, 10);
    let sign = if attribute(node, "forced-exponent-sign") == Some("false") {
        "E-"
    } else {
        "E+"
    };
    let mut code = "0".repeat(min_integer);
    if decimals > 0 {
        code.push('.');
        code.push_str(&"0".repeat(min_decimals));
        code.push_str(&"#".repeat(decimals - min_decimals));
    }
    code.push_str(sign);
    code.push_str(&"0".repeat(exponent));
    code
}

fn fraction_code(node: Node<'_, '_>) -> String {
    let min_integer = count(node, "min-integer-digits").unwrap_or(0);
    let numerator = count(node, "min-numerator-digits").unwrap_or(1).clamp(1, 10);
    let denominator = match count(node, "denominator-value") {
        Some(value) => value.to_string(),
        None => "?".repeat(count(node, "min-denominator-digits").unwrap_or(1).clamp(1, 10)),
    };
    let integer = if min_integer == 0 {
        "#".to_owned()
    } else {
        "0".repeat(min_integer.min(30))
    };
    format!("{integer} {}/{denominator}", "?".repeat(numerator))
}

/// `[$₩-412]` when the symbol's locale is one Excel has an id for; the symbol
/// as quoted text otherwise.
fn currency_code(node: Node<'_, '_>) -> String {
    let symbol = node.text().unwrap_or("");
    let locale = match (attribute(node, "language"), attribute(node, "country")) {
        (Some(language), Some(country)) => locale_id(language, country),
        _ => None,
    };
    match locale {
        Some(id) if !symbol.contains(']') => format!("[${symbol}-{id:X}]"),
        _ => literal(symbol, false),
    }
}

fn locale_id(language: &str, country: &str) -> Option<u32> {
    Some(match (language, country) {
        ("ko", "KR") => 0x412,
        ("en", "US") => 0x409,
        ("en", "GB") => 0x809,
        ("en", "AU") => 0xC09,
        ("en", "CA") => 0x1009,
        ("ja", "JP") => 0x411,
        ("zh", "CN") => 0x804,
        ("zh", "TW") => 0x404,
        ("de", "DE") => 0x407,
        ("fr", "FR") => 0x40C,
        ("es", "ES") => 0xC0A,
        ("it", "IT") => 0x410,
        ("nl", "NL") => 0x413,
        ("pt", "BR") => 0x416,
        ("pt", "PT") => 0x816,
        ("ru", "RU") => 0x419,
        ("pl", "PL") => 0x415,
        ("cs", "CZ") => 0x405,
        ("th", "TH") => 0x41E,
        ("vi", "VN") => 0x42A,
        ("id", "ID") => 0x421,
        ("ms", "MY") => 0x43E,
        ("hi", "IN") => 0x439,
        ("he", "IL") => 0x40D,
        ("tr", "TR") => 0x41F,
        _ => return None,
    })
}

/// The eight colours a format code can name.
fn color_name(color: &str) -> Option<&'static str> {
    Some(match color.to_ascii_lowercase().as_str() {
        "#000000" => "Black",
        "#0000ff" => "Blue",
        "#00ffff" => "Cyan",
        "#00ff00" => "Green",
        "#ff00ff" => "Magenta",
        "#ff0000" => "Red",
        "#ffffff" => "White",
        "#ffff00" => "Yellow",
        _ => return None,
    })
}

/// Literal text inside a format code. A handful of characters stand for
/// themselves; everything else is quoted, since a bare letter or digit sign is
/// a placeholder to Excel.
fn literal(text: &str, date_like: bool) -> String {
    let plain = |character: char| {
        matches!(character, ' ' | '-' | '+' | '(' | ')' | ':' | '$')
            || (date_like && matches!(character, '/' | '.' | ','))
    };
    let mut out = String::new();
    let mut quoted = String::new();
    let flush = |quoted: &mut String, out: &mut String| {
        if !quoted.is_empty() {
            out.push('"');
            out.push_str(quoted);
            out.push('"');
            quoted.clear();
        }
    };
    for character in text.chars() {
        if character == '"' {
            flush(&mut quoted, &mut out);
            out.push_str("\\\"");
        } else if plain(character) {
            flush(&mut quoted, &mut out);
            out.push(character);
        } else {
            quoted.push(character);
        }
    }
    flush(&mut quoted, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = r#"xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0""#;

    fn styles(body: &str) -> DataStyles {
        let xml = format!("<root {NS}>{body}</root>");
        let document = roxmltree::Document::parse(&xml).unwrap();
        let mut styles = DataStyles::default();
        for node in document.root_element().children().filter(Node::is_element) {
            styles.read(node);
        }
        styles
    }

    fn code(body: &str, name: &str) -> Option<String> {
        styles(body).code(name).map(|(code, _)| code)
    }

    #[test]
    fn numbers_become_digit_placeholders() {
        let body = concat!(
            r#"<number:number-style style:name="a"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>"#,
            r#"<number:number-style style:name="b"><number:number number:min-integer-digits="1"/></number:number-style>"#,
            r#"<number:number-style style:name="c"><number:number number:decimal-places="0" number:min-integer-digits="3"/></number:number-style>"#,
            r#"<number:number-style style:name="d"><number:number number:decimal-places="3" number:min-decimal-places="1" number:min-integer-digits="1"/></number:number-style>"#,
            r#"<number:number-style style:name="e"><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true" number:display-factor="1000"/><number:text>천원</number:text></number:number-style>"#,
            r#"<number:percentage-style style:name="f"><number:number number:decimal-places="1" number:min-decimal-places="1" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>"#,
            r#"<number:number-style style:name="g"><number:scientific-number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:min-exponent-digits="2"/></number:number-style>"#,
            r#"<number:number-style style:name="h"><number:fraction number:min-integer-digits="0" number:min-numerator-digits="1" number:min-denominator-digits="2"/></number:number-style>"#,
            r#"<number:number-style style:name="i"><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text>원</number:text></number:number-style>"#,
            r#"<number:text-style style:name="j"><number:text-content/></number:text-style>"#,
        );
        assert_eq!(code(body, "a").as_deref(), Some("#,##0.00"));
        assert_eq!(code(body, "b"), None, "the standard number is General");
        assert_eq!(code(body, "c").as_deref(), Some("000"));
        assert_eq!(code(body, "d").as_deref(), Some("0.0##"));
        assert_eq!(code(body, "e").as_deref(), Some("#,##0,\"천원\""));
        assert_eq!(code(body, "f").as_deref(), Some("0.0%"));
        assert_eq!(code(body, "g").as_deref(), Some("0.00E+00"));
        assert_eq!(code(body, "h").as_deref(), Some("# ?/??"));
        assert_eq!(code(body, "i").as_deref(), Some("#,##0\"원\""));
        assert_eq!(code(body, "j").as_deref(), Some("@"));
        let padded = r#"<number:number-style style:name="p"><number:text> </number:text><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text></number:number-style>"#;
        assert_eq!(code(padded, "p").as_deref(), Some("_ #,##0_ "));
    }

    #[test]
    fn mapped_styles_become_sections() {
        let body = concat!(
            r#"<number:number-style style:name="N1P0"><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/></number:number-style>"#,
            r##"<number:number-style style:name="N1"><style:text-properties fo:color="#ff0000"/><number:text>-</number:text><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><style:map style:condition="value()&gt;=0" style:apply-style-name="N1P0"/></number:number-style>"##,
            r#"<number:number-style style:name="N2P0"><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>"#,
            r#"<number:number-style style:name="N2P1"><number:text>(</number:text><number:number number:decimal-places="0" number:min-integer-digits="1"/><number:text>)</number:text></number:number-style>"#,
            r#"<number:number-style style:name="N2P2"><number:text>-</number:text></number:number-style>"#,
            r#"<number:text-style style:name="N2"><number:text-content/><style:map style:condition="value()&gt;0" style:apply-style-name="N2P0"/><style:map style:condition="value()&lt;0" style:apply-style-name="N2P1"/><style:map style:condition="value()=0" style:apply-style-name="N2P2"/></number:text-style>"#,
            r#"<number:number-style style:name="N3P0"><number:text>big </number:text><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>"#,
            r#"<number:number-style style:name="N3"><number:number number:decimal-places="0" number:min-integer-digits="1"/><style:map style:condition="value()&gt;=100" style:apply-style-name="N3P0"/></number:number-style>"#,
        );
        assert_eq!(code(body, "N1").as_deref(), Some("#,##0;[Red]-#,##0"));
        assert_eq!(code(body, "N2").as_deref(), Some("0;(0);-;@"));
        assert_eq!(code(body, "N3").as_deref(), Some("[>=100]\"big\" 0;0"));
        let hidden_zero = concat!(
            r#"<number:number-style style:name="ZP0"><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>"#,
            r#"<number:number-style style:name="ZP1"><number:text>-</number:text><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>"#,
            r#"<number:number-style style:name="Z"><number:text></number:text><style:map style:condition="value()&gt;0" style:apply-style-name="ZP0"/><style:map style:condition="value()&lt;0" style:apply-style-name="ZP1"/></number:number-style>"#,
            r#"<number:number-style style:name="H"><number:text></number:text></number:number-style>"#,
        );
        assert_eq!(code(hidden_zero, "Z").as_deref(), Some("0;-0;"));
        assert_eq!(code(hidden_zero, "H").as_deref(), Some(";;;"));
        assert_eq!(styles(body).code("N2").unwrap().1, FormatKind::Number);
    }

    #[test]
    fn dates_times_and_currency() {
        let body = concat!(
            r#"<number:date-style style:name="a"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>"#,
            r#"<number:date-style style:name="b"><number:year number:style="long"/><number:text>년 </number:text><number:month/><number:text>월 </number:text><number:day/><number:text>일 </number:text><number:day-of-week/></number:date-style>"#,
            r#"<number:time-style style:name="c" number:truncate-on-overflow="false"><number:hours/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:time-style>"#,
            r#"<number:time-style style:name="d"><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text> </number:text><number:am-pm/></number:time-style>"#,
            r#"<number:currency-style style:name="e"><number:currency-symbol number:language="ko" number:country="KR">₩</number:currency-symbol><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>"#,
            r#"<number:currency-style style:name="f"><number:currency-symbol>€</number:currency-symbol><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1"/></number:currency-style>"#,
            r#"<number:boolean-style style:name="g"><number:boolean/></number:boolean-style>"#,
        );
        let styles = styles(body);
        assert_eq!(styles.code("a").unwrap(), ("yyyy-mm-dd".to_owned(), FormatKind::Date));
        assert_eq!(styles.code("b").unwrap().0, "yyyy\"년\" m\"월\" d\"일\" ddd");
        assert_eq!(styles.code("c").unwrap(), ("[h]:mm:ss".to_owned(), FormatKind::Time));
        assert_eq!(styles.code("d").unwrap().0, "hh:mm AM/PM");
        assert_eq!(styles.code("e").unwrap().0, "[$₩-412]#,##0");
        assert_eq!(styles.code("f").unwrap().0, "\"€\"0.00");
        assert!(styles.code("g").is_none());
    }
}
