//! The drawing readers on inputs that are large rather than odd: they have to
//! finish, and give the answer a small input of the same shape gives.

use std::fmt::Write as _;
use std::rc::Rc;

use docx_engine::blank::{BlankDocxOptions, blank_docx_package};
use docx_engine::model::SharedStr;
use docx_engine::package::RelInfo;
use docx_engine::parse::drawings::diagram::extract_diagram_text;
use docx_engine::parse::drawings::host::{MediaEnv, NoHost};
use docx_engine::parse::parse_docx_full;
use docx_engine::parse::text::BuildContext;
use docx_engine::resolve::ResolveCtx;
use ooxml_pkg::Package;

/// `extractDiagramText` over a diagram data part, reached through `r:dm`.
fn diagram_text(data_xml: String) -> Option<String> {
    let package = Package::from_parts([("word/diagrams/data1.xml", data_xml)]);
    let media = MediaEnv::new(&NoHost);
    let mut ctx = BuildContext::bare(&package, Rc::new(ResolveCtx::default()), &media);
    ctx.rels.set(
        "rId9",
        RelInfo {
            target: "diagrams/data1.xml".to_owned(),
            rel_type: String::new(),
            target_mode: None,
        },
    );
    extract_diagram_text(r#"<dgm:relIds r:dm="rId9"/>"#, &ctx).expect("the diagram part reads")
}

/// One root with `wide` children in tree order, and `wide` points the tree
/// does not reach: the shape a visited-set scan per node is quadratic on.
#[test]
fn a_wide_shallow_diagram_is_read_in_linear_time() {
    const WIDE: usize = 1_500;
    let mut xml = String::from("<dgm:dataModel><dgm:ptLst>");
    xml.push_str(r#"<dgm:pt modelId="root"><a:t>root</a:t></dgm:pt>"#);
    for at in 0..WIDE {
        write!(xml, r#"<dgm:pt modelId="c{at}"><a:t>c{at}</a:t></dgm:pt>"#).unwrap();
    }
    for at in 0..WIDE {
        write!(xml, r#"<dgm:pt modelId="i{at}"><a:t>i{at}</a:t></dgm:pt>"#).unwrap();
    }
    xml.push_str("</dgm:ptLst><dgm:cxnLst>");
    // written in reverse, so the srcOrd sort has work to do
    for at in (0..WIDE).rev() {
        write!(
            xml,
            r#"<dgm:cxn srcId="root" destId="c{at}" srcOrd="{at}"/>"#
        )
        .unwrap();
    }
    xml.push_str("</dgm:cxnLst></dgm:dataModel>");

    let text = diagram_text(xml).expect("the diagram has texts");
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines.len(), 1 + 2 * WIDE);
    assert_eq!(lines[0], "root");
    assert_eq!(lines[1], "c0");
    assert_eq!(lines[WIDE], format!("c{}", WIDE - 1));
    assert_eq!(lines[WIDE + 1], "i0");
    assert_eq!(lines[2 * WIDE], format!("i{}", WIDE - 1));
}

/// Many separate parent-child pairs: every pair is a root, and each root is
/// tested against the set of all the nodes that have a parent.
#[test]
fn many_separate_roots_are_read_in_linear_time() {
    const PAIRS: usize = 1_500;
    let mut xml = String::from("<dgm:dataModel><dgm:ptLst>");
    for at in 0..PAIRS {
        write!(xml, r#"<dgm:pt modelId="p{at}"><a:t>p{at}</a:t></dgm:pt>"#).unwrap();
        write!(xml, r#"<dgm:pt modelId="k{at}"><a:t>k{at}</a:t></dgm:pt>"#).unwrap();
    }
    xml.push_str("</dgm:ptLst><dgm:cxnLst>");
    for at in 0..PAIRS {
        write!(xml, r#"<dgm:cxn srcId="p{at}" destId="k{at}"/>"#).unwrap();
    }
    xml.push_str("</dgm:cxnLst></dgm:dataModel>");

    let text = diagram_text(xml).expect("the diagram has texts");
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines.len(), 2 * PAIRS);
    assert_eq!(&lines[..4], ["p0", "k0", "p1", "k1"]);
}

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006""#;

/// An inline picture of the part `rIdImg` names.
fn inline_picture(id: usize) -> String {
    format!(
        r#"<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="952500" cy="952500"/><wp:docPr id="{id}" name="Picture {id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="p{id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>"#
    )
}

/// An anchored picture that wraps text: laid out beside the paragraph's text.
fn anchored_picture(id: usize) -> String {
    format!(
        r#"<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="952500" cy="952500"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="{id}" name="Picture {id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="p{id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>"#
    )
}

/// A text box whose fill is the picture.
fn picture_filled_box(id: usize) -> String {
    format!(
        r#"<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1905000" cy="952500"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="{id}" name="Box {id}"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>box {id}</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent>"#
    )
}

/// A document of `body` over a blank one, with a default header of
/// `header_body`, and `word/media/image1.png` of `image_bytes` bytes that
/// `rIdImg` names in both.
fn docx_with_picture(body: &str, header_body: &str, image_bytes: usize) -> Vec<u8> {
    let mut package = blank_docx_package(&BlankDocxOptions::default(), 0.0).expect("a blank docx");
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{body}<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/></w:sectPr></w:body></w:document>"#
    );
    package.set_file("word/document.xml", document.into_bytes());
    let header = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {NS}>{header_body}</w:hdr>"#
    );
    package.set_file("word/header1.xml", header.into_bytes());
    package.set_file(
        "word/_rels/header1.xml.rels",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>"#.to_vec(),
    );
    let rels = package
        .text("word/_rels/document.xml.rels")
        .expect("rels read")
        .expect("a blank docx has document rels")
        .replace(
            "</Relationships>",
            r#"<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>"#,
        );
    package.set_file("word/_rels/document.xml.rels", rels.into_bytes());
    package.set_file("word/media/image1.png", vec![0x89; image_bytes]);
    ooxml_pkg::write::generate(&package, 0.0).expect("the package is written")
}

/// One picture referenced from many paragraphs is one string in the parsed
/// document, as it is one string in the TypeScript: the picture paragraphs
/// and the pictures inside text paragraphs and table cells all hold the
/// allocation the media cache made.
#[test]
fn a_picture_used_many_times_is_one_allocation() {
    const USES: usize = 3;
    let mut body = String::new();
    for at in 0..USES {
        // a paragraph of nothing but the picture: an image block
        write!(body, "<w:p><w:r>{}</w:r></w:p>", inline_picture(3 * at + 1)).unwrap();
        // a text paragraph with the picture among its runs
        write!(
            body,
            "<w:p><w:r><w:t>text {at}</w:t></w:r><w:r>{}</w:r></w:p>",
            inline_picture(3 * at + 2)
        )
        .unwrap();
        // a table cell with the picture among its runs
        write!(
            body,
            "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r><w:r>{}</w:r></w:p></w:tc></w:tr></w:tbl>",
            inline_picture(3 * at + 3)
        )
        .unwrap();
    }
    for at in 0..USES {
        write!(
            body,
            "<w:p><w:r><w:t>beside {at}</w:t></w:r><w:r>{}</w:r></w:p>",
            anchored_picture(1000 + at)
        )
        .unwrap();
    }
    for at in 0..USES {
        write!(
            body,
            "<w:p><w:r>{}</w:r></w:p>",
            picture_filled_box(3000 + at)
        )
        .unwrap();
    }
    let mut header = String::new();
    for at in 0..USES {
        write!(
            header,
            "<w:p><w:r>{}</w:r></w:p>",
            inline_picture(2000 + at)
        )
        .unwrap();
    }
    let bytes = docx_with_picture(&body, &header, 30_000);
    // the parser's frames in a debug build do not fit the 2 MB of a test thread
    let doc = std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || parse_docx_full(&bytes, &NoHost).expect("the document parses"))
        .unwrap()
        .join()
        .unwrap();

    let mut image_blocks: Vec<&SharedStr> = Vec::new();
    let mut text_runs: Vec<&SharedStr> = Vec::new();
    let mut cell_runs: Vec<&SharedStr> = Vec::new();
    for block in &doc.blocks {
        image_blocks.extend(block.image_data_url.iter());
        for run in block.runs.iter().flatten() {
            text_runs.extend(run.image.iter().map(|image| &image.data_url));
        }
        for table in block.table.iter() {
            for cell in table.rows.iter().flatten() {
                for para in cell.rich_paras.iter().flatten() {
                    for run in &para.runs {
                        cell_runs.extend(run.image.iter().map(|image| &image.data_url));
                    }
                }
            }
        }
    }
    let mut box_fills: Vec<&SharedStr> = Vec::new();
    for block in &doc.blocks {
        for textbox in block.textboxes.iter().flatten() {
            box_fills.extend(textbox.fill_image_data_url.iter());
        }
    }
    let header_images: Vec<&SharedStr> = doc
        .header_images
        .iter()
        .flatten()
        .flatten()
        .filter_map(|image| image.data_url.as_ref())
        .collect();
    let part_images: Vec<&SharedStr> = doc
        .hf_parts
        .iter()
        .flat_map(|parts| parts.entries())
        .flat_map(|(_, part)| part.images.iter().flatten())
        .filter_map(|image| image.data_url.as_ref())
        .collect();
    assert_eq!(image_blocks.len(), USES);
    assert_eq!(text_runs.len(), 2 * USES);
    assert_eq!(cell_runs.len(), USES);
    assert_eq!(box_fills.len(), USES);
    assert_eq!(header_images.len(), USES);
    assert_eq!(part_images.len(), USES);
    let first = image_blocks[0];
    assert!(first.starts_with("data:image/png;base64,"));
    for (what, holders) in [
        ("image block", &image_blocks),
        ("text run", &text_runs),
        ("table cell run", &cell_runs),
        ("text box fill", &box_fills),
        ("header image", &header_images),
        ("header part image", &part_images),
    ] {
        for holder in holders {
            assert!(holder.ptr_eq(first), "a {what} holds its own copy");
        }
    }
    let found = image_blocks.len()
        + text_runs.len()
        + cell_runs.len()
        + box_fills.len()
        + header_images.len()
        + part_images.len();
    assert_eq!(
        first.holders(),
        found,
        "the document holds the string where the walk above does not look"
    );
}
