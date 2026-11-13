//! The LaTeX subset to OMML (`latexToOmml` and `mathParagraphXml` of
//! math.ts).
//!
//! The parser walks UTF-16 code units as the TypeScript indexes its string.
//! Where it takes a single character as a token (the argument of `x^`), it
//! takes the whole character: both units of one outside the BMP.

use std::fmt;

use jscompat::is_js_space;

use crate::tables::{
    ACCENT_CHARS, LATEX_FUNCTIONS, LATEX_SYMBOLS, LEFT_RIGHT_CHARS, MATRIX_DELIMS, NARY_OPS,
    value_of,
};
use crate::xml::escape_xml;

/// What `latexToOmml` throws: syntax outside the subset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatexError(pub String);

impl fmt::Display for LatexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LatexError {}

/// Groups and sequences nested deeper than this are refused. The TypeScript
/// recurses until the JavaScript stack overflows (a RangeError somewhere
/// between 1,000 and 2,000 nested braces); Rust has no such error to give,
/// only a crash.
pub const MAX_NESTING: usize = 256;

/// Where a sequence ends, besides the end of the text.
#[derive(Clone, Copy)]
enum Stop {
    End,
    /// `}` of a group.
    CloseBrace,
    /// `&`, `\\` or `\end` of a matrix cell.
    Cell,
    /// `\right`
    Right,
}

struct Parser<'s> {
    src: &'s [u16],
    pos: usize,
    nesting: usize,
}

/// `latexToOmml`: the children of an `<m:oMath>` for a formula in the subset.
pub fn latex_to_omml(latex: &str) -> Result<String, LatexError> {
    let src: Vec<u16> = latex.encode_utf16().collect();
    let mut parser = Parser {
        src: &src,
        pos: 0,
        nesting: 0,
    };
    let out = parser.sequence(Stop::End)?;
    if parser.pos < parser.src.len() {
        return Err(LatexError(format!(
            "Cannot parse: \"{}\"",
            parser.slice(parser.pos, parser.pos + 12)
        )));
    }
    Ok(out)
}

/// `mathParagraphXml`: a display formula paragraph; `align` defaults to
/// `center`.
pub fn math_paragraph_xml(omml: &str, align: Option<&str>) -> String {
    let align = align.unwrap_or("center");
    let jc = if align == "center" {
        String::new()
    } else {
        format!(r#"<w:pPr><w:jc w:val="{align}"/></w:pPr>"#)
    };
    let math_jc = if align == "center" { "center" } else { align };
    format!(
        r#"<w:p>{jc}<m:oMathPara><m:oMathParaPr><m:jc m:val="{math_jc}"/></m:oMathParaPr><m:oMath>{omml}</m:oMath></m:oMathPara></w:p>"#
    )
}

/// `mathRun`
fn math_run(text: &str, plain: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    let r_pr = if plain {
        r#"<m:rPr><m:sty m:val="p"/></m:rPr>"#
    } else {
        ""
    };
    format!(
        r#"<m:r>{r_pr}<m:t xml:space="preserve">{}</m:t></m:r>"#,
        escape_xml(text, false)
    )
}

impl Parser<'_> {
    /// `src.slice(from, to)`
    fn slice(&self, from: usize, to: usize) -> String {
        let len = self.src.len();
        String::from_utf16_lossy(&self.src[from.min(len)..to.min(len)])
    }

    fn peek(&self) -> Option<u16> {
        self.src.get(self.pos).copied()
    }

    /// `peek`: the whole character at the cursor, with the units it takes
    /// (two for a character outside the BMP); `None` at the end.
    fn peek_char(&self) -> Option<(String, usize)> {
        let rest = self.src.get(self.pos..)?;
        let len = match rest {
            [high, low, ..]
                if (0xD800..0xDC00).contains(high) && (0xDC00..0xE000).contains(low) =>
            {
                2
            }
            [_, ..] => 1,
            [] => return None,
        };
        Some((String::from_utf16_lossy(&rest[..len]), len))
    }

    fn peek_is(&self, ch: u8) -> bool {
        self.peek() == Some(u16::from(ch))
    }

    /// `src.startsWith(ascii, pos)`
    fn starts_with(&self, ascii: &str) -> bool {
        self.src.get(self.pos..).is_some_and(|rest| {
            rest.len() >= ascii.len()
                && rest
                    .iter()
                    .zip(ascii.bytes())
                    .all(|(&u, b)| u == u16::from(b))
        })
    }

    fn stops(&self, stop: Stop) -> bool {
        match stop {
            Stop::End => self.pos >= self.src.len(),
            Stop::CloseBrace => self.peek_is(b'}'),
            Stop::Cell => {
                self.peek_is(b'&') || self.starts_with("\\\\") || self.starts_with("\\end")
            }
            Stop::Right => self.starts_with("\\right"),
        }
    }

    /// One level deeper. An error ends the whole parse, so only a level left
    /// normally is counted back.
    fn descend(&mut self) -> Result<(), LatexError> {
        self.nesting += 1;
        if self.nesting > MAX_NESTING {
            return Err(LatexError("Nested too deeply".into()));
        }
        Ok(())
    }

    fn skip_spaces(&mut self) {
        while self
            .peek()
            .and_then(|u| char::from_u32(u32::from(u)))
            .is_some_and(is_js_space)
        {
            self.pos += 1;
        }
    }

    /// `readControlName`: the name after a backslash, letters or one character.
    fn read_control_name(&mut self) -> String {
        let rest = self.src.get(self.pos..).unwrap_or_default();
        let letters = rest
            .iter()
            .take_while(|&&u| u8::try_from(u).is_ok_and(|b| b.is_ascii_alphabetic()))
            .count();
        if letters > 0 {
            self.pos += letters;
            return String::from_utf16_lossy(&rest[..letters]);
        }
        let (ch, len) = self.peek_char().unwrap_or_default();
        self.pos += len;
        ch
    }

    /// `parseGroup`: a `{...}` group or, as LaTeX reads an argument, exactly
    /// one token.
    fn group(&mut self) -> Result<String, LatexError> {
        self.descend()?;
        self.skip_spaces();
        let out = if self.peek_is(b'{') {
            self.pos += 1;
            let out = self.sequence(Stop::CloseBrace)?;
            if !self.peek_is(b'}') {
                return Err(LatexError("Missing matching }".into()));
            }
            self.pos += 1;
            out
        } else if self.peek_is(b'\\') {
            self.pos += 1;
            self.control()?
        } else {
            match self.peek_char() {
                None => return Err(LatexError("An argument is required here".into())),
                Some((ch, _)) if "{}^_&".contains(ch.as_str()) => {
                    return Err(LatexError("An argument is required here".into()));
                }
                Some((ch, len)) => {
                    self.pos += len;
                    math_run(&ch, false)
                }
            }
        };
        self.nesting -= 1;
        Ok(out)
    }

    /// `readBraceText`: the raw text of a `{...}` group.
    fn brace_text(&mut self) -> Result<String, LatexError> {
        self.skip_spaces();
        if !self.peek_is(b'{') {
            return Err(LatexError("Expected { here".into()));
        }
        self.pos += 1;
        let mut depth = 1;
        let mut out = Vec::new();
        while let Some(ch) = self.peek() {
            self.pos += 1;
            if ch == u16::from(b'{') {
                depth += 1;
            } else if ch == u16::from(b'}') {
                depth -= 1;
                if depth == 0 {
                    return Ok(String::from_utf16_lossy(&out));
                }
            }
            if depth > 0 {
                out.push(ch);
            }
        }
        Err(LatexError("Missing matching }".into()))
    }

    /// `parseSequence`: atoms until `stop`, a `^` or `_` script applied to
    /// the atom before it.
    fn sequence(&mut self, stop: Stop) -> Result<String, LatexError> {
        self.descend()?;
        let mut atoms: Vec<String> = Vec::new();
        loop {
            self.skip_spaces();
            if self.pos >= self.src.len() || self.stops(stop) {
                break;
            }
            let ch = self.peek();
            if self.peek_is(b'^') || self.peek_is(b'_') {
                self.pos += 1;
                let script = self.group()?;
                let other = self.peek();
                let base = atoms.pop().unwrap_or_default();
                if (other == Some(u16::from(b'^')) || other == Some(u16::from(b'_'))) && other != ch
                {
                    self.pos += 1;
                    let second = self.group()?;
                    let (sub, sup) = if ch == Some(u16::from(b'_')) {
                        (script, second)
                    } else {
                        (second, script)
                    };
                    atoms.push(format!(
                        "<m:sSubSup><m:e>{base}</m:e><m:sub>{sub}</m:sub><m:sup>{sup}</m:sup></m:sSubSup>"
                    ));
                } else if ch == Some(u16::from(b'^')) {
                    atoms.push(format!(
                        "<m:sSup><m:e>{base}</m:e><m:sup>{script}</m:sup></m:sSup>"
                    ));
                } else {
                    atoms.push(format!(
                        "<m:sSub><m:e>{base}</m:e><m:sub>{script}</m:sub></m:sSub>"
                    ));
                }
                continue;
            }
            atoms.push(self.atom()?);
        }
        self.nesting -= 1;
        Ok(atoms.concat())
    }

    /// `parseAtom`: a control sequence, a group, or a run of ordinary
    /// characters.
    fn atom(&mut self) -> Result<String, LatexError> {
        self.skip_spaces();
        let Some(ch) = self.peek() else {
            return Ok(String::new());
        };
        if ch == u16::from(b'{') {
            return self.group();
        }
        if ch == u16::from(b'}') {
            return Err(LatexError("Unexpected }".into()));
        }
        if ch == u16::from(b'\\') {
            self.pos += 1;
            return self.control();
        }
        // ordinary characters up to the next special char (kept as one m:r)
        let start = self.pos;
        while let Some(u) = self.peek() {
            if b"\\{}^_&\n".iter().any(|&b| u16::from(b) == u) {
                break;
            }
            self.pos += 1;
        }
        let text = &self.src[start..self.pos];
        if text.is_empty() {
            return Err(LatexError(format!(
                "Cannot parse: \"{}\"",
                String::from_utf16_lossy(&[ch])
            )));
        }
        // a following script binds to the last character only ("ab^2" = a·b²):
        // rewind so it becomes its own atom on the next pass
        if (self.peek_is(b'^') || self.peek_is(b'_'))
            && char::decode_utf16(text.iter().copied()).nth(1).is_some()
        {
            let last = match text {
                [.., high, low]
                    if (0xD800..0xDC00).contains(high) && (0xDC00..0xE000).contains(low) =>
                {
                    2
                }
                _ => 1,
            };
            self.pos -= last;
            return Ok(math_run(
                &String::from_utf16_lossy(&text[..text.len() - last]),
                false,
            ));
        }
        Ok(math_run(&String::from_utf16_lossy(text), false))
    }

    fn nary(&mut self, chr: &str, lim_loc: &str) -> Result<String, LatexError> {
        let mut sub = String::new();
        let mut sup = String::new();
        for _ in 0..2 {
            self.skip_spaces();
            if self.peek_is(b'_') && sub.is_empty() {
                self.pos += 1;
                sub = self.group()?;
            } else if self.peek_is(b'^') && sup.is_empty() {
                self.pos += 1;
                sup = self.group()?;
            } else {
                break;
            }
        }
        // operand: the next {...} group when present, else the nary stands alone
        self.skip_spaces();
        let operand = if self.peek_is(b'{') {
            self.group()?
        } else {
            String::new()
        };
        let mut out = format!(
            r#"<m:nary><m:naryPr><m:chr m:val="{}"/><m:limLoc m:val="{lim_loc}"/>"#,
            escape_xml(chr, true)
        );
        if sub.is_empty() {
            out.push_str(r#"<m:subHide m:val="1"/>"#);
        }
        if sup.is_empty() {
            out.push_str(r#"<m:supHide m:val="1"/>"#);
        }
        out.push_str("</m:naryPr>");
        if !sub.is_empty() {
            out.push_str(&format!("<m:sub>{sub}</m:sub>"));
        }
        if !sup.is_empty() {
            out.push_str(&format!("<m:sup>{sup}</m:sup>"));
        }
        out.push_str(&format!("<m:e>{operand}</m:e></m:nary>"));
        Ok(out)
    }

    fn matrix(&mut self, env: &str, delims: Option<(&str, &str)>) -> Result<String, LatexError> {
        let mut rows: Vec<Vec<String>> = vec![Vec::new()];
        loop {
            let cell = self.sequence(Stop::Cell)?;
            if let Some(row) = rows.last_mut() {
                row.push(cell);
            }
            if self.peek_is(b'&') {
                self.pos += 1;
            } else if self.starts_with("\\\\") {
                self.pos += 2;
                rows.push(Vec::new());
            } else if self.starts_with("\\end") {
                self.pos += 4;
                let closing = self.brace_text()?;
                if closing != env {
                    return Err(LatexError(format!(
                        "\\end{{{closing}}} does not match \\begin{{{env}}}"
                    )));
                }
                break;
            } else {
                return Err(LatexError(format!(
                    "\\begin{{{env}}} is missing \\end{{{env}}}"
                )));
            }
        }
        let body: String = rows
            .iter()
            .filter(|row| row.len() > 1 || row.first().map(String::as_str) != Some(""))
            .map(|row| {
                let cells: String = row
                    .iter()
                    .map(|cell| format!("<m:e>{cell}</m:e>"))
                    .collect();
                format!("<m:mr>{cells}</m:mr>")
            })
            .collect();
        let matrix = format!("<m:m>{body}</m:m>");
        let Some((beg, end)) = delims else {
            return Ok(matrix);
        };
        Ok(format!(
            r#"<m:d><m:dPr><m:begChr m:val="{}"/><m:endChr m:val="{}"/></m:dPr><m:e>{matrix}</m:e></m:d>"#,
            escape_xml(beg, true),
            escape_xml(end, true)
        ))
    }

    /// `readDelimiter`: the token after `\left` or `\right`.
    fn read_delimiter(&mut self) -> Result<&'static str, LatexError> {
        self.skip_spaces();
        if self.peek_is(b'\\') {
            let start = self.pos;
            self.pos += 1;
            let name = self.read_control_name();
            if let Some(ch) = value_of(LEFT_RIGHT_CHARS, &format!("\\{name}")) {
                return Ok(ch);
            }
            self.pos = start;
            return Err(LatexError(format!("Unsupported delimiter: \\{name}")));
        }
        let ch = self.peek_char().map(|(ch, _)| ch).unwrap_or_default();
        if let Some(delimiter) = value_of(LEFT_RIGHT_CHARS, &ch) {
            self.pos += 1;
            return Ok(delimiter);
        }
        Err(LatexError(format!("Unsupported delimiter: \"{ch}\"")))
    }

    /// `parseControl`: the control sequence after a backslash.
    fn control(&mut self) -> Result<String, LatexError> {
        let name = self.read_control_name();
        if let Some(symbol) = value_of(LATEX_SYMBOLS, &name) {
            return Ok(math_run(symbol, false));
        }
        if let Some((chr, lim_loc)) = value_of(NARY_OPS, &name) {
            return self.nary(chr, lim_loc);
        }
        if let Some(accent) = value_of(ACCENT_CHARS, &name) {
            let base = self.group()?;
            return Ok(format!(
                r#"<m:acc><m:accPr><m:chr m:val="{}"/></m:accPr><m:e>{base}</m:e></m:acc>"#,
                escape_xml(accent, true)
            ));
        }
        if LATEX_FUNCTIONS.contains(&name.as_str()) {
            return Ok(math_run(&name, true));
        }
        Ok(match name.as_str() {
            "frac" | "dfrac" | "tfrac" => {
                let num = self.group()?;
                let den = self.group()?;
                format!("<m:f><m:num>{num}</m:num><m:den>{den}</m:den></m:f>")
            }
            "binom" => {
                let top = self.group()?;
                let bottom = self.group()?;
                format!(
                    r#"<m:d><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>{top}</m:num><m:den>{bottom}</m:den></m:f></m:e></m:d>"#
                )
            }
            "sqrt" => {
                self.skip_spaces();
                let mut deg = String::new();
                if self.peek_is(b'[') {
                    // ordinary-char runs do not stop at ']', so isolate the degree source
                    // up to the closing bracket and parse it as its own sequence
                    self.pos += 1;
                    let Some(close) = self.src[self.pos..]
                        .iter()
                        .position(|&u| u == u16::from(b']'))
                        .map(|at| self.pos + at)
                    else {
                        return Err(LatexError("Missing matching ]".into()));
                    };
                    let mut sub = Parser {
                        src: &self.src[self.pos..close],
                        pos: 0,
                        nesting: self.nesting,
                    };
                    deg = sub.sequence(Stop::End)?;
                    self.pos = close + 1;
                }
                let inner = self.group()?;
                if deg.is_empty() {
                    format!(
                        r#"<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>{inner}</m:e></m:rad>"#
                    )
                } else {
                    format!("<m:rad><m:deg>{deg}</m:deg><m:e>{inner}</m:e></m:rad>")
                }
            }
            "overline" => format!(
                r#"<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>{}</m:e></m:bar>"#,
                self.group()?
            ),
            "underline" => format!(
                r#"<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>{}</m:e></m:bar>"#,
                self.group()?
            ),
            "underbrace" => format!(
                r#"<m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="bot"/></m:groupChrPr><m:e>{}</m:e></m:groupChr>"#,
                self.group()?
            ),
            "overbrace" => format!(
                r#"<m:groupChr><m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/></m:groupChrPr><m:e>{}</m:e></m:groupChr>"#,
                self.group()?
            ),
            "text" | "mathrm" | "operatorname" => math_run(&self.brace_text()?, true),
            "lim" => {
                self.skip_spaces();
                if self.peek_is(b'_') {
                    self.pos += 1;
                    let lim = self.group()?;
                    format!(
                        "<m:limLow><m:e>{}</m:e><m:lim>{lim}</m:lim></m:limLow>",
                        math_run("lim", true)
                    )
                } else {
                    math_run("lim", true)
                }
            }
            "left" => {
                let beg = self.read_delimiter()?;
                let body = self.sequence(Stop::Right)?;
                if !self.starts_with("\\right") {
                    return Err(LatexError("\\left is missing a matching \\right".into()));
                }
                self.pos += "\\right".len();
                let end = self.read_delimiter()?;
                format!(
                    r#"<m:d><m:dPr><m:begChr m:val="{}"/><m:endChr m:val="{}"/></m:dPr><m:e>{body}</m:e></m:d>"#,
                    escape_xml(beg, true),
                    escape_xml(end, true)
                )
            }
            "begin" => {
                let env = self.brace_text()?;
                let Some(delims) = value_of(MATRIX_DELIMS, &env) else {
                    return Err(LatexError(format!(
                        "Unsupported environment: \\begin{{{env}}}"
                    )));
                };
                self.matrix(&env, delims)?
            }
            "," | ";" | " " | "quad" | "qquad" => math_run(" ", false),
            "\\" => {
                return Err(LatexError(
                    "\\\\ is only allowed inside matrix environments".into(),
                ));
            }
            "{" | "}" | "%" | "&" | "$" | "#" | "_" | "^" => math_run(&name, false),
            _ => return Err(LatexError(format!("Unsupported command: \\{name}"))),
        })
    }
}
