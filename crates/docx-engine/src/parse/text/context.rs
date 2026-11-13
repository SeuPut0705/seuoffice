//! `BuildContext` of parse.ts: what the readers of one part share.
//!
//! The members the TypeScript mutates while it walks (`openMoves`,
//! `chartParts`, `sdtGroupSeq`, `floatTableAhead`, `resolveDiff`,
//! `nextZoteroFieldId`) are `RefCell`/`Cell` fields, so every reader takes
//! `&BuildContext`. The TypeScript's `{ ...ctx, mediaByRid }` is `Clone`.
//! All offsets are byte offsets of the text they index, never UTF-16 units.
//!
//! `styles`, `numbering`, `defaultParaStyle`, `docDefaults`, `themeFonts` and
//! `themeColors` of the TypeScript context are the same objects its `resolver`
//! holds; here they are read through [`BuildContext::resolver`]:
//! `ctx.resolver.styles`, `ctx.resolver.numbering`,
//! `ctx.resolver.default_para_style()`, `ctx.resolver.doc_defaults`,
//! `ctx.resolver.theme_fonts`, `ctx.resolver.theme_colors`,
//! `ctx.resolver.compat`. [`BuildContext::style_ctx`] is the view
//! the `lists.rs` readers take.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use jscompat::{JsMap, JsNum, JsObject, js_regex};
use ooxml_pkg::Package;

use super::lists::StyleCtx;
use crate::inline_opaque::InlineRawSource;
use crate::model::{self, SharedStr};
use crate::package::RelInfo;
use crate::parse::drawings::host::MediaEnv;
use crate::resolve::ResolveCtx;
use crate::section::section_settings_from_xml;

/// `openMoves` of `BuildContext`: a move range open at the current point of
/// the body walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenMove {
    pub id: String,
    pub name: String,
    /// `'from' | 'to'`
    pub side: &'static str,
}

/// `floatTableAhead`: the column span (twips) of a w:tblpPr table built just
/// before the current block.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FloatTableAhead {
    pub left_twips: JsNum,
    pub right_twips: JsNum,
}

/// A `ResolveDiff` as shadow mode collects it.
#[derive(Debug, Clone, PartialEq)]
pub struct ShadowDiff {
    /// `'body' | 'cell' | 'run'`
    pub surface: &'static str,
    pub key: String,
    pub old: Option<serde_json::Value>,
    pub eff: Option<serde_json::Value>,
    pub text: String,
}

/// `sectionAt`: the page geometry of the section governing a byte offset of
/// document.xml. A section ends at its w:sectPr: the one governing an offset
/// is the first sectPr at or after it.
#[derive(Debug, Clone, Default)]
pub struct SectionIndex {
    /// `[start, end)` of each `<w:sectPr .../>` / `<w:sectPr>...</w:sectPr>` slice
    pub slices: Vec<(usize, usize)>,
    xml: Rc<str>,
    gutter_at_top: Option<bool>,
    cache: RefCell<JsMap<model::SectionSettings>>,
}

impl SectionIndex {
    /// The sections of `document_xml`; `gutter_at_top` is `parseSettingsFlag(zip, 'w:gutterAtTop')`.
    pub fn new(document_xml: &str, gutter_at_top: Option<bool>) -> Self {
        let slices = js_regex!(r"<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>", "g")
            .find_iter(document_xml)
            .map(|found| (found.start(), found.end()))
            .collect();
        Self {
            slices,
            xml: document_xml.into(),
            gutter_at_top,
            cache: RefCell::new(JsMap::new()),
        }
    }

    /// `sectionAt(docOffset)`
    pub fn at(&self, doc_offset: usize) -> model::SectionSettings {
        let found = self.slices.iter().position(|&(_, end)| end > doc_offset);
        let index = found.unwrap_or(self.slices.len().wrapping_sub(1));
        let key = if found.is_none() && self.slices.is_empty() {
            "-1".to_owned()
        } else {
            index.to_string()
        };
        if let Some(settings) = self.cache.borrow().get(&key) {
            return settings.clone();
        }
        let slice = match self.slices.get(index) {
            Some(&(start, end)) => &self.xml[start..end],
            None => "",
        };
        let engine = section_settings_from_xml(slice, self.gutter_at_top);
        // the engine's reader and the model type write the same JSON
        let settings: model::SectionSettings = serde_json::to_value(&engine)
            .ok()
            .and_then(|json| serde_json::from_value(json).ok())
            .unwrap_or_else(|| unreachable!("a SectionSettings the model cannot read"));
        self.cache.borrow_mut().set(key, settings.clone());
        settings
    }
}

/// `BuildContext`
#[derive(Clone)]
pub struct BuildContext<'a> {
    /// `zip`
    pub zip: &'a Package,
    /// `sourcePath`
    pub source_path: Option<String>,
    /// `styles`, `numbering`, `defaultParaStyle`, `docDefaults`, `themeFonts`,
    /// `themeColors`, `compat` and the resolver's table: see the module comment
    pub resolver: Rc<ResolveCtx>,
    /// whether the TypeScript context has `numbering` (a notes or header one has none)
    pub has_numbering: bool,
    /// `rels`
    pub rels: JsMap<RelInfo>,
    /// `numFormats`: numId to "bullet" or "ordered"; none on a notes or header context
    pub num_formats: Option<JsMap<&'static str>>,
    /// `openMoves`
    pub open_moves: RefCell<Vec<OpenMove>>,
    /// `chartParts`: chart part XML seen while building blocks (part path to xml)
    pub chart_parts: RefCell<JsObject<String>>,
    /// `noteNumbers`: "footnote:<id>" / "endnote:<id>" to display number
    pub note_numbers: JsMap<JsNum>,
    /// `mediaByRid`: a:blip rId to data/external URL for pictures inside w:tbl
    pub media_by_rid: Option<RefCell<JsMap<SharedStr>>>,
    /// `externalTxbxByRid`: r:txbx rId to the content of the external textbox part
    pub external_txbx_by_rid: Option<JsMap<String>>,
    /// `referenceOnlyComments`
    pub reference_only_comments: Option<HashSet<String>>,
    /// `sectionAt`
    pub section_at: Option<SectionIndex>,
    /// `firstPageBreakAt`
    pub first_page_break_at: Option<usize>,
    /// `floatTableAhead`
    pub float_table_ahead: RefCell<Option<FloatTableAhead>>,
    /// `sdtGroupSeq`
    pub sdt_group_seq: Cell<f64>,
    /// `tableRaw`: source text of the table being read
    pub table_raw: RefCell<Option<Rc<InlineRawSource<'static>>>>,
    /// `compatibilityMode`
    pub compatibility_mode: Option<JsNum>,
    /// `resolveDiff`: shadow mode collector (none: shadow mode off)
    pub resolve_diff: Option<Rc<RefCell<Vec<ShadowDiff>>>>,
    /// `xmlSpacePreserve`
    pub xml_space_preserve: bool,
    /// `partNamespaces`: prefix to namespace URI of the part root (none: no declarations known)
    pub part_namespaces: Option<JsMap<String>>,
    /// `vmlShapeTypes`
    pub vml_shape_types: Option<JsMap<JsObject<String>>>,
    /// `nextZoteroFieldId`
    pub next_zotero_field_id: Cell<f64>,
    /// the media host and the per-zip media caches, shared by every context of one zip
    pub media: &'a MediaEnv<'a>,
}

impl<'a> BuildContext<'a> {
    /// A context holding only the resolver: the members a notes or header
    /// context of the TypeScript sets (`rels` and `noteNumbers` empty, no
    /// `numbering`, no `numFormats`).
    pub fn bare(zip: &'a Package, resolver: Rc<ResolveCtx>, media: &'a MediaEnv<'a>) -> Self {
        Self {
            zip,
            source_path: None,
            resolver,
            has_numbering: false,
            rels: JsMap::new(),
            num_formats: None,
            open_moves: RefCell::new(Vec::new()),
            chart_parts: RefCell::new(JsObject::new()),
            note_numbers: JsMap::new(),
            media_by_rid: None,
            external_txbx_by_rid: None,
            reference_only_comments: None,
            section_at: None,
            first_page_break_at: None,
            float_table_ahead: RefCell::new(None),
            sdt_group_seq: Cell::new(0.0),
            table_raw: RefCell::new(None),
            compatibility_mode: None,
            resolve_diff: None,
            xml_space_preserve: false,
            part_namespaces: None,
            vml_shape_types: None,
            next_zotero_field_id: Cell::new(0.0),
            media,
        }
    }

    /// The members `lists.rs` reads of the context.
    pub fn style_ctx(&self) -> StyleCtx<'_> {
        StyleCtx {
            styles: Some(&self.resolver.styles),
            numbering: self.has_numbering.then_some(&self.resolver.numbering),
            num_formats: self.num_formats.as_ref(),
            default_para_style: self.default_para_style(),
            doc_defaults: self.doc_defaults(),
        }
    }

    /// `ctx.docDefaults`: only a body context carries it (a notes or header
    /// context has the resolver's, which is not the same member).
    pub fn doc_defaults(&self) -> Option<&crate::styles::DocDefaults> {
        if self.has_numbering {
            self.resolver.doc_defaults.as_ref()
        } else {
            None
        }
    }

    /// `ctx.defaultParaStyle`: carried by a body context only, as `docDefaults`.
    pub fn default_para_style(&self) -> Option<&crate::styles::StyleInfo> {
        if self.has_numbering {
            self.resolver.default_para_style()
        } else {
            None
        }
    }
}
