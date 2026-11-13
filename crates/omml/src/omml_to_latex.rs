//! OMML to the LaTeX subset `latex_to_omml` reads (`ommlToLatex` of math.ts).

use jscompat::{js_regex, trim};
use ooxml_xml::{XNode, parse_ordered};

use crate::fragments::omml_fragments_of;
use crate::tables::{
    ACCENT_CHARS, CHAR_ESCAPES, LATEX_FUNCTIONS, LATEX_SYMBOLS, LEFT_RIGHT_CHARS, MATRIX_DELIMS,
    NARY_OPS, first_key_of,
};
use crate::xml::{XML_PARSER_MAX_NESTED_TAGS, content_children, prop_on, prop_val, run_is_plain};

/// A structure the subset cannot express: `UnsupportedOmml`.
struct Unsupported;

type Latex = Result<String, Unsupported>;

/// `ommlToLatex`: one `<m:oMath>` fragment as LaTeX, or `None` (`null`) where
/// there is not exactly one fragment, it does not parse, or it holds a
/// structure outside the subset.
pub fn omml_to_latex(omml_xml: &str) -> Option<String> {
    let fragments = omml_fragments_of(omml_xml);
    let source = match fragments[..] {
        [] => omml_xml,
        [source] => source,
        _ => return None,
    };
    let parsed = parse_ordered(source, XML_PARSER_MAX_NESTED_TAGS).ok()?;
    let root = parsed.iter().find(|node| node.name() == Some("m:oMath"))?;
    let latex = latex_of_children(root.children().iter()).ok()?;
    Some(js_regex!(r"\s{2,}").replace_all(trim(&latex), |_| " ".to_owned()))
}

fn latex_of_children<'a>(nodes: impl Iterator<Item = &'a XNode>) -> Latex {
    nodes
        .filter(|node| node.name().is_some())
        .map(latex_of_node)
        .collect()
}

/// `latexSlot`: an `m:e`, `m:num`... container, `""` where it is absent.
fn latex_slot(parent: &XNode, name: &str) -> Latex {
    match parent.find_child(name) {
        None => Ok(String::new()),
        Some(slot) => latex_of_children(content_children(slot)),
    }
}

fn latex_of_node(node: &XNode) -> Latex {
    let Some(name) = node.name() else {
        return Ok(String::new());
    };
    Ok(match name {
        "m:r" => run_to_latex(node)?,
        "m:t" => chars_to_latex(&node.text())?,
        "m:f" => {
            // bare noBar fractions only exist inside \binom's m:d wrapper (handled
            // there); any other styled fraction is outside the subset
            if !matches!(prop_val(node, "m:fPr", "m:type"), None | Some("bar")) {
                return Err(Unsupported);
            }
            format!(
                "\\frac{{{}}}{{{}}}",
                latex_slot(node, "m:num")?,
                latex_slot(node, "m:den")?
            )
        }
        "m:sSup" => format!(
            "{{{}}}^{{{}}}",
            latex_slot(node, "m:e")?,
            latex_slot(node, "m:sup")?
        ),
        "m:sSub" => format!(
            "{{{}}}_{{{}}}",
            latex_slot(node, "m:e")?,
            latex_slot(node, "m:sub")?
        ),
        "m:sSubSup" => format!(
            "{{{}}}_{{{}}}^{{{}}}",
            latex_slot(node, "m:e")?,
            latex_slot(node, "m:sub")?,
            latex_slot(node, "m:sup")?
        ),
        "m:rad" => {
            if prop_on(node, "m:radPr", "m:degHide") || node.find_child("m:deg").is_none() {
                format!("\\sqrt{{{}}}", latex_slot(node, "m:e")?)
            } else {
                format!(
                    "\\sqrt[{}]{{{}}}",
                    latex_slot(node, "m:deg")?,
                    latex_slot(node, "m:e")?
                )
            }
        }
        "m:d" => delimiter_to_latex(node)?,
        "m:nary" => {
            let chr = prop_val(node, "m:naryPr", "m:chr").unwrap_or("∫");
            let Some(command) = NARY_OPS
                .iter()
                .find(|(_, (op, _))| *op == chr)
                .map(|(name, _)| *name)
            else {
                return Err(Unsupported);
            };
            let sub = if prop_on(node, "m:naryPr", "m:subHide") {
                String::new()
            } else {
                format!("_{{{}}}", latex_slot(node, "m:sub")?)
            };
            let sup = if prop_on(node, "m:naryPr", "m:supHide") {
                String::new()
            } else {
                format!("^{{{}}}", latex_slot(node, "m:sup")?)
            };
            format!("\\{command}{sub}{sup} {{{}}}", latex_slot(node, "m:e")?)
        }
        "m:func" => {
            let name = plain_text_of_runs(node.find_child("m:fName"));
            let name = trim(&name);
            let arg = format!("{{{}}}", latex_slot(node, "m:e")?);
            if LATEX_FUNCTIONS.contains(&name) {
                format!("\\{name} {arg}")
            } else if name == "lim" {
                format!("\\lim {arg}")
            } else if !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphabetic()) {
                format!("\\operatorname{{{name}}} {arg}")
            } else {
                return Err(Unsupported);
            }
        }
        "m:limLow" => {
            let base = plain_text_of_runs(node.find_child("m:e"));
            if trim(&base) != "lim" {
                return Err(Unsupported);
            }
            format!("\\lim_{{{}}}", latex_slot(node, "m:lim")?)
        }
        "m:acc" => {
            let chr = prop_val(node, "m:accPr", "m:chr").unwrap_or("\u{0302}");
            let Some(command) = first_key_of(ACCENT_CHARS, chr) else {
                return Err(Unsupported);
            };
            format!("\\{command}{{{}}}", latex_slot(node, "m:e")?)
        }
        "m:bar" => {
            let pos = prop_val(node, "m:barPr", "m:pos").unwrap_or("bot");
            let command = if pos == "top" {
                "overline"
            } else {
                "underline"
            };
            format!("\\{command}{{{}}}", latex_slot(node, "m:e")?)
        }
        "m:groupChr" => match prop_val(node, "m:groupChrPr", "m:chr").unwrap_or("⏟") {
            "⏟" => format!("\\underbrace{{{}}}", latex_slot(node, "m:e")?),
            "⏞" => format!("\\overbrace{{{}}}", latex_slot(node, "m:e")?),
            _ => return Err(Unsupported),
        },
        "m:m" => format!("\\begin{{matrix}} {} \\end{{matrix}}", matrix_body(node)?),
        "m:box" | "m:borderBox" | "m:phant" => latex_slot(node, "m:e")?,
        _ => return Err(Unsupported),
    })
}

/// `matrixBody`: the rows of an `m:m` or `m:eqArr` as `a & b \\ c & d`.
fn matrix_body(node: &XNode) -> Latex {
    let has_rows = node.find_child("m:mr").is_some();
    let row_name = if has_rows { "m:mr" } else { "m:e" };
    let mut rows = Vec::new();
    for row in node
        .children()
        .iter()
        .filter(|c| c.name() == Some(row_name))
    {
        rows.push(if has_rows {
            row.children()
                .iter()
                .filter(|c| c.name() == Some("m:e"))
                .map(|cell| latex_of_children(content_children(cell)))
                .collect::<Result<Vec<_>, _>>()?
                .join(" & ")
        } else {
            latex_of_children(content_children(row))?
        });
    }
    Ok(rows.join(" \\\\ "))
}

/// `delimTokens`: the `\left`/`\right` token of a delimiter character, `.`
/// for none.
fn delim_token(ch: &str) -> Option<&'static str> {
    if ch.is_empty() {
        return Some(".");
    }
    first_key_of(LEFT_RIGHT_CHARS, ch)
}

fn delimiter_to_latex(node: &XNode) -> Latex {
    let beg = prop_val(node, "m:dPr", "m:begChr").unwrap_or("(");
    let end = prop_val(node, "m:dPr", "m:endChr").unwrap_or(")");
    let mut slots = node.children().iter().filter(|c| c.name() == Some("m:e"));
    let (Some(slot), None) = (slots.next(), slots.next()) else {
        return Err(Unsupported);
    };
    let inner: Vec<&XNode> = content_children(slot).collect();

    // \binom: parenthesised single noBar fraction
    if let [only] = inner[..] {
        if beg == "("
            && end == ")"
            && only.name() == Some("m:f")
            && prop_val(only, "m:fPr", "m:type") == Some("noBar")
        {
            return Ok(format!(
                "\\binom{{{}}}{{{}}}",
                latex_slot(only, "m:num")?,
                latex_slot(only, "m:den")?
            ));
        }
        // matrix environments: delimiters wrapping a single matrix / equation array
        if matches!(only.name(), Some("m:m" | "m:eqArr")) {
            let key = format!("{beg} {end}");
            let env = MATRIX_DELIMS
                .iter()
                .filter(|(env, _)| *env != "matrix")
                .filter_map(|&(env, delims)| Some((env, delims?)))
                .rfind(|(_, (open, close))| format!("{open} {close}") == key)
                .map(|(env, _)| env);
            if let Some(env) = env {
                return Ok(format!(
                    "\\begin{{{env}}} {} \\end{{{env}}}",
                    matrix_body(only)?
                ));
            }
        }
    }
    let (Some(beg_token), Some(end_token)) = (delim_token(beg), delim_token(end)) else {
        return Err(Unsupported);
    };
    Ok(format!(
        "\\left{beg_token} {} \\right{end_token}",
        latex_of_children(inner.into_iter())?
    ))
}

/// `plainTextOfRuns`: the `m:t` text of the `m:r` children, for function
/// names and `lim`.
fn plain_text_of_runs(node: Option<&XNode>) -> String {
    let mut out = String::new();
    for run in node.into_iter().flat_map(|node| node.find_children("m:r")) {
        for child in run.children() {
            if child.name() == Some("m:t") {
                out.push_str(&child.text());
            }
        }
    }
    out
}

fn run_to_latex(run: &XNode) -> Latex {
    let plain = run_is_plain(run);
    let mut text = String::new();
    for child in run.children() {
        if child.name() == Some("m:t") {
            text.push_str(&child.text());
        }
    }
    if !plain {
        return chars_to_latex(&text);
    }
    let trimmed = trim(&text);
    Ok(if trimmed.is_empty() {
        " ".to_owned()
    } else if LATEX_FUNCTIONS.contains(&trimmed) {
        format!("\\{trimmed} ")
    } else if trimmed == "lim" {
        "\\lim ".to_owned()
    } else if text.contains(['{', '}', '\\']) {
        return Err(Unsupported);
    } else {
        format!("\\text{{{text}}}")
    })
}

/// `charsToLatex`: ordinary math text, syntax characters escaped and symbols
/// as their commands.
fn chars_to_latex(text: &str) -> Latex {
    let mut out = String::new();
    for ch in text.chars() {
        if ch == '\\' || ch == '\n' {
            return Err(Unsupported);
        }
        if let Some(&(_, escaped)) = CHAR_ESCAPES.iter().find(|(escaped, _)| *escaped == ch) {
            out.push_str(escaped);
            continue;
        }
        match first_key_of(LATEX_SYMBOLS, ch.encode_utf8(&mut [0; 4])) {
            Some(command) => {
                out.push('\\');
                out.push_str(command);
                out.push(' ');
            }
            None => out.push(ch),
        }
    }
    Ok(out)
}
