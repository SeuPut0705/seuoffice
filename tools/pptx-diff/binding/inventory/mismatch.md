# C2 pptx-engine: TS export vs Rust signature (322 functions)

Counts (one class per row; when several apply the primary is picked by priority slide-index > return-alias > extra-rust-param > callback > async > other, the rest is in the note as `also:`):

| class | n |
| --- | --- |
| one-to-one | 226 |
| slide-index | 14 |
| return-alias | 26 |
| extra-rust-param | 20 |
| async | 5 |
| callback | 4 |
| other | 27 (1 of them, savePptxToFile, has no Rust port) |
| total | 322 |

Global facts used below:
- `crate::deck::*` rows that need a uuid draw it inside via `deck::random_uuid()`; the caller can pin it with `crate::deck::with_uuid(uuid, || ...)`. Rows outside `deck` (insert, media_insert, narration, smartart, chart_insert, identity, model3d, xml_utils, sections) take the uuid as a parameter.
- `usize` index params are TS `number`; `f64` index params (slides.rs, sections.rs) are TS `number` as is.
- `Result<T,String>` = TS throws. `Option<T>` = TS `T|null` or `T|undefined`.
- TS `Set<T>` / `Map` args and returns are Rust `&[T]`/`Vec<T>`/`&HashSet`/`JsMap`: shape conversion only (kept `one-to-one`, said in the note).
- No Rust port: `savePptxToFile` only. `unescapeXml`, `xmlParser`, `elementCNvPrId` use the stream-C exceptions.

## Rows

| TS name | module | class | Rust path | Rust signature | note |
| --- | --- | --- | --- | --- | --- |
| alignRects | align | one-to-one | crate::align::align_rects | (rects:&[AlignRect], kind:&str, container_rect:Option<AlignRect>) -> Vec<AlignPoint> | |
| distributeRects | align | one-to-one | crate::align::distribute_rects | (rects:&[AlignRect], kind:&str) -> Vec<AlignPoint> | |
| isMediaEffect | animation | one-to-one | crate::animation::is_media_effect | (effect:AnimEffectKind) -> bool | |
| animClassOf | animation | one-to-one | crate::animation::anim_class_of | (effect:AnimEffectKind) -> AnimClass | |
| elementSpid | animation | one-to-one | crate::animation::element_spid | (el:&SlideElement) -> Option<JsNum> | |
| buildTimingXml | animation | one-to-one | crate::animation::build_timing_xml | (anims:&[SlideAnimation]) -> Result<String,String> | |
| patchSlideTimingXml | animation | one-to-one | crate::animation::patch_slide_timing_xml | (body_suffix:&str, anims:&[SlideAnimation]) -> Result<String,String> | |
| readSlideTimingXml | animation | one-to-one | crate::animation::read_slide_timing_xml | (body_suffix:&str) -> Vec<SlideAnimation> | |
| patchSlideTimingIncrementalXml | animation | other | crate::animation::patch_slide_timing_incremental_xml | (body_suffix:&str, anims:&[SlideAnimation]) -> Option<Result<String,String>> | nested return: None = TS null (caller rebuilds), Some(Err) = throws; row must unwrap two levels |
| setSlideAnimations | animation | one-to-one | crate::animation::set_slide_animations | (slide:&mut Slide, anims:&[SlideAnimation]) -> Result<(),String> | &mut Slide written back |
| getSlideAnimations | animation | one-to-one | crate::animation::get_slide_animations | (slide:&Slide) -> Vec<SlideAnimation> | |
| pruneTimingForSpids | animation | one-to-one | crate::animation::prune_timing_for_spids | (slide:&mut Slide, spids:&[f64]) -> Result<bool,String> | ReadonlySet<number> arrives as slice (Set shape); &mut Slide written back |
| cNvPrIdsInXml | animation | one-to-one | crate::animation::c_nv_pr_ids_in_xml | (xml:&str) -> Vec<JsNum> | TS returns Set<number>; Vec is deduped in set order (Set shape on revive) |
| promoteSlideBackground | background-promote | one-to-one | crate::background_promote::promote_slide_background | (slide:&mut Slide, size:&SlideSize) -> bool | &mut Slide written back |
| isBackgroundLikeElement | background-promote | one-to-one | crate::background_promote::is_background_like_element | (el:&SlideElement, size:&SlideSize) -> bool | |
| createBlankPptx | blank | async | crate::blank::create_blank_pptx | (now:f64) -> Result<Vec<u8>,String> | TS async (JSZip); Rust sync; also: extra-rust-param now (Date.now ms) |
| shouldOfferBuiltinLayouts | builtin-layouts | one-to-one | crate::builtin_layouts::should_offer_builtin_layouts | (layouts:&[SlideLayoutInfo]) -> bool | |
| builtinLayoutInfos | builtin-layouts | one-to-one | crate::builtin_layouts::builtin_layout_infos | (size:&SlideSize, existing_names:&HashSet<String>) -> Vec<SlideLayoutInfo> | Set<string> arrives as set |
| ensureBuiltinLayout | builtin-layouts | one-to-one | crate::builtin_layouts::ensure_builtin_layout | (archive:&mut PackageArchive, size:&SlideSize, key:&str) -> Result<Option<String>,String> | &mut PackageArchive written back |
| buildChartSpaceXml | chart-insert | one-to-one | crate::chart_insert::build_chart_space_xml | (opts:&NewChartOptions, external_data_r_id:Option<&str>) -> String | |
| writeChartWorkbook | chart-insert | one-to-one | crate::chart_insert::write_chart_workbook | (opened:&mut OpenedPptx, chart_path:&str, opts:&NewChartOptions) -> Result<String,String> | &mut OpenedPptx written back |
| addChart | chart-insert | return-alias | crate::chart_insert::add_chart | (opened:&mut OpenedPptx, slide_index:usize, opts:&NewChartOptions, uuid:&str) -> Result<Option<String>,String> | TS returns {slide, elementId} or null; Rust returns element id only: slide = opened.deck.slides[slide_index]; also: extra-rust-param uuid |
| chartWorkbookParts | chart-workbook | one-to-one | crate::chart_workbook::chart_workbook_parts | (data:&ChartWorkbookData) -> JsObject<String> | |
| storedZip | chart-workbook | one-to-one | crate::chart_workbook::stored_zip | (files:&JsObject<String>) -> Result<Vec<u8>,String> | |
| chartWorkbookXlsx | chart-workbook | one-to-one | crate::chart_workbook::chart_workbook_xlsx | (data:&ChartWorkbookData) -> Result<Vec<u8>,String> | |
| colLetter | chart-workbook | one-to-one | crate::chart_workbook::col_letter | (i:f64) -> String | |
| parseChartXml | chart | callback | crate::chart::parse_chart_xml | (xml:&str, theme:Option<&Theme>, resolve_fill:Option<&dyn Fn(Option<&Value>)->Option<Fill>>) -> Result<Option<ChartModel>,String> | resolve_fill = TS resolveFill callback (ResolveFill alias) |
| parseChartExXml | chartex | one-to-one | crate::chartex::parse_chart_ex_xml | (xml:&str, theme:Option<&Theme>) -> Result<Option<ChartModel>,String> | |
| resolveColorNode | color | one-to-one | crate::color::resolve_color_node | (node:Option<&Value>, theme:Option<&Theme>, ph_clr:Option<&str>) -> Option<String> | |
| applyColorMods | color | one-to-one | crate::color::apply_color_mods | (hex:&str, mods:Option<&Value>) -> String | |
| hexToRgb | color | one-to-one | crate::color::hex_to_rgb | (hex:&str) -> Rgb | |
| scaleLuminance | color | one-to-one | crate::color::scale_luminance | (hex:&str, factor:f64) -> String | |
| getSlideComments | comments | one-to-one | crate::comments::get_slide_comments | (archive:&PackageArchive, slide_path:&str) -> Result<Vec<SlideComment>,String> | |
| addSlideComment | comments | extra-rust-param | crate::comments::add_slide_comment | (opened:&mut OpenedPptx, slide_index:usize, opts:&SlideCommentOptions, dt:&str) -> Result<Option<SlideComment>,String> | dt = new Date().toISOString() supplied by caller; &mut OpenedPptx written back |
| deleteSlideComment | comments | one-to-one | crate::comments::delete_slide_comment | (opened:&mut OpenedPptx, slide_index:usize, reference:&SlideCommentRef) -> Result<bool,String> | |
| crc32 | crc32 | one-to-one | crate::crc32::crc32 | (buf:&[u8]) -> u32 | |
| evalGuides | custgeom | one-to-one | crate::custgeom::eval_guides | (gds:&[Guide], w:f64, h:f64) -> JsObject<f64> | |
| parseCustGeom | custgeom | other | crate::custgeom::parse_cust_geom | (shape_xml:&str, shape_w:f64, shape_h:f64) -> Result<Option<CustomGeometry>,RegexLimit> | error type is RegexLimit, not String (use .to_string()) |
| validCustGeomPath | custgeom | one-to-one | crate::custgeom::valid_cust_geom_path | (p:Option<&Value>) -> Result<bool,String> | TS arg unknown = JSON value |
| custGeomXml | custgeom | one-to-one | crate::custgeom::cust_geom_xml | (p:&CustGeomPath) -> String | |
| parseHierConstraints | dgm-hier | one-to-one | crate::dgm_hier::parse_hier_constraints | (layout_xml:Option<&str>) -> HierConstraints | |
| layoutHierTree | dgm-hier | other | crate::dgm_hier::layout_hier_tree | <'a>(roots:&'a [HierTreeNode], cons:HierConstraints, frame_cx:f64, frame_cy:f64) -> Option<HierLayout<'a>> | return borrows roots: lines[].to is a reference to an input node (TS holds the same object); binding must serialize (to = node identity lost, find by id/index) |
| eotToSfnt | embedded-fonts | one-to-one | crate::embedded_fonts::eot_to_sfnt | (bytes:&[u8]) -> Option<Vec<u8>> | |
| demandKey | embedded-fonts | one-to-one | crate::embedded_fonts::demand_key | (typeface:&str, style:EmbeddedFontStyle) -> String | |
| editedGlyphDemand | embedded-fonts | other | crate::embedded_fonts::edited_glyph_demand | (slides:&[Slide]) -> Option<GlyphDemand> | TS takes deck:{slides}; Rust takes deck.slides; GlyphDemand is an ordered-set struct (TS Map<string,Set<number>>) |
| sfntCmapLookup | embedded-fonts | other | crate::embedded_fonts::sfnt_cmap_lookup | (sfnt:&[u8]) -> Option<CmapLookup> | TS returns a function (cp)=>boolean; Rust returns a struct with .covers(cp): cannot cross wasm, needs a hand route (e.g. return covered cps / take cps) |
| staleEmbeddedTypefaces | embedded-fonts | one-to-one | crate::embedded_fonts::stale_embedded_typefaces | (archive:&PackageArchive, demand:&GlyphDemand) -> Result<Vec<String>,String> | |
| stripEmbeddedFonts | embedded-fonts | one-to-one | crate::embedded_fonts::strip_embedded_fonts | (archive:&mut PackageArchive, typefaces:Option<&HashSet<String>>) -> bool | ReadonlySet arrives as set; &mut PackageArchive written back |
| stripStaleEmbeddedFonts | embedded-fonts | other | crate::embedded_fonts::strip_stale_embedded_fonts | (slides:&[Slide], archive:&mut PackageArchive) -> Result<Vec<String>,String> | TS takes deck:{slides}; Rust takes deck.slides; &mut PackageArchive written back |
| listEmbeddedFonts | embedded-fonts | one-to-one | crate::embedded_fonts::list_embedded_fonts | (archive:&PackageArchive) -> Result<Vec<EmbeddedFontFace>,String> | |
| extractFormat | format-brush | one-to-one | crate::format_brush::extract_format | (el:&TextElement) -> CopiedFormat | |
| applyFormat | format-brush | one-to-one | crate::format_brush::apply_format | (fmt:&CopiedFormat, target_type:&str) -> FormatPatchResult | |
| patchTextElementXml | generate | one-to-one | crate::generate::patch_text_element_xml | (el:&TextElement, original_xml:&str) -> Result<String,String> | |
| patchParagraphPPrXml | generate | one-to-one | crate::generate::patch_paragraph_p_pr_xml | (para_xml:&str, p:&Paragraph, which:&PPrDirty) -> Result<String,String> | |
| patchElementPPr | generate | one-to-one | crate::generate::patch_element_p_pr | (el:&TextElement, xml:&str, which:&PPrDirty) -> Result<Option<String>,String> | |
| szAttr | generate | one-to-one | crate::generate::sz_attr | (pt:f64) -> String | |
| clampInt | generate | one-to-one | crate::generate::clamp_int | (v:f64, min:f64, max:f64) -> f64 | |
| hangulLang | generate | one-to-one | crate::generate::hangul_lang | (text:&str) -> Option<&'static str> | |
| tagHangulRun | generate | one-to-one | crate::generate::tag_hangul_run | (run:&TextRun) -> TextRun | returns a copy (TS may return the same object when untagged) |
| tagHangulParagraphs | generate | other | crate::generate::tag_hangul_paragraphs | (paragraphs:&[Paragraph]) -> Option<Vec<Paragraph>> | None = TS returns the same array unchanged; row must map None to the input |
| isConnectorXml | generate | one-to-one | crate::generate::is_connector_xml | (xml:&str) -> bool | |
| rebuildTxBody | generate | one-to-one | crate::generate::rebuild_tx_body | (el:&TextElement, original_xml:&str) -> String | |
| generateParagraphXml | generate | one-to-one | crate::generate::generate_paragraph_xml | (p:&Paragraph) -> String | |
| alternateContentBranches | generate | one-to-one | crate::generate::alternate_content_branches | (xml:&str) -> Result<Option<Vec<AlternateContentBranch>>,String> | |
| topLevelChildren | generate | one-to-one | crate::generate::top_level_children | (xml:&str, from:usize, to:usize) -> Result<Vec<TopLevelChild>,String> | |
| patchElementFill | generate | one-to-one | crate::generate::patch_element_fill | (original_xml:&str, fill:&FillPatch) -> Result<String,String> | |
| patchElementStroke | generate | one-to-one | crate::generate::patch_element_stroke | (original_xml:&str, stroke:Option<&StrokePatch>) -> Result<String,String> | |
| patchPictureSrcRect | generate | one-to-one | crate::generate::patch_picture_src_rect | (original_xml:&str, src_rect:Option<&Insets>) -> Result<String,String> | |
| patchSlideBackgroundXml | generate | one-to-one | crate::generate::patch_slide_background_xml | (body_prefix:&str, fill:&BackgroundFillPatch) -> String | |
| removeSlideBackgroundXml | generate | one-to-one | crate::generate::remove_slide_background_xml | (body_prefix:&str) -> String | |
| patchSlideShowMasterSpXml | generate | one-to-one | crate::generate::patch_slide_show_master_sp_xml | (body_prefix:&str, hidden:bool) -> Result<String,String> | |
| patchSlideTransitionXml | generate | one-to-one | crate::generate::patch_slide_transition_xml | (body_suffix:&str, kind:SlideTransitionKind) -> String | |
| readSlideTransitionXml | generate | one-to-one | crate::generate::read_slide_transition_xml | (body_suffix:&str) -> SlideTransitionKind | |
| patchSlideAdvanceTimeXml | generate | one-to-one | crate::generate::patch_slide_advance_time_xml | (body_suffix:&str, ms:Option<f64>) -> String | |
| readSlideAdvanceTimeXml | generate | one-to-one | crate::generate::read_slide_advance_time_xml | (body_suffix:&str) -> Option<f64> | |
| patchSlideHiddenXml | generate | one-to-one | crate::generate::patch_slide_hidden_xml | (body_prefix:&str, hidden:bool) -> String | |
| readSlideHiddenXml | generate | one-to-one | crate::generate::read_slide_hidden_xml | (body_prefix:&str) -> bool | |
| generateXfrmXml | generate | one-to-one | crate::generate::generate_xfrm_xml | (t:&Transform, tag:&str) -> String | |
| patchElementXfrm | generate | one-to-one | crate::generate::patch_element_xfrm | (el:&SlideElement, original_xml:&str) -> String | |
| patchBodyPrAutofit | generate | one-to-one | crate::generate::patch_body_pr_autofit | (xml:&str, font_scale:f64, ln_spc_reduction:Option<f64>) -> String | |
| clampEmu | generate | one-to-one | crate::generate::clamp_emu | (v:f64) -> f64 | |
| clampPosEmu | generate | one-to-one | crate::generate::clamp_pos_emu | (v:f64) -> f64 | |
| glbJson | glb-bounds | one-to-one | crate::glb_bounds::glb_json | (bytes:&[u8]) -> Result<Option<JsonValue>,String> | |
| glbBounds | glb-bounds | one-to-one | crate::glb_bounds::glb_bounds | (bytes:&[u8]) -> Result<Option<GlbBounds>,String> | |
| applyHeaderFooter | headerfooter | extra-rust-param | crate::headerfooter::apply_header_footer | (opened:&mut OpenedPptx, opts:&HeaderFooterOptions, slide_indexes:Option<&[f64]>, now_ms:f64) -> Result<bool,String> | now_ms = Date.now(); &mut OpenedPptx written back |
| readHeaderFooter | headerfooter | one-to-one | crate::headerfooter::read_header_footer | (slide:&Slide) -> HeaderFooterState | |
| setElementLink | hyperlink | return-alias | crate::hyperlink::set_element_link | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, target:Option<&LinkTarget>) -> Result<bool,String> | TS returns the Slide (opened.deck.slides[slide_index]) or null; Rust bool: true -> that slide, false -> null |
| decodeRunLink | hyperlink | one-to-one | crate::hyperlink::decode_run_link | (s:&str) -> Option<LinkTarget> | |
| encodeRunLink | hyperlink | one-to-one | crate::hyperlink::encode_run_link | (target:&LinkTarget) -> String | |
| ensureRunLinkRels | hyperlink | one-to-one | crate::hyperlink::ensure_run_link_rels | (opened:&mut OpenedPptx, slide_index:usize, paragraphs:&mut [Paragraph]) -> bool | paragraphs is &mut and written back (runs gain hyperlinkRId); also &mut OpenedPptx; no Result |
| getRunLinks | hyperlink | one-to-one | crate::hyperlink::get_run_links | (opened:&OpenedPptx, slide_index:usize) -> Result<Vec<RunLink>,String> | shared borrow, nothing written back |
| getElementLink | hyperlink | one-to-one | crate::hyperlink::get_element_link | (opened:&OpenedPptx, slide_index:usize, element_id:&str) -> Result<Option<LinkTarget>,String> | shared borrow |
| getSlideLinks | hyperlink | one-to-one | crate::hyperlink::get_slide_links | (opened:&OpenedPptx, slide_index:usize) -> Result<Vec<SlideLink>,String> | shared borrow |
| withFreshCreationIds | identity | extra-rust-param | crate::identity::with_fresh_creation_ids | (xml:&str, next_uuid:impl FnMut()->String) -> Result<String,String> | next_uuid replaces crypto.randomUUID, drawn once per creation id; caller must supply a uuid source (generic closure, not a TS callback) |
| elementDurableId | identity | one-to-one | crate::identity::element_durable_id | (el:&SlideElement) -> Result<Option<String>,String> | |
| slideDurableId | identity | one-to-one | crate::identity::slide_durable_id | (slide:&Slide) -> String | |
| elementCNvPrId | identity | one-to-one | crate::identity::element_cnvpr_id | (el:&SlideElement) -> Result<Option<String>,String> | stream-C name exception |
| matchesElementRef | identity | one-to-one | crate::identity::matches_element_ref | (el:&SlideElement, id:&str) -> Result<bool,String> | |
| ensureCreationId | identity | extra-rust-param | crate::identity::ensure_creation_id | (el:&mut SlideElement, uuid:&str) -> Result<(),String> | uuid = crypto.randomUUID (at most one drawn); &mut SlideElement written back |
| groupChildDurableId | identity | one-to-one | crate::identity::group_child_durable_id | (grp:&SlideElement, child:&SlideElement) -> Result<Option<String>,String> | |
| openPptx | index | async | crate::deck::open_pptx | (bytes:&[u8]) -> Result<OpenedPptx,String> | TS async, Rust sync; returns a fresh OpenedPptx (deck + archive + uids), not an alias |
| reparseDeck | index | return-alias | crate::deck::reparse_deck | (opened:&mut OpenedPptx) -> Result<(),String> | TS returns the same opened object (deck replaced in place); Rust returns nothing: result = the opened argument after write-back |
| savePptx | index | async | crate::deck::save_pptx | (opened:&mut OpenedPptx) -> Result<Vec<u8>,String> | TS async, Rust sync; &mut OpenedPptx written back; saveSnapshot stays in the binding |
| savePptxToFile | index | other | (none) | (none) | NO PORT: no file system in the engine (deck/mod.rs doc); binding = savePptx + host file write; also async |
| commitSaved | index | one-to-one | crate::deck::commit_saved | (opened:&mut OpenedPptx) | no Result; &mut OpenedPptx written back |
| patchSlideXml | index | one-to-one | crate::deck::patch_slide_xml | (slide:&mut Slide) -> String | &mut Slide written back (patching mutates elements); errors fall back to the original XML |
| patchedElementXml | index | one-to-one | crate::deck::patched_element_xml | (el:&mut SlideElement) -> String | &mut SlideElement written back (creation id minted); element is a standalone object, not part of an OpenedPptx arg |
| setSlideBackground | index | slide-index | crate::deck::set_slide_background | (opened:&mut OpenedPptx, slide_index:usize, fill:&SlideBackgroundFill) -> Result<(),String> | TS param slide -> Rust slide_index (index of slide in opened.deck.slides); fill string-or-gradient = SlideBackgroundFill |
| setSlideBackgroundImage | index | slide-index | crate::deck::set_slide_background_image | (opened:&mut OpenedPptx, slide_index:usize, source:&BackgroundImageSource, tile:Option<bool>) -> Result<Option<String>,String> | slide -> slide_index |
| resetSlideBackground | index | slide-index | crate::deck::reset_slide_background | (opened:&mut OpenedPptx, slide_index:usize) -> Result<(),String> | slide -> slide_index |
| setSlideBgGraphicsHidden | index | slide-index | crate::deck::set_slide_bg_graphics_hidden | (opened:&mut OpenedPptx, slide_index:usize, hidden:bool) -> Result<(),String> | slide -> slide_index |
| editPictureSrcRect | index | one-to-one | crate::deck::edit_picture_src_rect | (slide:&mut Slide, source_id:&str, src_rect:Option<Insets>) -> bool | &mut Slide written back |
| setShapePresetGeometry | index | one-to-one | crate::deck::set_shape_preset_geometry | (slide:&mut Slide, element_id:&str, prst:&str) -> bool | |
| setShapeCustomGeometry | index | one-to-one | crate::deck::set_shape_custom_geometry | (slide:&mut Slide, element_id:&str, geom:Option<&Value>) -> Result<bool,String> | geom = CustGeomPath as JSON, validated in Rust |
| setShapeAdjustValues | index | one-to-one | crate::deck::set_shape_adjust_values | (slide:&mut Slide, element_id:&str, adjust:&JsObject<f64>) -> bool | |
| setElementTextAnchor | index | one-to-one | crate::deck::set_element_text_anchor | (slide:&mut Slide, element_id:&str, anchor:TextAnchor) -> bool | |
| autofitGeneratedTextBoxes | index | one-to-one | crate::deck::autofit_generated_text_boxes | (slide:&mut Slide) -> usize | |
| setElementTextBodyProps | index | one-to-one | crate::deck::set_element_text_body_props | (slide:&mut Slide, element_id:&str, patch:&TextBodyPropsPatch) -> bool | |
| setElementEffects | index | one-to-one | crate::deck::set_element_effects | (slide:&mut Slide, element_id:&str, patch:&EffectsPatch) -> Result<bool,String> | |
| setElementFill | index | slide-index | crate::deck::set_element_fill | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, fill:&ElementFill, opts:&FillOpts) -> Result<bool,String> | slide -> slide_index; opts {groupId?} = FillOpts |
| setElementImageFill | index | slide-index | crate::deck::set_element_image_fill | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, source:&ImageFillSource, opts:&ImageFillOpts) -> Result<Option<String>,String> | slide -> slide_index |
| setElementRedaction | index | one-to-one | crate::deck::set_element_redaction | (slide:&mut Slide, source_id:&str, label:Option<&str>) -> Result<bool,String> | |
| setPictureOpacity | index | one-to-one | crate::deck::set_picture_opacity | (slide:&mut Slide, source_id:&str, opacity:f64) -> bool | |
| replacePictureBytes | index | slide-index | crate::deck::replace_picture_bytes | (opened:&mut OpenedPptx, slide_index:usize, source_id:&str, bytes:&[u8], ext:&str, keep_src_rect:bool) -> Result<bool,String> | slide -> slide_index; also: opts {keepSrcRect?} flattened to keep_src_rect:bool (opts undefined -> false) |
| duplicateSlide | index | return-alias | crate::deck::duplicate_slide | (opened:&mut OpenedPptx, source_index:f64, opts:Option<&DuplicateSlideOptions>) -> Result<Option<usize>,String> | TS returns the new Slide or null; Rust Some(i) = opened.deck.slides[i] |
| copySlide | index | one-to-one | crate::deck::copy_slide | (opened:&mut OpenedPptx, source_index:f64) -> Result<Option<SlideBundle>,String> | returns a fresh bundle (no alias); &mut OpenedPptx written back |
| pasteSlide | index | return-alias | crate::deck::paste_slide | (opened:&mut OpenedPptx, after_index:f64, bundle:&SlideBundle, opts:Option<&PasteSlideOptions>) -> Result<Option<usize>,String> | new Slide = opened.deck.slides[i] |
| insertBlankSlide | index | return-alias | crate::deck::insert_blank_slide | (opened:&mut OpenedPptx, source_index:f64) -> Result<Option<usize>,String> | new Slide = opened.deck.slides[i] |
| mergeSlideFromPptx | index | async | crate::deck::merge_slide_from_pptx | (target:&mut OpenedPptx, source_bytes:&[u8], opts:&MergeSlideOptions<'_>) -> Result<Option<usize>,String> | TS async, Rust sync; also: return-alias (new slide = target.deck.slides[i]); MergeSlideOptions<'_> is a borrowed struct |
| extractMergeSlideSource | index | async | crate::deck::extract_merge_slide_source | (source_bytes:&[u8]) -> Result<Option<MergeSlideSource>,String> | TS async, Rust sync pure read |
| mergeSlideFromSource | index | return-alias | crate::deck::merge_slide_from_source | (target:&mut OpenedPptx, source:&MergeSlideSource, opts:&MergeSlideOptions<'_>) -> Result<Option<usize>,String> | new Slide = target.deck.slides[i]; also: MergeSlideOptions<'_> borrowed struct |
| insertSlideWithLayout | index | return-alias | crate::deck::insert_slide_with_layout | (opened:&mut OpenedPptx, source_index:f64, layout_path:&str) -> Result<Option<usize>,String> | new Slide = opened.deck.slides[i] |
| deleteSlide | index | one-to-one | crate::deck::delete_slide | (opened:&mut OpenedPptx, index:f64) -> Result<bool,String> | |
| reorderElement | index | one-to-one | crate::deck::reorder_element | (slide:&mut Slide, element_id:&str, dir:ReorderDirection) -> bool | |
| materializeSlide | index | return-alias | crate::deck::materialize_slide | (opened:&mut OpenedPptx, slide_index:usize) -> Result<bool,String> | TS returns Slide or null; Rust bool: true -> opened.deck.slides[slide_index] (same slide, in place), false -> null |
| connectionSiteForSide | index | one-to-one | crate::deck::connection_site_for_side | (el:&SlideElement, side:ConnectionSide) -> f64 | |
| updateConnectorsForMoved | index | one-to-one | crate::deck::update_connectors_for_moved | (slide:&mut Slide, moved_ids:&[String]) -> f64 | |
| setElementConnection | index | one-to-one | crate::deck::set_element_connection | (slide:&mut Slide, element_id:&str, patch:&ConnectionPatch) -> bool | |
| setSlideLayout | index | return-alias | crate::deck::set_slide_layout | (opened:&mut OpenedPptx, slide_index:f64, layout_path:&str) -> Result<Option<usize>,String> | TS returns the Slide or null; Rust Some(i) -> opened.deck.slides[i] |
| resetSlideLayout | index | return-alias | crate::deck::reset_slide_layout | (opened:&mut OpenedPptx, slide_index:f64) -> Result<Option<usize>,String> | same as setSlideLayout |
| setSlideSize | index | one-to-one | crate::deck::set_slide_size | (opened:&mut OpenedPptx, cx:f64, cy:f64) -> Result<bool,String> | |
| appendRawElements | index | return-alias | crate::deck::append_raw_elements | (opened:&mut OpenedPptx, slide_index:usize, xmls:&[String]) -> Result<Option<Vec<String>>,String> | TS returns {slide, elementIds} or null; Rust returns elementIds; slide = opened.deck.slides[slide_index] |
| addTable | index | return-alias | crate::deck::add_table | (opened:&mut OpenedPptx, slide_index:usize, opts:&NewTableOptions) -> Result<Option<String>,String> | TS {slide, elementId}; Rust element id; slide = opened.deck.slides[slide_index]; uuid drawn inside (deck::with_uuid) |
| editTableCellText | index | one-to-one | crate::deck::edit_table_cell_text | (slide:&mut Slide, element_id:&str, row:f64, col:f64, paragraphs:&[Paragraph]) -> bool | |
| editTableStyle | index | one-to-one | crate::deck::edit_table_style | (slide:&mut Slide, element_id:&str, edit:&TableStyleEdit) -> bool | |
| ensureTableStylePart | index | one-to-one | crate::deck::ensure_table_style_part | (opened:&mut OpenedPptx, style_id:&str, style_def_xml:&str) | no Result; &mut OpenedPptx written back |
| editChartElement | index | one-to-one | crate::deck::edit_chart_element | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, patch:&ChartEditPatch) -> Result<bool,String> | |
| markChartEditable | index | one-to-one | crate::deck::mark_chart_editable | (slide:&mut Slide, element_id:&str) -> bool | |
| setElementHidden | index | one-to-one | crate::deck::set_element_hidden | (slide:&mut Slide, element_id:&str, hidden:bool) -> Result<bool,String> | |
| setElementName | index | one-to-one | crate::deck::set_element_name | (slide:&mut Slide, element_id:&str, name:&str) -> Result<bool,String> | |
| getChartElementData | index | one-to-one | crate::deck::get_chart_element_data | (slide:&Slide, element_id:&str) -> Option<ChartElementData> | |
| setElementFont | index | callback | crate::deck::set_element_font | (slide:&mut Slide, element_id:&str, patch:&ElementFontPatch, size_map:Option<FontSizeMap<'_>>) -> Result<bool,String> | size_map = TS FontSizeMap callback slot (borrowed fn) |
| replaceAllInDeck | index | one-to-one | crate::deck::replace_all_in_deck | (deck:&mut SlideDeck, find:&str, replace:&str, opts:&ReplaceOptions) -> Result<ReplaceResult,String> | &mut SlideDeck written back |
| applyParagraphFormat | index | one-to-one | crate::deck::apply_paragraph_format | (paragraphs:&mut [Paragraph], patch:&ParagraphFormatPatch) -> PPrDirty | paragraphs is &mut and written back (TS mutates in place) |
| setElementParagraphFormat | index | one-to-one | crate::deck::set_element_paragraph_format | (slide:&mut Slide, element_id:&str, patch:&ParagraphFormatPatch, para_indices:Option<&[f64]>) -> Result<bool,String> | |
| setGroupChildParagraphFormat | index | one-to-one | crate::deck::set_group_child_paragraph_format | (slide:&mut Slide, group_id:&str, child_id:&str, patch:&ParagraphFormatPatch, para_indices:Option<&[f64]>) -> Result<bool,String> | |
| editTableStructure | index | return-alias | crate::deck::edit_table_structure | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, op:&TableStructureOp) -> Result<Option<String>,String> | TS {slide, elementId}; Rust element id; slide = opened.deck.slides[slide_index] |
| mergeTableCells | index | return-alias | crate::deck::merge_table_cells | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, op:&TableMergeOp) -> Result<Option<String>,String> | same as editTableStructure |
| setTableColWidth | index | one-to-one | crate::deck::set_table_col_width | (slide:&mut Slide, element_id:&str, col:f64, w_emu:f64) -> bool | |
| setTableRowHeight | index | one-to-one | crate::deck::set_table_row_height | (slide:&mut Slide, element_id:&str, row:f64, h_emu:f64) -> bool | |
| resizeTable | index | one-to-one | crate::deck::resize_table | (slide:&mut Slide, element_id:&str, cx:f64, cy:f64) -> bool | |
| setTableCellAnchor | index | one-to-one | crate::deck::set_table_cell_anchor | (slide:&mut Slide, element_id:&str, row:f64, col:f64, anchor:TextAnchor) -> bool | |
| copyElementData | index | slide-index | crate::deck::copy_element_data | (opened:&mut OpenedPptx, slide_index:usize, element_index:usize) -> Result<ElementClipboardItem,String> | TS (opened, slide, el): slide -> slide_index, el -> element_index (position in opened.deck.slides[slide_index].elements); element must be a top-level element |
| pasteElements | index | return-alias | crate::deck::paste_elements | (opened:&mut OpenedPptx, slide_index:usize, items:&[ElementClipboardItem], shift_emu:ShiftEmu) -> Result<Option<Vec<String>>,String> | TS {slide, elementIds} or null; Rust element ids; slide = opened.deck.slides[slide_index] |
| setSlideTransition | index | one-to-one | crate::deck::set_slide_transition | (slide:&mut Slide, kind:SlideTransitionKind) | no return |
| getSlideTransition | index | one-to-one | crate::deck::get_slide_transition | (slide:&Slide) -> SlideTransitionKind | |
| setSlideAdvanceTime | index | one-to-one | crate::deck::set_slide_advance_time | (slide:&mut Slide, ms:Option<f64>) | no return |
| getSlideAdvanceTime | index | one-to-one | crate::deck::get_slide_advance_time | (slide:&Slide) -> Option<f64> | |
| setSlideHidden | index | one-to-one | crate::deck::set_slide_hidden | (slide:&mut Slide, hidden:bool) | no return |
| getSlideHidden | index | one-to-one | crate::deck::get_slide_hidden | (slide:&Slide) -> bool | |
| reassembleSlideXml | index | one-to-one | crate::deck::reassemble_slide_xml | (slide:&Slide) -> String | |
| groupElements | index | return-alias | crate::deck::group_elements | (opened:&mut OpenedPptx, slide_index:usize, source_ids:&[String]) -> Result<Option<String>,String> | TS {slide, groupId} or null; Rust group id; slide = opened.deck.slides[slide_index] |
| ungroupElement | index | return-alias | crate::deck::ungroup_element | (opened:&mut OpenedPptx, slide_index:usize, source_id:&str) -> Result<bool,String> | TS Slide or null; Rust bool: true -> opened.deck.slides[slide_index], false -> null |
| groupChildSlices | index | one-to-one | crate::deck::group_child_slices | (grp_xml:&str) -> Result<Vec<GroupChildSlice>,String> | |
| patchGroupChildXml | index | callback | crate::deck::patch_group_child_xml | (grp:&mut GroupElement, nv_id:Option<&str>, patch:impl FnOnce(&str)->Result<String,String>) -> Result<bool,String> | patch = TS callback (xml)=>string; also: TS param child:SlideElement -> Rust nv_id:Option<&str> (child's nvId); &mut GroupElement written back |
| findGroupChild | index | return-alias | crate::deck::find_group_child | (slide:&Slide, group_id:&str, child_id:&str) -> Option<(usize,usize)> | TS returns {grp, child} (objects inside slide); Rust (group index in slide.elements, child index in that group.children); resolve after call |
| editGroupChildTransform | index | one-to-one | crate::deck::edit_group_child_transform | (slide:&mut Slide, group_id:&str, child_id:&str, offset:EmuRect, rotation_deg:f64) -> Result<bool,String> | |
| patchGroupChildText | index | one-to-one | crate::deck::patch_group_child_text | (slide:&mut Slide, group_id:&str, child:&TextElement) -> Result<bool,String> | |
| setGroupChildFont | index | callback | crate::deck::set_group_child_font | (slide:&mut Slide, group_id:&str, child_id:&str, patch:&ElementFontPatch, size_map:Option<&dyn Fn(Option<f64>)->f64>) -> Result<bool,String> | size_map = TS FontSizeMap callback slot |
| editGroupChildFill | index | one-to-one | crate::deck::edit_group_child_fill | (slide:&mut Slide, group_id:&str, child_id:&str, fill:&FillPatch) -> Result<bool,String> | |
| strokePatchToModel | index | one-to-one | crate::deck::stroke_patch_to_model | (stroke:&StrokePatch) -> Stroke | |
| editGroupChildStroke | index | one-to-one | crate::deck::edit_group_child_stroke | (slide:&mut Slide, group_id:&str, child_id:&str, stroke:Option<&StrokePatch>) -> Result<bool,String> | |
| setGroupChildShapeAdjustValues | index | one-to-one | crate::deck::set_group_child_shape_adjust_values | (slide:&mut Slide, group_id:&str, child_id:&str, adjust:&JsObject<JsNum>) -> Result<bool,String> | |
| setGroupChildShapePresetGeometry | index | one-to-one | crate::deck::set_group_child_shape_preset_geometry | (slide:&mut Slide, group_id:&str, child_id:&str, prst:&str) -> Result<bool,String> | |
| setGroupChildShapeCustomGeometry | index | one-to-one | crate::deck::set_group_child_shape_custom_geometry | (slide:&mut Slide, group_id:&str, child_id:&str, geom:&Value) -> Result<bool,String> | geom = CustGeomPath as JSON |
| isLineKind | insert | one-to-one | crate::insert::is_line_kind | (kind:&str) -> bool | |
| nextCNvPrId | insert | one-to-one | crate::insert::next_c_nv_pr_id | (slide:&Slide) -> f64 | |
| buildSpXml | insert | extra-rust-param | crate::insert::build_sp_xml | (slide:&Slide, opts:&NewElementOptions, uuid:&str) -> String | uuid = crypto.randomUUID for the creationId |
| addElement | insert | return-alias | crate::insert::add_element | (slide:&mut Slide, opts:&NewElementOptions, uuid:&str, now_ms:f64) -> Result<TextElement,String> | TS returns the TextElement it pushed to slide.elements; Rust returns a value: the alias is the last element of slide.elements (same id); also: extra-rust-param uuid, now_ms; &mut Slide written back |
| buildTableXml | insert | extra-rust-param | crate::insert::build_table_xml | (slide:&Slide, opts:&NewTableOptions, uuid:&str) -> String | uuid |
| buildTableGridXml | insert | extra-rust-param | crate::insert::build_table_grid_xml | (slide:&Slide, opts:&NewTableGridOptions, uuid:&str) -> String | uuid |
| addImageMediaAndRel | insert | slide-index | crate::insert::add_image_media_and_rel | (opened:&mut OpenedPptx, slide_index:usize, bytes:&[u8], ext_raw:&str) -> Result<Option<ImageMediaRel>,String> | TS slide -> slide_index (missing slide is Err, not null) |
| addPicture | insert | slide-index | crate::insert::add_picture | (opened:&mut OpenedPptx, slide_index:usize, opts:&NewPictureOptions, uuid:&str, now_ms:f64) -> Result<Option<PictureElement>,String> | slide -> slide_index; also: return-alias (TS returns the PictureElement pushed to the slide: last of slide.elements); extra-rust-param uuid, now_ms |
| deleteElement | insert | slide-index | crate::insert::delete_element | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str) -> Result<bool,String> | slide -> slide_index (missing slide is Err) |
| calcBoundingBox | insert | other | crate::insert::calc_bounding_box | <'a>(elements:impl IntoIterator<Item=&'a SlideElement>) -> EmuRect | generic iterator arg; the row must pass a concrete &[SlideElement] / Vec |
| buildGrpSpXml | insert | extra-rust-param | crate::insert::build_grp_sp_xml | (slide:&Slide, bbox:&EmuRect, children_xml:&str, uuid:&str) -> String | uuid |
| parseLayoutPlaceholders | layout | one-to-one | crate::layout::parse_layout_placeholders | (xml:&str) -> Vec<LayoutPlaceholder> | |
| listSlideLayouts | layout | one-to-one | crate::layout::list_slide_layouts | (archive:&PackageArchive) -> Vec<SlideLayoutInfo> | |
| placeholderSpXml | layout | one-to-one | crate::layout::placeholder_sp_xml | (ph:&LayoutPlaceholder, id:f64) -> String | TS ph is a Pick<> subset |
| prepareInsertSlideWithLayout | layout | one-to-one | crate::layout::prepare_insert_slide_with_layout | (archive:&mut PackageArchive, deck:&SlideDeck, source_index:usize, layout_path:&str) -> Result<Option<String>,String> | &mut PackageArchive written back; deck read only |
| listMasterParts | master-edit | one-to-one | crate::master_edit::list_master_parts | (archive:&PackageArchive) -> Result<Vec<MasterPartInfo>,String> | |
| parseMasterPart | master-edit | extra-rust-param | crate::master_edit::parse_master_part | (archive:&PackageArchive, part_path:&str, uids:&Uids) -> Result<Option<Slide>,String> | uids = the parse.ts module id counter (global Uids in office-wasm) |
| solidPng | media-insert | one-to-one | crate::media_insert::solid_png | (w:u32, h:u32, rgb:[u8;3]) -> Result<Vec<u8>,String> | TS returns Buffer |
| ensureDefaultContentType | media-insert | one-to-one | crate::media_insert::ensure_default_content_type | (opened:&mut OpenedPptx, ext:&str, mime:&str) -> Result<(),String> | |
| addMedia | media-insert | return-alias | crate::media_insert::add_media | (opened:&mut OpenedPptx, slide_index:usize, opts:&NewMediaOptions, uuid:&str) -> Result<Option<String>,String> | TS {slide, elementId}; Rust element id; slide = opened.deck.slides[slide_index]; also: extra-rust-param uuid |
| addModel3d | media-insert | return-alias | crate::media_insert::add_model3d | (opened:&mut OpenedPptx, slide_index:usize, opts:&NewModel3dOptions, uuid:&str) -> Result<Option<String>,String> | same as addMedia |
| setModel3dView | media-insert | slide-index | crate::media_insert::set_model3d_view | (opened:&mut OpenedPptx, slide_index:usize, element_id:&str, view:&Model3dView) -> Result<bool,String> | slide -> slide_index |
| model3dPartOf | media-insert | other | crate::media_insert::model3d_part_of | (descr:Option<&str>) -> Option<String> | TS takes el:{descr?}; Rust takes el.descr: argument grouping |
| model3dFraming | model3d | one-to-one | crate::model3d::model3d_framing | (bounds:Option<&GlbBounds>) -> Model3dFraming | |
| model3dXml | model3d | extra-rust-param | crate::model3d::model3d_xml | (o:&Model3dXmlOptions<'_>, uuid:&str) -> String | uuid; also: Model3dXmlOptions<'_> is a borrowed struct (bounds etc.) |
| syncModel3dFrame | model3d | one-to-one | crate::model3d::sync_model3d_frame | (xml:&str) -> String | |
| readModel3dRotation | model3d | one-to-one | crate::model3d::read_model3d_rotation | (xml:&str) -> Model3dRotation | |
| setModel3dRotationXml | model3d | one-to-one | crate::model3d::set_model3d_rotation_xml | (xml:&str, rot:&Model3dRotation) -> String | |
| namedActionOf | named-action | one-to-one | crate::named_action::named_action_of | (action:Option<&str>) -> Option<&'static str> | |
| namedActionAttr | named-action | one-to-one | crate::named_action::named_action_attr | (action:&str) -> String | |
| narrationSpids | narration | one-to-one | crate::narration::narration_spids | (slide:&Slide) -> Vec<f64> | |
| clearNarration | narration | one-to-one | crate::narration::clear_narration | (opened:&mut OpenedPptx, slide_index:usize) -> Result<usize,String> | |
| addNarration | narration | return-alias | crate::narration::add_narration | (opened:&mut OpenedPptx, slide_index:usize, audio:&NarrationAudio, uuid:&str) -> Result<Option<String>,String> | TS {slide, elementId}; Rust element id; slide = opened.deck.slides[slide_index]; also: extra-rust-param uuid |
| setShowNarration | narration | one-to-one | crate::narration::set_show_narration | (opened:&mut OpenedPptx) -> Result<(),String> | |
| notesPathForSlide | notes | one-to-one | crate::notes::notes_path_for_slide | (archive:&PackageArchive, slide_path:&str) -> Result<Option<String>,String> | |
| getSlideNotes | notes | one-to-one | crate::notes::get_slide_notes | (archive:&PackageArchive, slide_path:&str) -> Result<String,String> | |
| setSlideNotes | notes | one-to-one | crate::notes::set_slide_notes | (opened:&mut OpenedPptx, slide_index:usize, text:&str) -> Result<bool,String> | TS already takes slideIndex |
| addContentTypeOverride | notes | one-to-one | crate::notes::add_content_type_override | (archive:&mut PackageArchive, part_path:&str, content_type:&str) | &mut PackageArchive written back; no Result |
| appendRelationship | notes | one-to-one | crate::notes::append_relationship | (archive:&mut PackageArchive, part_path:&str, r#type:&str, target:&str) -> String | &mut PackageArchive written back |
| unescapeXml | notes | one-to-one | crate::notes::unescape_xml | (raw:&str) -> String | pub use of xml_utils::decode_xml (stream-C exception name) |
| ownValue | own-value | other | crate::own_value::own_value / own_value_in | <'a,V>(table:&'a JsMap<V>, key:&str) -> Option<&'a V>; <'a,V>(table:&'a [(&str,V)], key:&str) -> Option<&'a V> | generic over V, two Rust variants (map / static pair table); TS Readonly<Record<string,V>>; needs a concrete V per call site |
| setOwn | own-value | other | crate::own_value::set_own | <V>(record:&mut JsMap<V>, key:&str, value:V) | generic over V; record is &mut and written back |
| parseSlide | parse | other | crate::parse::parse_slide | (input:SlideParseInput<'_>) -> Result<Slide,String> | SlideParseInput<'_>{path, slide_xml, layout_path, master_path, ctx:ParseContext<'_>} is borrowed; ctx must be built from ParseContextData::context(&Uids) |
| parseBackground | parse | other | crate::parse::parse_background | (xml:&str, ctx:&ParseContext<'_>) -> Option<Fill> | borrowed ParseContext built by the row from a ParseContextData + &Uids |
| sliceGroupChildXmls | parse | one-to-one | crate::parse::slice_group_child_xmls | (grp_xml:&str) -> Result<Vec<&str>,String> | |
| layoutDiagramFallback | parse | other | crate::parse::layout_diagram_fallback | (data_xml:&str, ctx:&ParseContext<'_>, frame_cx:f64, frame_cy:f64, layout_id:Option<&str>, colors_xml:Option<&str>, layout_xml:Option<&str>) -> Result<Vec<SlideElement>,String> | borrowed ParseContext |
| parseDecorations | parse | other | crate::parse::parse_decorations | (xml:&str, ctx:&ParseContext<'_>, opts:&DecorationOptions) -> Result<Vec<SlideElement>,String> | borrowed ParseContext |
| parsePlaceholderMap | placeholder | one-to-one | crate::placeholder::parse_placeholder_map | (layout_or_master_xml:&str, theme:Option<&Theme>, media_rels:Option<&JsMap<String>>) -> PlaceholderMap | Map<string,string> arrives as JsMap |
| parseDefRPrStyle | placeholder | one-to-one | crate::placeholder::parse_def_r_pr_style | (def_r_pr_raw:Option<&Value>, theme:Option<&Theme>, ph_clr:Option<&str>) -> Option<LevelTextStyle> | |
| parseLstStyleLevels | placeholder | other | crate::placeholder::parse_lst_style_levels | (lst:Option<&Value>, theme:Option<&Theme>, src:Option<&LstStyleSource<'_>>) -> Option<TextStyleLevels> | LstStyleSource<'_> borrowed struct (media_rels ref + foreign_part flag) |
| parseDefaultTextStyle | placeholder | one-to-one | crate::placeholder::parse_default_text_style | (presentation_xml:&str, theme:Option<&Theme>) -> Option<TextStyleLevels> | |
| parseMasterTextStyles | placeholder | one-to-one | crate::placeholder::parse_master_text_styles | (master_xml:&str, theme:Option<&Theme>, media_rels:Option<&JsMap<String>>) -> MasterTextStyles | |
| resolvePlaceholderInsets | placeholder | one-to-one | crate::placeholder::resolve_placeholder_insets | (layout:Option<&PlaceholderMap>, master:Option<&PlaceholderMap>, r#type:Option<&str>, idx:Option<&str>) -> Option<PlaceholderInsets> | |
| resolvePlaceholderAnchor | placeholder | one-to-one | crate::placeholder::resolve_placeholder_anchor | (layout:Option<&PlaceholderMap>, master:Option<&PlaceholderMap>, r#type:Option<&str>, idx:Option<&str>) -> Option<PlaceholderAnchor> | |
| resolvePlaceholderAnchorCtr | placeholder | one-to-one | crate::placeholder::resolve_placeholder_anchor_ctr | (layout:Option<&PlaceholderMap>, master:Option<&PlaceholderMap>, r#type:Option<&str>, idx:Option<&str>) -> Option<bool> | |
| placeholderStyleChain | placeholder | one-to-one | crate::placeholder::placeholder_style_chain | (layout:Option<&PlaceholderMap>, master:Option<&PlaceholderMap>, master_tx:Option<&MasterTextStyles>, r#type:Option<&str>, idx:Option<&str>) -> Vec<TextStyleLevels> | |
| mergeTextStyleChain | placeholder | one-to-one | crate::placeholder::merge_text_style_chain | (chain:&[Option<TextStyleLevels>], level:f64) -> Option<LevelTextStyle> | |
| resolvePlaceholderFillSpPr | placeholder | other | crate::placeholder::resolve_placeholder_fill_sp_pr | <'a>(layout:Option<&'a PlaceholderMap>, master:Option<&'a PlaceholderMap>, r#type:Option<&str>, idx:Option<&str>) -> Option<PlaceholderFill<'a>> | return PlaceholderFill<'a> borrows the maps (TS {spPr, layer} holds the node by reference); serialize it |
| resolvePlaceholderTransform | placeholder | one-to-one | crate::placeholder::resolve_placeholder_transform | (layout:Option<&PlaceholderMap>, master:Option<&PlaceholderMap>, r#type:Option<&str>, idx:Option<&str>) -> Option<Transform> | |
| resolvePlaceholderPresetGeom | placeholder | other | crate::placeholder::resolve_placeholder_preset_geom | <'a>(layout:Option<&'a PlaceholderMap>, master:Option<&'a PlaceholderMap>, r#type:Option<&str>, idx:Option<&str>) -> Option<&'a PresetGeom> | return borrows the maps (TS returns the object inside layout/master); serialize it |
| isPresetShapeType | preset-shape-types | one-to-one | crate::preset_shape_types::is_preset_shape_type | (name:&str) -> bool | |
| redactExtXml | redaction-xml | one-to-one | crate::redaction_xml::redact_ext_xml | (label:&str) -> String | |
| hasRedactExtIn | redaction-xml | one-to-one | crate::redaction_xml::has_redact_ext_in | (xml:&str) -> Result<bool,String> | |
| syncRedactExt | redaction-xml | one-to-one | crate::redaction_xml::sync_redact_ext | (xml:&str, tag:&str, label:Option<&str>) -> Result<String,String> | |
| readRedactLabel | redaction-xml | one-to-one | crate::redaction_xml::read_redact_label | (node:Option<&Value>) -> Option<&str> | |
| stripRedactExt | redaction-xml | one-to-one | crate::redaction_xml::strip_redact_ext | (xml:&str) -> Result<String,String> | |
| setRedactExt | redaction-xml | one-to-one | crate::redaction_xml::set_redact_ext | (props_xml:&str, label:&str) -> Result<String,String> | |
| cleanupSupersededSlideResources | resource-cleanup | slide-index | crate::resource_cleanup::cleanup_superseded_slide_resources | (opened:&mut OpenedPptx, slide_index:usize, previous_xml:&str, current_xml:&str) -> Result<ResourceCleanupStats,String> | TS (opened:ResourceCleanupContext, slide): slide -> slide_index; Rust wants the whole OpenedPptx where TS passed a context subset |
| cleanupDeletedElementResources | resource-cleanup | slide-index | crate::resource_cleanup::cleanup_deleted_element_resources | (opened:&mut OpenedPptx, slide_index:usize, removed_element_xml:&str) -> Result<ResourceCleanupStats,String> | slide -> slide_index; context as above |
| removeRelationshipAndCollectOwnedTarget | resource-cleanup | one-to-one | crate::resource_cleanup::remove_relationship_and_collect_owned_target | (archive:&mut PackageArchive, source_part:&str, relationship_id:&str) -> Result<ResourceCleanupStats,String> | &mut PackageArchive written back |
| removePartWithOwnedResources | resource-cleanup | one-to-one | crate::resource_cleanup::remove_part_with_owned_resources | (archive:&mut PackageArchive, part_path:&str) -> Result<ResourceCleanupStats,String> | &mut PackageArchive written back |
| scanSlide | scan | other | crate::scan::scan_slide | (slide_xml:&str) -> Result<SlideScan<'_>,ScanError<'_>> | result SlideScan<'_> borrows the input string (offsets/slices); error is ScanError<'_>, not String |
| getSections | sections | extra-rust-param | crate::sections::get_sections | (opened:&OpenedPptx, uuid:&mut dyn FnMut()->String) -> Result<Vec<SectionInfo>,String> | uuid source (crypto.randomUUID) supplied by caller; shared borrow of opened |
| setSections | sections | extra-rust-param | crate::sections::set_sections | (opened:&mut OpenedPptx, sections:&[SectionInfo], uuid:&mut dyn FnMut()->String) -> Result<(),String> | uuid source |
| normalizeSections | sections | one-to-one | crate::sections::normalize_sections | (sections:&[SectionInfo], total:usize) -> NormalizedSections | |
| addSection | sections | extra-rust-param | crate::sections::add_section | (opened:&mut OpenedPptx, at_slide_index:f64, name:&str, uuid:&mut dyn FnMut()->String) -> Result<Option<Vec<SectionInfo>>,String> | uuid source |
| renameSection | sections | extra-rust-param | crate::sections::rename_section | (opened:&mut OpenedPptx, id:&str, name:&str, uuid:&mut dyn FnMut()->String) -> Result<Option<Vec<SectionInfo>>,String> | uuid source |
| removeSection | sections | extra-rust-param | crate::sections::remove_section | (opened:&mut OpenedPptx, id:&str, _opts:Option<&RemoveSectionOptions>, uuid:&mut dyn FnMut()->String) -> Result<Option<Vec<SectionInfo>>,String> | uuid source |
| moveSlide | sections | extra-rust-param | crate::sections::move_slide | (opened:&mut OpenedPptx, from_index:f64, to_index:f64, uuid:&mut dyn FnMut()->String) -> Result<bool,String> | uuid source |
| moveSection | sections | extra-rust-param | crate::sections::move_section | (opened:&mut OpenedPptx, id:&str, dir:SectionDirection, uuid:&mut dyn FnMut()->String) -> Result<Option<Vec<SectionInfo>>,String> | uuid source |
| nextSlideId | slide-ids | other | crate::slide_ids::next_slide_id | (pres_xml:&str) -> Result<u32,SlideIdSpaceExhausted> | error type SlideIdSpaceExhausted, not String (TS throws) |
| canListSlide | slide-ids | one-to-one | crate::slide_ids::can_list_slide | (pres_xml:Option<&str>) -> bool | |
| withSlideListed | slide-ids | other | crate::slide_ids::with_slide_listed | (pres_xml:&str, rid:&str, after_rid:Option<&str>) -> Result<Option<String>,SlideIdSpaceExhausted> | error type SlideIdSpaceExhausted, not String |
| withSlideUnlisted | slide-ids | one-to-one | crate::slide_ids::with_slide_unlisted | (pres_xml:&str, rid:&str) -> Option<String> | |
| collectPart | slide-transfer | one-to-one | crate::slide_transfer::collect_part | (archive:&PackageArchive, part_path:&str, parts:&mut JsObject<String>, content_types:&mut JsObject<String>) -> Result<(),String> | parts and content_types are &mut and written back (TS mutates the Records); archive read only |
| collectSlideBundle | slide-transfer | one-to-one | crate::slide_transfer::collect_slide_bundle | (archive:&PackageArchive, slide_path:&str, slide_xml:&str) -> Result<SlideBundle,String> | |
| listLayouts | slide-transfer | one-to-one | crate::slide_transfer::list_layouts | (archive:&PackageArchive) -> Vec<LayoutRef> | |
| importClipboardParts | slide-transfer | one-to-one | crate::slide_transfer::import_clipboard_parts | (archive:&mut PackageArchive, parts:&JsObject<String>, content_types:&JsObject<String>) -> Result<JsMap<String>,String> | returns Map<string,string> (Map shape); &mut PackageArchive written back |
| materializeSlideBundle | slide-transfer | one-to-one | crate::slide_transfer::materialize_slide_bundle | (archive:&mut PackageArchive, bundle:&SlideBundle, slide_path:&str, layout_path:&str) -> Result<String,String> | |
| importSourceLayout | slide-transfer | one-to-one | crate::slide_transfer::import_source_layout | (archive:&mut PackageArchive, bundle:&SlideBundle) -> Result<Option<String>,String> | |
| chooseLayout | slide-transfer | one-to-one | crate::slide_transfer::choose_layout | (archive:&PackageArchive, bundle:&SlideBundle, neighbour_slide_path:Option<&str>) -> Result<Option<String>,String> | |
| layoutShapes | smartart-layout | one-to-one | crate::smartart_layout::layout_shapes | (layout:&str, items:&[String], cx:f64, cy:f64) -> Vec<SmartArtChildShape> | TS layout:SmartArtLayout = string union |
| buildSmartArtXml | smartart | extra-rust-param | crate::smartart::build_smart_art_xml | (slide:&Slide, opts:&NewSmartArtOptions, uuid:&str) -> String | uuid |
| addSmartArt | smartart | return-alias | crate::smartart::add_smart_art | (opened:&mut OpenedPptx, slide_index:usize, opts:&NewSmartArtOptions, uuid:&str) -> Result<Option<SmartArtAdded>,String> | TS {slide, elementId} or null; Rust Some(SmartArtAdded{element_id:Option<String>}); slide = opened.deck.slides[slide_index]; also: extra-rust-param uuid |
| ensureTableStyleXml | table-edit | one-to-one | crate::table_edit::ensure_table_style_xml | (table_styles_xml:Option<&str>, style_id:&str, style_def_xml:&str) -> String | |
| patchTableStyleXml | table-edit | one-to-one | crate::table_edit::patch_table_style_xml | (original_xml:&str, edit:&TableStyleEdit) -> String | |
| findTableElementInSlide | table-edit | return-alias | crate::table_edit::find_table_element_in_slide | <'a>(slide:&'a Slide, source_id:&str) -> Option<&'a SlideElement> | TS returns the TableElement object inside slide.elements; Rust returns a borrow: find it again by id after the call |
| tableRowGridCols | table-grid | one-to-one | crate::table_grid::table_row_grid_cols | (row:&[GridCell]) -> Vec<f64> | |
| builtinTableStyleName | table-style | one-to-one | crate::table_style::builtin_table_style_name | (style_id:Option<&str>) -> Option<String> | |
| resolveBuiltinTableStyleId | table-style | one-to-one | crate::table_style::resolve_builtin_table_style_id | (name_or_id:&str) -> Option<&'static str> | |
| resolveTableStyle | table-style | one-to-one | crate::table_style::resolve_table_style | (style_id:Option<&str>, table_styles_xml:Option<&str>, theme:Option<&Theme>) -> Option<TableStyleDef> | |
| cellStyleBorders | table-style | one-to-one | crate::table_style::cell_style_borders | (def:&TableStyleDef, flags:&TableStyleFlags, r:f64, c:f64, n_rows:f64, n_cols:f64) -> CellStyleBorders | |
| cellPartStyle | table-style | one-to-one | crate::table_style::cell_part_style | (def:&TableStyleDef, flags:&TableStyleFlags, r:f64, c:f64, n_rows:f64, n_cols:f64) -> TablePartStyle | |
| patchThemeXml | theme-apply | one-to-one | crate::theme_apply::patch_theme_xml | (xml:&str, spec:&ThemeSpec) -> String | |
| applyThemeToArchive | theme-apply | other | crate::theme_apply::apply_theme_to_archive | (archive:&mut PackageArchive, spec:&ThemeSpec) -> usize | TS takes opened; Rust takes opened.archive (argument grouping); &mut PackageArchive written back |
| collectExplicitColors | theme-apply | one-to-one | crate::theme_apply::collect_explicit_colors | (xmls:&[impl AsRef<str>]) -> JsMap<JsNum> | generic slice (use &[String]); returns Map<string,number> (Map shape) |
| buildColorMap | theme-apply | one-to-one | crate::theme_apply::build_color_map | (counts:&JsMap<JsNum>, spec:&ThemeSpec) -> JsMap<String> | Map in and out (Map shape) |
| recolorXml | theme-apply | one-to-one | crate::theme_apply::recolor_xml | (xml:&str, map:&JsMap<String>) -> String | Map in (Map shape) |
| remapDeckColors | theme-apply | other | crate::theme_apply::remap_deck_colors | (archive:&mut PackageArchive, deck:&Deck, spec:&ThemeSpec) -> usize | TS takes opened; Rust splits it into opened.archive (&mut) + opened.deck (&): argument grouping; only the archive is written back |
| sysColorHex | theme | one-to-one | crate::theme::sys_color_hex | (val:Option<&Value>, last_clr:Option<&Value>) -> String | |
| parseTheme | theme | one-to-one | crate::theme::parse_theme | (theme_xml:&str) -> Result<Theme,String> | |
| themeWithOverride | theme | one-to-one | crate::theme::theme_with_override | (base:Option<&Theme>, override_xml:&str) -> Result<Theme,String> | |
| eaScriptOfLang | theme | one-to-one | crate::theme::ea_script_of_lang | (tag:Option<&Value>) -> Option<EaScript> | |
| resolveFontRef | theme | one-to-one | crate::theme::resolve_font_ref | <'a>(typeface:Option<&'a str>, theme:Option<&'a Theme>, ea_script:Option<EaScript>) -> Option<&'a str> | lifetime-generic only (result is an owned string on the wire) |
| resolveSchemeColor | theme | one-to-one | crate::theme::resolve_scheme_color | <'a>(name:&'a str, theme:Option<&'a Theme>, ph_clr:Option<&'a str>) -> Option<&'a str> | lifetime-generic only |
| parseClrMap | theme | one-to-one | crate::theme::parse_clr_map | (master_xml:Option<&str>, layout_xml:Option<&str>, slide_xml:Option<&str>) -> Option<JsObject<String>> | |
| xmlParser | xml-parser | other | crate::xml_utils::xml_parse_object | (xml:&str, options:&ooxml_xml::ObjectOptions<'_>) -> Result<Value,ooxml_xml::ParseError> | TS returns an XMLParser object (caller then .parse(xml)); Rust parses directly and takes the options of the parse; error type ParseError; stream-C name exception; internal only, a hand route if exposed |
| asXmlNode | xml-utils | one-to-one | crate::xml_utils::as_xml_node | (v:Option<&Value>) -> &Value | |
| xmlArray | xml-utils | other | crate::xml_utils::xml_array | (v:Option<&Value>) -> impl Iterator<Item=&Value> | returns a borrowed iterator, TS returns XmlNode[]; row must collect |
| decodeXml | xml-utils | one-to-one | crate::xml_utils::decode_xml | (raw:&str) -> String | |
| attributeOf | xml-utils | one-to-one | crate::xml_utils::attribute_of | (element:&str, name:&str) -> Option<String> | |
| rootPrefixOf | xml-utils | one-to-one | crate::xml_utils::root_prefix_of | (xml:&str, ns:&str) -> Result<Option<String>,String> | |
| elementRange | xml-utils | one-to-one | crate::xml_utils::element_range | (xml:&str, name:&str, from:usize) -> Result<Option<ElementRange>,String> | |
| cSldNameOf | xml-utils | one-to-one | crate::xml_utils::c_sld_name_of | (part_xml:&str) -> Option<String> | |
| withRelationshipIds | xml-utils | one-to-one | crate::xml_utils::with_relationship_ids | (xml:&str, names:&[&str], ids:&JsMap<String>) -> String | ReadonlyMap in (Map shape) |
| percentFraction | xml-utils | one-to-one | crate::xml_utils::percent_fraction | (raw:Option<&Value>) -> Option<f64> | |
| escapeXmlText | xml-utils | one-to-one | crate::xml_utils::escape_xml_text | (text:&str) -> String | |
| escapeXmlAttr | xml-utils | one-to-one | crate::xml_utils::escape_xml_attr | (text:&str) -> String | |
| maxRelationshipIdNumber | xml-utils | one-to-one | crate::xml_utils::max_relationship_id_number | (rels_xml:&str) -> f64 | |
| hasContentTypeOverride | xml-utils | one-to-one | crate::xml_utils::has_content_type_override | (content_types:&str, part_path:&str) -> bool | |
| creationIdExtXml | xml-utils | extra-rust-param | crate::xml_utils::creation_id_ext_xml | (uuid:&str) -> String | uuid = crypto.randomUUID (TS has no params) |
| creationIdXml | xml-utils | extra-rust-param | crate::xml_utils::creation_id_xml | (uuid:&str) -> String | uuid |
| defaultContentTypeFor | xml-utils | one-to-one | crate::xml_utils::default_content_type_for | (ct:&str, ext:&str) -> Option<String> | |
| hasDefaultFor | xml-utils | one-to-one | crate::xml_utils::has_default_for | (ct:&str, ext:&str) -> bool | |
| assertZipWithinLimits | zip | other | crate::zip::assert_zip_within_limits | (files:&[DeclaredPart<'_>]) -> Result<(),String> | TS takes a JSZip; Rust takes the declared parts (Object.values(zip.files) order) as borrowed DeclaredPart<'_> |
| relsPathFor | zip | one-to-one | crate::zip::rels_path_for | (part_path:&str) -> String | |
| resolveTarget | zip | one-to-one | crate::zip::resolve_target | (base_part:&str, target:&str) -> String | |

## Rust params that are `&mut` (written back), by type

- `&mut OpenedPptx` (opened): reparseDeck, savePptx, commitSaved, copySlide, duplicateSlide, pasteSlide, insertBlankSlide, mergeSlideFromPptx (target), mergeSlideFromSource (target), insertSlideWithLayout, deleteSlide, materializeSlide, setSlideLayout, resetSlideLayout, setSlideSize, appendRawElements, addTable, ensureTableStylePart, editChartElement, editTableStructure, mergeTableCells, copyElementData, pasteElements, groupElements, ungroupElement, setSlideBackground, setSlideBackgroundImage, resetSlideBackground, setSlideBgGraphicsHidden, setElementFill, setElementImageFill, replacePictureBytes, writeChartWorkbook, addChart, addSlideComment, deleteSlideComment, applyHeaderFooter, setElementLink, ensureRunLinkRels, addImageMediaAndRel, addPicture, deleteElement, ensureDefaultContentType, addMedia, addModel3d, setModel3dView, addNarration, clearNarration, setShowNarration, setSlideNotes, cleanupSupersededSlideResources, cleanupDeletedElementResources, addSmartArt, setSections, addSection, renameSection, removeSection, moveSlide, moveSection. (getSections, getRunLinks, getElementLink, getSlideLinks take `&OpenedPptx`: nothing written back.)
- `&mut Slide` (slide): patchSlideXml, setSlideAnimations, pruneTimingForSpids, promoteSlideBackground, addElement, editPictureSrcRect, setShapePresetGeometry, setShapeCustomGeometry, setShapeAdjustValues, setElementTextAnchor, autofitGeneratedTextBoxes, setElementTextBodyProps, setElementEffects, setElementRedaction, setPictureOpacity, reorderElement, updateConnectorsForMoved, setElementConnection, editTableCellText, editTableStyle, markChartEditable, setElementHidden, setElementName, setElementFont, setElementParagraphFormat, setGroupChildParagraphFormat, setTableColWidth, setTableRowHeight, resizeTable, setTableCellAnchor, setSlideTransition, setSlideAdvanceTime, setSlideHidden, editGroupChildTransform, patchGroupChildText, setGroupChildFont, editGroupChildFill, editGroupChildStroke, setGroupChildShapeAdjustValues, setGroupChildShapePresetGeometry, setGroupChildShapeCustomGeometry.
- `&mut PackageArchive` (archive): ensureBuiltinLayout, stripEmbeddedFonts, stripStaleEmbeddedFonts, prepareInsertSlideWithLayout, addContentTypeOverride, appendRelationship, removeRelationshipAndCollectOwnedTarget, removePartWithOwnedResources, importClipboardParts, materializeSlideBundle, importSourceLayout, applyThemeToArchive, remapDeckColors.
- `&mut SlideDeck`: replaceAllInDeck.
- `&mut SlideElement`: patchedElementXml, ensureCreationId.
- `&mut GroupElement`: patchGroupChildXml (grp).
- `&mut [Paragraph]`: ensureRunLinkRels (paragraphs), applyParagraphFormat (paragraphs).
- `&mut JsObject<String>`: collectPart (parts, content_types).
- `&mut JsMap<V>`: setOwn (record).
- not written back (closures, not data): `uuid:&mut dyn FnMut()->String` in the 6 mutating sections exports plus getSections; `next_uuid:impl FnMut` in withFreshCreationIds.

## Exports with no Rust port

- savePptxToFile (index): no file system in the engine; use `crate::deck::save_pptx` and write the bytes in host code.
- Everything else (321 of 322) has a port.
