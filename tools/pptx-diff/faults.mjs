// One Rust fault at a time, through the same comparisons as the parity gate.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (Number(process.versions.node.split('.')[0]) !== 22)
  throw new Error('fault probes require Node 22')
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const leaf = 'crates/pptx-engine/src/'
const faults = [
  [
    'scan-shape-set',
    'pptxLeaves.scan.scanSlide',
    leaf + 'scan.rs',
    'SHAPE_TAGS.contains(&name)',
    'name == "p:sp"',
  ],
  [
    'node-array-is-object',
    'pptxLeaves.xml-utils.asXmlNode',
    leaf + 'xml_utils.rs',
    'Some(node @ (Value::Object(_) | Value::Array(_))) => node,',
    'Some(node @ Value::Object(_)) => node,',
  ],
  [
    'array-zero-truthy',
    'pptxLeaves.xml-utils.xmlArray',
    leaf + 'xml_utils.rs',
    'Some(v) if value_truthy(Some(v)) =>',
    'Some(v) =>',
  ],
  [
    'numeric-hex-radix',
    'pptxLeaves.xml-utils.decodeNumericCharRefs',
    leaf + 'xml_utils.rs',
    'Some(hex) => parse_int(hex, Radix::Sixteen)',
    'Some(hex) => parse_int(hex, Radix::Ten)',
  ],
  [
    'text-control-sanitizer',
    'pptxLeaves.xml-utils.escapeXmlText',
    leaf + 'xml_utils.rs',
    'sanitize_xml_chars(text)\n',
    'Cow::Borrowed(text)\n',
  ],
  [
    'attribute-quote-escape',
    'pptxLeaves.xml-utils.escapeXmlAttr',
    leaf + 'xml_utils.rs',
    '.replace(\'"\', "&quot;")',
    '.replace(\'"\', "&apos;")',
  ],
  [
    'relationship-maximum',
    'pptxLeaves.xml-utils.maxRelationshipIdNumber',
    leaf + 'xml_utils.rs',
    'if n > max {',
    'if n < max {',
  ],
  [
    'override-leading-slash',
    'pptxLeaves.xml-utils.hasContentTypeOverride',
    leaf + 'xml_utils.rs',
    'format!("/{part_path}")',
    'format!("{part_path}")',
  ],
  [
    'creation-uppercase',
    'pptxLeaves.xml-utils.creationIdExtXml',
    leaf + 'xml_utils.rs',
    'uuid.to_uppercase()',
    'uuid.to_lowercase()',
  ],
  [
    'creation-extlst-wrapper',
    'pptxLeaves.xml-utils.creationIdXml',
    leaf + 'xml_utils.rs',
    '"<a:extLst>{}</a:extLst>"',
    '"{}"',
  ],
  [
    'default-any-not-all',
    'pptxLeaves.xml-utils.hasDefaultFor',
    leaf + 'xml_utils.rs',
    '.any(|tag| re.test(tag.as_str()))',
    '.all(|tag| re.test(tag.as_str()))',
  ],
  [
    'slide-ceiling-boundary',
    'pptxLeaves.slide-ids.nextSlideId',
    leaf + 'slide_ids.rs',
    'if id > SLIDE_ID_MAX {',
    'if id >= SLIDE_ID_MAX {',
    2,
  ],
  [
    'named-action-equality',
    'pptxLeaves.named-action.namedActionOf',
    leaf + 'named_action.rs',
    '*named == name',
    '*named != name',
  ],
  [
    'named-action-prefix',
    'pptxLeaves.named-action.namedActionAttr',
    leaf + 'named_action.rs',
    'format!("{SHOWJUMP_ACTION}{action}")',
    'action.to_owned()',
  ],
  [
    'grid-merged-followers',
    'pptxLeaves.table-grid.tableRowGridCols',
    leaf + 'table_grid.rs',
    'f.merged == Some(true)',
    'f.merged == Some(false)',
  ],
  [
    'crc-initial-value',
    'pptxLeaves.crc32.crc32',
    leaf + 'crc32.rs',
    'let mut c = u32::MAX;',
    'let mut c = 0;',
  ],
  [
    'package-hash-case',
    'pptxPackage.open',
    leaf + 'zip.rs',
    'format!("{:x}", Sha256::digest(bytes))',
    'format!("{:X}", Sha256::digest(bytes))',
  ],
  [
    'package-empty-exists',
    'pptxPackage.has',
    leaf + 'zip.rs',
    'self.entries.has(path)',
    'self.entries.get(path).is_some_and(|bytes| !bytes.is_empty())',
  ],
  [
    'package-empty-text',
    'pptxPackage.readText',
    leaf + 'zip.rs',
    'self.entries.get(path).map(|bytes| decode_text(bytes))',
    'self.entries.get(path).filter(|bytes| !bytes.is_empty()).map(|bytes| decode_text(bytes))',
  ],
  [
    'package-empty-bytes',
    'pptxPackage.readBytes',
    leaf + 'zip.rs',
    'self.entries.get(path).map(Vec::as_slice)',
    'self.entries.get(path).filter(|bytes| !bytes.is_empty()).map(Vec::as_slice)',
  ],
  [
    'relationship-type-value',
    'pptxPackage.readRels',
    leaf + 'zip.rs',
    'r#type: text("@_Type")',
    'r#type: text("@_Target")',
  ],
  [
    'presentation-width-fallback',
    'pptxPackage.readPresentation',
    leaf + 'zip.rs',
    'emu_or(sz.get("@_cx"), 9_144_000.0)',
    'emu_or(sz.get("@_cx"), 1.0)',
  ],
  [
    'chain-theme-target',
    'pptxPackage.resolveSlideChain',
    leaf + 'zip.rs',
    'self.first_target(master, "/theme")?',
    'self.first_target(master, "/slideMaster")?',
  ],
  [
    'rels-filename-suffix',
    'pptxPackage.relsPathFor',
    leaf + 'zip.rs',
    'format!("{prefix}_rels/{file}.rels")',
    'format!("{prefix}_rels/{file}.xml")',
  ],
  [
    'target-root-anchor',
    'pptxPackage.resolveTarget',
    leaf + 'zip.rs',
    "normalized.starts_with('/')",
    "normalized.starts_with('!')",
  ],
  [
    'declared-count-boundary',
    'pptxPackage.assertZipWithinLimits',
    leaf + 'zip.rs',
    'files.len() > limits.max_parts',
    'files.len() >= limits.max_parts',
  ],
  [
    'xml-integer-key-order',
    'pptxXml.parseObject',
    'crates/ooxml-xml/src/object.rs',
    'in_property_order(object)',
    'object',
  ],
  [
    'independent-scan-byte-offset',
    'pptxLeaves.scan.scanSlide',
    'crates/office-wasm/src/calls/pptx_leaves.rs',
    'end: map.to_utf16(element.end as usize)',
    'end: element.end as u32',
  ],
  [
    'independent-target-decoding',
    'pptxPackage.resolveTarget',
    leaf + 'zip.rs',
    'let normalized = decoded.replace(\'\\\\\', "/");',
    'let normalized = target.replace(\'\\\\\', "/");',
  ],
  [
    'independent-xml-repeat-order',
    'pptxXml.parseObject',
    'crates/ooxml-xml/src/object.rs',
    'items.push(value);',
    'items.insert(0, value);',
  ],
  [
    'geom-min-nan',
    'pptxGeom.custgeom.evalGuides',
    'crates/pptx-engine/src/custgeom.rs',
    '"min" => math_min(x, y),',
    '"min" => x.min(y),',
  ],
  [
    'geom-r5-round',
    'pptxGeom.custgeom.parseCustGeom',
    'crates/pptx-engine/src/custgeom.rs',
    'let r5 = |v: f64| math_round(v * 100000.0) / 100000.0;',
    'let r5 = |v: f64| (v * 100000.0).round() / 100000.0;',
  ],
  [
    'geom-valid-count',
    'pptxGeom.custgeom.validCustGeomPath',
    'crates/pptx-engine/src/custgeom.rs',
    'pts.len() == count &&',
    'pts.len() >= count &&',
  ],
  [
    'geom-xml-round',
    'pptxGeom.custgeom.custGeomXml',
    'crates/pptx-engine/src/custgeom.rs',
    'number_to_string(math_round(x)),',
    'format!("{}", x.round()),',
  ],
  [
    'geom-q-count',
    'pptxGeom.custgeom.CUST_GEOM_PT_COUNT',
    'crates/pptx-engine/src/custgeom.rs',
    '("Q", 4)',
    '("Q", 3)',
  ],
  [
    'geom-preset-case',
    'pptxGeom.preset-shape-types.isPresetShapeType',
    'crates/pptx-engine/src/preset_shape_types.rs',
    'PRESET_SHAPE_TYPES.contains(&name)',
    'PRESET_SHAPE_TYPES.iter().any(|t| t.eq_ignore_ascii_case(name))',
  ],
  [
    'geom-preset-swap',
    'pptxGeom.preset-shape-types.PRESET_SHAPE_TYPES',
    'crates/pptx-engine/src/preset_shape_types.rs',
    '    "line",\n    "lineInv",',
    '    "lineInv",\n    "line",',
  ],
  [
    'layout-align-maxx',
    'pptxLayout.align.alignRects',
    'crates/pptx-engine/src/align.rs',
    'max_x = math_max(max_x, r.x + r.w);',
    'max_x = math_max(max_x, r.x);',
  ],
  [
    'layout-dist-divisor',
    'pptxLayout.align.distributeRects',
    'crates/pptx-engine/src/align.rs',
    'let divisor = rects.len() as f64 - 1.0;',
    'let divisor = rects.len() as f64;',
  ],
  [
    'layout-hier-zero',
    'pptxLayout.dgm-hier.parseHierConstraints',
    'crates/pptx-engine/src/dgm_hier.rs',
    'if v != 0.0 && !v.is_nan() {',
    'if !v.is_nan() {',
  ],
  [
    'layout-hier-rows',
    'pptxLayout.dgm-hier.layoutHierTree',
    'crates/pptx-engine/src/dgm_hier.rs',
    'if std_rows >= 4 &&',
    'if std_rows > 4 &&',
  ],
  [
    'layout-venn-start',
    'pptxLayout.smartart-layout.layoutShapes',
    'crates/pptx-engine/src/smartart_layout.rs',
    'let start = if m == 2.0 {',
    'let start = if m <= 2.0 {',
  ],
  [
    'layout-palette-neg',
    'pptxLayout.smartart-layout.SMARTART_PALETTE',
    'crates/office-wasm/src/calls/pptx_layout.rs',
    'let found = (index.fract() == 0.0 && index >= 0.0)',
    'let found = (index.fract() == 0.0)',
  ],
  [
    'layout-extract-fill',
    'pptxLayout.format-brush.extractFormat',
    'crates/pptx-engine/src/format_brush.rs',
    'if value_truthy(el.fill.as_ref()) {',
    'if el.fill.is_some() {',
  ],
  [
    'layout-apply-stroke-null',
    'pptxLayout.format-brush.applyFormat',
    'crates/pptx-engine/src/format_brush.rs',
    '        deserialize_with = "present",\n        skip_serializing_if = "Option::is_none"\n    )]\n    pub stroke:',
    '        skip_serializing_if = "Option::is_none"\n    )]\n    pub stroke:',
  ],
  [
    'tables-preset-case',
    'pptxTables.table-edit.TABLE_STYLE_PRESETS',
    'crates/pptx-engine/src/table_edit.rs',
    '.find(|(key, _)| *key == name)',
    '.find(|(key, _)| key.eq_ignore_ascii_case(name))',
  ],
  [
    'tables-ensure-any',
    'pptxTables.table-edit.ensureTableStyleXml',
    'crates/pptx-engine/src/table_edit.rs',
    'Some(xml) if xml.contains("<a:tblStyleLst") => xml,',
    'Some(xml) => xml,',
  ],
  [
    'tables-patch-selfclose',
    'pptxTables.table-edit.patchTableStyleXml',
    'crates/pptx-engine/src/table_edit.rs',
    'let self_closing = found.as_str().ends_with("/>");',
    'let self_closing = found.get(2) == Some("/>");',
  ],
  [
    'tables-find-last',
    'pptxTables.table-edit.findTableElementInSlide',
    'crates/pptx-engine/src/table_edit.rs',
    '.find(|el| el.id == source_id && el.r#type == "table")',
    '.rfind(|el| el.id == source_id && el.r#type == "table")',
  ],
  [
    'tables-hex6-case',
    'pptxTables.theme-apply.patchThemeXml',
    'crates/pptx-engine/src/theme_apply.rs',
    "slice_utf16(c.strip_prefix('#').unwrap_or(c), 0.0, Some(6.0)).to_uppercase()",
    "slice_utf16(c.strip_prefix('#').unwrap_or(c), 0.0, Some(6.0)).to_string()",
  ],
  [
    'tables-theme-path-anchor',
    'pptxTables.theme-apply.applyThemeToArchive',
    'crates/pptx-engine/src/theme_apply.rs',
    'js_regex!(r"^ppt\\/theme\\/theme\\d+\\.xml$")',
    'js_regex!(r"^ppt\\/theme\\/theme\\d+\\.xml")',
  ],
  [
    'tables-collect-case',
    'pptxTables.theme-apply.collectExplicitColors',
    'crates/pptx-engine/src/theme_apply.rs',
    'let hex = found.get(1).unwrap_or("").to_uppercase();',
    'let hex = found.get(1).unwrap_or("").to_owned();',
  ],
  [
    'tables-colormap-clamp',
    'pptxTables.theme-apply.buildColorMap',
    'crates/pptx-engine/src/theme_apply.rs',
    'accents.get(idx % accents.len())',
    'accents.get(idx.min(accents.len() - 1))',
  ],
  [
    'tables-recolor-case',
    'pptxTables.theme-apply.recolorXml',
    'crates/pptx-engine/src/theme_apply.rs',
    'map.get(&hex.to_uppercase())',
    'map.get(hex)',
  ],
  [
    'tables-remap-count',
    'pptxTables.theme-apply.remapDeckColors',
    'crates/pptx-engine/src/theme_apply.rs',
    '    map.len()\n}',
    '    xmls.len()\n}',
  ],
  [
    'anim-media-stop',
    'pptxAnim.animation.isMediaEffect',
    'crates/pptx-engine/src/animation/model.rs',
    'AnimEffectKind::MediaPlay | AnimEffectKind::MediaPause | AnimEffectKind::MediaStop',
    'AnimEffectKind::MediaPlay | AnimEffectKind::MediaPause',
  ],
  [
    'anim-class-path',
    'pptxAnim.animation.animClassOf',
    'crates/pptx-engine/src/animation/model.rs',
    'MotionPath => AnimClass::Path,',
    'MotionPath => AnimClass::Exit,',
  ],
  [
    'anim-spid-quote',
    'pptxAnim.animation.elementSpid',
    'crates/pptx-engine/src/animation/model.rs',
    'js_regex!(r#"<p:cNvPr\\s[^>]*\\bid=["\'](\\d+)["\']"#)',
    'js_regex!(r#"<p:cNvPr\\s[^>]*\\bid="(\\d+)""#)',
  ],
  [
    'anim-group-id-order',
    'pptxAnim.animation.buildTimingXml',
    'crates/pptx-engine/src/animation/write.rs',
    '    let effects: String = g.items.iter().map(|p| effect_par_xml(ids, p)).collect();\n    let outer = number_to_string(ids.next());\n    let inner = number_to_string(ids.next());',
    '    let outer = number_to_string(ids.next());\n    let inner = number_to_string(ids.next());\n    let effects: String = g.items.iter().map(|p| effect_par_xml(ids, p)).collect();',
  ],
  [
    'anim-patch-ext-order',
    'pptxAnim.animation.patchSlideTimingXml',
    'crates/pptx-engine/src/animation/write.rs',
    'let Some(at) = ext.or(sld_end) else {',
    'let Some(at) = sld_end.or(ext) else {',
  ],
  [
    'anim-read-psub',
    'pptxAnim.animation.readSlideTimingXml',
    'crates/pptx-engine/src/animation/read.rs',
    'if let Some(direction) = direction_from_preset(effect, psub)\n            && psub != preset(effect).sub\n',
    'if let Some(direction) = direction_from_preset(effect, psub)\n',
  ],
  [
    'anim-read-min-dur',
    'pptxAnim.animation.getSlideAnimations',
    'crates/pptx-engine/src/animation/read.rs',
    'prev_end = start_ms + math_max(1.0, duration_ms);',
    'prev_end = start_ms + duration_ms;',
  ],
  [
    'anim-incr-next-trigger',
    'pptxAnim.animation.patchSlideTimingIncrementalXml',
    'crates/pptx-engine/src/animation/incremental.rs',
    '            && next.trigger != AnimTrigger::OnClick\n',
    '            && false\n',
  ],
  [
    'anim-set-dirty',
    'pptxAnim.animation.setSlideAnimations',
    'crates/pptx-engine/src/animation/incremental.rs',
    '        .unwrap_or_else(|| patch_slide_timing_xml(&slide.body_suffix, anims));\n    slide.structure_dirty = true;\n',
    '        .unwrap_or_else(|| patch_slide_timing_xml(&slide.body_suffix, anims));\n',
  ],
  [
    'anim-prune-byte-slice',
    'pptxAnim.animation.pruneTimingForSpids',
    'crates/pptx-engine/src/animation/prune.rs',
    'let head = prefix_utf16(xml.get(seq.0..).unwrap_or_default(), 400);',
    'let head = xml.get(seq.0..seq.0 + 400).unwrap_or_default();',
  ],
  [
    'anim-cnvpr-dedup',
    'pptxAnim.animation.cNvPrIdsInXml',
    'crates/pptx-engine/src/animation/prune.rs',
    'if !out.contains(&id) {',
    'if true {',
  ],
  [
    'anim-effects-swap',
    'pptxAnim.animation.ANIM_EFFECTS',
    'crates/pptx-engine/src/animation/model.rs',
    'MotionPath, MediaPause,\n        MediaPlay, MediaStop,',
    'MotionPath, MediaPlay,\n        MediaPause, MediaStop,',
  ],
  [
    'anim-directions-swap',
    'pptxAnim.animation.ANIM_DIRECTIONS',
    'crates/pptx-engine/src/animation/model.rs',
    '    AnimDirection::Top,\n    AnimDirection::Bottom,\n    AnimDirection::Left,',
    '    AnimDirection::Bottom,\n    AnimDirection::Top,\n    AnimDirection::Left,',
  ],
  [
    'anim-triggers-swap',
    'pptxAnim.animation.ANIM_TRIGGERS',
    'crates/pptx-engine/src/animation/model.rs',
    '    AnimTrigger::WithPrev,\n    AnimTrigger::AfterPrev,\n];',
    '    AnimTrigger::AfterPrev,\n    AnimTrigger::WithPrev,\n];',
  ],
  [
    'anim-motion-default',
    'pptxAnim.animation.DEFAULT_MOTION_PATH',
    'crates/pptx-engine/src/animation/write.rs',
    'pub const DEFAULT_MOTION_PATH: &str = "M 0 0 L 0.25 0";',
    'pub const DEFAULT_MOTION_PATH: &str = "M 0 0 L 0.25 0 E";',
  ],
  [
    'bytes-glb-len',
    'pptxBytes.glb-bounds.glbJson',
    'crates/pptx-engine/src/glb_bounds.rs',
    'if 20 + length > bytes.len() as u64 {',
    'if 20 + length >= bytes.len() as u64 {',
  ],
  [
    'bytes-glb-negzero',
    'pptxBytes.glb-bounds.glbBounds',
    'crates/pptx-engine/src/glb_bounds.rs',
    'Visited::Number(if *x == 0.0 { 0 } else { x.to_bits() })',
    'Visited::Number(x.to_bits())',
  ],
  [
    'bytes-col-letter',
    'pptxBytes.chart-workbook.colLetter',
    'crates/pptx-engine/src/chart_workbook.rs',
    'label.insert(0, string_from_char_code(65.0 + rem));',
    'label.insert(0, char::from(65 + rem as u8));',
  ],
  [
    'bytes-parts-finite',
    'pptxBytes.chart-workbook.chartWorkbookParts',
    'crates/pptx-engine/src/chart_workbook.rs',
    '                && val.is_finite()\n',
    '                && true\n',
  ],
  [
    'bytes-zip-offset',
    'pptxBytes.chart-workbook.storedZip',
    'crates/pptx-engine/src/chart_workbook.rs',
    'local += 30 + name_length + data_length;',
    'local += 30 + data_length;',
  ],
  [
    'bytes-si-index',
    'pptxBytes.chart-workbook.chartWorkbookXlsx',
    'crates/pptx-engine/src/chart_workbook.rs',
    '    strings.push(s);\n    strings.len() - 1\n',
    '    strings.push(s);\n    strings.len()\n',
  ],
  [
    'bytes-constant-swap',
    'pptxBytes.chart-workbook.constant',
    'crates/pptx-engine/src/chart_workbook.rs',
    '    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package";\npub const XLSX_CONTENT_TYPE: &str =\n    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";',
    '    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";\npub const XLSX_CONTENT_TYPE: &str =\n    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package";',
  ],
  [
    'ident-durable-case',
    'pptxIdent.identity.elementDurableId',
    'crates/pptx-engine/src/identity.rs',
    'guid.get(..8).unwrap_or(guid).to_ascii_lowercase()',
    'guid.get(..8).unwrap_or(guid).to_owned()',
  ],
  [
    'ident-slide-flat',
    'pptxIdent.identity.slideDurableId',
    'crates/pptx-engine/src/identity.rs',
    '"_".repeat(other.as_str().encode_utf16().count())',
    '"_".to_owned()',
  ],
  [
    'ident-cnvpr-wordbound',
    'pptxIdent.identity.elementCNvPrId',
    'crates/pptx-engine/src/identity.rs',
    'js_regex!(r#"\\bid="(\\d+)""#).exec(open_tag)',
    'js_regex!(r#"id="(\\d+)""#).exec(open_tag)',
  ],
  [
    'ident-ref-id',
    'pptxIdent.identity.matchesElementRef',
    'crates/pptx-engine/src/identity.rs',
    '    el.id == id\n        ||',
    '    false\n        ||',
  ],
  [
    'ident-creation-selfclose',
    'pptxIdent.identity.ensureCreationId',
    'crates/pptx-engine/src/identity.rs',
    'tag.strip_suffix("/>").unwrap_or(tag),',
    'tag,',
  ],
  [
    'ident-group-open-cnvpr',
    'pptxIdent.identity.groupChildDurableId',
    'crates/pptx-engine/src/identity.rs',
    '        None => "",\n',
    '        None => xml.get(from..).unwrap_or(""),\n',
  ],
  [
    'ident-redact-el',
    'pptxIdent.redaction-xml.constants',
    'crates/pptx-engine/src/redaction_xml.rs',
    'pub const REDACT_EL: &str = "go:redact";',
    'pub const REDACT_EL: &str = "w:redact";',
  ],
  [
    'ident-redact-escape',
    'pptxIdent.redaction-xml.redactExtXml',
    'crates/pptx-engine/src/redaction_xml.rs',
    '        escape_xml_attr(label)\n',
    '        label\n',
  ],
  [
    'ident-has-selfclose',
    'pptxIdent.redaction-xml.hasRedactExtIn',
    'crates/pptx-engine/src/redaction_xml.rs',
    '(?:{ATTRIBUTES}/>|[^>]*(?:/>|>[\\s\\S]*?</a:ext>))"#',
    '[^>]*>[\\s\\S]*?</a:ext>"#',
  ],
  [
    'ident-sync-truthy',
    'pptxIdent.redaction-xml.syncRedactExt',
    'crates/pptx-engine/src/redaction_xml.rs',
    'let next = match truthy(label) {',
    'let next = match label {',
  ],
  [
    'ident-read-empty-label',
    'pptxIdent.redaction-xml.readRedactLabel',
    'crates/pptx-engine/src/redaction_xml.rs',
    'Some(Value::String(label)) if !label.is_empty() => Some(label.as_str()),',
    'Some(Value::String(label)) => Some(label.as_str()),',
  ],
  [
    'ident-strip-trim',
    'pptxIdent.redaction-xml.stripRedactExt',
    'crates/pptx-engine/src/redaction_xml.rs',
    'Some(inner) if !trim(inner).is_empty() =>',
    'Some(inner) if !inner.is_empty() =>',
  ],
  [
    'ident-set-first-close',
    'pptxIdent.redaction-xml.setRedactExt',
    'crates/pptx-engine/src/redaction_xml.rs',
    'let Some(close_at) = props_xml.rfind(&close) else {',
    'let Some(close_at) = props_xml.find(&close) else {',
  ],
  [
    'ident-glb-type',
    'pptxIdent.model3d.constants',
    'crates/pptx-engine/src/model3d.rs',
    '"model/gltf.binary"',
    '"model/gltf-binary"',
  ],
  [
    'ident-framing-round',
    'pptxIdent.model3d.model3dFraming',
    'crates/pptx-engine/src/model3d.rs',
    'JsNum(math_round((-c / max_extent) * MODEL3D_EMU_PER_METER))',
    'JsNum(((-c / max_extent) * MODEL3D_EMU_PER_METER).round())',
  ],
  [
    'ident-xml-viewport',
    'pptxIdent.model3d.model3dXml',
    'crates/pptx-engine/src/model3d.rs',
    'text(math_max(cx.0, cy.0))',
    'text(cx.0)',
  ],
  [
    'ident-sync-viewport',
    'pptxIdent.model3d.syncModel3dFrame',
    'crates/pptx-engine/src/model3d.rs',
    'text(math_max(to_number(cx), to_number(cy)))',
    'text(to_number(cx))',
  ],
  [
    'ident-rot-negative',
    'pptxIdent.model3d.readModel3dRotation',
    'crates/pptx-engine/src/model3d.rs',
    'ax: axis(js_regex!(r#"\\bax="(-?\\d+)""#)),',
    'ax: axis(js_regex!(r#"\\bax="(\\d+)""#)),',
  ],
  [
    'ident-rot-round',
    'pptxIdent.model3d.setModel3dRotationXml',
    'crates/pptx-engine/src/model3d.rs',
    'text(math_round(rot.ax.0)),',
    'text(rot.ax.0.round()),',
  ],
  [
    'mtx-error-empty-message',
    'pptxMtx.lzcomp.MtxError',
    'crates/pptx-engine/src/mtx/lzcomp.rs',
    'if self.message.is_empty() {',
    'if false {',
  ],
  [
    'mtx-writer-uint32',
    'pptxMtx.lzcomp.BitWriter',
    'crates/pptx-engine/src/mtx/lzcomp.rs',
    'let value = to_int32(value) as u32;',
    'let value = value as u32;',
  ],
  [
    'mtx-reader-fraction-bits',
    'pptxMtx.lzcomp.BitReader',
    'crates/pptx-engine/src/mtx/lzcomp.rs',
    'while i < number_of_bits {',
    'while i < number_of_bits.floor() {',
  ],
  [
    'mtx-huffman-range-boundary',
    'pptxMtx.lzcomp.AHuff',
    'crates/pptx-engine/src/mtx/lzcomp.rs',
    'range > 256 && range < 512',
    'range >= 256',
  ],
  [
    'mtx-lz-three-byte-distance',
    'pptxMtx.lzcomp.unpackLz',
    'crates/pptx-engine/src/mtx/lzcomp.rs',
    'distance >= MAX_2BYTE_DIST',
    'distance > MAX_2BYTE_DIST',
  ],
  [
    'mtx-block-end-boundary',
    'pptxMtx.lzcomp.unpackMtx',
    'crates/pptx-engine/src/mtx/lzcomp.rs',
    'offsets[k] + sizes[k] > length',
    'offsets[k] + sizes[k] >= length',
  ],
  [
    'mtx-cmap-language-platform',
    'pptxMtx.ctf.sanitizeCmap',
    'crates/pptx-engine/src/mtx/ctf.rs',
    'if pid == 3 && fmt == 4 &&',
    'if fmt == 4 &&',
  ],
  [
    'mtx-short-loca-boundary',
    'pptxMtx.ctf.ctfToSfnt',
    'crates/pptx-engine/src/mtx/ctf.rs',
    'out.pos <= 0x1fffe',
    'out.pos < 0x1fffe',
  ],
  [
    'mtx-block-order',
    'pptxMtx.index.mtxToSfnt',
    'crates/pptx-engine/src/mtx/mod.rs',
    '[&a, &b, &c]',
    '[&a, &c, &b]',
  ],
  [
    'independent-arc-param-angle-swapped-radii',
    'pptxGeom.custgeom.parseCustGeom',
    'crates/pptx-engine/src/custgeom.rs',
    'math_atan2(math_sin(a) * w_r, math_cos(a) * h_r)',
    'math_atan2(math_sin(a) * h_r, math_cos(a) * w_r)',
  ],
  [
    'independent-custgeomxml-round-half-away',
    'pptxGeom.custgeom.custGeomXml',
    'crates/pptx-engine/src/custgeom.rs',
    'number_to_string(math_round(x)),',
    'number_to_string(x.round()),',
  ],
  [
    'independent-hier-hang-two-kids',
    'pptxLayout.dgm-hier.layoutHierTree',
    'crates/pptx-engine/src/dgm_hier.rs',
    'kids.len() >= 2',
    'kids.len() > 2',
  ],
  [
    'independent-brush-run-truthy-not-nullish',
    'pptxLayout.format-brush.extractFormat',
    'crates/pptx-engine/src/format_brush.rs',
    'if let Some(v) = field {',
    'if let Some(v) = field.as_ref().filter(|v| value_truthy(Some(*v))) {',
  ],
  [
    'independent-table-border-default-width',
    'pptxTables.table-edit.patchTableStyleXml',
    'crates/pptx-engine/src/table_edit.rs',
    'map_or(12700.0',
    'map_or(9525.0',
  ],
  [
    'independent-theme-name-unescaped',
    'pptxTables.theme-apply.patchThemeXml',
    'crates/pptx-engine/src/theme_apply.rs',
    '&escape_xml_attr(&spec.name),',
    '&spec.name,',
  ],
  [
    'independent-anim-read-prev-end-zero-duration',
    'pptxAnim.animation.readSlideTimingXml',
    'crates/pptx-engine/src/animation/read.rs',
    'prev_end = start_ms + math_max(1.0, duration_ms);',
    'prev_end = start_ms + math_max(0.0, duration_ms);',
  ],
  [
    'independent-anim-eq-ignores-direction',
    'pptxAnim.animation.patchSlideTimingIncrementalXml',
    'crates/pptx-engine/src/animation/incremental.rs',
    '&& x.direction == y.direction',
    '&& x.effect == y.effect',
  ],
  [
    'independent-col-letter-bijective-carry',
    'pptxBytes.chart-workbook.colLetter',
    'crates/pptx-engine/src/chart_workbook.rs',
    'n = ((n - 1.0) / 26.0).floor();',
    'n = (n / 26.0).floor();',
  ],
  [
    'independent-glb-world-matrix-order',
    'pptxBytes.glb-bounds.glbBounds',
    'crates/pptx-engine/src/glb_bounds.rs',
    'multiply(&parent, &local_matrix(&node)?)',
    'multiply(&local_matrix(&node)?, &parent)',
  ],
  [
    'independent-slide-id-utf8-byte-count',
    'pptxIdent.identity.slideDurableId',
    'crates/pptx-engine/src/identity.rs',
    '"_".repeat(other.as_str().encode_utf16().count())',
    '"_".repeat(other.as_str().len())',
  ],
  [
    'independent-own-cnvpr-last-close',
    'pptxIdent.identity.elementDurableId',
    'crates/pptx-engine/src/identity.rs',
    'rest.find(CNVPR_CLOSE)',
    'rest.rfind(CNVPR_CLOSE)',
  ],
  [
    'independent-glyph-flag-x-minus-256',
    'pptxMtx.ctf.ctfToSfnt',
    'crates/pptx-engine/src/mtx/ctf.rs',
    'x > -256 && x < 0',
    'x >= -256 && x < 0',
  ],
  [
    'independent-cmap-fmt12-language-16bit',
    'pptxMtx.ctf.sanitizeCmap',
    'crates/pptx-engine/src/mtx/ctf.rs',
    'u32_at(off + 8) != 0',
    '(u32_at(off + 8) >> 16) != 0',
  ],
]

const out = resolve(here, 'out/faults')
const target = resolve(root, 'crates/target/fault-probes')
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: '4',
  CARGO_TARGET_DIR: target,
  SEUOFFICE_WASM: resolve(target, 'wasm32-wasip1/debug/office_wasm.wasm'),
}
if (process.argv.includes('--inventory')) {
  let stale = 0
  for (const [id, , file, before, , occurrences = 1] of faults) {
    const count = readFileSync(resolve(root, file), 'utf8').split(before).length - 1
    if (count !== occurrences) stale++
    console.log(`${count === occurrences ? 'OK' : 'STALE'} ${id}: ${count}/${occurrences}`)
  }
  if (new Set(faults.map(([id]) => id)).size !== faults.length)
    throw new Error('a fault id repeats')
  process.exit(stale === 0 ? 0 : 1)
}
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt === -1 ? null : new Set(process.argv[onlyAt + 1].split(','))
// `--shard INDEX/COUNT`: every COUNTth fault from INDEX, for runners side by side.
const shardAt = process.argv.indexOf('--shard')
const [shard, shards] = shardAt === -1 ? [0, 1] : process.argv[shardAt + 1].split('/').map(Number)
if (!(Number.isInteger(shard) && Number.isInteger(shards) && shard >= 0 && shard < shards))
  throw new Error('--shard takes INDEX/COUNT')
const named = faults.filter(([id]) => only === null || only.has(id))
if (only !== null && named.length !== only.size) throw new Error('--only names an unknown fault')
const selected = named.filter((_, index) => index % shards === shard)
// A scratch copy: an interrupted probe leaves no fault in the working tree.
const workspace = mkdtempSync(join(tmpdir(), 'pptx-faults-'))
cpSync(resolve(root, 'crates'), resolve(workspace, 'crates'), {
  recursive: true,
  filter: (source) => {
    const path = relative(resolve(root, 'crates'), source)
    return path !== 'target' && !path.startsWith(`target${sep}`)
  },
})
const args = [
  'build',
  '--locked',
  '--target',
  'wasm32-wasip1',
  '--manifest-path',
  resolve(workspace, 'crates/Cargo.toml'),
  '-p',
  'office-wasm',
  '-j4',
]
mkdirSync(out, { recursive: true })
const run = (program, args, extraEnv = {}) =>
  spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  })
const compareArgs = [
  resolve(root, 'node_modules/tsx/dist/cli.mjs'),
  resolve(here, 'main.ts'),
  '--calls-only',
  '--by-function',
]
const baselineBuild = run('cargo', args)
if (baselineBuild.status !== 0) throw new Error(baselineBuild.stderr || String(baselineBuild.error))
const baseline = run(process.execPath, compareArgs, { PPTX_DIFF_OUT: resolve(out, 'baseline') })
writeFileSync(resolve(out, 'baseline.log'), (baseline.stdout ?? '') + (baseline.stderr ?? ''))
if (baseline.status !== 0) throw new Error('fault baseline failed: out/faults/baseline.log')
const results = []
for (const [id, fn, file, before, after, occurrences = 1] of selected) {
  const path = resolve(workspace, file)
  const original = readFileSync(path, 'utf8')
  const count = original.split(before).length - 1
  if (count !== occurrences)
    throw new Error(`${id}: source anchor occurs ${count}, expected ${occurrences}`)
  let result
  try {
    // a function: `$` in the fault text is not a replacement pattern
    writeFileSync(
      path,
      original.replace(before, () => after),
    )
    const build = run('cargo', args)
    if (build.status !== 0) throw new Error(build.stderr || String(build.error))
    // Only the group of the faulted function: the baseline above compared them all.
    const group = fn.split('.')[0].slice('pptx'.length).toLowerCase()
    const compared = run(process.execPath, [...compareArgs, '--group', group], {
      PPTX_DIFF_OUT: resolve(out, id),
    })
    writeFileSync(resolve(out, `${id}.log`), (compared.stdout ?? '') + (compared.stderr ?? ''))
    const tally = (compared.stdout ?? '')
      .split('\n')
      .find((line) => line.trim().startsWith(fn + ' '))
    const differences = Number(/differences\s+(\d+)/.exec(tally ?? '')?.[1] ?? 0)
    result = { id, fn, file, before, after, differences, caught: differences > 0 }
  } finally {
    writeFileSync(path, original)
  }
  results.push(result)
  console.log(
    `${result.caught ? 'CAUGHT' : 'MISSED'} ${id}: ${fn}, ${result.differences} differences`,
  )
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(results, null, 2) + '\n')
}
rmSync(workspace, { recursive: true, force: true })
process.exit(results.every((result) => result.caught) ? 0 : 1)
