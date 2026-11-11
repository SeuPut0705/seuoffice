//! Runs the one-run edit over every tracked .docx, both ways, and prints the
//! table of README.md. Usage: `measure [output file]` from the repository root.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::ops::Range;
use std::process::Command;

use docx_engine::scan::scan_body;
use spike_one_run_save::classify::classify;
use spike_one_run_save::container::{Archive, Docx, MAIN_PART};
use spike_one_run_save::probe::{body_text, paragraph_runs};
use spike_one_run_save::{RunEdit, way_a, way_b};

const NEW_TEXT: &str = "Edit & <x> \u{1D11E}";
const PARAGRAPHS_PER_DOCUMENT: usize = 20;

/// Constructs a minimal mirror does not hold, counted in the edited paragraphs.
const FEATURES: [(&str, &[&str]); 14] = [
    (
        "w:rsid* attributes",
        &[" w:rsidR=", " w:rsidRPr=", " w:rsidP=", " w:rsidDel="],
    ),
    ("w:proofErr", &["<w:proofErr"]),
    ("bookmarks", &["<w:bookmarkStart"]),
    ("w:hyperlink", &["<w:hyperlink"]),
    ("w:ins or w:del", &["<w:ins ", "<w:del "]),
    ("field characters", &["<w:fldChar", "<w:instrText"]),
    ("w:tab", &["<w:tab/>"]),
    ("w:br or w:cr", &["<w:br", "<w:cr"]),
    ("w:drawing or w:pict", &["<w:drawing", "<w:pict"]),
    ("w:lastRenderedPageBreak", &["<w:lastRenderedPageBreak"]),
    ("w:smartTag or w:sdt", &["<w:smartTag", "<w:sdt>"]),
    ("comment ranges", &["<w:commentRangeStart"]),
    ("entity or character reference", &["&quot;", "&apos;", "&#"]),
    ("line break between elements", &[">\n", ">\r\n"]),
];

#[derive(Default)]
struct Tally {
    edits: usize,
    errors: BTreeMap<String, (usize, String)>,
    entries_compared: usize,
    entries_raw: usize,
    entries_inflated: usize,
    edits_entries_raw: usize,
    sibling_paragraphs: usize,
    sibling_runs: usize,
    text_invariant: usize,
    classes: BTreeMap<String, (usize, String)>,
}

struct Target {
    path: String,
    paragraph: usize,
    para: Range<usize>,
    run: usize,
    content: Range<usize>,
}

fn note(
    map: &mut BTreeMap<String, (usize, String)>,
    key: String,
    example: impl FnOnce() -> String,
) {
    let entry = map.entry(key).or_insert_with(|| (0, example()));
    entry.0 += 1;
}

fn check_xml(tally: &mut Tally, original: &str, saved: &str, target: &Target, expected_text: &str) {
    let (ts, te) = (target.content.start, target.content.end);
    let fits = saved.len() >= ts + (original.len() - te);
    let paragraph_fits = saved.len() >= target.para.start + (original.len() - target.para.end);
    if paragraph_fits
        && saved.starts_with(&original[..target.para.start])
        && saved.ends_with(&original[target.para.end..])
    {
        tally.sibling_paragraphs += 1;
    }
    if fits && saved.starts_with(&original[..ts]) && saved.ends_with(&original[te..]) {
        tally.sibling_runs += 1;
    } else {
        match classify(original, saved, target.para.clone(), target.content.clone()) {
            Some(d) => note(&mut tally.classes, d.class, || {
                format!(
                    "{} paragraph {} run {}\n      original: {}\n      saved:    {}",
                    target.path, target.paragraph, target.run, d.original, d.saved
                )
            }),
            None => note(&mut tally.classes, "unclassified".into(), || {
                target.path.clone()
            }),
        }
    }
    match body_text(saved, None) {
        Ok(text) if text == expected_text => tally.text_invariant += 1,
        Ok(_) => note(
            &mut tally.classes,
            "INVARIANT: text read back differs".into(),
            || target.path.clone(),
        ),
        Err(e) => note(
            &mut tally.classes,
            format!("INVARIANT: saved part does not scan: {e}"),
            || target.path.clone(),
        ),
    }
}

fn check_zip(
    tally: &mut Tally,
    original: &Archive<'_>,
    original_entries: &[ooxml_pkg::Entry],
    saved_bytes: &[u8],
    main: usize,
) -> Result<String, String> {
    let saved = Archive::parse(saved_bytes)?;
    let saved_entries = ooxml_pkg::read_entries(saved_bytes).map_err(|e| e.to_string())?;
    let mut all_raw = true;
    for (i, record) in original.records.iter().enumerate() {
        if i == main {
            continue;
        }
        tally.entries_compared += 1;
        let raw = saved
            .find(&String::from_utf8_lossy(&record.name))
            .is_some_and(|j| saved.local_record(j) == original.local_record(i));
        tally.entries_raw += usize::from(raw);
        all_raw &= raw;
        let inflated = saved_entries
            .iter()
            .zip(original_entries)
            .find(|(s, _)| s.raw_name == record.name)
            .is_some_and(|(s, o)| s.content == o.content);
        tally.entries_inflated += usize::from(inflated);
    }
    tally.edits_entries_raw += usize::from(all_raw);
    let main_saved = saved_entries
        .iter()
        .find(|e| e.raw_name == MAIN_PART.as_bytes())
        .ok_or("no main part in the saved file")?;
    let content = main_saved.content.clone()?;
    String::from_utf8(content).map_err(|_| "saved main part is not UTF-8".to_owned())
}

fn pct(n: usize, of: usize) -> String {
    if of == 0 {
        "-".into()
    } else {
        format!("{:.1}%", 100.0 * n as f64 / of as f64)
    }
}

fn main() {
    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/u1g-result.txt".into());
    let given: Vec<String> = std::env::args().skip(2).collect();
    let paths: Vec<String> = if given.is_empty() {
        let listing = Command::new("git")
            .args(["ls-files", "*.docx"])
            .output()
            .expect("git ls-files");
        String::from_utf8_lossy(&listing.stdout)
            .lines()
            .map(str::to_owned)
            .collect()
    } else {
        given
    };

    // the configurations with the zip checked; the A steps between are XML only
    let full = [
        "B".to_owned(),
        "A0".to_owned(),
        format!("A{}", way_a::LAST_STEP),
    ];
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    let mut not_opened: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let (mut opened, mut without_paragraph, mut paragraphs, mut multi_t_runs) = (0, 0, 0, 0);
    let (mut with_rsid, mut top_paragraphs) = (0, 0);
    let (mut with_descriptor, mut with_prefix, mut container_ok) = (0, 0, 0);
    let mut container_failures: Vec<String> = Vec::new();
    let mut census = [0usize; FEATURES.len()];

    for path in &paths {
        let Ok(bytes) = std::fs::read(path) else {
            not_opened
                .entry("unreadable".into())
                .or_default()
                .push(path.clone());
            continue;
        };
        let docx = match Docx::open(&bytes) {
            Ok(docx) => docx,
            Err(e) => {
                not_opened.entry(e).or_default().push(path.clone());
                continue;
            }
        };
        let scan = match scan_body(&docx.xml) {
            Ok(scan) => scan,
            Err(e) => {
                not_opened
                    .entry(format!("scan: {e}"))
                    .or_default()
                    .push(path.clone());
                continue;
            }
        };
        opened += 1;
        with_rsid += usize::from(docx.xml.contains(" w:rsidR="));
        with_descriptor += usize::from(docx.archive.records.iter().any(|r| r.flags & 8 != 0));
        with_prefix += usize::from(docx.archive.records.iter().all(|r| r.local.start > 0));
        let original_entries = ooxml_pkg::read_entries(&bytes).unwrap_or_default();
        let round_trip = docx.save(&docx.xml).and_then(|saved| {
            let archive = Archive::parse(&saved)?;
            let entries = ooxml_pkg::read_entries(&saved).map_err(|e| e.to_string())?;
            let raw = (0..docx.archive.records.len())
                .filter(|&i| i != docx.main)
                .all(|i| archive.local_record(i) == docx.archive.local_record(i));
            let inflated = entries.len() == original_entries.len()
                && entries
                    .iter()
                    .zip(&original_entries)
                    .all(|(s, o)| s.raw_name == o.raw_name && s.content == o.content);
            Ok(raw && inflated)
        });
        match round_trip {
            Ok(true) => container_ok += 1,
            Ok(false) => container_failures.push(path.clone()),
            Err(e) => container_failures.push(format!("{path}: {e}")),
        }
        let mut eligible = Vec::new();
        for (index, element) in scan.elements.iter().enumerate() {
            if element.name != "w:p" {
                continue;
            }
            top_paragraphs += 1;
            let runs = paragraph_runs(&docx.xml, element.start..element.end);
            multi_t_runs += runs.iter().filter(|r| r.texts.len() > 1).count();
            let text_runs: Vec<(usize, Range<usize>)> = runs
                .iter()
                .enumerate()
                .filter(|(_, r)| r.texts.len() == 1 && !r.texts[0].is_empty())
                .map(|(i, r)| (i, r.texts[0].clone()))
                .collect();
            if text_runs.len() >= 2 {
                eligible.push((index, element.start..element.end, text_runs));
            }
        }
        if eligible.is_empty() {
            without_paragraph += 1;
            continue;
        }
        let picked: Vec<usize> = if eligible.len() <= PARAGRAPHS_PER_DOCUMENT {
            (0..eligible.len()).collect()
        } else {
            (0..PARAGRAPHS_PER_DOCUMENT)
                .map(|i| i * eligible.len() / PARAGRAPHS_PER_DOCUMENT)
                .collect()
        };
        paragraphs += picked.len();
        for &p in &picked {
            let paragraph = &docx.xml[eligible[p].1.clone()];
            for (count, (_, needles)) in census.iter_mut().zip(FEATURES) {
                *count += usize::from(needles.iter().any(|n| paragraph.contains(n)));
            }
        }
        for &p in &picked {
            let (paragraph, para, text_runs) = &eligible[p];
            let mut which = vec![0, text_runs.len() / 2, text_runs.len() - 1];
            which.dedup();
            for k in which {
                let (run, content) = text_runs[k].clone();
                let target = Target {
                    path: path.clone(),
                    paragraph: *paragraph,
                    para: para.clone(),
                    run,
                    content: content.clone(),
                };
                let edit = RunEdit {
                    paragraph: *paragraph,
                    run,
                    text: NEW_TEXT,
                };
                let Ok(expected_text) = body_text(&docx.xml, Some((content, NEW_TEXT))) else {
                    continue;
                };
                let mut configs: Vec<(String, Result<String, String>)> =
                    vec![("B".into(), way_b::edit_xml(&docx.xml, &edit))];
                for step in 0..=way_a::LAST_STEP {
                    configs.push((format!("A{step}"), way_a::edit_xml(&docx.xml, &edit, step)));
                }
                for (name, xml) in configs {
                    let tally = tallies.entry(name.clone()).or_default();
                    tally.edits += 1;
                    let xml = match xml {
                        Ok(xml) => xml,
                        Err(e) => {
                            note(&mut tally.errors, e, || target.path.clone());
                            continue;
                        }
                    };
                    let saved_xml = if full.contains(&name) {
                        let saved = match docx.save(&xml) {
                            Ok(saved) => saved,
                            Err(e) => {
                                note(&mut tally.errors, format!("save: {e}"), || {
                                    target.path.clone()
                                });
                                continue;
                            }
                        };
                        match check_zip(tally, &docx.archive, &original_entries, &saved, docx.main)
                        {
                            Ok(read_back) => read_back,
                            Err(e) => {
                                note(&mut tally.errors, format!("reread: {e}"), || {
                                    target.path.clone()
                                });
                                continue;
                            }
                        }
                    } else {
                        xml
                    };
                    check_xml(tally, &docx.xml, &saved_xml, &target, &expected_text);
                }
            }
        }
    }

    let mut report = String::new();
    let edits = tallies.get("B").map_or(0, |t| t.edits);
    let _ = writeln!(
        report,
        "documents tracked: {}, opened: {opened}, not opened: {}",
        paths.len(),
        paths.len() - opened
    );
    for (reason, docs) in &not_opened {
        let _ = writeln!(
            report,
            "  not opened ({reason}): {} e.g. {}",
            docs.len(),
            docs[0]
        );
    }
    let _ = writeln!(
        report,
        "archives with data descriptors: {with_descriptor}, with bytes before the first record: {with_prefix}"
    );
    let _ = writeln!(
        report,
        "main part saved unchanged through the container, every other record raw and every entry inflating the same: {container_ok} of {opened} {container_failures:?}"
    );
    let _ = writeln!(
        report,
        "documents with w:rsid attributes (Word-saved): {with_rsid}, top-level paragraphs: {top_paragraphs}"
    );
    let _ = writeln!(
        report,
        "documents without a top-level paragraph of two or more text runs: {without_paragraph}"
    );
    let _ = writeln!(
        report,
        "paragraphs edited: {paragraphs}, edits: {edits}, runs with more than one w:t (never targets): {multi_t_runs}"
    );
    let _ = writeln!(report, "edited paragraphs containing:");
    for (count, (name, _)) in census.iter().zip(FEATURES) {
        let _ = writeln!(report, "  {name}: {count}");
    }
    let _ = writeln!(report, "new text: {NEW_TEXT:?}\n");
    let _ = writeln!(
        report,
        "| way | edits | errors | other entries raw-identical (entries) | edits with all other entries raw | sibling paragraphs identical | sibling runs identical | text read back as expected |"
    );
    let _ = writeln!(report, "|---|---|---|---|---|---|---|---|");
    let mut order: Vec<String> = vec!["B".into()];
    order.extend((0..=way_a::LAST_STEP).map(|s| format!("A{s}")));
    for name in &order {
        let Some(t) = tallies.get(name) else { continue };
        let errors: usize = t.errors.values().map(|e| e.0).sum();
        let zip = if full.contains(name) {
            (
                format!(
                    "{} ({}/{}, inflated {})",
                    pct(t.entries_raw, t.entries_compared),
                    t.entries_raw,
                    t.entries_compared,
                    pct(t.entries_inflated, t.entries_compared)
                ),
                pct(t.edits_entries_raw, t.edits - errors),
            )
        } else {
            ("not saved".into(), "not saved".into())
        };
        let label = match name.strip_prefix('A').and_then(|s| s.parse::<usize>().ok()) {
            Some(step) => format!("{name}: {}", way_a::STEP_NAMES[step]),
            None => "B: spans and provenance".into(),
        };
        let _ = writeln!(
            report,
            "| {label} | {} | {errors} | {} | {} | {} | {} | {} |",
            t.edits,
            zip.0,
            zip.1,
            pct(t.sibling_paragraphs, t.edits),
            pct(t.sibling_runs, t.edits),
            pct(t.text_invariant, t.edits)
        );
    }
    for name in &order {
        let Some(t) = tallies.get(name) else { continue };
        if t.classes.is_empty() && t.errors.is_empty() {
            continue;
        }
        let _ = writeln!(
            report,
            "\n## {name}: first difference outside the edited w:t content, by class"
        );
        let mut classes: Vec<_> = t.classes.iter().collect();
        classes.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.0.cmp(b.0)));
        for (class, (count, example)) in classes {
            let _ = writeln!(report, "- {count} {class}\n    e.g. {example}");
        }
        for (error, (count, example)) in &t.errors {
            let _ = writeln!(report, "- {count} ERROR {error}\n    e.g. {example}");
        }
    }
    print!("{report}");
    if let Err(e) = std::fs::write(&out_path, &report) {
        eprintln!("cannot write {out_path}: {e}");
    }
}
