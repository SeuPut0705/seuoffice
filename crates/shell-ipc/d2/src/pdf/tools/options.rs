//! The pure parts of `pdf-tools/tools.ts` and the page ranges of
//! `apps/pdf/src/renderer/convert/page-range.ts`: which tools exist, what
//! each takes, its options checked against the file, the names of what it
//! writes, and the shapes of the job answers it reads.

use jscompat::js_regex;
use shell_contract::{BytesKind, IpcValue};

use super::int_text;
use crate::kit::{IntoIpc, as_num, as_str, field, obj};

/// `PDF_TOOL_IDS`
pub const TOOL_IDS: [&str; 18] = [
    "merge",
    "split",
    "extract",
    "reverse",
    "nup",
    "rotate",
    "pageSize",
    "splitPages",
    "imagesToPdf",
    "toText",
    "duplex",
    "overlay",
    "stripAnnots",
    "blankPages",
    "compress",
    "encrypt",
    "decrypt",
    "repair",
];

const PAPERS: [&str; 5] = ["A3", "A4", "A5", "Letter", "Legal"];
const SHEET_PAGES: [f64; 7] = [1.0, 2.0, 4.0, 6.0, 8.0, 9.0, 16.0];
const ANNOT_KINDS: [&str; 6] = [
    "comments",
    "highlights",
    "drawings",
    "stamps",
    "links",
    "other",
];
const MARGINS: [&str; 3] = ["none", "small", "large"];
const COMPRESS_LEVELS: [&str; 3] = ["light", "medium", "strong"];

/// `MAX_TOOL_INPUT_BYTES`
pub const MAX_TOOL_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
/// `MAX_PASSWORD_BYTES`
const MAX_PASSWORD_BYTES: usize = 127;

/// `isPdfToolId(value)`
pub fn tool_id(v: &IpcValue) -> Option<&'static str> {
    let s = as_str(v)?;
    TOOL_IDS.iter().copied().find(|t| *t == s)
}

/// `toolTakesMany(tool)`
pub fn takes_many(tool: &str) -> bool {
    matches!(tool, "merge" | "imagesToPdf" | "duplex")
}

/// `toolMinInputs(tool)`
pub fn min_inputs(tool: &str) -> usize {
    if tool == "merge" { 2 } else { 1 }
}

/// `toolAccepts(tool)`
pub fn accepts(tool: &str) -> &'static str {
    match tool {
        "decrypt" => "encrypted",
        "repair" => "damaged",
        _ => "pdf",
    }
}

/// `toolRunsAsJob(tool)`
pub fn runs_as_job(tool: &str) -> bool {
    matches!(tool, "encrypt" | "decrypt" | "repair")
}

/// `toolInputKind(tool)`
pub fn input_kind(tool: &str) -> &'static str {
    if tool == "imagesToPdf" {
        "image"
    } else {
        "pdf"
    }
}

/// `toolOutputExtension(tool)`
pub fn output_extension(tool: &str) -> &'static str {
    if tool == "toText" { "txt" } else { "pdf" }
}

/// `parsePageRange(text, pageCount)`: the pages, ascending, or why not
pub fn parse_page_range(text: &str, page_count: f64) -> Result<Vec<f64>, &'static str> {
    let parts: Vec<&str> = js_regex!(r"[,;，、；]")
        .split(text)
        .into_iter()
        .map(jscompat::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("empty");
    }
    let mut pages: Vec<f64> = Vec::new();
    let mut outside = false;
    for part in parts {
        let Some(m) = js_regex!(r"^(\d{1,6})\s*(?:[-‐–—~～]\s*(\d{1,6}))?$").exec(part)
        else {
            return Err("syntax");
        };
        let a: f64 = m.get(1).unwrap_or("0").parse().unwrap_or(0.0);
        let b: f64 = m.get(2).map_or(a, |b| b.parse().unwrap_or(0.0));
        let (lo, hi) = (a.min(b), a.max(b));
        if lo < 1.0 || hi > page_count {
            outside = true;
            continue;
        }
        let mut page = lo;
        while page <= hi {
            if !pages.contains(&page) {
                pages.push(page);
            }
            page += 1.0;
        }
    }
    if outside {
        return Err("outOfRange");
    }
    pages.sort_by(f64::total_cmp);
    Ok(pages)
}

fn join(pages: &[f64]) -> String {
    pages
        .iter()
        .map(|p| int_text(*p))
        .collect::<Vec<_>>()
        .join(",")
}

/// `intIn(value, lo, hi)`
fn int_in(v: &IpcValue, lo: f64, hi: f64) -> Option<f64> {
    as_num(v).filter(|n| n.fract() == 0.0 && *n >= lo && *n <= hi)
}

fn one_of(v: &IpcValue, list: &[&'static str]) -> Option<&'static str> {
    let s = as_str(v)?;
    list.iter().copied().find(|x| *x == s)
}

/// `checkOptions(tool, raw, pageCount, backgroundPages)`: only the options
/// the tool reads, or the error the window shows
pub fn check_options(
    tool: &str,
    raw: &IpcValue,
    page_count: f64,
    background_pages: f64,
) -> Result<IpcValue, &'static str> {
    let o = |k: &str| field(raw, k);
    let str_of = |k: &str| as_str(o(k)).unwrap_or("").to_owned();
    Ok(match tool {
        "split" => obj([(
            "chunkSize",
            int_in(o("chunkSize"), 1.0, page_count)
                .unwrap_or(1.0)
                .into_ipc(),
        )]),
        "extract" => {
            let pages = parse_page_range(&str_of("pages"), page_count).map_err(|_| "range")?;
            obj([("pages", join(&pages).into_ipc())])
        }
        "nup" => obj([
            (
                "perSheet",
                int_in(o("perSheet"), 2.0, 16.0).unwrap_or(2.0).into_ipc(),
            ),
            (
                "direction",
                if as_str(o("direction")) == Some("vertical") {
                    "vertical"
                } else {
                    "horizontal"
                }
                .into_ipc(),
            ),
            (
                "separator",
                (o("separator") == &IpcValue::Bool(true)).into_ipc(),
            ),
        ]),
        "rotate" => {
            let r = as_num(o("rotation")).filter(|r| *r == 180.0 || *r == 270.0);
            obj([("rotation", r.unwrap_or(90.0).into_ipc())])
        }
        "pageSize" => obj([(
            "paper",
            one_of(o("paper"), &PAPERS).unwrap_or("A4").into_ipc(),
        )]),
        "splitPages" => {
            let p = as_num(o("perPage")).filter(|p| *p == 4.0 || *p == 9.0);
            obj([("perPage", p.unwrap_or(2.0).into_ipc())])
        }
        "encrypt" => {
            // passwords are taken as typed: no trimming
            let password = str_of("password");
            let restrict = o("restrict") == &IpcValue::Bool(true);
            let permission = str_of("permissionPassword");
            if password.is_empty() || (restrict && permission.is_empty()) {
                return Err("password-empty");
            }
            if password.len() > MAX_PASSWORD_BYTES || permission.len() > MAX_PASSWORD_BYTES {
                return Err("password-long");
            }
            if restrict && permission == password {
                return Err("password-same");
            }
            if restrict {
                obj([
                    ("password", password.into_ipc()),
                    ("restrict", true.into_ipc()),
                    ("permissionPassword", permission.into_ipc()),
                ])
            } else {
                obj([("password", password.into_ipc())])
            }
        }
        "decrypt" => {
            let password = str_of("password");
            if password.is_empty() {
                return Err("password-empty");
            }
            obj([("password", password.into_ipc())])
        }
        "compress" => obj([(
            "compressLevel",
            one_of(o("compressLevel"), &COMPRESS_LEVELS)
                .unwrap_or("medium")
                .into_ipc(),
        )]),
        "blankPages" => {
            let raw = str_of("removePages");
            let mut pages: Vec<f64> = Vec::new();
            for p in raw.split(',') {
                let n = js_number(jscompat::trim(p));
                if !pages.contains(&n) {
                    pages.push(n);
                }
            }
            pages.retain(|p| p.fract() == 0.0 && *p >= 1.0 && *p <= page_count);
            pages.sort_by(f64::total_cmp);
            if pages.is_empty() {
                return Err("none-chosen");
            }
            if pages.len() as f64 >= page_count {
                return Err("all-pages");
            }
            obj([("removePages", join(&pages).into_ipc())])
        }
        "stripAnnots" => {
            let range = applied_pages(o("applyPages"), page_count)?;
            let kinds: Vec<&str> = match o("annotKinds") {
                IpcValue::Array(chosen) => ANNOT_KINDS
                    .iter()
                    .copied()
                    .filter(|k| chosen.iter().any(|c| as_str(c) == Some(k)))
                    .collect(),
                _ => ANNOT_KINDS
                    .iter()
                    .copied()
                    .filter(|k| *k != "links")
                    .collect(),
            };
            if kinds.is_empty() {
                return Err("no-kinds");
            }
            obj([
                ("annotKinds", kinds.into_ipc()),
                ("applyPages", range.into_ipc()),
            ])
        }
        "overlay" => {
            let range = applied_pages(o("applyPages"), page_count)?;
            obj([
                (
                    "layer",
                    if as_str(o("layer")) == Some("front") {
                        "front"
                    } else {
                        "behind"
                    }
                    .into_ipc(),
                ),
                (
                    "backgroundPage",
                    int_in(o("backgroundPage"), 1.0, background_pages)
                        .unwrap_or(1.0)
                        .into_ipc(),
                ),
                ("applyPages", range.into_ipc()),
            ])
        }
        "duplex" => {
            let s = as_num(o("sheetPages")).filter(|s| SHEET_PAGES.contains(s));
            obj([("sheetPages", s.unwrap_or(1.0).into_ipc())])
        }
        "imagesToPdf" => {
            let paper = if as_str(o("imagePaper")) == Some("image") {
                "image"
            } else {
                one_of(o("imagePaper"), &PAPERS).unwrap_or("A4")
            };
            obj([
                ("imagePaper", paper.into_ipc()),
                (
                    "margin",
                    one_of(o("margin"), &MARGINS).unwrap_or("small").into_ipc(),
                ),
            ])
        }
        _ => IpcValue::Object(Vec::new()),
    })
}

/// `applyPages` of overlay and stripAnnots: `''` for every page
fn applied_pages(v: &IpcValue, page_count: f64) -> Result<String, &'static str> {
    let text = as_str(v).map(jscompat::trim).unwrap_or("");
    if text.is_empty() {
        return Ok(String::new());
    }
    parse_page_range(text, page_count)
        .map(|pages| join(&pages))
        .map_err(|_| "range")
}

/// `Number(text)` of a trimmed string
fn js_number(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `outputNames(tool, sourceName, count, options)`
pub fn output_names(
    tool: &str,
    source_name: &str,
    count: usize,
    options: &IpcValue,
) -> Vec<String> {
    let stripped =
        js_regex!(r"\.(pdf|jpe?g|png)$", "i").replace_all(source_name, |_| String::new());
    let base = if stripped.is_empty() {
        "document".to_owned()
    } else {
        stripped
    };
    match tool {
        "split" => (1..=count).map(|i| format!("{base}-{i}.pdf")).collect(),
        "imagesToPdf" => vec![format!("{base}.pdf")],
        "toText" => vec![format!("{base}.txt")],
        _ => {
            let suffix = match tool {
                "merge" => "merged".to_owned(),
                "duplex" => "duplex".to_owned(),
                "overlay" => "background".to_owned(),
                "stripAnnots" => "clean".to_owned(),
                "blankPages" => "no-blank".to_owned(),
                "compress" => "smaller".to_owned(),
                "encrypt" => "locked".to_owned(),
                "decrypt" => "unlocked".to_owned(),
                "repair" => "repaired".to_owned(),
                "extract" => "pages".to_owned(),
                "reverse" => "reversed".to_owned(),
                "nup" => format!(
                    "{}up",
                    int_text(as_num(field(options, "perSheet")).unwrap_or(2.0))
                ),
                "rotate" => "rotated".to_owned(),
                "pageSize" => as_str(field(options, "paper")).unwrap_or("A4").to_owned(),
                _ => "split".to_owned(),
            };
            vec![format!("{base}-{suffix}.pdf")]
        }
    }
}

/// One blank-page candidate as the job found it
pub struct Candidate {
    pub page: f64,
    pub reason: &'static str,
    /// width, height, BGRA pixels
    pub thumb: Option<(f64, f64, Vec<u8>)>,
}

/// `foundBlankPagesOf(value)`: page count and candidates, or `None` when the
/// answer is not that shape
pub fn found_blank_pages(value: &IpcValue) -> Option<(f64, Vec<Candidate>)> {
    if !crate::kit::is_object(value) {
        return None;
    }
    let page_count = as_num(field(value, "pageCount"))?;
    let IpcValue::Array(raw) = field(value, "candidates") else {
        return None;
    };
    let mut out = Vec::new();
    for c in raw {
        if !crate::kit::is_object(c) {
            return None;
        }
        let page = as_num(field(c, "page")).filter(|p| p.fract() == 0.0)?;
        if page < 1.0 || page > page_count {
            return None;
        }
        let reason = match as_str(field(c, "reason")) {
            Some("empty") => "empty",
            Some("nearly-white") => "nearly-white",
            _ => return None,
        };
        let t = field(c, "thumb");
        let thumb = if crate::kit::truthy(t) {
            let (w, h) = (as_num(field(t, "width"))?, as_num(field(t, "height"))?);
            match field(t, "bgra") {
                IpcValue::Bytes(BytesKind::Uint8Array, bgra)
                    if bgra.len() as f64 == w * h * 4.0 =>
                {
                    Some((w, h, bgra.clone()))
                }
                _ => return None,
            }
        } else {
            None
        };
        out.push(Candidate {
            page,
            reason,
            thumb,
        });
    }
    Some((page_count, out))
}

/// `jobFor(tool, path, options)`
pub fn job_for(tool: &str, path: &str, options: &IpcValue) -> IpcValue {
    let source = obj([("pdfPath", path.into_ipc())]);
    let password = as_str(field(options, "password")).unwrap_or("").to_owned();
    match tool {
        "repair" => obj([("op", "repair".into_ipc()), ("source", source)]),
        "decrypt" => obj([
            ("op", "decrypt".into_ipc()),
            ("source", source),
            ("password", password.into_ipc()),
        ]),
        _ => {
            let mut job = vec![
                ("op".to_owned(), "encrypt".into_ipc()),
                ("source".to_owned(), source),
                ("userPassword".to_owned(), password.into_ipc()),
            ];
            let permission = as_str(field(options, "permissionPassword")).unwrap_or("");
            if crate::kit::truthy(field(options, "restrict")) && !permission.is_empty() {
                job.push(("ownerPassword".to_owned(), permission.into_ipc()));
            }
            IpcValue::Object(job)
        }
    }
}

/// `jobBytesOf(value)`
pub fn job_bytes(value: &IpcValue) -> Option<Vec<u8>> {
    match field(value, "bytes") {
        IpcValue::Bytes(BytesKind::Uint8Array, b) if !b.is_empty() => Some(b.clone()),
        _ => None,
    }
}

/// the record check of a request: `raw && typeof raw === 'object' ? raw : {}`
pub fn record_or_empty(v: &IpcValue) -> IpcValue {
    if crate::kit::truthy(v) && crate::kit::is_object(v) {
        v.clone()
    } else {
        IpcValue::Object(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::{j, v};
    use super::*;

    #[test]
    fn page_ranges_read_as_the_dialog_reads_them() {
        assert_eq!(
            parse_page_range("5-3, 1；8", 10.0),
            Ok(vec![1.0, 3.0, 4.0, 5.0, 8.0])
        );
        assert_eq!(parse_page_range("2～4", 10.0), Ok(vec![2.0, 3.0, 4.0]));
        assert_eq!(parse_page_range(" , ", 10.0), Err("empty"));
        assert_eq!(parse_page_range("1-x", 10.0), Err("syntax"));
        assert_eq!(parse_page_range("1, 11", 10.0), Err("outOfRange"));
    }

    #[test]
    fn options_keep_only_what_the_tool_reads() {
        let raw = v(json!({ "perSheet": 4, "direction": "vertical", "chunkSize": 3 }));
        assert_eq!(
            j(&check_options("nup", &raw, 10.0, 1.0).unwrap()),
            json!({ "perSheet": 4, "direction": "vertical", "separator": false })
        );
        assert_eq!(
            j(&check_options("split", &raw, 2.0, 1.0).unwrap()),
            json!({ "chunkSize": 1 })
        );
        assert_eq!(
            check_options("extract", &v(json!({ "pages": "9" })), 3.0, 1.0),
            Err("range")
        );
        assert_eq!(
            j(&check_options(
                "blankPages",
                &v(json!({ "removePages": "3, 1,3,x" })),
                4.0,
                1.0
            )
            .unwrap()),
            json!({ "removePages": "1,3" })
        );
        assert_eq!(
            check_options("blankPages", &v(json!({ "removePages": "1,2" })), 2.0, 1.0),
            Err("all-pages")
        );
        let enc = |o| check_options("encrypt", &v(o), 1.0, 1.0);
        assert_eq!(
            enc(json!({ "password": "a", "restrict": true })),
            Err("password-empty")
        );
        assert_eq!(
            enc(json!({ "password": "a", "restrict": true, "permissionPassword": "a" })),
            Err("password-same")
        );
        assert_eq!(
            enc(json!({ "password": "가".repeat(43) })),
            Err("password-long")
        );
        assert_eq!(
            j(
                &check_options("stripAnnots", &v(json!({ "applyPages": " 2 " })), 3.0, 1.0)
                    .unwrap()
            ),
            json!({ "annotKinds": ["comments", "highlights", "drawings", "stamps", "other"], "applyPages": "2" })
        );
    }

    #[test]
    fn output_names_follow_the_source() {
        let o = v(json!({ "perSheet": 4 }));
        assert_eq!(output_names("nup", "a.PDF", 1, &o), vec!["a-4up.pdf"]);
        assert_eq!(
            output_names("split", ".pdf", 2, &o),
            vec!["document-1.pdf", "document-2.pdf"]
        );
        assert_eq!(output_names("toText", "scan.pdf", 1, &o), vec!["scan.txt"]);
    }
}
