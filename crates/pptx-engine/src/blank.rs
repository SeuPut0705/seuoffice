//! Blank presentation template (packages/pptx-engine/src/blank.ts): the
//! starting point of the start screen's "new presentation".

use ooxml_pkg::Package;
use ooxml_pkg::write::generate;

/// The XML declaration every part starts with.
macro_rules! xmldecl {
    () => {
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
    };
}

/// The three namespace declarations of a presentation part root.
macro_rules! ns_attrs {
    () => {
        concat!(
            " xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"",
            " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
            " xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\""
        )
    };
}

/// `EMPTY_SPTREE`
macro_rules! empty_sptree {
    () => {
        concat!(
            "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>",
            "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>",
            "<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>"
        )
    };
}

const CONTENT_TYPES: &str = concat!(
    xmldecl!(),
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
    "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
    "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>",
    "<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>",
    "<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>",
    "<Override PartName=\"/ppt/slides/slide1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>",
    "<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>",
    "</Types>"
);

const ROOT_RELS: &str = concat!(
    xmldecl!(),
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/>",
    "</Relationships>"
);

const PRESENTATION: &str = concat!(
    xmldecl!(),
    "<p:presentation",
    ns_attrs!(),
    ">",
    "<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>",
    "<p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst>",
    "<p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/>",
    "</p:presentation>"
);

const PRESENTATION_RELS: &str = concat!(
    xmldecl!(),
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>",
    "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/>",
    "</Relationships>"
);

/// Minimal blank slide XML (empty spTree); insertBlankSlide also uses it as new slide content.
pub const BLANK_SLIDE_XML: &str = concat!(
    xmldecl!(),
    "<p:sld",
    ns_attrs!(),
    ">",
    "<p:cSld>",
    empty_sptree!(),
    "</p:cSld>",
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
);

const SLIDE1_RELS: &str = concat!(
    xmldecl!(),
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>",
    "</Relationships>"
);

const LAYOUT1: &str = concat!(
    xmldecl!(),
    "<p:sldLayout",
    ns_attrs!(),
    " type=\"blank\">",
    "<p:cSld name=\"Blank\">",
    empty_sptree!(),
    "</p:cSld>",
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
);

const LAYOUT1_RELS: &str = concat!(
    xmldecl!(),
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/>",
    "</Relationships>"
);

const MASTER1: &str = concat!(
    xmldecl!(),
    "<p:sldMaster",
    ns_attrs!(),
    ">",
    "<p:cSld>",
    empty_sptree!(),
    "</p:cSld>",
    "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>",
    "<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>",
    "<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>",
    "</p:sldMaster>"
);

const MASTER1_RELS: &str = concat!(
    xmldecl!(),
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>",
    "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/>",
    "</Relationships>"
);

macro_rules! solid_ph {
    () => {
        "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>"
    };
}

macro_rules! ln_ph {
    ($w:literal) => {
        concat!("<a:ln w=\"", $w, "\">", solid_ph!(), "</a:ln>")
    };
}

// The per-script faces are written as escapes: Jpan, Hang, Hans and Hant of the
// major font, then the same four of the minor font.
const THEME1: &str = concat!(
    xmldecl!(),
    "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office\">",
    "<a:themeElements>",
    "<a:clrScheme name=\"Office\">",
    "<a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1>",
    "<a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1>",
    "<a:dk2><a:srgbClr val=\"44546A\"/></a:dk2>",
    "<a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2>",
    "<a:accent1><a:srgbClr val=\"C43E1C\"/></a:accent1>",
    "<a:accent2><a:srgbClr val=\"ED7D31\"/></a:accent2>",
    "<a:accent3><a:srgbClr val=\"A5A5A5\"/></a:accent3>",
    "<a:accent4><a:srgbClr val=\"FFC000\"/></a:accent4>",
    "<a:accent5><a:srgbClr val=\"4472C4\"/></a:accent5>",
    "<a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6>",
    "<a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink>",
    "<a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink>",
    "</a:clrScheme>",
    "<a:fontScheme name=\"Office\">",
    "<a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/>",
    "<a:font script=\"Jpan\" typeface=\"\u{FF2D}\u{FF33}\u{0020}\u{30B4}\u{30B7}\u{30C3}\u{30AF}\"/>",
    "<a:font script=\"Hang\" typeface=\"\u{B9D1}\u{C740}\u{0020}\u{ACE0}\u{B515}\"/>",
    "<a:font script=\"Hans\" typeface=\"\u{7B49}\u{7EBF}\"/>",
    "<a:font script=\"Hant\" typeface=\"\u{65B0}\u{7D30}\u{660E}\u{9AD4}\"/>",
    "</a:majorFont>",
    "<a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/>",
    "<a:font script=\"Jpan\" typeface=\"\u{FF2D}\u{FF33}\u{0020}\u{FF30}\u{30B4}\u{30B7}\u{30C3}\u{30AF}\"/>",
    "<a:font script=\"Hang\" typeface=\"\u{B9D1}\u{C740}\u{0020}\u{ACE0}\u{B515}\"/>",
    "<a:font script=\"Hans\" typeface=\"\u{7B49}\u{7EBF}\"/>",
    "<a:font script=\"Hant\" typeface=\"\u{65B0}\u{7D30}\u{660E}\u{9AD4}\"/>",
    "</a:minorFont>",
    "</a:fontScheme>",
    "<a:fmtScheme name=\"Office\">",
    // fill, line, effect and background fill style lists
    "<a:fillStyleLst>",
    solid_ph!(),
    solid_ph!(),
    solid_ph!(),
    "</a:fillStyleLst>",
    "<a:lnStyleLst>",
    ln_ph!("6350"),
    ln_ph!("12700"),
    ln_ph!("19050"),
    "</a:lnStyleLst>",
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>",
    "<a:effectStyle><a:effectLst/></a:effectStyle>",
    "<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>",
    "<a:bgFillStyleLst>",
    solid_ph!(),
    solid_ph!(),
    solid_ph!(),
    "</a:bgFillStyleLst>",
    "</a:fmtScheme>",
    "</a:themeElements></a:theme>"
);

/// Generate blank presentation bytes (16:9, one blank slide). `now` is the
/// clock (a time value in milliseconds) the zip entries are stamped with:
/// JSZip reads it from the host, the engine does not.
pub fn create_blank_pptx(now: f64) -> Result<Vec<u8>, String> {
    let package = Package::from_parts([
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("ppt/presentation.xml", PRESENTATION),
        ("ppt/_rels/presentation.xml.rels", PRESENTATION_RELS),
        ("ppt/slides/slide1.xml", BLANK_SLIDE_XML),
        ("ppt/slides/_rels/slide1.xml.rels", SLIDE1_RELS),
        ("ppt/slideLayouts/slideLayout1.xml", LAYOUT1),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", LAYOUT1_RELS),
        ("ppt/slideMasters/slideMaster1.xml", MASTER1),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", MASTER1_RELS),
        ("ppt/theme/theme1.xml", THEME1),
    ]);
    generate(&package, now).map_err(|error| error.to_string())
}
