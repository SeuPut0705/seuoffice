//! OMML to MathML Core (`ommlToMathML` of math.ts).

use ooxml_xml::{XNode, parse_ordered};

use crate::fragments::omml_fragments_of;
use crate::tables::OPERATOR_CHARS;
use crate::xml::{
    XML_PARSER_MAX_NESTED_TAGS, content_children, escape_xml, prop_on, prop_val, run_is_plain,
};

/// `ommlToMathML`: MathML Core for one or more `<m:oMath>` fragments, which
/// may come concatenated; `""` where nothing converts.
pub fn omml_to_mathml(omml_xml: &str) -> String {
    let fragments = omml_fragments_of(omml_xml);
    let sources = if fragments.is_empty() {
        vec![omml_xml]
    } else {
        fragments
    };
    let mut parts = String::new();
    for source in sources {
        let Ok(parsed) = parse_ordered(source, XML_PARSER_MAX_NESTED_TAGS) else {
            continue;
        };
        let Some(root) = parsed.iter().find(|node| node.name() == Some("m:oMath")) else {
            continue;
        };
        let body = mml_children(root.children());
        if !body.is_empty() {
            parts.push_str(&format!(
                r#"<math display="block"><mrow>{body}</mrow></math>"#
            ));
        }
    }
    parts
}

fn mml_children<'a>(nodes: impl IntoIterator<Item = &'a XNode>) -> String {
    nodes.into_iter().map(mml_of).collect()
}

/// `mmlSlot`: an `m:e`, `m:num`... container as an `mrow`.
fn mml_slot(parent: &XNode, name: &str) -> String {
    match parent.find_child(name) {
        None => "<mrow></mrow>".to_owned(),
        Some(slot) => format!("<mrow>{}</mrow>", mml_children(content_children(slot))),
    }
}

fn mo(ch: &str, extra: &str) -> String {
    format!("<mo{extra}>{}</mo>", escape_xml(ch, false))
}

fn mml_of(node: &XNode) -> String {
    let Some(name) = node.name() else {
        return String::new();
    };
    match name {
        "m:r" => run_to_mml(node),
        "m:f" => {
            let attrs = match prop_val(node, "m:fPr", "m:type") {
                Some("noBar") => r#" linethickness="0""#,
                Some("lin" | "skw") => r#" bevelled="true""#,
                _ => "",
            };
            format!(
                "<mfrac{attrs}>{}{}</mfrac>",
                mml_slot(node, "m:num"),
                mml_slot(node, "m:den")
            )
        }
        "m:sSup" => format!(
            "<msup>{}{}</msup>",
            mml_slot(node, "m:e"),
            mml_slot(node, "m:sup")
        ),
        "m:sSub" => format!(
            "<msub>{}{}</msub>",
            mml_slot(node, "m:e"),
            mml_slot(node, "m:sub")
        ),
        "m:sSubSup" => format!(
            "<msubsup>{}{}{}</msubsup>",
            mml_slot(node, "m:e"),
            mml_slot(node, "m:sub"),
            mml_slot(node, "m:sup")
        ),
        "m:sPre" => format!(
            "<mmultiscripts>{}<mprescripts/>{}{}</mmultiscripts>",
            mml_slot(node, "m:e"),
            mml_slot(node, "m:sub"),
            mml_slot(node, "m:sup")
        ),
        "m:rad" => {
            let inner = mml_slot(node, "m:e");
            if prop_on(node, "m:radPr", "m:degHide") || node.find_child("m:deg").is_none() {
                return format!("<msqrt>{inner}</msqrt>");
            }
            format!("<mroot>{inner}{}</mroot>", mml_slot(node, "m:deg"))
        }
        "m:d" => {
            let beg = prop_val(node, "m:dPr", "m:begChr").unwrap_or("(");
            let end = prop_val(node, "m:dPr", "m:endChr").unwrap_or(")");
            let sep = prop_val(node, "m:dPr", "m:sepChr").unwrap_or("|");
            let separator = if sep.is_empty() {
                String::new()
            } else {
                mo(sep, "")
            };
            let body = node
                .children()
                .iter()
                .filter(|child| child.name() == Some("m:e"))
                .map(|slot| format!("<mrow>{}</mrow>", mml_children(content_children(slot))))
                .collect::<Vec<_>>()
                .join(separator.as_str());
            let open = if beg.is_empty() {
                String::new()
            } else {
                mo(beg, r#" stretchy="true""#)
            };
            let close = if end.is_empty() {
                String::new()
            } else {
                mo(end, r#" stretchy="true""#)
            };
            format!("<mrow>{open}{body}{close}</mrow>")
        }
        "m:nary" => {
            let chr = prop_val(node, "m:naryPr", "m:chr").unwrap_or("\u{222B}");
            let lim_loc = prop_val(node, "m:naryPr", "m:limLoc").unwrap_or(if chr == "\u{222B}" {
                "subSup"
            } else {
                "undOvr"
            });
            let sub_hide = prop_on(node, "m:naryPr", "m:subHide");
            let sup_hide = prop_on(node, "m:naryPr", "m:supHide");
            let op = mo(chr, r#" stretchy="false""#);
            let under_over = lim_loc == "undOvr";
            let scripted = if !sub_hide && !sup_hide {
                let tag = if under_over { "munderover" } else { "msubsup" };
                format!(
                    "<{tag}>{op}{}{}</{tag}>",
                    mml_slot(node, "m:sub"),
                    mml_slot(node, "m:sup")
                )
            } else if !sub_hide {
                let tag = if under_over { "munder" } else { "msub" };
                format!("<{tag}>{op}{}</{tag}>", mml_slot(node, "m:sub"))
            } else if !sup_hide {
                let tag = if under_over { "mover" } else { "msup" };
                format!("<{tag}>{op}{}</{tag}>", mml_slot(node, "m:sup"))
            } else {
                op
            };
            format!("<mrow>{scripted}{}</mrow>", mml_slot(node, "m:e"))
        }
        "m:func" => format!(
            "<mrow>{}<mo>\u{2061}</mo>{}</mrow>",
            mml_slot(node, "m:fName"),
            mml_slot(node, "m:e")
        ),
        "m:limLow" => format!(
            "<munder>{}{}</munder>",
            mml_slot(node, "m:e"),
            mml_slot(node, "m:lim")
        ),
        "m:limUpp" => format!(
            "<mover>{}{}</mover>",
            mml_slot(node, "m:e"),
            mml_slot(node, "m:lim")
        ),
        "m:acc" => {
            let chr = prop_val(node, "m:accPr", "m:chr").unwrap_or("\u{0302}");
            format!(
                r#"<mover accent="true">{}{}</mover>"#,
                mml_slot(node, "m:e"),
                mo(chr, "")
            )
        }
        "m:bar" => {
            let top = prop_val(node, "m:barPr", "m:pos").unwrap_or("bot") == "top";
            let line = if top { "\u{00AF}" } else { "\u{005F}" };
            let tag = if top { "mover" } else { "munder" };
            format!(
                "<{tag}>{}{}</{tag}>",
                mml_slot(node, "m:e"),
                mo(line, r#" stretchy="true""#)
            )
        }
        "m:groupChr" => {
            let chr = prop_val(node, "m:groupChrPr", "m:chr").unwrap_or("\u{23DF}");
            let pos = prop_val(node, "m:groupChrPr", "m:pos").unwrap_or("bot");
            let tag = if pos == "top" { "mover" } else { "munder" };
            format!(
                "<{tag}>{}{}</{tag}>",
                mml_slot(node, "m:e"),
                mo(chr, r#" stretchy="true""#)
            )
        }
        "m:m" => {
            let jc = node
                .find_child("m:mPr")
                .and_then(|pr| pr.find_child("m:mcs"))
                .and_then(|mcs| mcs.find_child("m:mc"))
                .and_then(|mc| mc.find_child("m:mcPr"))
                .and_then(|pr| pr.find_child("m:mcJc"))
                .and_then(|jc| jc.attr("m:val"));
            // MathML Core has no columnalign: the UA centers mtd content, so the
            // alignment (and the inset on that side) is CSS on each cell
            let cell_attrs = match jc {
                Some(side @ ("left" | "right")) => {
                    format!(r#" style="text-align:{side};padding-{side}:0""#)
                }
                _ => String::new(),
            };
            let mut rows = String::new();
            for row in node.children().iter().filter(|c| c.name() == Some("m:mr")) {
                rows.push_str("<mtr>");
                for cell in row.children().iter().filter(|c| c.name() == Some("m:e")) {
                    rows.push_str(&format!(
                        "<mtd{cell_attrs}><mrow>{}</mrow></mtd>",
                        mml_children(content_children(cell))
                    ));
                }
                rows.push_str("</mtr>");
            }
            format!("<mtable>{rows}</mtable>")
        }
        "m:eqArr" => {
            let rows: String = node
                .children()
                .iter()
                .filter(|c| c.name() == Some("m:e"))
                .map(|row| {
                    format!(
                        "<mtr><mtd><mrow>{}</mrow></mtd></mtr>",
                        mml_children(content_children(row))
                    )
                })
                .collect();
            format!("<mtable>{rows}</mtable>")
        }
        "m:borderBox" => {
            // MathML Core has no menclose; the frame is CSS on the row
            let sides: Vec<String> = [
                ("Top", "top"),
                ("Right", "right"),
                ("Bot", "bottom"),
                ("Left", "left"),
            ]
            .into_iter()
            .filter(|(side, _)| !prop_on(node, "m:borderBoxPr", &format!("m:hide{side}")))
            .map(|(_, css)| format!("border-{css}:0.06em solid"))
            .collect();
            let style = if sides.is_empty() {
                String::new()
            } else {
                format!(r#" style="{};padding:0.15em""#, sides.join(";"))
            };
            let inner = node
                .find_child("m:e")
                .map(|e| mml_children(content_children(e)))
                .unwrap_or_default();
            format!("<mrow{style}>{inner}</mrow>")
        }
        "m:box" | "m:phant" => mml_slot(node, "m:e"),
        "m:t" => run_text_to_mml(&node.text(), false),
        // unknown structure: render its content children so nothing disappears
        _ => mml_children(content_children(node)),
    }
}

fn run_to_mml(run: &XNode) -> String {
    let plain = run_is_plain(run);
    let mut out = String::new();
    for child in run.children() {
        if child.name() == Some("m:t") {
            out.push_str(&run_text_to_mml(&child.text(), plain));
        }
    }
    out
}

/// `runTextToMml`: a text run as `mn`, `mi`, `mo` and `mtext` tokens.
fn run_text_to_mml(text: &str, plain: bool) -> String {
    // a lone plain letter would otherwise take the italic single-char mi default
    if plain {
        if text.is_empty() {
            return String::new();
        }
        let variant = if text.chars().count() == 1 {
            r#" mathvariant="normal""#
        } else {
            ""
        };
        return format!("<mi{variant}>{}</mi>", escape_xml(text, false));
    }
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    let mut buffer = [0; 4];
    while let Some(ch) = chars.next() {
        let token: &str = ch.encode_utf8(&mut buffer);
        match ch {
            '0'..='9' | '.' => {
                let mut num = String::from(ch);
                while let Some(&next @ ('0'..='9' | '.')) = chars.peek() {
                    num.push(next);
                    chars.next();
                }
                out.push_str(&format!("<mn>{num}</mn>"));
            }
            'A'..='Z' | 'a'..='z' | '\u{0370}'..='\u{03FF}' | '\u{1D400}'..='\u{1D7FF}' => {
                out.push_str(&format!("<mi>{}</mi>", escape_xml(token, false)));
            }
            ' ' => {}
            // parens inside a plain run are literal characters; only m:d wraps
            // (explicit delimiters) may stretch; Word draws a math hyphen-minus as
            // a real minus sign
            '(' | ')' | '[' | ']' | '{' | '}' | '|' => {
                out.push_str(&mo(token, r#" stretchy="false""#));
            }
            '-' => out.push_str(&mo("\u{2212}", "")),
            _ if OPERATOR_CHARS.contains(ch) => out.push_str(&mo(token, "")),
            _ => out.push_str(&format!("<mtext>{}</mtext>", escape_xml(token, false))),
        }
    }
    out
}
