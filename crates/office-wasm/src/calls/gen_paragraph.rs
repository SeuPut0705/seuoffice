//! `genParagraph.<name>`: `generateParagraphXml` of generate.ts. The context
//! callbacks of the TypeScript are counters built per call on both sides, and
//! what they were asked crosses back with the XML.

use docx_engine::generate::paragraph::{GenerateContext, generate_paragraph_xml};
use docx_engine::model::{GeneratedBlock, MapEntries};
use jscompat::JsNum;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Returned, required, value};

/// The context the spec describes: the style tables as they are, and per
/// callback whether it exists. Hyperlink rels are always allocated.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CtxArg {
    heading_style_ids: MapEntries<JsNum, String>,
    #[serde(default)]
    list_paragraph_style_id: Option<String>,
    bookmark_ids: bool,
    revision_ids: bool,
}

/// What the TypeScript wrapper returns: the XML and every callback call, in order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Generated {
    xml: String,
    hyperlinks: Vec<String>,
    bookmarks: Vec<String>,
    revisions: u32,
}

fn generate(block: &GeneratedBlock, ctx: &CtxArg) -> Result<Generated, String> {
    let mut hyperlinks: Vec<String> = Vec::new();
    let mut bookmarks: Vec<String> = Vec::new();
    let mut revisions = 0u32;
    let mut allocate_hyperlink_rel = |href: &str| {
        hyperlinks.push(href.to_owned());
        format!("rIdH{}", hyperlinks.len())
    };
    let mut allocate_bookmark_id = |name: &str| {
        bookmarks.push(name.to_owned());
        (100 + bookmarks.len()) as f64
    };
    let mut allocate_revision_id = || {
        revisions += 1;
        format!("{}", 500 + revisions)
    };
    let xml = {
        let mut context = GenerateContext {
            heading_style_ids: &ctx.heading_style_ids,
            list_paragraph_style_id: ctx.list_paragraph_style_id.as_deref(),
            allocate_hyperlink_rel: &mut allocate_hyperlink_rel,
            allocate_bookmark_id: if ctx.bookmark_ids {
                Some(&mut allocate_bookmark_id)
            } else {
                None
            },
            allocate_revision_id: if ctx.revision_ids {
                Some(&mut allocate_revision_id)
            } else {
                None
            },
            part: None,
        };
        generate_paragraph_xml(block, &mut context)?
    };
    Ok(Generated {
        xml,
        hyperlinks,
        bookmarks,
        revisions,
    })
}

pub fn dispatch(function: &str, _text: &str, args: &Value) -> Returned {
    match function {
        "generateParagraphXml" => {
            let block: GeneratedBlock = required(args, "block")?;
            let ctx: CtxArg = required(args, "ctx")?;
            value(generate(&block, &ctx)?)
        }
        _ => Err(format!("unknown function {function}")),
    }
}
