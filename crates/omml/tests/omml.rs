//! Expected values are what packages/docx-engine/src/math.ts returned for the
//! same inputs (`npx tsx` on a script calling the exported functions), except
//! the nesting limit, which the TypeScript does not have.

use omml::{
    MAX_NESTING, latex_to_omml, math_paragraph_xml, math_tokens_of, omml_ends_with_break,
    omml_fragments_of, omml_to_latex, omml_to_mathml,
};

fn run(text: &str) -> String {
    format!(r#"<m:r><m:t xml:space="preserve">{text}</m:t></m:r>"#)
}

#[test]
fn a_script_binds_to_the_last_code_point_of_a_run() {
    assert_eq!(
        latex_to_omml("ab^2").unwrap(),
        format!(
            "{}<m:sSup><m:e>{}</m:e><m:sup>{}</m:sup></m:sSup>",
            run("a"),
            run("b"),
            run("2")
        )
    );
    // the rewind is two UTF-16 units for a character outside the BMP
    assert_eq!(
        latex_to_omml("a\u{1F600}^2").unwrap(),
        format!(
            "{}<m:sSup><m:e>{}</m:e><m:sup>{}</m:sup></m:sSup>",
            run("a"),
            run("\u{1F600}"),
            run("2")
        )
    );
}

#[test]
fn an_empty_limit_leaves_its_slot_open() {
    assert_eq!(
        latex_to_omml(r"\sum_{}_{a}").unwrap(),
        format!(
            r#"<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/><m:supHide m:val="1"/></m:naryPr><m:sub>{}</m:sub><m:e></m:e></m:nary>"#,
            run("a")
        )
    );
}

#[test]
fn spaces_are_those_of_javascript() {
    // U+FEFF is skipped as a space, U+0085 is ordinary text
    assert_eq!(
        latex_to_omml("\u{FEFF}\\alpha\u{85}").unwrap(),
        format!("{}{}", run("α"), run("\u{85}"))
    );
}

#[test]
fn a_matrix_drops_its_empty_last_row() {
    assert_eq!(
        latex_to_omml(r"\begin{cases} x & 1 \\ \end{cases}").unwrap(),
        format!(
            r#"<m:d><m:dPr><m:begChr m:val="{{"/><m:endChr m:val=""/></m:dPr><m:e><m:m><m:mr><m:e>{}</m:e><m:e>{}</m:e></m:mr></m:m></m:e></m:d>"#,
            run("x "),
            run("1 ")
        )
    );
}

#[test]
fn what_the_typescript_throws_is_an_error() {
    for latex in [
        r"\sqrt[a}]{x}",
        "{unclosed",
        r"x\",
        r"\unknowncmd{x}",
        // the TypeScript reads an inherited key of its table and throws a TypeError
        r"\begin{constructor}a\end{constructor}",
        r"\constructor",
    ] {
        assert!(latex_to_omml(latex).is_err(), "{latex}");
    }
}

#[test]
fn nesting_past_the_limit_is_refused() {
    let nested = |depth: usize| format!("{}x{}", "{".repeat(depth), "}".repeat(depth));
    // the top sequence counts once, each brace twice (its group and its sequence)
    let deepest = (MAX_NESTING - 1) / 2;
    let checked = std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            (
                latex_to_omml(&nested(deepest)).is_ok(),
                latex_to_omml(&nested(deepest + 1)).is_err(),
            )
        })
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(checked, (true, true));
}

#[test]
fn omml_decompiles_to_latex() {
    assert_eq!(
        omml_to_latex(concat!(
            r#"<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">"#,
            "<m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr>",
            r#"<m:e><m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>x</m:t></m:r></m:e>"#,
            "<m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>",
            "<m:r><m:t>+1=0</m:t></m:r></m:oMath>"
        ))
        .as_deref(),
        Some("{x}^{2}+1=0")
    );
    assert_eq!(
        omml_to_latex("<m:oMath><m:r><m:t>100%_x  ≤ ε</m:t></m:r></m:oMath>").as_deref(),
        Some(r"100\% \_ x \le \epsilon")
    );
    let vmatrix = latex_to_omml(r"\begin{vmatrix} a & b \\ c & d \end{vmatrix}").unwrap();
    assert_eq!(
        omml_to_latex(&format!("<m:oMath>{vmatrix}</m:oMath>")).as_deref(),
        Some(r"\begin{vmatrix} a & b \\ c & d \end{vmatrix}")
    );
    assert_eq!(
        omml_to_latex(
            "<m:oMath><m:r><m:t>a</m:t></m:r></m:oMath><m:oMath><m:r><m:t>b</m:t></m:r></m:oMath>"
        ),
        None
    );
}

#[test]
fn omml_converts_to_mathml() {
    assert_eq!(
        omml_to_mathml(concat!(
            "<m:oMath><m:r><m:t>n-k (x)</m:t></m:r>",
            r#"<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>d</m:t></m:r></m:oMath>"#
        )),
        concat!(
            r#"<math display="block"><mrow><mi>n</mi><mo>−</mo><mi>k</mi>"#,
            r#"<mo stretchy="false">(</mo><mi>x</mi><mo stretchy="false">)</mo>"#,
            r#"<mi mathvariant="normal">d</mi></mrow></math>"#
        )
    );
    // propOn lowercases: OFF is off, on is on
    assert_eq!(
        omml_to_mathml(concat!(
            r#"<m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/><m:supHide m:val="OFF"/>"#,
            r#"<m:subHide m:val="on"/></m:naryPr><m:sup><m:r><m:t>n</m:t></m:r></m:sup>"#,
            "<m:e/></m:nary></m:oMath>"
        )),
        concat!(
            r#"<math display="block"><mrow><mrow><mover><mo stretchy="false">∑</mo>"#,
            "<mrow><mi>n</mi></mrow></mover><mrow></mrow></mrow></mrow></math>"
        )
    );
}

#[test]
fn fragments_paragraphs_and_tokens() {
    assert_eq!(
        omml_fragments_of(
            r#"<w:p><m:oMathPara><m:oMath>a</m:oMath></m:oMathPara><m:oMath x="1">b</m:oMath></w:p>"#
        ),
        ["<m:oMath>a</m:oMath>", r#"<m:oMath x="1">b</m:oMath>"#]
    );
    assert!(omml_ends_with_break(
        "<m:oMath><m:r><w:br/></m:r>\n</m:oMath> "
    ));
    assert_eq!(
        math_tokens_of(r#"<m:t>&amp;lt;</m:t><m:t xml:space="preserve">a&lt;b</m:t>"#),
        ["&lt;", "a<b"]
    );
    assert_eq!(
        math_paragraph_xml("<m:r/>", None),
        r#"<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath><m:r/></m:oMath></m:oMathPara></w:p>"#
    );
    assert_eq!(
        math_paragraph_xml("<m:r/>", Some("left")),
        r#"<w:p><w:pPr><w:jc w:val="left"/></w:pPr><m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath><m:r/></m:oMath></m:oMathPara></w:p>"#
    );
}
