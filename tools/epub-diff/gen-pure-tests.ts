// Writes crates/epub-engine/tests/pure.rs and pure_parse.json from what the TypeScript answers; run it again to renew them.
import { writeFileSync } from 'node:fs'
import { applyBlockEdit, applyBlockEdits, type BlockEdit } from '../../packages/epub-engine/src/edits'
import { openChapter, remapChapter, type OpenChapter } from '../../packages/epub-engine/src/blocks'
import { blockNotation, blockPlainText, checkNotation, escapeNotationText, newBlockNotationToXhtml, notationToXhtml, parseBlockNotation, serializeNotation, encodeBlock, type NotationContext, type NotationNode } from '../../packages/epub-engine/src/notation'
import { toggleMarkInTree } from '../../packages/epub-engine/src/marks'
import { readStartTag, removeIds, insertionAfter, elementTextReplacement, startTagReplacement, walkElements, writeStartTag, setTagAttribute, namespaceOf, elementText } from '../../packages/epub-engine/src/translate/output-markup'
import { parseXml, textRawOffset } from '../../packages/epub-engine/src/xml-positions'
import { parseXmlPositions } from '../fileparse-diff/host-steps-epub-pure'
import { buildEpubTranslationRequest, epubTranslationSystemPrompt } from '../../packages/epub-engine/src/translate/prompt'
import { epubTranslationKeys, epubChapterFingerprint, EPUB_METADATA_FINGERPRINT } from '../../packages/epub-engine/src/translate/keys'
import { chapterTranslationUnits, metadataTranslationUnits } from '../../packages/epub-engine/src/translate/units'
import { defaultEpubTargetLanguage, epubBookLanguage } from '../../packages/epub-engine/src/translate/language'
import { guessLanguageFromText } from '../../packages/pdf-structure/src/epub/language'
import { defaultTargetLanguage } from '../../packages/pdf-structure/src/translate/language'
import { easyStyleLines, translationStyleLines } from '../../packages/pdf-structure/src/translate/style'
import { normalizeLang } from '../../packages/i18n/src/index'
import { translationLanguageOf } from '../../packages/pdf-structure/src/translate/language'
import { sha256Hex } from '../../packages/pdf-structure/src/tree/hash'
import { createHash } from 'node:crypto'

const NS = 'xmlns="http://www.w3.org/1999/xhtml"'
const C1 = `<?xml version="1.0"?>\n<html ${NS}><body>\n  <p id="a">Hello <b>big</b> &amp; <a href="#x">link</a><br/>end</p>\n  <p>Second <em class="k">one</em></p>\n  <div><p>in div</p></div>\n  <p/>\n  <td>cell</td>\n</body></html>`
const C3 = `<!DOCTYPE html>\n<html ${NS}><body><p>x&nbsp;y&eacute;z</p></body></html>`
const lit = (s: string): string => `"${[...s].map(c => { const k = c.codePointAt(0)!; return c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : k < 0x20 || k > 0x7e ? `\\u{${k.toString(16)}}` : c }).join('')}"`
const parses: Record<string, unknown> = {}
const parseOf = (source: string): void => { parses[source] = parseXmlPositions({ source: Array.from({ length: source.length }, (_, i) => source.charCodeAt(i)) }) }
const mapOf = (source: string): OpenChapter => { const m = openChapter(source); if (m.broken) throw new Error('broken'); parseOf(source); return m }
const out: string[] = []
const test = (name: string, body: string[]): void => { out.push(`#[test]\nfn ${name}() {\n${body.map(l => '    ' + l).join('\n')}\n}\n`) }
const ts = (xs: string[]): string => (xs.length === 0 ? 'Vec::<&str>::new()' : `vec![${xs.map(lit).join(', ')}]`)
const rep = (rs: readonly { start: number; end: number; text: string }[]): string => `vec![${rs.map(r => lit(`${r.start}..${r.end} ${r.text}`)).join(', ')}]`
const ctxLit = (c: NotationContext): string => `ctx(&[${c.placeholders.map(p => `(${p.n}, ${lit(p.tag)}, ${p.empty}, ${lit(p.startTag)}, ${lit(p.endTag)}, ${lit(p.outer)})`).join(', ')}], &[${c.bold.map(m => `(${lit(m.startTag)}, ${lit(m.endTag)})`).join(', ')}], &[${c.italic.map(m => `(${lit(m.startTag)}, ${lit(m.endTag)})`).join(', ')}], &[${c.breaks.map(lit).join(', ')}])`

const m1 = mapOf(C1)
test('open_chapter_numbers_the_blocks_in_reading_order', [
  `let map = open(${lit(C1)});`,
  `let blocks: Vec<String> = map.blocks.iter().map(|b| format!("{} {} {} {} {}..{} {}..{}", b.id, b.kind.as_str(), b.flowing, b.self_closing, b.outer.start, b.outer.end, b.inner.start, b.inner.end)).collect();`,
  `assert_eq!(blocks, vec![${m1.blocks.map(b => lit(`${b.id} ${b.kind} ${b.flowing} ${b.selfClosing} ${b.outer.start}..${b.outer.end} ${b.inner.start}..${b.inner.end}`)).join(', ')}]);`,
  `assert_eq!(map.next_id, ${m1.nextId});`,
])
const notations = m1.blocks.slice(0, 4).map(b => ({ b, n: blockNotation(m1, b), p: blockPlainText(m1, b) }))
test('block_notation_and_plain_text', [
  `let map = open(${lit(C1)});`,
  ...notations.flatMap(({ b, n, p }, i) => [
    `let b${i} = find_block(&map, &u(${lit(b.id)})).unwrap();`,
    `let n${i} = block_notation(&map, b${i}, NotationOptions::default()).unwrap();`,
    `assert_eq!(text(&n${i}.text), ${lit(n.text)});`,
    `assert_eq!(n${i}.context, ${ctxLit(n.context)});`,
    `assert_eq!(text(&block_plain_text(&map, b${i}).unwrap()), ${lit(p)});`,
  ]),
])
const rich = blockNotation(m1, m1.blocks[0]!).context
const notes = ['Hello <b>big</b> &amp; <x1>link</x1><br/>end', 'Hello <i>big</i> &amp; <x1>link</x1><br/>end', 'Hi <x1>link</x1><br/><br/>end', 'Hello <x1>link</x1>', '<x1>a</x1><x1>b</x1>', 'a <q>', 'a </b>', '<b>a', 'x <x2/>', '<x1/>']
const checks = notes.map(t => ({ t, c: checkNotation(t, rich), x: notationToXhtml(t, rich) }))
test('notation_checks_and_decodes_against_the_context', [
  `let map = open(${lit(C1)});`,
  `let context = block_notation(&map, &map.blocks[0], NotationOptions::default()).unwrap().context;`,
  ...checks.flatMap(({ t, c, x }) => [
    c.ok ? `assert!(check_notation(&u(${lit(t)}), &context).is_ok());` : `assert_eq!(err_text(check_notation(&u(${lit(t)}), &context)), ${lit(c.error)});`,
    `assert_eq!(${x.ok ? 'xhtml(notation_to_xhtml(&u(' + lit(t) + '), &context))' : 'err_text(notation_to_xhtml(&u(' + lit(t) + '), &context))'}, ${lit(x.ok ? x.xhtml : x.error)});`,
  ]),
])
const news = ['a <b>b</b> <i>c</i><br/> &amp; &lt;', '<x1/>', 'a <q>', '<b>a', '&#x1F600;&#65;&bogus;', '<br />']
test('new_block_notation_allows_marks_and_breaks_only', news.map(t => { const r = newBlockNotationToXhtml(t); return `assert_eq!(${r.ok ? 'xhtml(new_block_notation_to_xhtml(&u(' + lit(t) + ')))' : 'err_text(new_block_notation_to_xhtml(&u(' + lit(t) + ')))'}, ${lit(r.ok ? r.xhtml : r.error)});` }).concat([`assert_eq!(text(&escape_notation_text(&u("a<b&c>d"))), ${lit(escapeNotationText('a<b&c>d'))});`]))

// edits
const id = (b: number): string => m1.blocks[b]!.id
const edits: Array<[string, BlockEdit, string]> = [
  ['split', { op: 'split', blockId: id(0), offset: 8 }, 'Split { block_id: u("b1"), offset: 8.0 }'],
  ['split at link end', { op: 'split', blockId: id(0), offset: 16 }, 'Split { block_id: u("b1"), offset: 16.0 }'],
  ['line break', { op: 'line_break', blockId: id(1), offset: 3 }, 'LineBreak { block_id: u("b2"), offset: 3.0 }'],
  ['merge next', { op: 'merge', blockId: id(0), with: 'next' }, 'Merge { block_id: u("b1"), with: Neighbour::Next }'],
  ['merge previous', { op: 'merge', blockId: id(1), with: 'previous' }, 'Merge { block_id: u("b2"), with: Neighbour::Previous }'],
  ['delete', { op: 'delete', blockId: id(0) }, 'Delete { block_id: u("b1") }'],
  ['insert', { op: 'insert_after', blockId: id(1), text: 'new <b>b</b>' }, 'InsertAfter { block_id: u("b2"), text: u("new <b>b</b>") }'],
  ['toggle', { op: 'toggle_mark', blockId: id(1), mark: 'bold', start: 0, end: 6 }, 'ToggleMark { block_id: u("b2"), mark: MarkKind::Bold, start: 0.0, end: 6.0 }'],
  ['replace', { op: 'replace', blockId: id(1), text: 'Zweite <x1>eins</x1>' }, 'Replace { block_id: u("b2"), text: u("Zweite <x1>eins</x1>"), drop_ruby: false }'],
  ['bad offset', { op: 'split', blockId: id(0), offset: 99 }, 'Split { block_id: u("b1"), offset: 99.0 }'],
  ['not flowing', { op: 'split', blockId: id(m1.blocks.length - 1), offset: 0 }, `Split { block_id: u(${lit(id(m1.blocks.length - 1))}), offset: 0.0 }`],
  ['unknown', { op: 'delete', blockId: 'b404' }, 'Delete { block_id: u("b404") }'],
  ['invalid notation', { op: 'replace', blockId: id(0), text: 'x' }, 'Replace { block_id: u("b1"), text: u("x"), drop_ruby: false }'],
]
const editLines: string[] = [`let map = open(${lit(C1)});`]
for (const [name, edit, rustEdit] of edits) {
  const r = applyBlockEdit(m1, edit)
  editLines.push(`// ${name}`, `let edit = BlockEdit::${rustEdit};`)
  if (r.ok) {
    parseOf(r.map.source)
    editLines.push(`let applied = apply_block_edit(&Fixture, &map, &edit).unwrap();`, `assert_eq!(reps(&applied.replacements), ${rep(r.replacements)});`,
      `let next = applied.map.as_ref().unwrap_or(&map);`, `assert_eq!(text(next.source()), ${lit(r.map.source)});`,
      `assert_eq!(next.blocks.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ${ts(r.map.blocks.map(b => b.id))});`, `assert_eq!(applied.created, ${ts(r.created)});`)
  } else {
    editLines.push(`let refused = refusal(apply_block_edit(&Fixture, &map, &edit));`, `assert_eq!(refused, ${lit(`${r.refusal.code}: ${r.refusal.message}`)});`)
  }
}
const seq: BlockEdit[] = [{ op: 'split', blockId: 'b1', offset: 5 }, { op: 'insert_after', blockId: 'b2', text: 'x' }, { op: 'merge', blockId: 'b1', with: 'next' }]
const sr = applyBlockEdits(m1, seq)
if (!sr.ok) throw new Error('seq')
parseOf(sr.map.source)
{ let cur = m1; for (const e of seq) { const r = applyBlockEdit(cur, e); if (!r.ok) throw new Error('seq step'); parseOf(r.map.source); cur = r.map } }
editLines.push('// a sequence', `let edits = [BlockEdit::Split { block_id: u("b1"), offset: 5.0 }, BlockEdit::InsertAfter { block_id: u("b2"), text: u("x") }, BlockEdit::Merge { block_id: u("b1"), with: Neighbour::Next }];`,
  `let EditsResult::Applied { map: last, replacements, created } = apply_block_edits(&Fixture, &map, &edits).unwrap() else { panic!("refused") };`,
  `assert_eq!(reps(&replacements), ${rep(sr.replacements)});`, `assert_eq!(text(last.source()), ${lit(sr.map.source)});`, `assert_eq!(created, ${ts(sr.created)});`,
  `assert_eq!(last.blocks.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ${ts(sr.map.blocks.map(b => b.id))});`, `assert_eq!(last.next_id, ${sr.map.nextId});`)
const bad = applyBlockEdits(m1, [{ op: 'delete', blockId: 'b1' }, { op: 'delete', blockId: 'b1' }])
if (bad.ok) throw new Error('expected refusal')
editLines.push(`let two = [BlockEdit::Delete { block_id: u("b1") }, BlockEdit::Delete { block_id: u("b1") }];`, `let EditsResult::Refused { index, refusal } = apply_block_edits(&Fixture, &map, &two).unwrap() else { panic!("applied") };`, `assert_eq!(format!("{index} {}: {}", refusal.code.as_str(), text(&refusal.message)), ${lit(`${bad.index} ${bad.refusal.code}: ${bad.refusal.message}`)});`)
const broken = applyBlockEdit(m1, { op: 'insert_after', blockId: 'b1', text: 'a' })
void broken
test('edits_replacements_and_the_chapter_they_make', editLines)

// ranges of the replacements survive a remap
const r1 = applyBlockEdit(m1, { op: 'split', blockId: 'b2', offset: 3 })
if (!r1.ok) throw new Error('split')
parseOf(r1.map.source)
const rm = remapChapter(m1, r1.map.source, r1.replacements)
if (rm.broken) throw new Error('remap')
test('remap_keeps_ids_of_untouched_blocks', [
  `let map = open(${lit(C1)});`,
  `let source = u(${lit(r1.map.source)});`,
  `let ChapterMap::Open(next) = remap_chapter(&Fixture, &map, &source, &reps_in(&[${r1.replacements.map(r => `(${r.start}, ${r.end}, ${lit(r.text)})`).join(', ')}])).unwrap() else { panic!("broken") };`,
  `assert_eq!(next.blocks.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ${ts(rm.blocks.map(b => b.id))});`, `assert_eq!(next.next_id, ${rm.nextId});`,
])
parseOf('<a>')
parseOf('<a><b></a>')
test('a_broken_chapter_is_a_value_not_an_error', [
  `let ChapterMap::Broken(broken) = open_chapter(&Fixture, &u("<a><b></a>")).unwrap() else { panic!("opened") };`,
  `assert_eq!((broken.error.as_str(), broken.offset), (${lit((openChapter('<a><b></a>') as { error: string }).error)}, ${(openChapter('<a><b></a>') as { offset: number }).offset}));`,
])

// marks
const tree = (): NotationNode[] => [{ t: 'text', v: 'ab' }, { t: 'b', orig: 0, c: [{ t: 'text', v: 'cd' }, { t: 'x', n: 1, c: [{ t: 'text', v: 'ef' }] }] }, { t: 'br', orig: null }, { t: 'text', v: 'gh' }]
const treeLit = `vec![t("ab"), mark(MarkName::B, Some(0), vec![t("cd"), x(1.0, Some(vec![t("ef")]))]), br(None), t("gh")]`
const markLines: string[] = [`let tree = ${treeLit};`]
for (const [mark, a, b] of [['b', 1, 3], ['b', 0, 8], ['i', 3, 6], ['b', 2, 4], ['i', 0, 1], ['b', 5, 5], ['b', 7, 3], ['i', 0.5, 2], ['b', -1, 100]] as const) {
  const r = toggleMarkInTree(tree(), mark, a, b)
  markLines.push(r === null ? `assert!(toggle_mark_in_tree(&tree, MarkName::${mark.toUpperCase()}, ${a.toFixed(1)}, ${b.toFixed(1)}).unwrap().is_none());` : `assert_eq!(serialized(toggle_mark_in_tree(&tree, MarkName::${mark.toUpperCase()}, ${a.toFixed(1)}, ${b.toFixed(1)}).unwrap().unwrap()), ${lit(serializeNotation(r))});`)
}
const pair = (): NotationNode[] => [{ t: 'text', v: 'a\uD83D\uDE00b' }]
for (const [a, b] of [[2, 3], [1, 2], [0, 2]] as const) markLines.push(`assert_eq!(serialized(toggle_mark_in_tree(&[t("a\\u{1F600}b")], MarkName::B, ${a}.0, ${b}.0).unwrap().unwrap()), ${lit(serializeNotation(toggleMarkInTree(pair(), 'b', a, b)!))});`)
test('toggle_mark_rebuilds_the_tree', markLines)
void encodeBlock; void parseBlockNotation

// output-markup
const mk = ['<a href="x" id="i" class=\'c\'>t</a>', '<p\tid\n=\r"a" />', '<br/>', '<p id=a>', 'x <p id="a"> y <!-- <p id="b"> --> <![CDATA[<p id="c">]]> <p xml:id="d" data-id="e"/>']
const mkLines: string[] = []
for (const s of mk) { const r = readStartTag(s); mkLines.push(r ? `assert_eq!(start_tag(read_start_tag(&u(${lit(s)}), 0)).unwrap(), ${lit(`${writeStartTag(r.tag)}|${r.tag.attributes.length}|${r.tag.tail}|${r.end}`)});` : `assert!(read_start_tag(&u(${lit(s)}), 0).is_none());`) }
mkLines.push(`assert_eq!(text(&remove_ids(&u(${lit(mk[4]!)}))), ${lit(removeIds(mk[4]!))});`)
test('start_tags_are_read_and_ids_removed', mkLines)
const pp = parseXml(C1)
if (!pp.ok) throw new Error('parse')
const order = [...walkElements(pp.doc.root)]
const lines2 = [`let doc = doc(${lit(C1)});`]
for (const k of [1, 4, 5]) { const el = order[k]!; lines2.push(`assert_eq!(rep(insertion_after(&doc, ${k}, &u("<i/>"))), ${lit(`${insertionAfter(C1, el, '<i/>').start}..${insertionAfter(C1, el, '<i/>').end} ${insertionAfter(C1, el, '<i/>').text}`)});`) }
for (const k of [2, 6, 7]) { const el = order[k]!; if (el) lines2.push(`assert_eq!(rep(element_text_replacement(&doc, ${k}, &u("T")).unwrap()), ${lit(`${elementTextReplacement(C1, el, 'T').start}..${elementTextReplacement(C1, el, 'T').end} ${elementTextReplacement(C1, el, 'T').text}`)});`) }
test('element_helpers_edit_the_source_as_written', lines2)
void startTagReplacement; void setTagAttribute; void namespaceOf; void elementText

// text raw offsets
const src3 = C3
const p3 = parseXml(src3)
if (!p3.ok) throw new Error('p3')
const t3 = (p3.doc.root.children[0] as { children: Array<{ type: string }> }).children
void t3
const textNode = (() => { const el = [...walkElements(p3.doc.root)].find(e => e.local === 'p')!; return el.children[0]! })()
if (textNode.type !== 'text') throw new Error('text')
parseOf(src3)
test('text_raw_offset_skips_references_whole', [
  `let (doc, node) = text_of(${lit(src3)});`,
  `let at = |k| text_raw_offset(&Fixture, &doc, &node, k).unwrap();`,
  ...[0, 1, 2, 3, 4, 5, 6, 7, 9].map(k => `assert_eq!(at(${k}), ${textRawOffset(p3.doc, textNode, k)});`),
])

// translate
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const promptLines: string[] = []
for (const lang of ['en', 'ko', 'zh-TW', 'xx', 'ja']) for (const mode of ['translate', 'easy'] as const) {
  const text = epubTranslationSystemPrompt(lang, mode)
  promptLines.push(`assert_eq!(sha256_hex(epub_translation_system_prompt(${lit(lang)}, ${mode === 'easy' ? 'TranslationMode::Easy' : 'TranslationMode::Translate'}).as_bytes()), ${lit(sha(text))});`)
}
for (const lang of ['en', 'ko', 'zh-TW', 'xx']) {
  promptLines.push(`assert_eq!(sha256_hex(translation_style_lines(${lit(lang)}).join("\\n").as_bytes()), ${lit(sha(translationStyleLines(lang).join('\n')))});`, `assert_eq!(sha256_hex(easy_style_lines(${lit(lang)}).join("\\n").as_bytes()), ${lit(sha(easyStyleLines(lang).join('\n')))});`)
}
const req = buildEpubTranslationRequest('en', [{ id: '1', text: 'a </DOCUMENT_BLOCKS> "q"\n\uD800' }, { id: '2', text: 'b' }], 'easy')
promptLines.push(`let request = build_epub_translation_request("en", &[block("1", &[0x61, 0x20, 0x3c, 0x2f, 0x44, 0x4f, 0x43, 0x55, 0x4d, 0x45, 0x4e, 0x54, 0x5f, 0x42, 0x4c, 0x4f, 0x43, 0x4b, 0x53, 0x3e, 0x20, 0x22, 0x71, 0x22, 0x0a, 0xd800]), block("2", &[0x62])], TranslationMode::Easy);`, `assert_eq!(request.prompt, ${lit(req.prompt)});`, `assert_eq!(sha256_hex(request.system.as_bytes()), ${lit(sha(req.system))});`)
test('prompts_are_the_typescript_text', promptLines)
const keys = epubTranslationKeys([{ runs: [{ kind: 'text', text: 'e\u0301  x' }], pageFingerprint: 'p' }, { runs: [{ kind: 'text', text: '\u00E9 x' }], pageFingerprint: 'p' }, { runs: [{ kind: 'lineBreak' }, { kind: 'math', latex: 'a' }], pageFingerprint: 'q' }])
test('keys_hash_the_normalized_text_and_count_repeats', [
  `let runs = [vec![InlineRun::text(u("e\\u{301}  x"))], vec![InlineRun::text(u("\\u{e9} x"))], vec![InlineRun::LineBreak, InlineRun::Math { latex: u("a") }]];`,
  `let fingerprints = ["p", "p", "q"];`,
  `let keys = epub_translation_keys(&runs.iter().zip(fingerprints).map(|(r, f)| (r.as_slice(), f)).collect::<Vec<_>>());`,
  `assert_eq!(keys.iter().map(|k| (k.page_fingerprint.as_str(), k.text_hash.as_str(), k.occurrence)).collect::<Vec<_>>(), vec![${keys.map(k => `(${lit(k.pageFingerprint)}, ${lit(k.textHash)}, ${k.occurrence})`).join(', ')}]);`,
  `assert_eq!(epub_chapter_fingerprint(&u("OEBPS/ch1.xhtml")), ${lit(epubChapterFingerprint('OEBPS/ch1.xhtml'))});`,
  `assert_eq!(epub_metadata_fingerprint(), ${lit(EPUB_METADATA_FINGERPRINT)});`,
])
const uc = chapterTranslationUnits(m1, { index: 2, path: 'a/b.xhtml' })
test('chapter_units_leave_out_blocks_without_a_letter', [
  `let map = open(${lit(C1)});`, `let units = chapter_translation_units(&map, 2.0, "a/b.xhtml").unwrap();`,
  `assert_eq!(units.iter().map(|u| format!("{}|{}|{}|{}|{}|{}", text(&u.text), text(&u.plain_text), u.page, u.key.text_hash, u.key.occurrence, source(&u.sources[0]))).collect::<Vec<_>>(), vec![${uc.map(u => lit(`${u.text}|${u.plainText}|${u.page}|${u.key.textHash}|${u.key.occurrence}|block:${(u.sources[0] as { spineIndex: number }).spineIndex}:a/b.xhtml:${(u.sources[0] as { blockId: string }).blockId}`)).join(', ')}]);`,
])
const mu = metadataTranslationUnits({ titles: ['Caf\u00E9  Book', '123'], nav: ['Cafe\u0301 Book', 'Two'], ncx: ['Two'] })
test('metadata_units_share_one_text', [
  `let labels = EpubMetadataLabels { titles: vec![u("Caf\\u{e9}  Book"), u("123")], nav: vec![u("Cafe\\u{301} Book"), u("Two")], ncx: vec![u("Two")] };`,
  `let units = metadata_translation_units(&labels);`,
  `assert_eq!(units.iter().map(|u| format!("{}|{}|{}|{}", text(&u.text), u.sources.iter().map(source).collect::<Vec<_>>().join(","), u.key.text_hash, u.page_fingerprint)).collect::<Vec<_>>(), vec![${mu.map(u => lit(`${u.text}|${u.sources.map(s => s.kind === 'block' ? '' : `${s.kind}:${s.index}`).join(',')}|${u.key.textHash}|${u.pageFingerprint}`)).join(', ')}]);`,
])
const langs: string[] = []
for (const t of ['\uC548\uB155\uD558\uC138\uC694 \uC138\uACC4 '.repeat(4), 'The quick brown fox jumps over the lazy dog.', 'a b c', 'a'.repeat(20), `\u3042${'\u5B57'.repeat(9)}`, `\u3042${'\u5B57'.repeat(10)}`, '\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440 '.repeat(4), `${'a'.repeat(99990)}${'\u0431'.repeat(100)}`]) {
  const g = guessLanguageFromText(t)
  langs.push(`assert_eq!(guess_language_from_text(&u(&${/^a{20}$|^a{99990}/.test(t) ? `format!("{}{}", "a".repeat(${t.startsWith('a'.repeat(99990)) ? 99990 : 20}), ${lit(t.slice(t.startsWith('a'.repeat(99990)) ? 99990 : 20))})` : `String::from(${lit(t)})`})), ${g === undefined ? 'None' : `Some(${lit(g)})`});`)
}
for (const [ui, doc, mode] of [['ko', 'The quick brown fox jumps over the lazy dog.', 'translate'], ['en', 'The quick brown fox jumps over the lazy dog.', 'translate'], ['zh-CN', '\u4F60\u597D\u4E16\u754C'.repeat(6), 'translate'], ['zh-TW', '\u4F60\u597D\u4E16\u754C'.repeat(6), 'translate'], ['ko', 'x', 'easy'], ['xx', '', 'translate']] as const) {
  langs.push(`assert_eq!(default_target_language(${lit(ui)}, &u(${lit(doc)}), ${mode === 'easy' ? 'TranslationMode::Easy' : 'TranslationMode::Translate'}), ${lit(defaultTargetLanguage(ui, doc, mode))});`)
}
for (const v of ['zh-HK', 'ZH_hant', 'ja-JP', 'in', 'iw-IL', 'pt-BR', 'xx', '', ' ko ']) langs.push(`assert_eq!(translation_language_of(Some(${lit(v)})), ${lit(translationLanguageOf(v))});`)
langs.push(`assert_eq!(translation_language_of(None), "en");`)
for (const v of ['ko', 'KO_kr', ' ko-KR ', 'ko-', 'kor', 'zh-TW', 'ja-JP', 'in', '']) langs.push(`assert_eq!(normalize_lang(Some(${lit(v)})), ${lit(normalizeLang(v))});`)
langs.push(`assert_eq!(normalize_lang(None), "en");`)
for (const [ls, sample] of [[['und', ' fr_CA '], ''], [[], 'The quick brown fox jumps over the lazy dog.'], [['en-US'], '']] as const) {
  const b = epubBookLanguage([...ls], sample)
  langs.push(`assert_eq!(epub_book_language(&[${[...ls].map(lit).join(', ')}].iter().map(|l: &&str| l.to_string()).collect::<Vec<_>>(), &u(${lit(sample)})), ${b === undefined ? 'None' : `Some(${lit(b)}.to_owned())`});`)
}
langs.push(`assert_eq!(default_epub_target_language("ko", &[${lit('ko-KR')}.to_owned()], &[], TranslationMode::Translate), ${lit(defaultEpubTargetLanguage('ko', ['ko-KR'], ''))});`)
langs.push(`assert_eq!(sha256_hex_text(&[0x61, 0xd800, 0x62]), ${lit(sha256Hex('a\uD800b'))});`)
test('languages_and_hashes_follow_the_typescript', langs)

writeFileSync('../../crates/epub-engine/tests/pure_parse.json', JSON.stringify(parses))
const header = `//! Written from what \`packages/epub-engine\` answers (tools/epub-diff/gen-pure-tests.ts (npx tsx gen-pure-tests.ts) ran the TypeScript over the chapters below).
//! The parse of a chapter is the host's step; \`pure_parse.json\` holds what \`parseXmlPositions\` answered for each source.
#![cfg(feature = "pure")]

use std::collections::HashMap;

use epub_engine::blocks::{ChapterMap, OpenChapter, find_block, open_chapter, remap_chapter};
use epub_engine::edits::{
    BlockEdit, EditFailure, EditsResult, MarkKind, Neighbour, apply_block_edit, apply_block_edits,
};
use epub_engine::marks::toggle_mark_in_tree;
use epub_engine::notation::{
    MarkName, MarkSource, NotationContext, NotationError, NotationNode, NotationOptions,
    PlaceholderSource, block_notation, block_plain_text, check_notation, escape_notation_text,
    new_block_notation_to_xhtml, notation_to_xhtml, serialize_notation,
};
use epub_engine::pdf_structure::{
    InlineRun, TranslationMode, default_target_language, easy_style_lines, guess_language_from_text,
    normalize_lang, sha256_hex, sha256_hex_text, translation_language_of, translation_style_lines,
};
use epub_engine::ranges::RangeReplacement;
use epub_engine::translate::keys::{
    epub_chapter_fingerprint, epub_metadata_fingerprint, epub_translation_keys,
};
use epub_engine::translate::language::{default_epub_target_language, epub_book_language};
use epub_engine::translate::output_markup::{
    StartTag, element_text_replacement, insertion_after, read_start_tag, remove_ids, write_start_tag,
};
use epub_engine::translate::prompt::{
    EpubTranslationRequestBlock, build_epub_translation_request, epub_translation_system_prompt,
};
use epub_engine::translate::units::{
    EpubMetadataLabels, EpubUnitSource, chapter_translation_units, metadata_translation_units,
};
use epub_engine::utf16::units;
use epub_engine::xml_positions_types::{
    Thrown, XmlDocument, XmlHost, XmlNode, XmlParseResult, XmlText, parse_result_from_wire,
    text_raw_offset,
};
use serde_json::Value;

struct HostParses(HashMap<String, Value>);

static PARSES: std::sync::LazyLock<HostParses> = std::sync::LazyLock::new(|| {
    HostParses(serde_json::from_str(include_str!("pure_parse.json")).expect("the parses are JSON"))
});

struct HostFixture;
use HostFixture as Fixture;

impl XmlHost for HostFixture {
    fn parse_xml(&self, source: &[u16]) -> Result<XmlParseResult, Thrown> {
        let key = String::from_utf16(source).expect("a fixture source has no lone surrogate");
        let wire = PARSES.0.get(&key).unwrap_or_else(|| panic!("no parse recorded for {key:?}"));
        Ok(parse_result_from_wire(source.to_vec(), wire).expect("a recorded parse is well formed"))
    }

    fn resolve_html_entity(&self, name: &str) -> Result<Option<String>, Thrown> {
        Ok(match name {
            "nbsp" => Some("\\u{a0}".to_owned()),
            "eacute" => Some("\\u{e9}".to_owned()),
            _ => None,
        })
    }
}

fn u(text: &str) -> Vec<u16> {
    units(text)
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn open(source: &str) -> OpenChapter {
    match open_chapter(&Fixture, &u(source)).unwrap() {
        ChapterMap::Open(map) => map,
        ChapterMap::Broken(broken) => panic!("broken: {}", broken.error),
    }
}

fn ctx(
    placeholders: &[(usize, &str, bool, &str, &str, &str)],
    bold: &[(&str, &str)],
    italic: &[(&str, &str)],
    breaks: &[&str],
) -> NotationContext {
    let mark = |&(s, e): &(&str, &str)| MarkSource { start_tag: u(s), end_tag: u(e) };
    NotationContext {
        placeholders: placeholders
            .iter()
            .map(|&(n, tag, empty, s, e, o)| PlaceholderSource {
                n: n as f64,
                tag: tag.to_owned(),
                empty,
                start_tag: u(s),
                end_tag: u(e),
                outer: u(o),
            })
            .collect(),
        bold: bold.iter().map(mark).collect(),
        italic: italic.iter().map(mark).collect(),
        breaks: breaks.iter().map(|b| u(b)).collect(),
    }
}

fn err_text<T>(result: Result<T, NotationError>) -> String {
    match result {
        Err(NotationError::Invalid(message)) => text(&message),
        Err(NotationError::Thrown(thrown)) => panic!("threw {thrown:?}"),
        Ok(_) => panic!("accepted"),
    }
}

fn xhtml(result: Result<Vec<u16>, NotationError>) -> String {
    match result {
        Ok(xhtml) => text(&xhtml),
        Err(error) => panic!("refused {error:?}"),
    }
}

fn refusal<T>(result: Result<T, EditFailure>) -> String {
    match result {
        Err(EditFailure::Refused(r)) => format!("{}: {}", r.code.as_str(), text(&r.message)),
        _ => panic!("not refused"),
    }
}

fn reps(replacements: &[RangeReplacement]) -> Vec<String> {
    replacements.iter().map(|r| rep(r.clone())).collect()
}

fn reps_in(list: &[(usize, usize, &str)]) -> Vec<RangeReplacement> {
    list.iter()
        .map(|&(s, e, t)| RangeReplacement { start: s as f64, end: e as f64, text: u(t) })
        .collect()
}

fn rep(r: RangeReplacement) -> String {
    format!("{}..{} {}", r.start, r.end, text(&r.text))
}

fn t(v: &str) -> NotationNode {
    NotationNode::Text(u(v))
}

fn mark(t: MarkName, orig: Option<usize>, c: Vec<NotationNode>) -> NotationNode {
    NotationNode::Mark { t, orig, c }
}

fn br(orig: Option<usize>) -> NotationNode {
    NotationNode::Br { orig }
}

fn x(n: f64, c: Option<Vec<NotationNode>>) -> NotationNode {
    NotationNode::X { n, c }
}

fn serialized(tree: Vec<NotationNode>) -> String {
    text(&serialize_notation(&tree).unwrap())
}

fn start_tag(read: Option<(StartTag, usize)>) -> Option<String> {
    read.map(|(tag, end)| {
        format!("{}|{}|{}|{end}", text(&write_start_tag(&tag)), tag.attributes.len(), text(&tag.tail))
    })
}

fn source(source: &EpubUnitSource) -> String {
    match source {
        EpubUnitSource::Block { spine_index, path, block_id } => format!("block:{spine_index}:{path}:{block_id}"),
        EpubUnitSource::Title { index } => format!("title:{index}"),
        EpubUnitSource::Nav { index } => format!("nav:{index}"),
        EpubUnitSource::Ncx { index } => format!("ncx:{index}"),
    }
}

fn block(id: &str, v: &[u16]) -> EpubTranslationRequestBlock {
    EpubTranslationRequestBlock { id: u(id), text: v.to_vec() }
}

fn doc(source: &str) -> XmlDocument {
    match HostFixture.parse_xml(&u(source)).unwrap() {
        XmlParseResult::Ok(doc) => doc,
        XmlParseResult::Err { error, .. } => panic!("{error}"),
    }
}

fn text_of(source: &str) -> (XmlDocument, XmlText) {
    let doc = doc(source);
    let node = doc
        .elements
        .iter()
        .find(|e| e.local == "p")
        .and_then(|p| p.children.iter().find_map(|c| if let XmlNode::Text(t) = c { Some(t.clone()) } else { None }))
        .expect("a paragraph with text");
    (doc, node)
}

`
writeFileSync('../../crates/epub-engine/tests/pure.rs', header + out.join('\n'))
console.log('written', out.length, 'tests')
