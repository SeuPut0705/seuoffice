//! What parseStyles answers. Every expected value is the answer of the
//! TypeScript engine (packages/docx-engine/src/parse-styles.ts) for the same
//! package; `tools/docx-diff` compares the two over the whole corpus.

use docx_engine::styles::{
    DocDefaults, StyleDisplay, para_cs_format, parse_styles, style_run_format,
};
use docx_engine::theme::{ThemeColors, ThemeFonts};
use jscompat::{JsNum, Slot};
use ooxml_pkg::Package;
use serde_json::{Value, json};

const THEME: &str = r#"{"colors":{"dk1":"000000","lt1":"FFFFFF","dk2":"44546A","lt2":"E7E6E6","accent1":"4472C4","accent2":"ED7D31","accent3":"A5A5A5","accent4":"FFC000","accent5":"5B9BD5","accent6":"70AD47","hlink":"0563C1","folHlink":"954F72"},"fonts":{"major":"Calibri Light","minor":"Calibri","eastAsia":"","majorEastAsia":"Batang","eaLang":"ko-KR"}}"#;

fn run(files: &[(&str, &str)], with_theme: bool) -> Value {
    let package = Package::from_parts(
        files
            .iter()
            .map(|(name, xml)| (*name, xml.as_bytes().to_vec())),
    );
    let theme: Value = serde_json::from_str(THEME).expect("the theme fixture parses");
    let colors: ThemeColors = serde_json::from_value(theme["colors"].clone()).expect("colors");
    let fonts: ThemeFonts = serde_json::from_value(theme["fonts"].clone()).expect("fonts");
    let parsed = if with_theme {
        parse_styles(&package, Some(&colors), Some(&fonts))
    } else {
        parse_styles(&package, None, None)
    }
    .expect("parseStyles does not throw");
    json!({ "styles": parsed.styles, "docDefaults": parsed.doc_defaults })
}

fn expected(json: &str) -> Value {
    serde_json::from_str(json).expect("the expected value parses")
}

/// A child inherits through two levels; a cycle and a missing parent resolve without looping.
#[test]
fn based_on_chain_cycle_and_missing_parent() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:rPr><w:sz w:val="22"/><w:color w:val="FF0000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Mid"><w:name w:val="Mid"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:pos="9000"/></w:tabs><w:ind w:leftChars="100" w:left="400"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Leaf"><w:name w:val="Leaf"/><w:basedOn w:val="Mid"/><w:pPr><w:tabs><w:tab w:val="clear" w:pos="720"/><w:tab w:val="center" w:pos="4500"/></w:tabs><w:ind w:firstLineChars="200"/></w:pPr><w:rPr><w:b w:val="0"/><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CycA"><w:name w:val="CycA"/><w:basedOn w:val="CycB"/><w:rPr><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CycB"><w:name w:val="CycB"/><w:basedOn w:val="CycA"/><w:rPr><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Orphan"><w:name w:val="Orphan"/><w:basedOn w:val="Nowhere"/><w:rPr><w:strike/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Self"><w:name w:val="Self"/><w:basedOn w:val="Self"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="100"/></w:tabs></w:pPr></w:style></w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Normal",{"styleId":"Normal","name":"Normal","type":"paragraph","display":{"sizeHalfPoints":22,"color":"FF0000","lineRule":"auto","lineRawTwips":300,"lineSpacing":1.25,"spaceAfterTwips":120,"align":"justify"},"isDefault":true}],["Mid",{"styleId":"Mid","name":"Mid","type":"paragraph","basedOn":"Normal","display":{"sizeHalfPoints":22,"color":"FF0000","lineRule":"auto","lineRawTwips":300,"lineSpacing":1.25,"spaceAfterTwips":120,"align":"justify","bold":true,"tabStops":[{"pos":720,"val":"left"},{"pos":9000,"val":"right"}],"indentLeftTwips":400,"indentChars":{"left":100}}}],["Leaf",{"styleId":"Leaf","name":"Leaf","type":"paragraph","basedOn":"Mid","display":{"sizeHalfPoints":22,"color":"FF0000","lineRule":"auto","lineRawTwips":300,"lineSpacing":1.25,"spaceAfterTwips":120,"align":"justify","bold":false,"tabStops":[{"pos":4500,"val":"center"},{"pos":9000,"val":"right"}],"indentLeftTwips":400,"indentChars":{"left":100,"firstLine":200},"italic":true}}],["CycA",{"styleId":"CycA","name":"CycA","type":"paragraph","basedOn":"CycB","display":{"sizeHalfPoints":30,"underline":true}}],["CycB",{"styleId":"CycB","name":"CycB","type":"paragraph","basedOn":"CycA","display":{"sizeHalfPoints":30,"underline":true}}],["Orphan",{"styleId":"Orphan","name":"Orphan","type":"paragraph","basedOn":"Nowhere","display":{"strike":true}}],["Self",{"styleId":"Self","name":"Self","type":"paragraph","basedOn":"Self","display":{"tabStops":[{"pos":100,"val":"left"}]}}]],"docDefaults":{"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// Declared rPrDefault and pPrDefault, with borders and indents feeding paragraph styles.
#[test]
fn doc_defaults_present() {
    let files = [(
        "word/styles.xml",
        r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:color w:val="#123456"/><w:kern w:val="2"/><w:sz w:val="22"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/><w:b/><w:iCs/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:spacing w:before="40" w:after="160" w:line="259" w:lineRule="auto" w:beforeAutospacing="true"/><w:ind w:left="100" w:hanging="200" w:rightChars="50"/><w:pBdr><w:top w:val="single" w:sz="4" w:color="auto"/></w:pBdr><w:bidi/><w:suppressAutoHyphens/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:ind w:left="0" w:leftChars="10"/><w:pBdr><w:top w:val="nil"/><w:bottom w:val="double" w:sz="6"/></w:pBdr></w:pPr></w:style><w:style w:type="character" w:styleId="Em"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style></w:styles>"##,
    )];
    assert_eq!(
        run(&files, true),
        expected(
            r#"{"styles":[["Normal",{"styleId":"Normal","name":"Normal","type":"paragraph","display":{"borderSides":{"t":null,"b":{"szPt":0.75}},"indentLeftTwips":0,"indentChars":{"right":50,"left":10},"indentFirstLineTwips":-200},"isDefault":true}],["Em",{"styleId":"Em","name":"Emphasis","type":"character","display":{"italic":true}}]],"docDefaults":{"sizeHalfPoints":22,"sizeCsHalfPoints":24,"asciiFont":"Calibri","eaThemeSlot":true,"csFont":"Times New Roman","eastAsiaLang":"ko-KR","eastAsiaFont":"Malgun Gothic","eaFromLang":true,"eaSlotEmpty":true,"bold":true,"italicCs":true,"color":"123456","kernHalfPoints":2,"lang":"en-US","lineRawTwips":259,"lineRule":"auto","lineSpacing":1.0791666666666666,"spaceBeforeTwips":40,"spaceAfterTwips":160,"spaceBeforeAuto":true,"suppressAutoHyphens":true,"bidi":true,"widowControl":false,"borderSides":{"t":{"szPt":0.5}},"indentLeftTwips":100,"indentFirstLineTwips":-200,"indentChars":{"right":50}}}"#
        )
    );
}

/// An empty pPrDefault switches the built-in spacing off; no rFonts and no theme falls back to Times New Roman 10pt.
#[test]
fn doc_defaults_empty_p_pr_default() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:docDefaults><w:rPrDefault/><w:pPrDefault/></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Normal",{"styleId":"Normal","name":"Normal","type":"paragraph","isDefault":true}]],"docDefaults":{"asciiFont":"Times New Roman","sizeHalfPoints":20}}"#
        )
    );
}

/// No w:docDefaults at all: built-in paragraph spacing only.
#[test]
fn doc_defaults_absent() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Normal",{"styleId":"Normal","name":"Normal","type":"paragraph","isDefault":true}]],"docDefaults":{"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// A package without word/styles.xml lays out in the built-in Normal.
#[test]
fn no_styles_part() {
    let files = [("word/document.xml", r#"<w:document/>"#)];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[],"docDefaults":{"asciiFont":"Aptos","sizeHalfPoints":24,"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// An unclosed comment degrades to the built-in defaults.
#[test]
fn unparseable_styles_part() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><!-- never closed</w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[],"docDefaults":{"asciiFont":"Aptos","sizeHalfPoints":24,"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// A part whose root is not w:styles degrades to the built-in defaults.
#[test]
fn no_styles_root() {
    let files = [(
        "word/styles.xml",
        r#"<w:document><w:style w:type="paragraph" w:styleId="X"/></w:document>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[],"docDefaults":{"asciiFont":"Aptos","sizeHalfPoints":24,"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// w:linkStyles without w:attachedTemplate: Normal.dotm docDefaults, Normal loses its own props and parent.
#[test]
fn link_styles_swaps_in_normal_template() {
    let files = [
        (
            "word/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/><w:b/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="100" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:leftChars="100"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:basedOn w:val="Base"/><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:rPr><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:name w:val="Child"/><w:basedOn w:val="Normal"/></w:style></w:styles>"#,
        ),
        (
            "word/settings.xml",
            r#"<w:settings><w:linkStyles w:val="true"/><w:zoom w:percent="100"/></w:settings>"#,
        ),
    ];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Base",{"styleId":"Base","name":"Base","type":"paragraph","display":{"italic":true,"indentChars":{"left":100}}}],["Normal",{"styleId":"Normal","name":"Normal","type":"paragraph","display":{"spaceAfterTwips":160,"lineRawTwips":278,"lineRule":"auto","lineSpacing":1.1583333333333334,"indentChars":{"left":100}},"isDefault":true}],["Child",{"styleId":"Child","name":"Child","type":"paragraph","basedOn":"Normal","display":{"spaceAfterTwips":160,"lineRawTwips":278,"lineRule":"auto","lineSpacing":1.1583333333333334,"indentChars":{"left":100}}}]],"docDefaults":{"sizeHalfPoints":24,"asciiFont":"Arial","lineRawTwips":278,"lineRule":"auto","lineSpacing":1.1583333333333334,"spaceAfterTwips":160,"indentChars":{"left":100},"sizeCsHalfPoints":24,"kernHalfPoints":2}}"#
        )
    );
}

/// An attached template keeps the package styles.
#[test]
fn link_styles_with_attached_template_is_ignored() {
    let files = [
        (
            "word/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="40"/></w:rPr></w:style></w:styles>"#,
        ),
        (
            "word/settings.xml",
            r#"<w:settings><w:linkStyles/><w:attachedTemplate r:id='rId1'/></w:settings>"#,
        ),
    ];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Normal",{"styleId":"Normal","name":"Normal","type":"paragraph","display":{"sizeHalfPoints":40},"isDefault":true}]],"docDefaults":{"asciiFont":"Times New Roman","sizeHalfPoints":20,"spaceAfterTwips":0}}"#
        )
    );
}

/// numId and ilvl inherit separately; numId 0 cancels; an empty numId drops numbering.
#[test]
fn num_pr_inherits_num_id_and_ilvl_separately() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:style w:type="paragraph" w:styleId="List"><w:name w:val="List"/><w:pPr><w:numPr><w:numId w:val="7"/><w:ilvl w:val="2"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="LvlOnly"><w:name w:val="LvlOnly"/><w:basedOn w:val="List"/><w:pPr><w:numPr><w:ilvl w:val="4"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="IdOnly"><w:name w:val="IdOnly"/><w:basedOn w:val="List"/><w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Cancel"><w:name w:val="Cancel"/><w:basedOn w:val="List"/><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="AfterCancel"><w:name w:val="AfterCancel"/><w:basedOn w:val="Cancel"/><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/><w:basedOn w:val="Cancel"/></w:style><w:style w:type="paragraph" w:styleId="EmptyId"><w:name w:val="EmptyId"/><w:pPr><w:numPr><w:numId w:val=""/><w:ilvl w:val="x"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading 3"><w:name w:val="Heading 3"/><w:basedOn w:val="List"/></w:style><w:style w:type="paragraph" w:styleId="Outline"><w:name w:val="Outline"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Outline"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="BodyKid"><w:name w:val="BodyKid"/><w:basedOn w:val="Outline"/></w:style></w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["List",{"styleId":"List","name":"List","type":"paragraph","numPr":{"numId":"7","ilvl":2}}],["LvlOnly",{"styleId":"LvlOnly","name":"LvlOnly","type":"paragraph","basedOn":"List","numPr":{"numId":"7","ilvl":4}}],["IdOnly",{"styleId":"IdOnly","name":"IdOnly","type":"paragraph","basedOn":"List","numPr":{"numId":"9","ilvl":2}}],["Cancel",{"styleId":"Cancel","name":"Cancel","type":"paragraph","basedOn":"List","numPr":"none"}],["AfterCancel",{"styleId":"AfterCancel","name":"AfterCancel","type":"paragraph","basedOn":"Cancel","numPr":"none"}],["Plain",{"styleId":"Plain","name":"Plain","type":"paragraph","basedOn":"Cancel","numPr":"none"}],["EmptyId",{"styleId":"EmptyId","name":"EmptyId","type":"paragraph"}],["Heading 3",{"styleId":"Heading 3","name":"Heading 3","type":"paragraph","headingLevel":3,"basedOn":"List","numPr":{"numId":"7","ilvl":2}}],["Outline",{"styleId":"Outline","name":"Outline","type":"paragraph","headingLevel":3}],["Body",{"styleId":"Body","name":"Body","type":"paragraph","headingOutlineOff":true,"basedOn":"Outline"}],["BodyKid",{"styleId":"BodyKid","name":"BodyKid","type":"paragraph","headingLevel":3,"basedOn":"Outline","headingLevelInherited":true}]],"docDefaults":{"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// Whole-table run formatting, four conditions, bands, borders, margins and paragraph spacing; a child table style merges deep.
#[test]
fn table_style_with_conditional_formats() {
    let files = [(
        "word/styles.xml",
        r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="accent1" w:themeColor="accent1"/><w:b/><w:sz w:val="18"/><w:kern w:val="x"/></w:rPr><w:tblPr><w:tblStyleRowBandSize w:val="2"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tcPr><w:shd w:val="clear" w:fill="#EEEEEE"/></w:tcPr><w:tblStylePr w:type="firstRow"><w:pPr><w:spacing w:before="20" w:line="276"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi"/><w:b/><w:caps w:val="0"/><w:spacing w:val="-10"/><w:color w:themeColor="background1"/></w:rPr><w:tcPr><w:tcBorders><w:bottom w:val="double" w:sz="6"/></w:tcBorders><w:tcMar><w:top w:w="50" w:type="dxa"/></w:tcMar><w:shd w:fill="4472C4"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="lastRow"><w:rPr><w:smallCaps/><w:i/></w:rPr></w:tblStylePr><w:tblStylePr w:type="firstCol"><w:tcPr><w:shd w:fill="auto"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:fill="F2F2F2"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="band2Horz"><w:tcPr><w:shd w:fill="auto"/></w:tcPr></w:tblStylePr></w:style><w:style w:type="table" w:styleId="GridKid"><w:name w:val="Grid Kid"/><w:basedOn w:val="Grid"/><w:rPr><w:i/></w:rPr><w:tblPr><w:tblBorders><w:left w:val="single" w:sz="8"/></w:tblBorders></w:tblPr><w:tblStylePr w:type="firstRow"><w:pPr><w:spacing w:after="30"/></w:pPr><w:rPr><w:sz w:val="28"/></w:rPr><w:tcPr><w:tcBorders><w:top w:val="single" w:sz="2"/></w:tcBorders><w:tcMar><w:bottom w:w="60" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr></w:style></w:styles>"##,
    )];
    assert_eq!(
        run(&files, true),
        expected(
            r#"{"styles":[["Grid",{"styleId":"Grid","name":"Table Grid","type":"table","tableDisplay":{"fill":"EEEEEE","wholeTable":{"color":"4472C4","bold":true,"sizeHalfPoints":18,"kernHalfPoints":0},"firstRow":{"fill":"4472C4","bold":true,"color":"FFFFFF","caps":"none","fontAscii":"Calibri Light","charSpacingTwips":-10,"borders":{"bottom":{"style":"double","szEighths":6}},"cellMarTwips":{"top":50},"paraSpacing":{"beforeTwips":20,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}},"lastRow":{"italic":true,"caps":"small"},"band1Fill":"F2F2F2","rowBandSize":2,"borders":{"top":{"style":"single","szEighths":4,"color":"000000"},"insideH":{"style":"single","szEighths":4}},"cellMarTwips":{"left":108,"right":108},"paraJc":"center","paraSpacing":{"afterTwips":0,"lineRawTwips":240,"lineRule":"auto","lineSpacing":1}}}],["GridKid",{"styleId":"GridKid","name":"Grid Kid","type":"table","basedOn":"Grid","tableDisplay":{"fill":"EEEEEE","wholeTable":{"color":"4472C4","bold":true,"sizeHalfPoints":18,"kernHalfPoints":0,"italic":true},"firstRow":{"fill":"4472C4","bold":true,"color":"FFFFFF","caps":"none","fontAscii":"Calibri Light","charSpacingTwips":-10,"borders":{"bottom":{"style":"double","szEighths":6},"top":{"style":"single","szEighths":2}},"cellMarTwips":{"top":50,"bottom":60},"paraSpacing":{"afterTwips":30},"sizeHalfPoints":28},"lastRow":{"italic":true,"caps":"small"},"band1Fill":"F2F2F2","rowBandSize":2,"borders":{"left":{"style":"single","szEighths":8}},"cellMarTwips":{"left":108,"right":108},"paraJc":"center","paraSpacing":{"afterTwips":0,"lineRawTwips":240,"lineRule":"auto","lineSpacing":1}}}]],"docDefaults":{"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// Theme font slots, an empty East Asian slot, theme colours with tint, w14 outline and shading.
#[test]
fn theme_fonts_and_colours() {
    let files = [(
        "word/styles.xml",
        r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading 1"><w:name w:val="Heading 1"/><w:pPr><w:keepNext/><w:shd w:val="clear" w:fill="auto"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cstheme="majorBidi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:shd w:val="pct20" w:color="000000" w:fill="FFFFFF"/><w14:textOutline w14:w="9525"><w14:solidFill><w14:schemeClr w14:val="accent2"><w14:lumMod w14:val="75000"/><w14:satMod w14:val="120000"/><w14:alpha w14:val="30000"/></w14:schemeClr></w14:solidFill></w14:textOutline></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia" w:ascii="Georgia"/><w:color w:val="auto"/><w:bdr w:val="single" w:sz="0" w:color="#00FF00" w:space="2"/><w:vanish/><w:specVanish/></w:rPr></w:style><w:style w:type="character" w:styleId="Heading1Char"><w:name w:val="Heading 1 Char"/><w:link w:val="Heading1"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading1"/><w:link w:val="Heading1Char"/><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="32"/><w:szCs w:val="abc"/><w:caps/></w:rPr></w:style></w:styles>"##,
    )];
    assert_eq!(
        run(&files, true),
        expected(
            r#"{"styles":[["Heading 1",{"styleId":"Heading 1","name":"Heading 1","type":"paragraph","headingLevel":1,"display":{"color":"2F5496","fontAscii":"Calibri Light","eastAsiaFont":"Batang","csFont":"Times New Roman","font":"Batang","shading":"CCCCCC","textOutline":{"color":"C05B17","widthPt":0.75,"alpha":0.3},"keepNext":true,"shadingFill":"auto"}}],["Quote",{"styleId":"Quote","name":"Quote","type":"paragraph","display":{"color":"auto","bdr":{"val":"single","sz":4,"color":"00FF00","space":2},"fontAscii":"Georgia","font":"Malgun Gothic","eaSlotEmpty":true}}],["Heading1Char",{"styleId":"Heading1Char","name":"Heading 1 Char","type":"character","display":{"sizeHalfPoints":32,"font":"Arial","fontAscii":"Arial","caps":"all"},"linkedCharShell":true}],["Heading1",{"styleId":"Heading1","name":"Heading1","type":"paragraph","headingLevel":1,"display":{"sizeHalfPoints":32,"fontAscii":"Arial","font":"Arial","caps":"all"}}]],"docDefaults":{"asciiFont":"Calibri","eaThemeSlot":true,"eastAsiaLang":"ko-KR","eastAsiaFont":"Malgun Gothic","eaFromLang":true,"eaSlotEmpty":true,"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// A later style with the same id replaces the value and keeps the first position; its stale basedOn and link survive.
#[test]
fn duplicated_style_ids() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:style w:type="paragraph" w:styleId="Parent"><w:name w:val="Parent"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Dup"><w:name w:val="Dup"/><w:basedOn w:val="Parent"/><w:link w:val="DupChar"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Other"><w:name w:val="Other"/></w:style><w:style w:type="character" w:styleId="Dup"><w:name w:val="Dup again"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="DupChar" w:default="1"><w:name w:val="normal"/><w:link w:val="Dup"/><w:rPr><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="numbering" w:styleId="Other"/><w:style w:type="paragraph"><w:name w:val="no id"/></w:style><w:style w:type="paragraph" w:styleId="Last" w:default="true" w:customStyle="1"><w:name w:val="Last"/><w:semiHidden/><w:qFormat w:val="0"/><w:uiPriority w:val="12"/><w:unhideWhenUsed/></w:style></w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Parent",{"styleId":"Parent","name":"Parent","type":"paragraph","display":{"bold":true}}],["Dup",{"styleId":"Dup","name":"Dup again","type":"character","headingOutlineOff":true,"display":{"sizeHalfPoints":26,"bold":true,"italic":true},"linkedCharShell":true}],["Other",{"styleId":"Other","name":"Other","type":"paragraph"}],["DupChar",{"styleId":"DupChar","name":"normal","type":"paragraph","display":{"sizeHalfPoints":26}}],["Last",{"styleId":"Last","name":"Last","type":"paragraph","semiHidden":true,"qFormat":false,"uiPriority":12,"unhideWhenUsed":true,"custom":true,"isDefault":true}]],"docDefaults":{"spaceAfterTwips":160,"lineRawTwips":276,"lineRule":"auto","lineSpacing":1.15}}"#
        )
    );
}

/// w:sz of "21.5", "", "abc", negative and huge; odd spacing, kern and indents.
#[test]
fn odd_numerics() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="abc"/><w:szCs w:val=""/><w:kern w:val=""/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="0" w:before="x" w:after="-5"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Frac"><w:name w:val="Frac"/><w:rPr><w:sz w:val="21.5"/><w:spacing w:val="1.9"/></w:rPr><w:pPr><w:spacing w:line="250.7" w:lineRule="exact"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Empty"><w:name w:val="Empty"/><w:basedOn w:val="Frac"/><w:rPr><w:sz w:val=""/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Abc"><w:name w:val="Abc"/><w:basedOn w:val="Frac"/><w:rPr><w:sz w:val="abc"/><w:szCs w:val="0"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Neg"><w:name w:val="Neg"/><w:rPr><w:sz w:val="-8"/><w:kern w:val="-3"/></w:rPr><w:pPr><w:ind w:left="-300" w:firstLine="-20" w:hangingChars="-5"/><w:spacing w:before="-40"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Huge"><w:name w:val="Huge"/><w:rPr><w:sz w:val="99999999999999999999999"/></w:rPr><w:pPr><w:spacing w:line="1e5"/></w:pPr></w:style><w:style w:type="character" w:styleId="AbcChar"><w:name w:val="Abc Char"/><w:link w:val="Abc"/></w:style><w:style w:type="paragraph" w:styleId="Prio"><w:name w:val="Prio"/><w:uiPriority w:val="0012"/></w:style><w:style w:type="paragraph" w:styleId="PrioBad"><w:name w:val="PrioBad"/><w:uiPriority w:val="-1"/></w:style></w:styles>"#,
    )];
    assert_eq!(
        run(&files, false),
        expected(
            r#"{"styles":[["Frac",{"styleId":"Frac","name":"Frac","type":"paragraph","display":{"sizeHalfPoints":21,"charSpacingTwips":1,"lineRule":"exact","lineRawTwips":250}}],["Empty",{"styleId":"Empty","name":"Empty","type":"paragraph","basedOn":"Frac","display":{"sizeHalfPoints":21,"charSpacingTwips":1,"lineRule":"exact","lineRawTwips":250}}],["Abc",{"styleId":"Abc","name":"Abc","type":"paragraph","basedOn":"Frac","display":{"charSpacingTwips":1,"lineRule":"exact","lineRawTwips":250}}],["Neg",{"styleId":"Neg","name":"Neg","type":"paragraph","display":{"sizeHalfPoints":-8,"kernHalfPoints":-3,"spaceBeforeTwips":-40,"indentLeftTwips":-300,"indentFirstLineTwips":0}}],["Huge",{"styleId":"Huge","name":"Huge","type":"paragraph","display":{"sizeHalfPoints":1e+23}}],["AbcChar",{"styleId":"AbcChar","name":"Abc Char","type":"character","linkedCharShell":true}],["Prio",{"styleId":"Prio","name":"Prio","type":"paragraph","uiPriority":12}],["PrioBad",{"styleId":"PrioBad","name":"PrioBad","type":"paragraph"}]],"docDefaults":{"asciiFont":"Times New Roman","kernHalfPoints":0,"spaceBeforeTwips":0,"spaceAfterTwips":-5}}"#
        )
    );
}

/// The order of the keys every spread, `Object.assign` and `delete` of
/// parseStyles leaves: a per-side pBdr spread, a tab merge that empties, the
/// docDefaults indent and border fill-in, a linked style taking run keys
/// around a key holding undefined, mergeTableDisplay with both sides of a
/// condition, and the Times New Roman and w:lang paths of docDefaults.
#[test]
fn key_order_of_spreads() {
    let files = [(
        "word/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/><w:b/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:pBdr><w:left w:val="single" w:sz="4"/></w:pBdr><w:ind w:right="100" w:leftChars="30"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="P1"><w:name w:val="P1"/><w:link w:val="C1"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8"/></w:pBdr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:ind w:firstLineChars="100"/></w:pPr><w:rPr><w:color w:val="FF0000"/><w:sz w:val="28"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="P2"><w:name w:val="P2"/><w:basedOn w:val="P1"/><w:pPr><w:pBdr><w:top w:val="nil"/></w:pBdr><w:tabs><w:tab w:val="clear" w:pos="720"/></w:tabs><w:ind w:left="200" w:leftChars="50"/></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="C1"><w:name w:val="C1"/><w:link w:val="P1"/><w:rPr><w:sz w:val="abc"/><w:i/></w:rPr></w:style><w:style w:type="table" w:styleId="T0"><w:name w:val="T0"/><w:rPr><w:color w:val="00FF00"/></w:rPr><w:pPr><w:spacing w:after="10"/></w:pPr><w:tblPr><w:tblCellMar><w:right w:w="50" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:tcBorders><w:top w:val="single"/></w:tcBorders><w:tcMar><w:left w:w="5" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr></w:style><w:style w:type="table" w:styleId="T1"><w:name w:val="T1"/><w:basedOn w:val="T0"/><w:rPr><w:i/><w:color w:val="0000FF"/></w:rPr><w:pPr><w:jc w:val="center"/><w:spacing w:before="20" w:after="30"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders><w:tblCellMar><w:top w:w="7" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="lastRow"><w:tcPr><w:shd w:fill="AAAAAA"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="firstRow"><w:tcPr><w:shd w:fill="BBBBBB"/><w:tcBorders><w:bottom w:val="double"/></w:tcBorders><w:tcMar><w:top w:w="9" w:type="dxa"/></w:tcMar></w:tcPr></w:tblStylePr></w:style></w:styles>"#,
    )];
    assert_eq!(
        serde_json::to_string(&run(&files, false)).expect("serializes"),
        r#"{"styles":[["P1",{"styleId":"P1","name":"P1","type":"paragraph","display":{"sizeHalfPoints":28,"color":"FF0000","bold":true,"borderSides":{"l":{"szPt":0.5},"b":{"szPt":1}},"tabStops":[{"pos":720,"val":"left"}],"indentChars":{"left":30,"firstLine":100},"indentRightTwips":100}}],["P2",{"styleId":"P2","name":"P2","type":"paragraph","basedOn":"P1","display":{"sizeHalfPoints":28,"color":"FF0000","bold":true,"borderSides":{"l":{"szPt":0.5},"b":{"szPt":1},"t":null},"indentChars":{"left":50,"firstLine":100},"italic":true,"indentLeftTwips":200,"indentRightTwips":100}}],["C1",{"styleId":"C1","name":"C1","type":"character","display":{"color":"FF0000","bold":true,"italic":true},"linkedCharShell":true}],["T0",{"styleId":"T0","name":"T0","type":"table","tableDisplay":{"wholeTable":{"color":"00FF00"},"firstRow":{"bold":true,"borders":{"top":{"style":"single"}},"cellMarTwips":{"left":5}},"cellMarTwips":{"right":50},"paraSpacing":{"afterTwips":10}}}],["T1",{"styleId":"T1","name":"T1","type":"table","basedOn":"T0","tableDisplay":{"wholeTable":{"color":"0000FF","italic":true},"firstRow":{"bold":true,"borders":{"top":{"style":"single"},"bottom":{"style":"double"}},"cellMarTwips":{"left":5,"top":9},"fill":"BBBBBB"},"cellMarTwips":{"top":7},"paraSpacing":{"afterTwips":30,"beforeTwips":20},"lastRow":{"fill":"AAAAAA"},"borders":{"top":{"style":"single"}},"paraJc":"center"}}]],"docDefaults":{"sizeCsHalfPoints":24,"asciiFont":"Times New Roman","sizeHalfPoints":20,"eastAsiaLang":"ko-KR","eastAsiaFont":"Malgun Gothic","eaFromLang":true,"bold":true,"lang":"en-US","borderSides":{"l":{"szPt":0.5}},"indentRightTwips":100,"indentChars":{"left":30}}}"#
    );
}

/// Word's rtl selection: Cs twins for rtl runs, base props otherwise, no cross-fallback.
#[test]
fn style_run_format_and_para_cs_format() {
    let display = StyleDisplay {
        bold_cs: Slot::of(true),
        size_half_points: Slot::of(JsNum(30.0)),
        bold: Slot::of(false),
        italic: Slot::of(true),
        ..StyleDisplay::default()
    };
    let dd = DocDefaults {
        size_cs_half_points: Slot::of(JsNum(26.0)),
        italic_cs: Slot::of(true),
        ..DocDefaults::default()
    };
    assert_eq!(
        json!([
            style_run_format(Some(&display), true),
            style_run_format(Some(&display), false),
            style_run_format(None, true)
        ]),
        expected(r#"[{"bold":true},{"bold":false,"italic":true,"sizeHalfPoints":30},{}]"#)
    );
    assert_eq!(
        json!([
            para_cs_format(Some(&display), Some(&dd)),
            para_cs_format(None, Some(&dd)),
            para_cs_format(None, None)
        ]),
        expected(
            r#"[{"sizeHalfPoints":26,"bold":true,"italic":true},{"sizeHalfPoints":26,"bold":false,"italic":true},{"sizeHalfPoints":20,"bold":false,"italic":false}]"#
        )
    );
}
