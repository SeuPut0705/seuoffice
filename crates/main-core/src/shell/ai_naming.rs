//! `apps/shell/src/main/ai-naming.ts`: naming a document from its own
//! contents. A model asked for a file name will happily return
//! "Q3 / Revenue.md", a sentence with a full stop, or fifty words of prose;
//! what reaches the filesystem has to survive every platform's rules at once.

use jscompat::{js_regex, replace_first_with, slice_utf16, trim};

/// Long enough to be searchable, short enough to survive a file dialog.
const MAX_NAME_LENGTH: usize = 60;

/// Windows device names, lowercased, with or without an extension.
const RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// `sanitizeFileStem(raw)`: reduce a model reply to a bare file stem: no
/// directory, no extension, no character any supported platform rejects, no
/// leading dot, no reserved name. Returns `""` when nothing usable is left.
pub fn sanitize_file_stem(raw: &str) -> String {
    // models like to answer with a path, a bullet, or a quoted title
    let step = js_regex!(r"[\r\n]+", "g").replace_all(raw, |_| " ".to_owned());
    let step = replace_first_with(
        js_regex!(r#"^[\s"'`#*\-\u2013\u2014\u2022>]+"#),
        &step,
        |_| String::new(),
    );
    let step = replace_first_with(js_regex!(r#"["'`]+$"#), &step, |_| String::new());
    // keep the last path segment: the stem is what lands next to the real dir
    let mut name = js_regex!(r"[/\\]")
        .split(&step)
        .pop()
        .unwrap_or_default()
        .to_owned();
    // drop an extension the model volunteered - the caller appends the real
    // one. A name that is *only* an extension (".env") is left alone.
    if js_regex!(r"^[^.]{2,}\.[A-Za-z0-9]{1,8}$").test(&name)
        || js_regex!(r"^.{3,}\.[A-Za-z0-9]{1,8}$").test(&name)
    {
        name = replace_first_with(js_regex!(r"\.[A-Za-z0-9]{1,8}$"), &name, |_| String::new());
    }
    // illegal on Windows, and "/" splits a path on unix
    name = js_regex!(r#"[<>:"|?*]"#, "g").replace_all(&name, |_| " ".to_owned());
    // control characters are not printable and several filesystems reject them
    name = js_regex!(r"[\u0000-\u001f\u007f]", "g").replace_all(&name, |_| " ".to_owned());
    name = js_regex!(r"\s+", "g").replace_all(&name, |_| " ".to_owned());
    name = trim(&name).to_owned();
    // a leading dot hides the file and, on Windows, is just illegal
    name = replace_first_with(js_regex!(r"^\.+"), &name, |_| String::new());
    name = trim(&name).to_owned();
    let units: Vec<u16> = name.encode_utf16().collect();
    if units.len() > MAX_NAME_LENGTH {
        // cut on a space so the name never ends mid-word; a single token longer
        // than the budget is hard-cut rather than dropped
        let head = &units[..MAX_NAME_LENGTH + 1];
        let last_space = head.iter().rposition(|u| *u == u16::from(b' '));
        name = match last_space {
            Some(at) if at > MAX_NAME_LENGTH / 2 => {
                trim(&String::from_utf16_lossy(&head[..at])).to_owned()
            }
            _ => trim(&String::from_utf16_lossy(&head[..MAX_NAME_LENGTH])).to_owned(),
        };
    }
    // Windows also forbids a name that ends in a dot or a space
    name = replace_first_with(js_regex!(r"[.\s]+$"), &name, |_| String::new());
    // a Windows device name is illegal even with an extension appended
    if RESERVED_STEMS.contains(&name.to_lowercase().as_str()) {
        name = format!("{name}-file");
    }
    name
}

/// `buildNamingInstruction(content, lang)`: the instruction sent to the
/// model.
pub fn build_naming_instruction(content: &str, lang: &str) -> String {
    [
        "Give this document a file name. Reply with the name only: no quotes, no extension, no path, no explanation.",
        &format!("Write it in {lang}. Use 2-6 words."),
        "Base it on what the document is actually about, not on a generic description of its format.",
        "",
        "Document:",
        content,
    ]
    .join("\n")
}

/// `excerptForNaming(content, limit)`: cap the text handed to the model.
pub fn excerpt_for_naming(content: &str, limit: Option<f64>) -> String {
    let limit = limit.unwrap_or(4000.0);
    let collapsed = collapse_newlines(content);
    let collapsed = trim(&collapsed);
    if (collapsed.encode_utf16().count() as f64) <= limit {
        return collapsed.to_owned();
    }
    format!("{}\n\u{2026}", slice_utf16(collapsed, 0.0, Some(limit)))
}

fn collapse_newlines(content: &str) -> String {
    js_regex!(r"\n{3,}", "g").replace_all(content, |_| "\n\n".to_owned())
}
