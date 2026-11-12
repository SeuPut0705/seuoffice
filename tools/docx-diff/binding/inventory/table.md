
#### font-table

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| deobfuscateOdttf | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | bytes |
| isSfnt | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | bytes |
| parseFontTable | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | json |
| readEmbeddedFonts | async | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | JSZip |
| sfntLineMetrics | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | bytes |

#### parse-xml-text

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| decodeEntities | sync | docx-engine/src/sources.rs | call props.decodeEntities | json |

#### checkbox-control

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| sdtCheckboxGlyphs | sync | docx-engine/src/checkbox_control.rs | call checkbox.sdtCheckboxGlyphs | json |
| sdtCheckboxIsChecked | sync | docx-engine/src/checkbox_control.rs | call checkbox.sdtCheckboxIsChecked | json |

#### inline-opaque

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| inlineWrapContentLocked | sync | docx-engine/src/inline_opaque.rs | call parse.inlineWrapContentLocked | json |
| runCopiedElsewhere | sync | docx-engine/src/inline_opaque.rs | call parse.runCopiedElsewhere | json |
| sameInlineWrap | sync | docx-engine/src/inline_opaque.rs | call parse.sameInlineWrap | json |
| sameInlineWrapChain | sync | docx-engine/src/inline_opaque.rs | call parse.sameInlineWrapChain | json |

#### content-control

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| buildContentControlXml | sync | docx-engine/src/save/features/content_control.rs | call save.buildContentControlXml | json |
| isContentControlLock | sync | docx-engine/src/save/features/content_control.rs | call save.isContentControlLock | json |
| nextContentControlId | sync | docx-engine/src/save/features/content_control.rs | call save.nextContentControlId | json |

#### parse

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| parseDocx | async | docx-engine/src/parse/entry.rs | blob ParseDocx (+options, pending, extras: extend) | bytes, whole-model |
| reconcileGridColumns | sync | docx-engine/src/parse/tables.rs | call parse.reconcileGridColumns | json |

#### parse-styles

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| paraCsFormat | sync | docx-engine/src/styles/mod.rs | **NEW call route** (Rust port exists) | json |
| styleRunFormat | sync | docx-engine/src/styles/mod.rs | **NEW call route** (Rust port exists) | json |

#### mail-merge

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| compareOperands | sync | docx-engine/src/save/features/mail_merge.rs | call save.compareOperands | json |
| conditionHolds | sync | docx-engine/src/save/features/mail_merge.rs | call save.conditionHolds | json |
| controlEffect | sync | docx-engine/src/save/features/mail_merge.rs | call save.controlEffect | json |
| ifBranch | sync | docx-engine/src/save/features/mail_merge.rs | call save.ifBranch | json |
| mergeBlockTree | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeBlockTree | Block[] |
| mergeDataFromRows | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeDataFromRows | json |
| mergeFieldInstruction | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldInstruction | json |
| mergeFieldName | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldName | json |
| mergeFieldSwitches | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldSwitches | json |
| mergeFieldText | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldText | json |
| mergeOutputFileName | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeOutputFileName | json |
| mergeRecords | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeRecords | Block[] |
| placeholderText | sync | docx-engine/src/save/features/mail_merge.rs | call save.placeholderText | json |
| splitInstruction | sync | docx-engine/src/save/features/mail_merge.rs | call save.splitInstruction | json |
| valueOf | sync | docx-engine/src/save/features/mail_merge.rs | call save.valueOf | json |

#### zip-gate/src/index

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| assertZipInflatesWithinLimits | async | ooxml-pkg/src/gate.rs | **NEW call route** (Rust port exists) | bytes |

#### zip-load

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| assertZipWithinLimits | sync | pptx-engine/src/zip.rs | call pptxPackage.assertZipWithinLimits | JSZip |

#### lazy-media

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| isLazyMediaPart | sync | docx-engine/src/lazy_media.rs | **NEW call route** (Rust port exists) | json |
| lazyMediaUrl | sync | docx-engine/src/lazy_media.rs | **NEW call route** (Rust port exists) | json |
| parseLazyMediaUrl | sync | docx-engine/src/lazy_media.rs | call save.parseLazyMediaUrl | json |

#### alt-chunk

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| setAltChunkHtmlConverter | sync | (host hook; no Rust fn) | host hook | json |

#### parse-fields

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| tocLevelOf | sync | docx-engine/src/fields.rs | call fields.tocLevelOf | Map |

#### parse-props

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| mergeStyleBorders | sync | docx-engine/src/props/borders.rs | call props.mergeStyleBorders | json |
| themeLangEaSlotFont | sync | docx-engine/src/props/fonts.rs | call props.themeLangEaSlotFont | json |

#### doc-properties

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyPropertyChanges | async | docx-engine/src/save/features/doc_properties_write.rs | call save.applyPropertyChanges | JSZip |
| emptyDocumentProperties | sync | NONE (build in TS: all-empty record) | call docprops.emptyDocumentProperties | json |
| newDocumentAppPropertiesXml | sync | docx-engine/src/blank.rs | **NEW call route** (Rust port exists) | json |
| newDocumentCorePropertiesXml | sync | docx-engine/src/blank.rs | **NEW call route** (Rust port exists) | Date |
| parseAppPropertiesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseAppPropertiesXml | json |
| parseCorePropertiesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseCorePropertiesXml | json |
| parseCustomPropertiesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseCustomPropertiesXml | json |
| parseCustomPropertyTypesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseCustomPropertyTypesXml | json |
| parsePropertyChanges | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.parsePropertyChanges | json |
| patchAppPropertiesXml | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.patchAppPropertiesXml | json |
| patchCorePropertiesXml | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.patchCorePropertiesXml | json |
| patchCustomPropertiesXml | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.patchCustomPropertiesXml | json |
| readDocumentProperties | async | docx-engine/src/doc_properties.rs | call docprops.readDocumentProperties | JSZip |
| w3cdtfStamp | sync | docx-engine/src/blank.rs | **NEW call route** (Rust port exists) | Date |

#### patch

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| saveDocx | async | docx-engine/src/save/save.rs | blob SaveDocx | bytes, whole-model, Block[] |
| findChartWorkbookPath | async | docx-engine/src/save/save/helpers.rs | **NEW call route** (Rust port exists) | bytes |
| missingHeadingLevels | sync | docx-engine/src/save/save/helpers.rs | call save.missingHeadingLevels | Map, Block[] |
| readDocxPartBase64 | async | docx-engine/src/save/save/helpers.rs | **NEW call route** (Rust port exists) | bytes |

#### remove-parts

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyRemoveParts | async | docx-engine/src/save/parts/remove_parts.rs | call save.applyRemoveParts | JSZip |
| planRemoveParts | async | docx-engine/src/save/parts/remove_parts.rs | call save.planRemoveParts | bytes |
| removePartsRefusalMessage | sync | docx-engine/src/save/parts/remove_parts.rs | call save.removePartsRefusalMessage | json |
| removePartsRefusalMessageFor | sync | docx-engine/src/save/parts/remove_parts.rs | call save.removePartsRefusalMessageFor | json |

#### generate

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyImageWrap | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyImageWrap | json |
| applyImageZOrder | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyImageZOrder | json |
| applyShapeWrapAt | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyShapeWrapAt | json |
| applyShapeZOrderAt | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyShapeZOrderAt | json |
| buildAnchoredTextboxParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildAnchoredTextboxParagraphXml | json |
| buildShapeParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildShapeParagraphXml | json |
| buildTextboxParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildTextboxParagraphXml | json |
| buildWordArtParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildWordArtParagraphXml | json |
| generateCaptionXml | sync | docx-engine/src/generate/fields.rs | call genFields.generateCaptionXml | json |
| generateIndexFieldXml | sync | docx-engine/src/generate/fields.rs | call genFields.generateIndexFieldXml | json |
| generateParagraphXml | sync | docx-engine/src/generate/paragraph.rs | call genParagraph.generateParagraphXml | callback |
| mergeRPrModel | sync | docx-engine/src/generate/rpr.rs | call genRpr.mergeRPrModel | json |
| generateTableModelXml | sync | docx-engine/src/generate/table.rs | call genTable.generateTableModelXml | class |
| generateTableXml | sync | docx-engine/src/generate/table.rs | call genTable.generateTableXml | json |
| generateTocFieldXml | sync | docx-engine/src/generate/fields.rs | call genFields.generateTocFieldXml | json |
| mergePPrFormat | sync | docx-engine/src/generate/props.rs | call genProps.mergePPrFormat | json |
| setPPrChange | sync | docx-engine/src/generate/props.rs | call genProps.setPPrChange | json |
| stripPPrChange | sync | docx-engine/src/generate/props.rs | call genProps.stripPPrChange | json |
| paraMarkRevisionXml | sync | docx-engine/src/generate/props.rs | call genProps.paraMarkRevisionXml | callback |
| setParaMarkRevision | sync | docx-engine/src/generate/props.rs | call genProps.setParaMarkRevision | json |
| stripParaMarkRevision | sync | docx-engine/src/generate/props.rs | call genProps.stripParaMarkRevision | json |
| resolveParaMarkRPrChange | sync | docx-engine/src/generate/props.rs | call genProps.resolveParaMarkRPrChange | json |
| paraMarkColor | sync | docx-engine/src/generate/props.rs | call genProps.paraMarkColor | json |
| stripParaMarkColor | sync | docx-engine/src/generate/props.rs | call genProps.stripParaMarkColor | json |
| patchFieldParagraphXml | sync | docx-engine/src/generate/text_patch.rs | call genText.patchFieldParagraphXml | json |
| patchImageParagraphXml | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchImageParagraphXml | json |
| patchMathTokens | sync | docx-engine/src/generate/text_patch.rs | call genText.patchMathTokens | json |
| patchTableCellTexts | sync | docx-engine/src/generate/text_patch.rs | call genText.patchTableCellTexts | class |
| patchTextboxHeights | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchTextboxHeights | json |
| patchTextboxParas | sync | docx-engine/src/generate/text_patch.rs | call genText.patchTextboxParas | json |
| patchTextboxSizes | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchTextboxSizes | json |
| patchShapeStyles | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchShapeStyles | json |
| patchDrawingExtent | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchDrawingExtent | json |
| buildLineParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildLineParagraphXml | json |
| inlinePictureDrawingXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.inlinePictureDrawingXml | json |
| resizeInlinePictureXml | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.resizeInlinePictureXml | json |

#### chart

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| buildChartPartXml | sync | docx-engine/src/save/features/chart_write.rs | call save.buildChartPartXml | json |
| buildChartWorkbookXlsxBase64 | async | docx-engine/src/save/features/chart_write.rs | call save.buildChartWorkbookXlsxBase64 | json |
| patchChartWorkbookXlsxBase64 | async | docx-engine/src/save/features/chart_write.rs | call save.patchChartWorkbookXlsxBase64 | json |
| parseChartPartXml | sync | docx-engine/src/chart.rs | call chart.parseChartPartXml | json |
| patchChartPartXml | sync | docx-engine/src/save/features/chart_write.rs | call save.patchChartPartXml | json |
| lumHex | sync | docx-engine/src/chart.rs | call chart.lumHex | json |

#### math

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| latexToOmml | sync | omml/src/latex_to_omml.rs | call math.latexToOmml | json |
| mathParagraphXml | sync | omml/src/latex_to_omml.rs | call math.mathParagraphXml | json |
| mathTokensOf | sync | omml/src/fragments.rs | call math.mathTokensOf | json |
| ommlFragmentsOf | sync | omml/src/fragments.rs | call math.ommlFragmentsOf | json |
| ommlToLatex | sync | omml/src/omml_to_latex.rs | call math.ommlToLatex | json |
| ommlToMathML | sync | omml/omml_to_mathml | call math.ommlToMathML | json |

#### run-picture

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| patchHfPicturesXml | sync | docx-engine/src/save/save/run_picture.rs | call save.patchHfPicturesXml | json |
| patchRunPictureXml | sync | docx-engine/src/save/save/run_picture.rs | call save.patchRunPictureXml | json |

#### scan

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| scanBody | sync | docx-engine/src/scan.rs | blob ScanBody | json |

#### blank

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| buildBlankDocx | async | docx-engine/src/blank.rs | call blank.buildBlankDocx | bytes |
| customLevelFromNumberingLevel | sync | docx-engine/src/blank.rs | call blank.customLevelFromNumberingLevel | json |
| customLevelXml | sync | docx-engine/src/blank.rs | call blank.customLevelXml | json |
| mergeLevelXml | sync | docx-engine/src/blank.rs | call blank.mergeLevelXml | json |
| numberingLevelFromCustom | sync | docx-engine/src/blank.rs | call blank.numberingLevelFromCustom | json |
| paperSizeForLocale | sync | docx-engine/src/blank.rs | call blank.paperSizeForLocale | json |
| paperSizeForRegion | sync | docx-engine/src/blank.rs | call blank.paperSizeForRegion | json |

#### section

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applySectionSettings | sync | docx-engine/src/save/save/section_write.rs | call save.applySectionSettings | json |
| applyPageNumType | sync | docx-engine/src/save/save/section_write.rs | call save.applyPageNumType | json |
| applySectionStartType | sync | docx-engine/src/save/save/section_write.rs | call save.applySectionStartType | json |
| applyTitlePg | sync | docx-engine/src/save/save/section_write.rs | call save.applyTitlePg | json |
| sectionFromSectPr | sync | docx-engine/src/section/read.rs | call section.sectionFromSectPr | json |
| readPageColor | sync | docx-engine/src/section/read.rs | call section.readPageColor | whole-model |
| readSections | sync | docx-engine/src/section/read.rs | call section.readSections | whole-model |
| readSectionSettings | sync | docx-engine/src/section/read.rs | call section.readSectionSettings | whole-model |
| sectionSettingsFromXml | sync | docx-engine/src/section/read.rs | call section.sectionSettingsFromXml | json |
| pageBordersXml | sync | docx-engine/src/save/save/section_write.rs | call save.pageBordersXml | json |
| notePropsFromXml | sync | docx-engine/src/section/read.rs | call section.notePropsFromXml | json |
| xmlFlagOn | sync | docx-engine/src/section.rs | call section.xmlFlagOn | json |

#### notes

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| nextNoteId | sync | docx-engine/src/notes.rs | call section.nextNoteId | json |
| parseNotesXml | sync | docx-engine/src/notes.rs | call section.parseNotesXml | json |

#### watermark

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| isPictureWatermark | sync | docx-engine/src/watermark.rs | call section.isPictureWatermark | json |
| pictureWatermarkPreviewImage | sync | docx-engine/src/watermark.rs | call section.pictureWatermarkPreviewImage | json |
| textWatermarkPreviewImage | sync | docx-engine/src/watermark.rs | call section.textWatermarkPreviewImage | json |
| textWatermarkBoxPt | sync | docx-engine/src/watermark.rs | call section.textWatermarkBoxPt | json |
| readPictureWatermark | sync | docx-engine/src/watermark.rs | call section.readPictureWatermark | json |
| readWatermarkText | sync | docx-engine/src/watermark.rs | call section.readWatermarkText | json |

#### style-upsert

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| builtInHeadingStyleUpsert | sync | docx-engine/src/save/parts/style_upsert.rs | call save.builtInHeadingStyleUpsert | json |
| mergeStyleXml | sync | docx-engine/src/save/parts/style_upsert.rs | call save.mergeStyleXml | json |
| mergeDefaultFontsXml | sync | docx-engine/src/save/parts/style_upsert.rs | call save.mergeDefaultFontsXml | json |
| pendingHeadingLevel | sync | docx-engine/src/save/parts/style_upsert.rs | call save.pendingHeadingLevel | Map, callback |

#### ink

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| anchoredInkRunXml | sync | docx-engine/src/ink.rs | call ink.anchoredInkRunXml | json |
| findInkRuns | sync | docx-engine/src/ink.rs | call ink.findInkRuns | json |
| injectInkRunsIntoParagraph | sync | docx-engine/src/ink.rs | call ink.injectInkRunsIntoParagraph | json |
| stripInkRuns | sync | docx-engine/src/ink.rs | call ink.stripInkRuns | json |

#### xml-number

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| usableNumber | sync | docx-engine/src/save/save/xml_number_usable.rs | call save.usableNumber | json |
| usablePictureSize | sync | docx-engine/src/save/save/xml_number_usable.rs | call save.usablePictureSize | json |
| usablePositionOffset | sync | docx-engine/src/save/save/xml_number_usable.rs | call save.usablePositionOffset | json |

#### xml-tag

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| removeElements | sync | docx-engine/src/xml_tag.rs | call xmltag.removeElements | json |

#### sources

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| bibliographyLine | sync | docx-engine/src/sources.rs | call docprops.bibliographyLine | json |
| citationText | sync | docx-engine/src/sources.rs | call docprops.citationText | json |
| parseSourcesXml | sync | docx-engine/src/sources.rs | call docprops.parseSourcesXml | json |

#### zotero-doc-props

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| parseZoteroDocumentDataXml | sync | docx-engine/src/doc_properties/zotero.rs | call docprops.parseZoteroDocumentDataXml | json |
| patchZoteroDocumentDataXml | sync | docx-engine/src/save/features/zotero_doc_props.rs | call save.patchZoteroDocumentDataXml | json |

#### theme

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| readThemeColors | sync | docx-engine/src/theme.rs | **NEW call route** (Rust port exists) | json |
| readThemeFonts | sync | docx-engine/src/theme.rs | **NEW call route** (Rust port exists) | json |

#### protection

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| hashProtectionPassword | async | docx-engine/src/protection.rs | call docprops.hashProtectionPassword | json |
| resolveSpinCount | sync | docx-engine/src/protection.rs | call docprops.resolveSpinCount | json |
| verifyProtectionPassword | async | docx-engine/src/protection.rs | call docprops.verifyProtectionPassword | json |

#### symbol-fonts

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| decodeSymbolChar | sync | docx-engine/src/symbol_fonts.rs | call markers.decodeSymbolChar | json |
| decodeSymbolText | sync | docx-engine/src/symbol_fonts.rs | call markers.decodeSymbolText | json |
| isSymbolFont | sync | docx-engine/src/symbol_fonts.rs | call markers.isSymbolFont | json |
| symbolGlyph | sync | docx-engine/src/symbol_fonts.rs | call markers.symbolGlyph | json |
| symbolPuaChar | sync | docx-engine/src/symbol_fonts.rs | call markers.symbolPuaChar | json |
| toSymbolPua | sync | docx-engine/src/symbol_fonts.rs | call markers.toSymbolPua | json |

#### list-markers

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| substituteBullet | sync | docx-engine/src/list_markers.rs | call markers.substituteBullet | json |
| markerFallbackFace | sync | docx-engine/src/list_markers.rs | call markers.markerFallbackFace | json |
| computeListMarkerInfos | sync | docx-engine/src/list_markers.rs | call markers.computeListMarkerInfos | Map |
| computeListMarkers | sync | docx-engine/src/list_markers.rs | **NEW call route** (Rust port exists) | Map |
| computeListValues | sync | docx-engine/src/list_markers.rs | call markers.computeListValues | Map |
| customEnumItems | sync | docx-engine/src/list_markers.rs | call markers.customEnumItems | json |
| formatNumber | sync | docx-engine/src/list_markers.rs | call markers.formatNumber | json |
| markerTabAdvance | sync | docx-engine/src/list_markers.rs | call markers.markerTabAdvance | json |

#### font-settings

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| previewFontSettings | async | docx-engine/src/save/features/index_exports.rs | **NEW call route** (Rust port exists) | Map, whole-model |

#### revision-xml

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyRevisionResolutions | sync | docx-engine/src/revision_xml.rs | call revision.applyRevisionResolutions | json |
| applyTrackedChangesXml | sync | docx-engine/src/revision_xml.rs | call revision.applyTrackedChangesXml | json |
| cleanMoveRangeMarkers | sync | docx-engine/src/revision_xml.rs | call revision.cleanMoveRangeMarkers | json |
| countTrackedChangesXml | sync | docx-engine/src/revision_xml.rs | call revision.countTrackedChangesXml | json |
| readPropChangeXml | sync | docx-engine/src/revision_xml.rs | call revision.readPropChangeXml | json |
| revisionDateBefore | sync | docx-engine/src/save/features/index_exports.rs | call save.revisionDateBefore | json |
| revisionDateMs | sync | docx-engine/src/revision_xml.rs | **NEW call route** (Rust port exists) | json |
| resolvePropChangeXml | sync | docx-engine/src/generate/table.rs | call revision.resolvePropChangeXml | json |

#### resolve-props

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| resolveParagraphProps | sync | docx-engine/src/resolve.rs | call resolve.resolveParagraphProps | XNode |
| resolveCtxOf | sync | docx-engine/src/resolve.rs | call resolve.resolveCtxOf | Map |
| resolveParagraphPropsXml | sync | docx-engine/src/resolve.rs | call resolve.resolveParagraphPropsXml | json |
| resolveRunProps | sync | docx-engine/src/resolve.rs | call resolve.resolveRunProps | XNode |
| shadowCompare | sync | docx-engine/src/resolve.rs | call resolve.shadowCompare | json |

#### compare

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| compareBlocks | sync | docx-engine/src/save/features/compare.rs | call save.compareBlocks | whole-model, Block[] |
| compareDocuments | async | docx-engine/src/save/features/compare.rs | blob CompareDocuments | whole-model |

#### parse-block-passes

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| keepsHangulKanaSingle | sync | docx-engine/src/block_passes.rs | **NEW call route** (Rust port exists) | json |

#### char-class

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| charClass | sync | docx-engine/src/char_class.rs | call charclass.charClass | json |
| isCjkLetterChar | sync | docx-engine/src/char_class.rs | call charclass.isCjkLetterChar | json |
| isDoubleByteChar | sync | docx-engine/src/char_class.rs | call charclass.isDoubleByteChar | json |
| isEastAsianChar | sync | docx-engine/src/char_class.rs | call charclass.isEastAsianChar | json |
| isEastAsianLangTag | sync | docx-engine/src/char_class.rs | call charclass.isEastAsianLangTag | json |
| isHangulChar | sync | docx-engine/src/char_class.rs | call charclass.isHangulChar | json |
| isLatinAlnumChar | sync | docx-engine/src/char_class.rs | call charclass.isLatinAlnumChar | json |
| textHasEastAsian | sync | docx-engine/src/char_class.rs | call charclass.textHasEastAsian | json |
| textHasHangulChars | sync | docx-engine/src/char_class.rs | call charclass.textHasHangulChars | json |

#### consts (35)

| const | Rust | binding |
|---|---|---|
| REDACT_EL | docx-engine/src/save/save/body.rs | TS literal kept; generated parity check |
| REDACT_NS | docx-engine/src/save/save/body.rs | TS literal kept; generated parity check |
| REDACT_PREFIX | docx-engine/src/save/save/body.rs | TS literal kept; generated parity check |
| CONTENT_CONTROL_LOCKS | docx-engine/src/save/features/content_control.rs | TS literal kept; generated parity check |
| DOCX_ZIP_LIMITS | NONE | TS literal kept; generated parity check |
| LAZY_MEDIA_SCHEME | docx-engine/src/lazy_media.rs | TS literal kept; generated parity check |
| EMPTY_EA_THEME_FONT | docx-engine/src/props/fonts.rs | TS literal kept; generated parity check |
| APP_PROPERTIES_PATH | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| APP_PROPERTY_KEYS | NONE | TS literal kept; generated parity check |
| CORE_PROPERTIES_PATH | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| CORE_PROPERTY_KEYS | NONE | TS literal kept; generated parity check |
| NEW_DOCUMENT_APPLICATION | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| NEW_DOCUMENT_APP_VERSION | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| NEW_DOCUMENT_TEMPLATE | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| REMOVE_PARTS_KINDS | docx-engine/src/save/parts/remove_parts.rs | TS literal kept; generated parity check |
| TABLE_HEADER_FILL | docx-engine/src/generate/table.rs | TS literal kept; generated parity check |
| LINE_KINDS | NONE | TS literal kept; generated parity check |
| NEW_PICTURE_TOKEN_PREFIX | docx-engine/src/generate/drawing_build.rs | TS literal kept; generated parity check |
| colLetter | pptx-engine/src/chart_workbook.rs | TS literal kept; generated parity check |
| CHART_WORKBOOK_REL_TYPE | pptx-engine/src/chart_workbook.rs | TS literal kept; generated parity check |
| BLANK_BULLET_NUM_ID | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| BLANK_ORDERED_NUM_ID | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| DEFAULT_SECTION | docx-engine/src/section/read.rs | TS literal kept; generated parity check |
| LINE_BORDER_VALS | docx-engine/src/section/read.rs | TS literal kept; generated parity check |
| INK_NAME_PREFIX | docx-engine/src/ink.rs | TS literal kept; generated parity check |
| DEFAULT_PICTURE_PX | docx-engine/src/save/save/xml_number_usable.rs | TS literal kept; generated parity check |
| DEFAULT_SPIN_COUNT | docx-engine/src/protection.rs | TS literal kept; generated parity check |
| MAX_SPIN_COUNT | docx-engine/src/protection.rs | TS literal kept; generated parity check |
| SEGOE_UI_SYMBOL_RE | docx-engine/src/list_markers.rs | TS literal kept; generated parity check |
| DEFAULT_COMPARE_AUTHOR | docx-engine/src/save/features/compare.rs | TS literal kept; generated parity check |
| TEXT_EFFECTS | docx-engine/src/parse/text/build_run.rs | TS literal kept; generated parity check |
| EMPHASIS_MARKS | NONE | TS literal kept; generated parity check |
| TOTAL_PAGES_MARK | docx-engine/src/parse/tables/hf_fields.rs | TS literal kept; generated parity check |
| PAGE_MARK | docx-engine/src/parse/tables/hf_fields.rs | TS literal kept; generated parity check |
| SECTION_PAGES_MARK | docx-engine/src/parse/tables/hf_fields.rs | TS literal kept; generated parity check |