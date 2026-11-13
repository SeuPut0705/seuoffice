use std::io::Write;

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use spike_one_run_save::container::{Archive, Docx};
use spike_one_run_save::probe::{body_text, paragraph_runs};
use spike_one_run_save::{RunEdit, way_a, way_b};

struct Entry<'a> {
    name: &'a str,
    data: &'a [u8],
    deflate: bool,
    descriptor: bool,
    extra: &'a [u8],
}

/// A zip written field by field, so the test controls data descriptors,
/// extra fields and a prefix before the first record.
fn zip(prefix: &[u8], entries: &[Entry<'_>]) -> Vec<u8> {
    let mut out = prefix.to_vec();
    let mut central = Vec::new();
    for e in entries {
        let mut crc = Crc::new();
        crc.update(e.data);
        let stored = if e.deflate {
            let mut enc = DeflateEncoder::new(Vec::new(), Compression::fast());
            enc.write_all(e.data).unwrap();
            enc.finish().unwrap()
        } else {
            e.data.to_vec()
        };
        let flags: u16 = if e.descriptor { 8 } else { 0 };
        let method: u16 = if e.deflate { 8 } else { 0 };
        let sizes = |zeroed: bool| -> Vec<u8> {
            let mut v = Vec::new();
            let (c, s, u) = if zeroed {
                (0, 0, 0)
            } else {
                (crc.sum(), stored.len() as u32, e.data.len() as u32)
            };
            v.extend(c.to_le_bytes());
            v.extend(s.to_le_bytes());
            v.extend(u.to_le_bytes());
            v
        };
        let offset = out.len() as u32;
        out.extend(0x0403_4b50u32.to_le_bytes());
        out.extend(20u16.to_le_bytes());
        out.extend(flags.to_le_bytes());
        out.extend(method.to_le_bytes());
        out.extend([0, 0, 0x21, 0]);
        out.extend(sizes(e.descriptor));
        out.extend((e.name.len() as u16).to_le_bytes());
        out.extend((e.extra.len() as u16).to_le_bytes());
        out.extend(e.name.as_bytes());
        out.extend(e.extra);
        out.extend(&stored);
        if e.descriptor {
            out.extend(0x0807_4b50u32.to_le_bytes());
            out.extend(sizes(false));
        }
        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(flags.to_le_bytes());
        central.extend(method.to_le_bytes());
        central.extend([0, 0, 0x21, 0]);
        central.extend(sizes(false));
        central.extend((e.name.len() as u16).to_le_bytes());
        central.extend((e.extra.len() as u16).to_le_bytes());
        central.extend([0u8; 6]);
        central.extend(0u32.to_le_bytes());
        central.extend(offset.to_le_bytes());
        central.extend(e.name.as_bytes());
        central.extend(e.extra);
    }
    let cd_start = out.len() as u32;
    out.extend(&central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]);
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(cd_start.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

const WORD_PARAGRAPH: &str = concat!(
    r#"<w:p w:rsidR="00A1" w14:paraId="1A2B3C4D"><w:pPr><w:pStyle w:val="Normal"/></w:pPr>"#,
    r#"<w:proofErr w:type="spellStart"/><w:r w:rsidR="00B2"><w:rPr><w:b/></w:rPr><w:t>Helo</w:t></w:r>"#,
    r#"<w:proofErr w:type="spellEnd"/><w:bookmarkStart w:id="0" w:name="mark"/>"#,
    r#"<w:r><w:t xml:space="preserve"> world </w:t></w:r><w:bookmarkEnd w:id="0"/>"#,
    r#"<w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>link</w:t></w:r></w:hyperlink></w:p>"#,
);

fn document(paragraph: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\r\n",
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
            r#"<w:p><w:r><w:t>Before</w:t></w:r></w:p>{}<w:p><w:r><w:t>After</w:t></w:r></w:p>"#,
            r#"<w:sectPr/></w:body></w:document>"#
        ),
        paragraph
    )
}

fn package(xml: &str) -> Vec<u8> {
    zip(
        b"PREFIX",
        &[
            Entry {
                name: "[Content_Types].xml",
                data: b"<Types/>",
                deflate: true,
                descriptor: true,
                extra: &[],
            },
            Entry {
                name: "word/document.xml",
                data: xml.as_bytes(),
                deflate: true,
                descriptor: true,
                extra: &[],
            },
            Entry {
                name: "word/styles.xml",
                data: b"<w:styles/>",
                deflate: false,
                descriptor: false,
                extra: &[0x55, 0x54, 1, 0, 7],
            },
            Entry {
                name: "word/media/image1.png",
                data: &[0x89, b'P', b'N', b'G', 0, 1, 2, 3],
                deflate: false,
                descriptor: true,
                extra: &[],
            },
        ],
    )
}

/// The original with the content of one `w:t` of the edited paragraph (the
/// one with `w:rsidR`) replaced.
fn spliced(xml: &str, run: usize, text: &str) -> (String, std::ops::Range<usize>) {
    let start = xml.find("<w:p w:rsidR").unwrap();
    let end = start + xml[start..].find("</w:p>").unwrap() + 6;
    let content = paragraph_runs(xml, start..end)[run].texts[0].clone();
    (
        format!("{}{}{}", &xml[..content.start], text, &xml[content.end..]),
        content,
    )
}

fn saved_xml(bytes: &[u8]) -> String {
    Docx::open(bytes).unwrap().xml
}

#[test]
fn other_entries_stay_raw_identical_both_ways() {
    let xml = document(WORD_PARAGRAPH);
    let bytes = package(&xml);
    let docx = Docx::open(&bytes).unwrap();
    let edit = RunEdit {
        paragraph: 1,
        run: 1,
        text: "changed",
    };
    let saves = [
        way_b::save_with_edit(&docx, &edit).unwrap(),
        way_a::save_with_edit(&docx, &edit, 0).unwrap(),
        way_a::save_with_edit(&docx, &edit, way_a::LAST_STEP).unwrap(),
    ];
    for saved in &saves {
        assert!(
            saved.starts_with(b"PREFIX"),
            "prefix before the first record kept"
        );
        let archive = Archive::parse(saved).unwrap();
        for (i, record) in docx.archive.records.iter().enumerate() {
            if i == docx.main {
                continue;
            }
            let j = archive
                .find(std::str::from_utf8(&record.name).unwrap())
                .unwrap();
            assert_eq!(
                archive.local_record(j),
                docx.archive.local_record(i),
                "raw record of {:?}",
                record.name
            );
        }
        let entries = ooxml_pkg::read_entries(saved).unwrap();
        let main = entries
            .iter()
            .find(|e| e.raw_name == b"word/document.xml")
            .unwrap();
        assert!(
            main.content.is_ok(),
            "the zip crate reads the replaced entry"
        );
    }
}

#[test]
fn way_b_keeps_sibling_runs_around_bookmark_hyperlink_and_proof_err() {
    let xml = document(WORD_PARAGRAPH);
    let bytes = package(&xml);
    let docx = Docx::open(&bytes).unwrap();
    for run in 0..3 {
        let edit = RunEdit {
            paragraph: 1,
            run,
            text: "changed",
        };
        let saved = saved_xml(&way_b::save_with_edit(&docx, &edit).unwrap());
        assert_eq!(saved, spliced(&xml, run, "changed").0, "run {run}");
    }
}

#[test]
fn way_a_minimal_rewrites_exactly_what_it_does_not_hold() {
    let xml = document(WORD_PARAGRAPH);
    let edit = RunEdit {
        paragraph: 1,
        run: 0,
        text: "Hello",
    };
    let saved = way_a::edit_xml(&xml, &edit, 0).unwrap();
    let paragraph = concat!(
        r#"<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>"#,
        r#"<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello</w:t></w:r>"#,
        r#"<w:r><w:t xml:space="preserve"> world </w:t></w:r>"#,
        r#"<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">link</w:t></w:r></w:p>"#,
    );
    assert_eq!(
        saved,
        document(paragraph),
        "rsid and paraId, proofErr, bookmarks and the hyperlink are gone; every w:t preserves"
    );

    let identical: Vec<u8> = (0..=way_a::LAST_STEP)
        .filter(|&step| way_a::edit_xml(&xml, &edit, step).unwrap() == spliced(&xml, 0, "Hello").0)
        .collect();
    assert_eq!(
        identical,
        vec![way_a::STEP_MARKS, way_a::STEP_WHITESPACE],
        "identity needs every step through the paragraph marks"
    );
}

#[test]
fn escaping_and_edge_space_are_written_correctly() {
    let xml = document(r#"<w:p w:rsidR="1"><w:r><w:t>x</w:t></w:r><w:r><w:t>y</w:t></w:r></w:p>"#);
    let bytes = package(&xml);
    let docx = Docx::open(&bytes).unwrap();
    let text = "  a & b < c > \u{1D11E} ";
    let edit = RunEdit {
        paragraph: 1,
        run: 0,
        text,
    };
    let (_, content) = spliced(&xml, 0, text);
    let expected = body_text(&xml, Some((content, text))).unwrap();
    let written = r#"<w:t xml:space="preserve">  a &amp; b &lt; c &gt; 𝄞 </w:t>"#;
    for (name, saved) in [
        ("B", way_b::save_with_edit(&docx, &edit).unwrap()),
        ("A0", way_a::save_with_edit(&docx, &edit, 0).unwrap()),
        (
            "A last",
            way_a::save_with_edit(&docx, &edit, way_a::LAST_STEP).unwrap(),
        ),
    ] {
        let saved = saved_xml(&saved);
        assert!(saved.contains(written), "{name}: {saved}");
        assert_eq!(
            body_text(&saved, None).unwrap(),
            expected,
            "{name} reads back"
        );
    }
}

#[test]
fn way_a_last_step_still_rewrites_quoting_and_entities_of_sibling_runs() {
    let xml = document(
        r#"<w:p w:rsidR="1"><w:r><w:rPr><w:b w:val='1'/></w:rPr><w:t>say &quot;hi&#33;&quot;</w:t></w:r><w:r><w:t>x</w:t></w:r></w:p>"#,
    );
    let edit = RunEdit {
        paragraph: 1,
        run: 1,
        text: "y",
    };
    assert_eq!(
        way_b::edit_xml(&xml, &edit).unwrap(),
        spliced(&xml, 1, "y").0
    );
    let paragraph = r#"<w:p w:rsidR="1"><w:r><w:rPr><w:b w:val="1"/></w:rPr><w:t>say "hi!"</w:t></w:r><w:r><w:t>y</w:t></w:r></w:p>"#;
    assert_eq!(
        way_a::edit_xml(&xml, &edit, way_a::LAST_STEP).unwrap(),
        document(paragraph)
    );
}
