//! `apps/html/src/main/marked-html.ts`: content a person marked "hidden from
//! AI" in an HTML page (the redactor's three marks: `data-gx-redact` on an
//! element, `data-gx-redact-<attr>` beside an attribute, `/*gx:redact:label*/`
//! before a script literal). Neither an ODT nor the Word export can keep the
//! hiding, so both refuse marked pages and offer to write the copy with the
//! marks cleared (the page itself keeps them).

use jscompat::js_regex;
use serde::Serialize;

/// `ANY_MARK.test(html)`: the same test the redactor and the skill-template
/// check start with.
pub fn holds_hidden_marks(html: &str) -> bool {
    js_regex!(r"data-gx-redact|gx:redact:", "i").test(html)
}

/// What `clearHiddenMarks` throws when a trace of a mark is left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarksLeft;

impl MarksLeft {
    pub const MESSAGE: &'static str = "could not clear the marks of this page";
}

/// `clearHiddenMarks(html)`: the page with every mark taken off; refused when
/// a trace is left, so a copy never claims to be clear when it is not.
pub fn clear_hidden_marks(html: &str) -> Result<String, MarksLeft> {
    let attribute_mark = js_regex!(
        r#"\sdata-gx-redact(?:-[\w:.-]+)?(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?"#,
        "gi"
    );
    let script_mark = js_regex!(r"\/\*\s*gx:redact:[^]*?\*\/", "gi");
    let cleared = attribute_mark.replace_all(html, |_| String::new());
    let cleared = script_mark.replace_all(&cleared, |_| String::new());
    if holds_hidden_marks(&cleared) {
        return Err(MarksLeft);
    }
    Ok(cleared)
}

/// `MarkedExportChoice`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkedExportChoice {
    Clear,
    Cancel,
}

/// `MarkedExportPlan`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MarkedExportPlan {
    Write { html: String },
    Declined,
}

/// `planMarkedExport(html, ask)`: what an export that cannot keep the hiding
/// may write for this page. `ask` `None`: nobody can be asked (a headless
/// export), so a marked page is declined. An error of `ask` is the rejection
/// of its promise.
pub fn plan_marked_export<E: From<MarksLeft>>(
    html: &str,
    ask: Option<impl FnOnce() -> Result<MarkedExportChoice, E>>,
) -> Result<MarkedExportPlan, E> {
    if !holds_hidden_marks(html) {
        return Ok(MarkedExportPlan::Write {
            html: html.to_owned(),
        });
    }
    let Some(ask) = ask else {
        return Ok(MarkedExportPlan::Declined);
    };
    Ok(match ask()? {
        MarkedExportChoice::Clear => MarkedExportPlan::Write {
            html: clear_hidden_marks(html)?,
        },
        MarkedExportChoice::Cancel => MarkedExportPlan::Declined,
    })
}
