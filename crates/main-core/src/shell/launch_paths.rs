//! `apps/shell/src/main/launch-paths.ts`.

use jscompat::{JsonValue, js_regex};

/// Every extension the suite opens.
pub const LAUNCHABLE_EXTS: &[&str] = &[
    "docx", "doc", "dot", "odt", "xlsx", "xlsm", "xls", "csv", "tsv", "ods", "pptx", "ppt", "odp",
    "otp", "pdf", "md", "markdown", "txt", "json", "html", "htm", "xmind", "hwp", "hwpx", "epub",
    "drawio", "dio", "vsdx",
];

/// draw.io pictures the suite opens as diagrams, known by their double extension.
pub const LAUNCHABLE_DOUBLE_EXTS: &[&str] = &["drawio.svg", "drawio.png"];

/// Files the suite imports but never claims.
pub const LAUNCHABLE_UNCLAIMED_EXTS: &[&str] = &["mm"];

/// `SUPPORTED_LAUNCH_RE`: the three lists in this order, `.` escaped; written
/// out because a pattern must be a literal (the harness covers each entry).
fn supported(path: &str) -> bool {
    js_regex!(
        r"\.(docx|doc|dot|odt|xlsx|xlsm|xls|csv|tsv|ods|pptx|ppt|odp|otp|pdf|md|markdown|txt|json|html|htm|xmind|hwp|hwpx|epub|drawio|dio|vsdx|mm|drawio\.svg|drawio\.png)$",
        "i"
    )
    .test(path)
}

/// `UNSUPPORTED_LAUNCH_RE`
fn unsupported(path: &str) -> bool {
    js_regex!(r"\.(rtf|pps|xlsb|pages|key|numbers)$", "i").test(path)
}

/// `payloadLaunchPaths`
fn payload_launch_paths(additional_data: Option<&JsonValue>) -> Vec<String> {
    let Some(data @ (JsonValue::Object(_) | JsonValue::Array(_))) = additional_data else {
        return Vec::new();
    };
    let mut paths: Vec<String> = match data.get("launchPaths").as_deref() {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    if let Some(JsonValue::String(s)) = data.get("launchPath").as_deref()
        && !s.is_empty()
    {
        paths.push(s.clone());
    }
    paths
}

/// `collectLaunchPaths`
pub fn collect_launch_paths(
    argv: &[&str],
    additional_data: Option<&JsonValue>,
    exists: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let supported_paths: Vec<&str> = argv
        .iter()
        .copied()
        .filter(|path| supported(path) && exists(path))
        .collect();
    let payload = payload_launch_paths(additional_data);
    let fallback = if supported_paths.is_empty() && payload.is_empty() {
        argv.iter()
            .copied()
            .find(|path| unsupported(path) && exists(path))
    } else {
        None
    };
    // [...new Set([...supported, ...payload, ...fallback])]
    let mut out: Vec<String> = Vec::new();
    let all = supported_paths
        .into_iter()
        .map(str::to_owned)
        .chain(payload)
        .chain(fallback.filter(|f| !f.is_empty()).map(str::to_owned));
    for path in all {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}
