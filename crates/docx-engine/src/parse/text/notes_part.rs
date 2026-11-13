//! The notes parts through the document's run extraction and resolver.

use std::rc::Rc;

use jscompat::JsMap;
use ooxml_pkg::Package;
use serde_json::{Map, Value};

use super::context::BuildContext;
use super::convert::{json, model_of, run_eff_to_model};
use super::extract_runs::extract_runs_plain;
use super::note_run_of;
use crate::model::{NoteInfo, NoteInfoSpacing};
use crate::notes::{NoteKind, NoteParagraph, parse_notes_xml_with};
use crate::package::{Thrown, parse_part, part_text};
use crate::parse::drawings::host::{MediaEnv, NoHost};
use crate::resolve::{
    ResolveCompat, ResolveCtx, ResolveParaOptions, effective_spacing_twips,
    resolve_paragraph_props, resolve_run_props,
};

/// `NOTE_PART_PATH`
pub fn note_part_path(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => "word/footnotes.xml",
        NoteKind::Endnote => "word/endnotes.xml",
    }
}

/// `noteParagraphReader`: a `NoteParagraphReader` over a `<w:p>` slice:
/// extractRuns for the text, the resolver (FootnoteText / EndnoteText chain,
/// docDefaults) for the base run look and the paragraph spacing.
pub fn note_paragraph_reader<'a>(
    ctx: &'a BuildContext<'_>,
) -> impl FnMut(&str) -> Result<NoteParagraph, Thrown> + 'a {
    move |p_xml: &str| {
        let rctx: &ResolveCtx = &ctx.resolver;
        // a part the parser refuses reads as no paragraph node
        let parsed = parse_part(p_xml).ok();
        let p_node = parsed
            .as_ref()
            .and_then(|nodes| nodes.iter().find(|node| node.name() == Some("w:p")));
        let p_pr = p_node.and_then(|node| node.find_child("w:pPr"));
        let eff = resolve_paragraph_props(p_pr, rctx, ResolveParaOptions::default())?;
        let base = resolve_run_props(None, eff.style_id.as_deref(), eff.bidi, rctx, false);
        let base = run_eff_to_model(&base)?;
        let runs = match p_node {
            Some(p_node) => extract_runs_plain(p_node, ctx, false)?
                .iter()
                .filter(|run| {
                    run.text.as_deref().is_some_and(|text| !text.is_empty()) && run.image.is_none()
                })
                .map(|run| note_run_of(run, &base))
                .collect(),
            None => Vec::new(),
        };
        let sp = effective_spacing_twips(&eff, &rctx.compat);
        let mut spacing = Map::new();
        spacing.insert("beforeTwips".to_owned(), json(&sp.before));
        spacing.insert("afterTwips".to_owned(), json(&sp.after));
        if let Some(line) = &eff.spacing.line {
            spacing.insert("lineRule".to_owned(), Value::from(line.rule.as_str()));
            spacing.insert("lineRawTwips".to_owned(), json(&line.raw));
        }
        let spacing: NoteInfoSpacing = model_of(Value::Object(spacing))?;
        Ok(NoteParagraph {
            runs,
            style_id: eff.style_id.clone().filter(|id| !id.is_empty()),
            spacing,
        })
    }
}

/// `parseNotesPart`: the notes of the footnotes or endnotes part (none without one).
pub fn parse_notes_part(
    zip: &Package,
    kind: NoteKind,
    ctx: &BuildContext<'_>,
) -> Result<Vec<NoteInfo>, Thrown> {
    let Some(xml) = part_text(zip, note_part_path(kind))? else {
        return Ok(Vec::new());
    };
    let mut read = note_paragraph_reader(ctx);
    parse_notes_xml_with(xml, kind, &mut read)
}

/// The resolver of `standaloneNoteParagraphReader`: no styles, builtin defaults.
fn standalone_resolver() -> ResolveCtx {
    ResolveCtx {
        styles: Rc::new(JsMap::new()),
        numbering: Rc::new(JsMap::new()),
        compat: ResolveCompat {
            mode: jscompat::JsNum(0.0),
            additive_para_spacing: false,
            indent_not_numbering_tab_stop: false,
        },
        ..ResolveCtx::default()
    }
}

/// `standaloneNoteParagraphReader`'s notes: a notes part on its own (no
/// styles: builtin defaults; tests, tools).
pub fn parse_notes_standalone(xml: &str, kind: NoteKind) -> Result<Vec<NoteInfo>, Thrown> {
    let package = Package::default();
    let media = MediaEnv::new(&NoHost);
    let ctx = BuildContext::bare(&package, Rc::new(standalone_resolver()), &media);
    let mut read = note_paragraph_reader(&ctx);
    parse_notes_xml_with(xml, kind, &mut read)
}

/// `standaloneNoteParagraphReader()(pXml)`: one `<w:p>` slice read on its own.
pub fn read_note_paragraph_standalone(p_xml: &str) -> Result<NoteParagraph, Thrown> {
    let package = Package::default();
    let media = MediaEnv::new(&NoHost);
    let ctx = BuildContext::bare(&package, Rc::new(standalone_resolver()), &media);
    note_paragraph_reader(&ctx)(p_xml)
}
