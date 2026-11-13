//! `packages/google-drive/src/oauth.ts`: the page the browser shows once the
//! Google sign-in is back on this PC. Only the pure part is here: the HTML.

/// `SignInPage`: the page the browser shows once it is back on this PC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInPage {
    pub lang: String,
    pub title: String,
    pub body: String,
}

/// `escapeHtml(text)`: each of `& < > " '` as its decimal character
/// reference.
fn escape_html(text: &str) -> String {
    jscompat::js_regex!(r#"[&<>"']"#, "g").replace_all(text, |m| {
        format!("&#{};", m.as_str().encode_utf16().next().unwrap_or(0))
    })
}

/// `signInPageHtml(page)`: a self-contained page: no script, no outside
/// resource.
pub fn sign_in_page_html(page: &SignInPage) -> String {
    format!(
        "<!doctype html>\n\
<html lang=\"{lang}\"><head><meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{title}</title>\n\
<style>body{{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}}\n\
main{{max-width:28rem;padding:2rem;text-align:center}}h1{{font-size:1.4rem}}p{{line-height:1.6}}</style>\n\
</head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>",
        lang = escape_html(&page.lang),
        title = escape_html(&page.title),
        body = escape_html(&page.body),
    )
}
