//! The slide reader, packages/pptx-engine/src/parse.ts: one module per
//! section, ported line by line. This table is the API the sections call
//! across modules: a function keeps its TypeScript name in snake case and
//! its parameters in the TypeScript order, and another section calls it as
//! `super::<module>::<name>`. An item another section calls is
//! `pub(super)`; the exports of parse.ts are `pub`.
//!
//! Conventions of the signatures:
//!
//! - An XML node is [`Node<'_>`](context::Node) (`Option<&Value>`), an XML
//!   text `&str`, a number `f64` (a model field is `JsNum`), the context
//!   `&ParseContext<'_>`. parse.ts never writes to a context: a spread
//!   `{ ...ctx, key: value }` is `ParseContext { key: Some(&value), ..*ctx }`.
//! - The ids of `uid` come from `ctx.uid(prefix)` ([`context::Uids`] says
//!   where to call it and how a spec compares ids). `passthrough` takes a
//!   `ctx` the TypeScript does not, for that alone.
//! - An element builder takes its `ByteAnchor` by value and stores it; the
//!   caller clones where the TypeScript hands one anchor to several elements.
//! - `Result<_, String>` where the TypeScript can throw: fast-xml-parser on a
//!   shape fragment, `scanSlide`, `atob` of a document's `gxRaw` attribute
//!   (base64ToUtf8), the chart readers and `themeWithOverride`, and every
//!   caller that does not catch them.
//! - Types are those of crate::types; build a `js_object!` model type in the
//!   order of the TypeScript literal with `Slot::of`, `Slot::maybe` and
//!   `types::assigned`.
//!
//! | Line | TypeScript | Module | Rust name | Rust signature |
//! | ---- | ---------- | ------ | --------- | -------------- |
//! | 78 | `parser` | context | `PARSER_OPTIONS`, `parse_xml` | `pub fn parse_xml(xml: &str) -> Result<Value, String>` |
//! | 104 | `EMU_PER_PT` | context | `EMU_PER_PT` | `pub const EMU_PER_PT: f64` |
//! | 107 | `DEFAULT_BODY_INSETS` | context | `DEFAULT_BODY_INSETS` | `pub const DEFAULT_BODY_INSETS: Insets` |
//! | 109 | `ParseContext` | context | `ParseContext`, `ParseContextData` | `pub struct ParseContext<'a>` (borrowed), `pub struct ParseContextData` (owned, `Deserialize`) |
//! | 166 | `SlideParseInput` | context | `SlideParseInput` | `pub struct SlideParseInput<'a>` |
//! | 175 | `uid` | context | `ParseContext::uid` | `pub fn uid(&self, prefix: &str) -> String` |
//! | 179 | `parseSlide` | slide | `parse_slide` | `pub fn parse_slide(input: SlideParseInput<'_>) -> Result<Slide, String>` |
//! | 258 | `parseBackground` | slide | `parse_background` | `pub fn parse_background(xml: &str, ctx: &ParseContext<'_>) -> Option<Fill>` |
//! | 307 | `isHiddenElement` | shape | `is_hidden_element` | `fn is_hidden_element(node: Node<'_>, tag_name: &str) -> bool` |
//! | 324 | `mathBlockAsRun` | shape | `math_block_as_run` | `fn math_block_as_run(block: &str) -> String` |
//! | 332 | `utf8ToBase64` | shape | `utf8_to_base64` | `fn utf8_to_base64(s: &str) -> String` |
//! | 340 | `base64ToUtf8` | text | `base64_to_utf8` | `fn base64_to_utf8(b64: &str) -> Result<String, String>` |
//! | 347 | `parseShapeFragment` | shape | `parse_shape_fragment` | `pub(super) fn parse_shape_fragment(sp: &SpElement<'_>, frag_xml: &str, anchor: ByteAnchor, ctx: &ParseContext<'_>) -> Result<Option<SlideElement>, String>` |
//! | 461 | `parseSpShape` | shape | `parse_sp_shape` | `pub(super) fn parse_sp_shape(node: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>, raw_xml: Option<&str>) -> Result<TextElement, String>` (the TypeScript declares `TextElement \| PassthroughElement` and returns only the first) |
//! | 643 | `styleRefStroke` | shape | `style_ref_stroke` | `fn style_ref_stroke(node: Node<'_>, ctx: &ParseContext<'_>) -> Option<Stroke>` |
//! | 661 | `parseStroke` | shape | `parse_stroke` | `pub(super) fn parse_stroke(sp_pr: Node<'_>, ctx: &ParseContext<'_>, fallback_color: Option<&str>) -> Option<Option<Stroke>>` (`None` is `undefined`, `Some(None)` the `null` of an explicit `a:noFill`) |
//! | 704 | `parseArrowEnd` | shape | `parse_arrow_end` | `fn parse_arrow_end(node: Node<'_>) -> Option<ArrowEnd>` |
//! | 726 | `parseConnector` | shape | `parse_connector` | `fn parse_connector(node: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>) -> TextElement` |
//! | 775 | `parseGlow` | shape | `parse_glow` | `pub(super) fn parse_glow(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<GlowEffect>` |
//! | 785 | `parseReflection` | shape | `parse_reflection` | `pub(super) fn parse_reflection(sp_pr: Node<'_>) -> Option<ReflectionEffect>` |
//! | 796 | `parseShadow` | shape | `parse_shadow` | `pub(super) fn parse_shadow(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<ShadowEffect>` |
//! | 821 | `parseScene3D` | shape | `parse_scene3d` | `pub(super) fn parse_scene3d(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<Scene3D>` |
//! | 864 | `parseAvLst` | shape | `parse_av_lst` | `pub(super) fn parse_av_lst(av_lst: Node<'_>) -> Option<JsObject<JsNum>>` |
//! | 905 | `groupScaleWithinWriteRange` | shape | `group_scale_within_write_range` | `fn group_scale_within_write_range(group_ext: &EmuRect, child_ext: &EmuRect) -> bool` |
//! | 936 | `groupExceedsBudget` | shape | `group_exceeds_budget` | `fn group_exceeds_budget(xml: &str) -> bool` |
//! | 962 | `parseGroup` | shape | `parse_group` | `fn parse_group(node: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>, raw_xml: Option<&str>, depth: u32, budget: &mut GroupParseBudget) -> Result<GroupElement, String>` (callers pass the defaults `0` and `GroupParseBudget { remaining: MAX_GROUP_DESCENDANTS }`) |
//! | 1038 | `parseGroupChild` | shape | `parse_group_child` | `fn parse_group_child(tag: &str, child: Node<'_>, ctx: &ParseContext<'_>, raw_xml: Option<&str>, depth: u32, budget: &mut GroupParseBudget) -> Result<Option<SlideElement>, String>` |
//! | 1075 | `groupChildNvId` | shape | `group_child_nv_id` | `fn group_child_nv_id(child: Node<'_>) -> Option<String>` |
//! | 1099 | `sliceGroupChildren` | shape | `slice_group_children` | `fn slice_group_children(xml: &str) -> Vec<GroupChildSlice<'_>>` |
//! | 1135 | `sliceGroupChildXmls` | shape | `slice_group_child_xmls` | `pub fn slice_group_child_xmls(grp_xml: &str) -> Vec<&str>` |
//! | 1145 | `blipEmbedId` | fill | `blip_embed_id` | `pub(super) fn blip_embed_id<'a>(blip: Node<'a>) -> Option<&'a str>` |
//! | 1150 | `svgBlipEmbedId` | fill | `svg_blip_embed_id` | `fn svg_blip_embed_id<'a>(blip: Node<'a>) -> Option<&'a str>` |
//! | 1166 | `blipMediaRef` | fill | `blip_media_ref` | `pub(super) fn blip_media_ref<'a>(blip: Node<'_>, embed_id: Option<&str>, ctx: &ParseContext<'a>) -> &'a str` (`""` where the TypeScript gives `''`) |
//! | 1171 | `parsePicture` | picture | `parse_picture` | `pub(super) fn parse_picture(node: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>, raw_xml: Option<&str>) -> PictureElement` |
//! | 1293 | `parseSrcRect` | picture | `parse_src_rect` | `fn parse_src_rect(sr: Node<'_>) -> Option<Insets>` |
//! | 1307 | `parseChartUserLines` | picture | `parse_chart_user_lines` | `fn parse_chart_user_lines(us_xml: &str, ctx: &ParseContext<'_>) -> Vec<UserLine>` |
//! | 1350 | `parseChartUserShapes` | picture | `parse_chart_user_shapes` | `fn parse_chart_user_shapes(us_xml: &str, frame: &Transform, anchor: &ByteAnchor, ctx: &ParseContext<'_>) -> Result<Vec<TextElement>, String>` |
//! | 1431 | `graphicFramePassthrough` | picture | `graphic_frame_passthrough` | `pub(super) fn graphic_frame_passthrough(node: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>) -> Result<SlideElement, String>` |
//! | 1603 | `diagramTextColors` | picture | `diagram_text_colors` | `fn diagram_text_colors(data_xml: Option<&str>, colors_xml: Option<&str>, ctx: &ParseContext<'_>) -> JsMap<String>` |
//! | 1630 | `parseDiagramDrawing` | picture | `parse_diagram_drawing` | `fn parse_diagram_drawing(drawing_xml: &str, parent_ctx: &ParseContext<'_>, tx_colors: Option<&JsMap<String>>) -> Result<Vec<SlideElement>, String>` |
//! | 1715 | `splitDiagramParagraphs` | picture | `split_diagram_paragraphs` | `fn split_diagram_paragraphs(body: &mut TextBody)` |
//! | 1762 | `dgmBulletLines` | diagram | `dgm_bullet_lines` | `fn dgm_bullet_lines(node: &DgmTreeNode, lvl: f64) -> Vec<DgmBulletLine>` (the caller passes the default `1.0`) |
//! | 1772 | `diagramLabelFills` | diagram | `diagram_label_fills` | `fn diagram_label_fills(colors_xml: Option<&str>, ctx: &ParseContext<'_>) -> JsMap<Vec<String>>` |
//! | 1803 | `dgmSp` | diagram | `dgm_sp` | `fn dgm_sp(r#box: DgmBox, fill: DgmFill<'_>, lines: &[DgmLine], opts: &DgmSpOpts) -> Value` |
//! | 1893 | `dgmTint` | diagram | `dgm_tint` | `fn dgm_tint(hex: &str, pct: f64) -> String` |
//! | 1910 | `layoutDiagramFallback` | diagram | `layout_diagram_fallback` | `pub fn layout_diagram_fallback(data_xml: &str, ctx: &ParseContext<'_>, frame_cx: f64, frame_cy: f64, layout_id: Option<&str>, colors_xml: Option<&str>, layout_xml: Option<&str>) -> Result<Vec<SlideElement>, String>` |
//! | 3134 | `collectDgmTexts` | diagram | `collect_dgm_texts` | `fn collect_dgm_texts(pt: Node<'_>) -> Vec<String>` |
//! | 3153 | `collectDgmRunSize` | diagram | `collect_dgm_run_size` | `fn collect_dgm_run_size(pt: Node<'_>) -> Option<f64>` |
//! | 3162 | `findDescendantPic` | picture | `find_descendant_pic` | `fn find_descendant_pic(node: Node<'_>, depth: u32) -> Node<'_>` (the caller passes the default `0`) |
//! | 3180 | `xsdBool` | table | `xsd_bool` | `fn xsd_bool(v: Node<'_>) -> bool` (not `chart::xsd_bool`, which reads another way) |
//! | 3185 | `parseTable` | table | `parse_table` | `pub(super) fn parse_table(node: Node<'_>, tbl: Node<'_>, anchor: ByteAnchor, ctx: &ParseContext<'_>) -> Result<Option<TableElement>, String>` |
//! | 3272 | `parseTableCell` | table | `parse_table_cell` | `fn parse_table_cell(tc: Node<'_>, ctx: &ParseContext<'_>, part: Option<&TablePartStyle>, inside: Option<&CellStyleBorders>) -> Result<TableCell, String>` |
//! | 3378 | `passthrough` | shape | `passthrough` | `pub(super) fn passthrough(anchor: ByteAnchor, kind: PassthroughKind, node: Node<'_>, ctx: &ParseContext<'_>) -> PassthroughElement` |
//! | 3390 | `parseXfrm` | shape | `parse_xfrm` | `pub(super) fn parse_xfrm(xfrm: Node<'_>) -> Transform` |
//! | 3413 | `lacksExt` | shape | `lacks_ext` | `pub(super) fn lacks_ext(xfrm: Node<'_>) -> bool` |
//! | 3418 | `withInheritedExt` | shape | `with_inherited_ext` | `pub(super) fn with_inherited_ext(xfrm: Node<'_>, own: Transform, inherited: Transform) -> Transform` |
//! | 3429 | `parseLum` | fill | `parse_lum` | `pub(super) fn parse_lum(blip_node: Node<'_>) -> Option<Lum>` |
//! | 3442 | `parseBiLevel` | fill | `parse_bi_level` | `pub(super) fn parse_bi_level(blip_node: Node<'_>) -> Option<f64>` |
//! | 3451 | `parseDuotone` | fill | `parse_duotone` | `pub(super) fn parse_duotone(blip_node: Node<'_>, ctx: &ParseContext<'_>) -> Option<(String, String)>` |
//! | 3480 | `parseClrChange` | fill | `parse_clr_change` | `pub(super) fn parse_clr_change(blip_node: Node<'_>, ctx: &ParseContext<'_>) -> Option<ClrChange>` |
//! | 3491 | `parseFill` | fill | `parse_fill` | `pub(super) fn parse_fill(sp_pr: Node<'_>, ctx: &ParseContext<'_>) -> Option<Fill>` |
//! | 3563 | `parseGradFill` | fill | `parse_grad_fill` | `fn parse_grad_fill(grad: Node<'_>, ctx: &ParseContext<'_>) -> Option<Fill>` |
//! | 3620 | `resolveColorNode` | fill | `resolve_color_node` | `pub(super) fn resolve_color_node(node: Node<'_>, ctx: &ParseContext<'_>) -> Option<String>` |
//! | 3633 | `xmlAttrEsc` | fill | `xml_attr_esc` | `fn xml_attr_esc(v: &str) -> String` |
//! | 3640 | `nonPlainColorNode` | fill | `non_plain_color_node` | `pub(super) fn non_plain_color_node(container: Node<'_>) -> Option<String>` |
//! | 3649 | `colorNodeXml` | fill | `color_node_xml` | `pub(super) fn color_node_xml(fill_node: Node<'_>) -> Option<String>` |
//! | 3680 | `parseTextBody` | text | `parse_text_body` | `pub(super) fn parse_text_body(tx_body: Node<'_>, ctx: &ParseContext<'_>, ph_chain: &[TextStyleLevels], inherited_insets: Option<&PlaceholderInsets>) -> Result<TextBody, String>` (the default chain is `&[]`) |
//! | 3786 | `spcPct` | text | `spc_pct` | `fn spc_pct(node: Node<'_>) -> Option<f64>` |
//! | 3792 | `spcPts` | text | `spc_pts` | `fn spc_pts(node: Node<'_>) -> Option<f64>` |
//! | 3797 | `parseParagraph` | text | `parse_paragraph` | `fn parse_paragraph(p: Node<'_>, ctx: &ParseContext<'_>, chain: &[Option<TextStyleLevels>]) -> Result<Paragraph, String>` |
//! | 4016 | `parseParagraphDefRPr` | text | `parse_paragraph_def_r_pr` | `fn parse_paragraph_def_r_pr(def_r_pr_node: Node<'_>, style: &LevelTextStyle) -> ParagraphDefaultRunProps` |
//! | 4057 | `paragraphSources` | text | `paragraph_sources` | `fn paragraph_sources(dflt: Option<&LevelTextStyle>, para_style: &LevelTextStyle) -> StyleSource` |
//! | 4068 | `themeFontSource` | text | `theme_font_source` | `fn theme_font_source(r#ref: Option<&str>) -> Option<&'static str>` |
//! | 4073 | `parseRun` | text | `parse_run` | `fn parse_run(r: Node<'_>, ctx: &ParseContext<'_>, dflt: Option<&LevelTextStyle>) -> TextRun` |
//! | 4330 | `DecorationOptions` | context | `DecorationOptions` | `pub struct DecorationOptions` |
//! | 4349 | `parseDecorations` | decor | `parse_decorations` | `pub fn parse_decorations(xml: &str, ctx: &ParseContext<'_>, opts: &DecorationOptions) -> Result<Vec<SlideElement>, String>` |
//! | 4381 | `substituteSlideNum` | decor | `substitute_slide_num` | `fn substitute_slide_num(el: &mut SlideElement, num: f64)` |
//! | 4395 | `intOr` | decor | `int_or` | `pub(super) fn int_or(v: Node<'_>, dflt: f64) -> f64` |
//!
//! Constants and types private to one section, where they live:
//!
//! | Line | TypeScript | Module | Rust |
//! | ---- | ---------- | ------ | ---- |
//! | 299 | `NV_PR_KEYS` | shape | a `match` in `is_hidden_element` |
//! | 315 | `MATH_AC_RE` | shape | `js_regex!` at its use |
//! | 879 | `GROUP_CHILD_TAGS` | shape | `const GROUP_CHILD_TAGS: [&str; 5]` |
//! | 880 | `MAX_GROUP_DEPTH` | shape | `const MAX_GROUP_DEPTH: u32 = 64` |
//! | 881 | `MAX_GROUP_DESCENDANTS` | shape | `pub(super) const MAX_GROUP_DESCENDANTS: usize = 10_000` (parseSlide reads it) |
//! | 883 | `GroupParseBudget` | shape | `struct GroupParseBudget { remaining: i64 }` |
//! | 1085 | `GROUP_TAG_RE`, `GROUP_NAME_RE` | shape | `js_regex!` at their uses |
//! | 1088 | `GroupChildSlice` | shape | `struct GroupChildSlice<'a> { name: &'a str, xml: &'a str, start: u64 }` (`start` a byte offset: it only orders) |
//! | 1713 | `DGM_PARA_BREAK` | picture | `const DGM_PARA_BREAK: char = '\u{2029}'` |
//! | 1743 | `DgmTreeNode` | diagram | `struct DgmTreeNode`; `DgmBulletLine`, `DgmBox`, `DgmFill`, `DgmLine` and `DgmSpOpts` are the inline types of `dgmBulletLines` and `dgmSp` |
//! | 1759 | `MAX_DGM_TREE_DEPTH` | diagram | `const MAX_DGM_TREE_DEPTH: u32 = 256` |
//! | 3624 | `COLOR_NODE_TAGS` | fill | `pub(super) const COLOR_NODE_TAGS: [&str; 6]` (diagramLabelFills reads it) |
//! | 4039 | `CJK_RE`, `CS_RE` | text | `js_regex!` at their uses |
//! | 4045 | `SOURCE_FIELDS` | text | a list of the `StyleSource` fields in `paragraph_sources` |
//! | 335 of generate.ts | `COORD_MAX` | context | `pub const COORD_MAX: f64` |
//!
//! Modules and their parse.ts lines: context 78-178; slide 179-297; shape
//! 299-339, 347-1138 and 3378-3425; picture 1171-1742 and 3162-3175;
//! diagram 1743-3161; table 3176-3377; fill 1141-1170 and 3426-3677; text
//! 340-345 and 3678-4327; decor 4328-4401.

pub mod context;
mod decor;
mod diagram;
mod fill;
mod picture;
mod shape;
mod slide;
mod table;
mod text;

pub use context::{
    DEFAULT_BODY_INSETS, DecorationOptions, EMU_PER_PT, ParseContext, ParseContextData,
    SlideParseInput, Uids,
};
pub use decor::parse_decorations;
pub use diagram::layout_diagram_fallback;
pub use shape::slice_group_child_xmls;
pub use slide::{parse_background, parse_slide};
