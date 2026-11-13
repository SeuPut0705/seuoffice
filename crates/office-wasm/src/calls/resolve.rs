//! `resolve.<name>`: resolve-props.ts. The context of a call is built from
//! `args.parts` the way the TypeScript side builds it (`parseTheme`,
//! `parseStyles`, `parseNumbering`, `resolveCtxOf`), once per distinct parts;
//! `args.compat` and `args.table` are set on it per call.

use std::cell::RefCell;

use docx_engine::numbering::parse_numbering;
use docx_engine::props::{CharUnits, XML_PARSER_MAX_NESTED_TAGS};
use docx_engine::resolve::{
    self, AUTO_SPACING_TWIPS, EffectiveParaFormatOptions, LineSpacing, PropSource, ResolveCompat,
    ResolveCtx, ResolveDoc, ResolveParaOptions, TableCtx,
};
use docx_engine::styles::parse_styles;
use docx_engine::theme::parse_theme;
use jscompat::JsNum;
use ooxml_xml::{XNode, parse_ordered};
use serde::Deserialize;
use serde_json::Value;

use super::{Returned, arg, package, required, value};

/// `args.compat`: the settings.xml values `resolveCtxOf` takes.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatArg {
    compatibility_mode: Option<JsNum>,
    #[serde(rename = "doNotUseHTMLParagraphAutoSpacing")]
    do_not_use_html_paragraph_auto_spacing: Option<bool>,
    indent_not_numbering_tab_stop: Option<bool>,
}

/// `resolveCtxOf({ styles: new Map(), numbering: new Map(), ...args.compat }).compat`
fn compat_of(args: &Value) -> Result<ResolveCompat, String> {
    let compat: CompatArg = arg(args, "compat")?.unwrap_or_default();
    Ok(resolve::resolve_ctx_of(ResolveDoc {
        compatibility_mode: compat.compatibility_mode,
        do_not_use_html_paragraph_auto_spacing: compat.do_not_use_html_paragraph_auto_spacing,
        indent_not_numbering_tab_stop: compat.indent_not_numbering_tab_stop,
        ..ResolveDoc::default()
    })
    .compat)
}

/// The context of the package `args.parts`; `Err` where a reader throws.
fn build_ctx(args: &Value) -> Result<ResolveCtx, String> {
    let package = package(args)?;
    let theme = parse_theme(&package)?;
    let styles = parse_styles(&package, theme.colors.as_ref(), theme.fonts.as_ref())?;
    let numbering = parse_numbering(&package)?;
    Ok(resolve::resolve_ctx_of(ResolveDoc {
        styles: styles.styles.into_iter().collect(),
        doc_defaults: styles.doc_defaults,
        numbering: numbering.defs,
        theme_fonts: theme.fonts,
        theme_colors: theme.colors,
        ..ResolveDoc::default()
    }))
}

/// Contexts kept, the latest used last: a corpus document's calls come
/// together, but the runner batches them by text across documents.
const CONTEXTS_KEPT: usize = 16;

thread_local! {
    static CONTEXTS: RefCell<Vec<(Value, Result<ResolveCtx, String>)>> =
        const { RefCell::new(Vec::new()) };
}

/// Calls `call` with the context of `args`.
pub(super) fn with_ctx(args: &Value, call: impl FnOnce(&ResolveCtx) -> Returned) -> Returned {
    let compat = compat_of(args)?;
    let table: Option<TableCtx> = arg(args, "table")?;
    let parts = args.get("parts").cloned().unwrap_or(Value::Null);
    CONTEXTS.with(|contexts| {
        let mut contexts = contexts.borrow_mut();
        let entry = match contexts.iter().position(|(key, _)| *key == parts) {
            Some(at) => contexts.remove(at),
            None => {
                let built = build_ctx(args);
                if contexts.len() == CONTEXTS_KEPT {
                    drop(contexts.remove(0));
                }
                (parts, built)
            }
        };
        contexts.push(entry);
        let Some((_, built)) = contexts.last_mut() else {
            return Err("no context".to_owned());
        };
        let ctx = built.as_mut().map_err(|error| error.clone())?;
        ctx.compat = compat;
        ctx.table = table;
        call(ctx)
    })
}

/// The top-level element of `text` named `args.node`, as the TypeScript side
/// picks it from `xmlParser.parse(text)`; `Err` where the parser refuses.
fn with_node(text: &str, args: &Value, call: impl FnOnce(Option<&XNode>) -> Returned) -> Returned {
    let nodes =
        parse_ordered(text, XML_PARSER_MAX_NESTED_TAGS).map_err(|error| error.to_string())?;
    let wanted: Option<String> = arg(args, "node")?;
    let node = wanted
        .as_deref()
        .and_then(|wanted| nodes.iter().find(|node| node.name() == Some(wanted)));
    call(node)
}

/// `CharUnits` as it crosses JSON: `null` is the NaN `JSON.stringify` wrote.
#[derive(Deserialize)]
struct UnitsArg {
    run: Option<f64>,
    normal: Option<f64>,
}

fn opts_of(args: &Value) -> Result<ResolveParaOptions, String> {
    let units: Option<UnitsArg> = arg(args, "charUnits")?;
    Ok(ResolveParaOptions {
        char_units: units.map(|units| CharUnits {
            run: units.run.unwrap_or(f64::NAN),
            normal: units.normal.unwrap_or(f64::NAN),
        }),
    })
}

fn constant(name: &str) -> Returned {
    match name {
        "AUTO_SPACING_TWIPS" => value(JsNum(AUTO_SPACING_TWIPS)),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constants" => constant(&required::<String>(args, "name")?),
        "resolveCtxOf" => with_ctx(args, |ctx| value(ctx)),
        "resolveParagraphProps" => {
            let opts = opts_of(args)?;
            with_ctx(args, |ctx| {
                with_node(text, args, |p_pr| {
                    value(resolve::resolve_paragraph_props(p_pr, ctx, opts)?)
                })
            })
        }
        "resolveParagraphPropsXml" => {
            let opts = opts_of(args)?;
            with_ctx(args, |ctx| {
                value(resolve::resolve_paragraph_props_xml(text, ctx, opts)?)
            })
        }
        "resolveRunProps" | "directRunFormat" => {
            let para_style_id: Option<String> = arg(args, "paraStyleId")?;
            let para_bidi: Option<bool> = arg(args, "paraBidi")?;
            let mark: Option<bool> = arg(args, "mark")?;
            with_ctx(args, |ctx| {
                with_node(text, args, |r_pr| {
                    let eff = resolve::resolve_run_props(
                        r_pr,
                        para_style_id.as_deref(),
                        para_bidi == Some(true),
                        ctx,
                        mark == Some(true),
                    );
                    if function == "resolveRunProps" {
                        value(eff)
                    } else {
                        value(resolve::direct_run_format(&eff))
                    }
                })
            })
        }
        "directParaFormat" | "effectiveSpacingTwips" | "hfLineSources" | "effectiveParaFormat" => {
            let opts = opts_of(args)?;
            let in_table: Option<bool> = arg(args, "inTable")?;
            let line_sources: Option<Vec<PropSource>> = arg(args, "lineSources")?;
            with_ctx(args, |ctx| {
                let eff = resolve::resolve_paragraph_props_xml(text, ctx, opts)?;
                match function {
                    "directParaFormat" => value(resolve::direct_para_format(&eff)),
                    "effectiveSpacingTwips" => {
                        value(resolve::effective_spacing_twips(&eff, &ctx.compat))
                    }
                    "hfLineSources" => {
                        value(resolve::hf_line_sources(&eff, in_table.unwrap_or(false)))
                    }
                    _ => value(resolve::effective_para_format(
                        &eff,
                        &ctx.compat,
                        &EffectiveParaFormatOptions { line_sources },
                    )),
                }
            })
        }
        "autoSpacingTwips" => value(JsNum(resolve::auto_spacing_twips(&compat_of(args)?))),
        "effectiveLineFormat" => {
            let line: Option<LineSpacing> = arg(args, "line")?;
            value(resolve::effective_line_format(line.as_ref()))
        }
        "shadowCompare" => {
            let keys: Option<Vec<String>> = arg(args, "keys")?;
            value(resolve::shadow_compare(
                args.get("legacy"),
                args.get("resolved"),
                keys.as_deref(),
            ))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
