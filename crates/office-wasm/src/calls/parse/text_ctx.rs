//! The readers of parse.ts that take a whole `BuildContext`. The context is
//! rebuilt on both sides from `args.parts` (styles, numbering, theme,
//! settings) and `args.compat`: the same members `calls-parse-text.ts`
//! builds, all of them present. It has no relationships, no media and no
//! section index.

use std::rc::Rc;

use docx_engine::model::{Block, Run};
use docx_engine::numbering::parse_numbering;
use docx_engine::parse::drawings::host::{MediaEnv, NoHost};
use docx_engine::parse::text::{self, BuildContext, ZoteroFieldParagraph};
use docx_engine::resolve::ResolveCtx;
use jscompat::{JsMap, JsNum};
use serde_json::Value;

use super::super::resolve::with_ctx;
use super::super::{Returned, arg, optional, package, required, value};
use super::text::{with_named, with_node};

/// None: not a function of this module.
pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Option<Returned> {
    let call: fn(&str, &Value) -> Returned = match function {
        "cellResolverOf" => cell_resolver_of,
        "outlineOnlyHeading" => outline_only_heading,
        "inheritedCsFont" => inherited_cs_font,
        "paraCsSize" => para_cs_size,
        "paraTextSizeHalfPoints" => para_text_size_half_points,
        "charUnitsOf" => char_units_of,
        "attachInlineContentControls" => attach_inline_content_controls,
        "extractParaFormat" => extract_para_format,
        "pPrOnlyFormat" => ppr_only_format,
        "resolvedParaFormat" => resolved_para_format,
        "anchorLineOf" => anchor_line_of,
        "strayAnchorLine" => stray_anchor_line,
        "anchoredRuleOverlays" => anchored_rule_overlays,
        "extractRuns" => extract_runs,
        "buildTextParagraph" => build_text_paragraph,
        "standaloneNoteParagraphReader" => standalone_note_reader,
        _ => return None,
    };
    Some(call(text_arg, args))
}

/// The `BuildContext` of `args`.
fn with_build_ctx(args: &Value, call: impl FnOnce(&BuildContext<'_>) -> Returned) -> Returned {
    let package = package(args)?;
    let formats = Some(parse_numbering(&package)?.formats);
    let xml_space_preserve: Option<bool> = arg(args, "xmlSpacePreserve")?;
    let namespaces: Option<Vec<(String, String)>> = arg(args, "partNamespaces")?;
    let part_namespaces = namespaces.map(|entries| {
        let mut map = JsMap::new();
        for (prefix, uri) in entries {
            map.set(prefix, uri);
        }
        map
    });
    let compatibility_mode: Option<JsNum> = arg(args, "compatibilityMode")?;
    with_ctx(args, |rctx: &ResolveCtx| {
        let media = MediaEnv::new(&NoHost);
        let mut ctx = BuildContext::bare(&package, Rc::new(rctx.clone()), &media);
        ctx.has_numbering = true;
        ctx.num_formats = formats;
        ctx.xml_space_preserve = xml_space_preserve == Some(true);
        ctx.part_namespaces = part_namespaces;
        ctx.compatibility_mode = compatibility_mode;
        call(&ctx)
    })
}

fn cell_resolver_of(_text: &str, args: &Value) -> Returned {
    let table_style_id: Option<String> = arg(args, "tableStyleId")?;
    with_build_ctx(args, |ctx| {
        // The TypeScript stores `cond` as given, whatever its elements are;
        // only the compat is read from the scoped resolver.
        let scoped = text::cell_resolver_of(ctx, table_style_id.as_deref(), &[]);
        let mut table = serde_json::Map::new();
        if let Some(id) = table_style_id.as_deref().filter(|id| !id.is_empty()) {
            table.insert("styleId".to_owned(), Value::String(id.to_owned()));
        }
        if let Some(cond) = args.get("cond") {
            table.insert("cond".to_owned(), cond.clone());
        }
        value(serde_json::json!({ "table": table, "compat": scoped.compat }))
    })
}

fn outline_only_heading(text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    with_build_ctx(args, |ctx| {
        with_node(text, args, |p_pr| {
            value(text::outline_only_heading(p_pr, style_id.as_deref(), ctx)?)
        })
    })
}

fn inherited_cs_font(_text: &str, args: &Value) -> Returned {
    let r_style_id: Option<String> = arg(args, "rStyleId")?;
    let p_style_id: Option<String> = arg(args, "pStyleId")?;
    with_build_ctx(args, |ctx| {
        optional(text::inherited_cs_font(
            r_style_id.as_deref(),
            p_style_id.as_deref(),
            ctx,
        ))
    })
}

fn para_cs_size(_text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    with_build_ctx(args, |ctx| {
        value(text::para_cs_size(ctx, style_id.as_deref()))
    })
}

fn para_text_size_half_points(text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    let runs: Vec<Run> = required(args, "runs")?;
    let p_node: String = required(args, "pNode")?;
    with_build_ctx(args, |ctx| {
        with_named(&p_node, Some("w:p"), |p_node| {
            with_node(text, args, |p_pr| {
                value(text::para_text_size_half_points(
                    ctx,
                    &runs,
                    p_node.ok_or("TypeError: no paragraph")?,
                    p_pr,
                    style_id.as_deref(),
                ))
            })
        })
    })
}

fn char_units_of(text: &str, args: &Value) -> Returned {
    let style_id: Option<String> = arg(args, "styleId")?;
    let runs: Vec<Run> = required(args, "runs")?;
    let p_node: String = required(args, "pNode")?;
    with_build_ctx(args, |ctx| {
        with_named(&p_node, Some("w:p"), |p_node| {
            with_node(text, args, |p_pr| {
                let units = text::char_units_of(
                    ctx,
                    &runs,
                    p_node.ok_or("TypeError: no paragraph")?,
                    p_pr,
                    style_id.as_deref(),
                    None,
                );
                value(serde_json::json!({ "run": JsNum(units.run), "normal": JsNum(units.normal) }))
            })
        })
    })
}

/// The block comes as `args.block`, the paragraph XML as the text. The block
/// stays the JSON object it is: the function only reads and sets one key.
fn attach_inline_content_controls(text: &str, args: &Value) -> Returned {
    let Some(Value::Object(block)) = args.get("block") else {
        return Err(
            "TypeError: Cannot read properties of non-object (reading 'inlineContentControls')"
                .to_owned(),
        );
    };
    let mut block = block.clone();
    let present = match block.get("inlineContentControls") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    };
    let is_para = text.strip_prefix("<w:p").is_some_and(|rest| {
        rest.chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || c == '\u{feff}' || c == '/' || c == '>')
    });
    if !present && is_para {
        let inline = text::inline_content_controls_of(text);
        if !inline.is_empty() {
            block.insert(
                "inlineContentControls".to_owned(),
                serde_json::to_value(inline).map_err(|error| error.to_string())?,
            );
        }
    }
    value(Value::Object(block))
}

fn theme_colors_of(
    ctx: &BuildContext<'_>,
    args: &Value,
) -> Result<Option<docx_engine::theme::ThemeColors>, String> {
    let wanted: Option<bool> = arg(args, "theme")?;
    Ok(if wanted == Some(true) {
        ctx.resolver.theme_colors.clone()
    } else {
        None
    })
}

fn extract_para_format(text: &str, args: &Value) -> Returned {
    let style_bidi: Option<bool> = arg(args, "styleBidi")?;
    with_build_ctx(args, |ctx| {
        let theme = theme_colors_of(ctx, args)?;
        with_node(text, args, |p_pr| {
            optional(text::extract_para_format(
                p_pr.ok_or("TypeError: no pPr")?,
                theme.as_ref(),
                style_bidi,
            )?)
        })
    })
}

fn ppr_only_format(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| {
        let theme = theme_colors_of(ctx, args)?;
        with_node(text, args, |p_pr| {
            value(text::ppr_only_format(
                p_pr.ok_or("TypeError: no pPr")?,
                theme.as_ref(),
            )?)
        })
    })
}

fn resolved_para_format(text: &str, args: &Value) -> Returned {
    let mut eff: docx_engine::resolve::EffectivePPr = required(args, "eff")?;
    // `align` is not deserialized: the resolver only ever produces these five
    eff.align = match args.pointer("/eff/align").and_then(Value::as_str) {
        Some("left") => Some("left"),
        Some("center") => Some("center"),
        Some("right") => Some("right"),
        Some("justify") => Some("justify"),
        Some("distribute") => Some("distribute"),
        _ => None,
    };
    with_build_ctx(args, |ctx| {
        let theme = theme_colors_of(ctx, args)?;
        with_node(text, args, |p_pr| {
            optional(text::resolved_para_format(&eff, p_pr, theme.as_ref())?)
        })
    })
}

fn anchor_line_of(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| optional(text::anchor_line_of(text, ctx)?))
}

fn stray_anchor_line(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| optional(text::stray_anchor_line(text, ctx)?))
}

fn anchored_rule_overlays(text: &str, args: &Value) -> Returned {
    with_build_ctx(args, |ctx| value(text::anchored_rule_overlays(text, ctx)?))
}

fn extract_runs(text: &str, args: &Value) -> Returned {
    let math: Vec<String> = arg(args, "math")?.unwrap_or_default();
    let ruby: Vec<String> = arg(args, "ruby")?.unwrap_or_default();
    let with_images: bool = arg(args, "withImages")?.unwrap_or(false);
    let zotero: Option<ZoteroArg> = arg(args, "zotero")?;
    let zotero = zotero.map(|z| ZoteroFieldParagraph {
        id: z.id,
        instruction: z.instruction,
        part: z.part,
    });
    let nodes = docx_engine::package::parse_part(text)?;
    let p_node = nodes
        .iter()
        .find(|node| node.name() == Some("w:p"))
        .ok_or("TypeError: no paragraph")?;
    let math_refs: Vec<&str> = math.iter().map(String::as_str).collect();
    let ruby_refs: Vec<&str> = ruby.iter().map(String::as_str).collect();
    with_build_ctx(args, |ctx| {
        value(text::extract_runs(
            p_node,
            ctx,
            &math_refs,
            &ruby_refs,
            with_images,
            zotero.as_ref(),
            None,
            None,
        )?)
    })
}

#[derive(serde::Deserialize)]
struct ZoteroArg {
    id: u32,
    instruction: String,
    part: docx_engine::model::RunZoteroFieldPart,
}

fn build_text_paragraph(text: &str, args: &Value) -> Returned {
    let with_images: bool = arg(args, "withImages")?.unwrap_or(false);
    let doc_offset: Option<f64> = arg(args, "docOffset")?;
    let id: String = required(args, "id")?;
    let docx_index: JsNum = required(args, "docxIndex")?;
    let base = text::BlockBase {
        id,
        docx_index,
        original_xml: text.to_owned(),
    };
    with_build_ctx(args, |ctx| {
        let block: Block = text::build_text_paragraph(
            &base,
            text,
            ctx,
            with_images,
            doc_offset.map(|o| o as usize),
            None,
        )?;
        value(block)
    })
}

fn standalone_note_reader(text: &str, args: &Value) -> Returned {
    let kind: docx_engine::notes::NoteKind = required(args, "kind")?;
    value(text::parse_notes_standalone(text, kind)?)
}
