// Group `odtCore` of comparison (f): core/*.ts and assemble/zip.ts of
// packages/odt-engine. The Rust side answers in
// crates/office-wasm/src/calls/odt_core.rs to `odtCore.<TypeScript name>`; the
// convention of the groups is at the top of calls-support.ts. What is particular
// to this group (shapes the Rust side answers with):
//
//   readRoot            text the part. Result `{ name, tag, start, end, attributes, prefixes }` or
//                       `null`; `prefixes` is the list `[prefix, canonical prefix]` of every `xmlns:*`
//                       attribute of the root (the PrefixMap is not plain data).
//   attributeMap        text the tag source; args `nameEnd`, `tagEnd`, `prefixes` = the root attributes
//                       `[{ name, raw }]` the PrefixMap is built from.
//   XmlScanner          text the xml; args `from`, `to`: the tokens `[{ kind, start, end, name, nameEnd }]`.
//   walkElements        text the part; args `prefixes` (as above), `from`, `to`, `skip` (canonical names
//                       whose `open` answers 'skip'), `stopOpen` (canonical name whose `open` answers
//                       'stop'), `stopClose` (the same for `close`). Result: the list of the visitor's
//                       calls in order, then `{ call: 'return', value }`:
//                       `{ call: 'open', name, tag, start, nameEnd, openEnd, selfClosing, parent }`,
//                       `{ call: 'close', name, tag, start, nameEnd, openEnd, closeStart, end, selfClosing, parent }`,
//                       `{ call: 'other', kind, start, end, parent }`, `{ call: 'warn', message }`
//                       (`parent` is the canonical name of the parent frame or null).
//   scanOdtBody         text the content.xml. Result `{ text, blocks, warnings, prefixes }`, each node
//                       `{ kind, name, tag, start, openEnd, closeStart, end, nameEnd, selfClosing,
//                       attrs, attributes, children }` (parent links dropped).
//   nodesOfKind         text the content.xml; args `kind`: the nodes of `scanOdtBody(text)` of that kind.
//   walkNodes           text the content.xml; args `skipKinds`: the `start` of each node visited, in order,
//                       a node of a kind in `skipKinds` answering `false`.
//   pairBookmarks,      text the content.xml: the pairs of `scanOdtBody(text)`, a node as its `start`
//   pairAnnotations     (`null` for none).
//   anchorType,         args `attrs`: the decoded attributes of the node (`OdtNode.attr` reads them).
//   cellSpan, bookmarkName
//   readOdtStyles       text the styles.xml (`args.missing` for null); args `contentXml`. Result
//                       `{ all, masterPages, containers }`, the public fields of the table.
//   OdtStyleTable.resolve  text the styles.xml; args `contentXml`, `name`, `family`, `scope`.
//   createBridgeMap     args `doc`: `{ generator: { name, producer } }`.
//   editedItems         args `edited`: `{ blocks }` of a parsed docx (the first 40 blocks).
//   paragraphBlockOf    args `item`: an EditedItem.
//   crc32 / readDocxPart  bytes as `{ $bytes }`. dosDateTime: args `ms`, the local time of the host (UTC).//
//   odtCore.constant   args `name`: the value of the exported constant of that name of the group (or the
//        answer of a function that takes nothing); the names are the keys of the spec at the end of this file.

import type { Block } from '../docx-diff/reference/index'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import {
  type Args,
  bytesArg,
  bytesOf,
  contentWith,
  distinct,
  nameEndOf,
  rootPrefixes,
  startTags,
  textRuns,
  constantSpec,
} from './calls-support'
import { buildZip } from '../docx-diff/package-zips'
import { REAL_BLOCKS, firstOf, withFields } from './real-model'
import { surrogateClasses } from './listed'
import * as ts from './ts'

const xml = ts.coreXml
const part = (parts: ReadonlyMap<string, string>, name: string): string | undefined =>
  parts.get(name)

const rootAttributes = rootPrefixes

function prefixMapOf(attributes: unknown): ts.coreXml.PrefixMap {
  const list = (attributes ?? []) as Array<{ name: string; raw: string }>
  return new xml.PrefixMap(
    list.map((a) => ({ name: a.name, raw: a.raw, nameStart: 0, valueStart: 0, valueEnd: 0 })),
  )
}

const prefixList = (
  attributes: Array<{ name: string; raw: string }>,
  map: ts.coreXml.PrefixMap,
): Array<[string, string]> =>
  attributes
    .filter((a) => a.name.startsWith('xmlns:'))
    .map((a) => {
      const prefix = a.name.slice(6)
      return [prefix, map.canonical(`${prefix}:x`).split(':')[0]!]
    })

/** The parts of an ODT in the corpus documents, whichever of them the document has. */
const odfParts = (parts: ReadonlyMap<string, string>): string[] =>
  ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml'].flatMap((n) =>
    parts.has(n) ? [parts.get(n)!] : [],
  )

const PREFIXED =
  '<a:root xmlns:a="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:z="urn:unknown"><t:x a:name="1"/><a:p z:q="2">text<a:s/></a:p></a:root>'

const ENTITY_TEXTS = [
  '',
  'plain',
  '&amp;&lt;&gt;&quot;&apos;',
  '&amp;amp;',
  '&#65;&#x42;&#X43;',
  '&#0;&#1;',
  '&#x10FFFF;&#x110000;&#1114111;&#1114112;',
  '&#xD800;&#xDFFF;',
  '&#x1F600;',
  '&unknown;&Amp;&AMP;',
  '&;&#;&#x;&#xZZ;',
  'a & b',
  '&#99999999999999999999;',
  '&#-5;',
  '&#x-5;',
  '\ud55c\uae00 &amp; \ud83d\ude00 &#xAC00;',
  '&#12345678901234567890123;',
  '&lt',
  'tail &amp',
  '&#65',
]

const ESCAPE_TEXTS = [
  '',
  'plain',
  'a & b < c > d "q" \'s\'',
  '\u0000\u0001\u0008\u000b\u000c\u000e\u001f',
  '\t\n\r',
  '\ud55c\uae00 \ud83d\ude00 \u0131\u017f\u212a',
  '&amp; already',
  ']]>',
  '\u007f\u0080\u00a0\ufeff\ufffe\uffff',
]

const TAG_CASES: Array<[tag: string, extra?: Args]> = [
  ['<a b="1" c=\'2\'>'],
  ['<a b=1 c=2>'],
  ['<a b c="3">'],
  ['<a b = "1" c\n=\t\'2\'/>'],
  ['<a b="1>2" c="3">'],
  ['<a b="unterminated>'],
  ['<a b="1"c="2">'],
  ['<a =x b="1">'],
  ['<a b="1" b="2">'],
  ['<text:p text:style-name="\ud55c\uae00" xml:id=\'x\'/>'],
  ['<a b="&amp;&lt;">'],
  ['<a/>'],
  ['<a>'],
  ['<a  \n >'],
  ['<a b=\'"\' c="\'">'],
  ['<a b="1" /c="2">'],
]

const TEXT_ODFS = [
  '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text><text:p>x</text:p></office:text></office:body></office:document-content>',
  PREFIXED,
  '<?xml version="1.0"?><!DOCTYPE a><!-- c --><r xmlns:x="urn:x"/>',
  '<a><b></a></b>',
  '<a><b>',
  '</a><a/>',
  '<a><![CDATA[ <b> ]]><?pi x?>text</a>',
  '',
  'no markup at all',
  '<r xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:tx="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><tx:p/><text:p/></r>',
  '<\ud55c\uae00 \uc18d\uc131="\uac12">\ub0b4\uc6a9</\ud55c\uae00>',
]

function walkInputs(text: string): Input[] {
  const prefixes = rootAttributes(text)
  const names = distinct(
    [...text.matchAll(/<([A-Za-z][\w:.-]*)/g)].map((m) => m[1]!),
    40,
  )
  const base: Input = { text, args: { prefixes } }
  const out: Input[] = [base]
  const pick = (index: number): string | undefined => names[index % Math.max(1, names.length)]
  if (names.length > 2) {
    out.push({ text, args: { prefixes, skip: [pick(2)!] } })
    out.push({ text, args: { prefixes, stopOpen: pick(4)! } })
    out.push({ text, args: { prefixes, stopClose: pick(3)! } })
    out.push({
      text,
      args: { prefixes, from: Math.floor(text.length / 3), to: Math.floor((text.length * 2) / 3) },
    })
  }
  return out
}

function walkRecord(text: string, args: Args): unknown {
  const prefixes = prefixMapOf(args.prefixes)
  const skip = new Set((args.skip as string[] | undefined) ?? [])
  const calls: unknown[] = []
  const parentOf = (parent: ts.coreXml.ElementFrame | null): string | null =>
    parent ? parent.name : null
  const frame = (el: ts.coreXml.ElementFrame) => ({
    name: el.name,
    tag: el.tag,
    start: el.start,
    nameEnd: el.nameEnd,
    openEnd: el.openEnd,
    selfClosing: el.selfClosing,
  })
  const value = xml.walkElements(
    text,
    prefixes,
    {
      open(el, parent) {
        calls.push({ call: 'open', ...frame(el), parent: parentOf(parent) })
        if (args.stopOpen !== undefined && el.name === args.stopOpen) return 'stop'
        if (skip.has(el.name)) return 'skip'
        return undefined
      },
      close(el, parent) {
        calls.push({
          call: 'close',
          ...frame(el),
          closeStart: el.closeStart,
          end: el.end,
          parent: parentOf(parent),
        })
        if (args.stopClose !== undefined && el.name === args.stopClose) return 'stop'
        return undefined
      },
      other(kind, start, end, parent) {
        calls.push({ call: 'other', kind, start, end, parent: parentOf(parent) })
      },
      warn(message) {
        calls.push({ call: 'warn', message })
      },
    },
    args.from as number | undefined,
    args.to as number | undefined,
  )
  calls.push({ call: 'return', value })
  return calls
}

function projectNode(node: ts.coreBody.OdtNode): unknown {
  return {
    kind: node.kind,
    name: node.name,
    tag: node.tag,
    start: node.start,
    openEnd: node.openEnd,
    closeStart: node.closeStart,
    end: node.end,
    nameEnd: node.nameEnd,
    selfClosing: node.selfClosing,
    attrs: node.attrs,
    attributes: node.attributes(),
    children: node.children.map(projectNode),
  }
}

/** `scanOdtBody` of the text, or the message it throws with. */
const scan = (text: string): ts.coreBody.OdtBody => ts.coreBody.scanOdtBody(text)

const OBJECT_BODY = contentWith(
  '<text:p text:style-name="P1">a<text:bookmark text:name="b1"/><text:bookmark-start text:name="r"/>mid<text:bookmark-end text:name="r"/><text:bookmark-end text:name="orphan"/><text:bookmark-start text:name="open"/></text:p>' +
    '<office:annotation office:name="m1"><text:p>memo</text:p></office:annotation>x<office:annotation-end office:name="m1"/>' +
    '<office:annotation><text:p>no name</text:p></office:annotation><office:annotation-end office:name="lonely"/>' +
    '<table:table><table:table-row><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="x"><text:p>c</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table>' +
    '<draw:frame text:anchor-type="paragraph"><draw:image xlink:href="Pictures/a.png"/></draw:frame><text:list><text:list-item><text:p>l</text:p></text:list-item></text:list><!-- c --><?pi x?><![CDATA[x]]>',
)

const WITH_BOOKMARKS = [
  OBJECT_BODY,
  contentWith(
    '<text:p><text:bookmark-start text:name="a"/><text:bookmark-start text:name="a"/><text:bookmark-end text:name="a"/><text:bookmark-end text:name="a"/><text:bookmark-end text:name="a"/></text:p>',
  ),
  contentWith(
    '<text:p><office:annotation office:name="a"/><office:annotation office:name="a"/><office:annotation-end office:name="a"/><office:annotation-end office:name="a"/></text:p>',
  ),
  contentWith(''),
  contentWith('<text:p>&amp;<text:bookmark text:name="&lt;&amp;\ud55c"/></text:p>'),
]

const MANIFESTS = [
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.text" manifest:full-path="/" manifest:version="1.3"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="content.xml"/><manifest:file-entry manifest:full-path="x"/></manifest:manifest>',
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:media-type="a" manifest:full-path="content.xml"><manifest:encryption-data manifest:checksum="A"><manifest:algorithm/></manifest:encryption-data></manifest:file-entry><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>',
  '<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="/" m:media-type="x"/></m:manifest>',
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="&lt;a&amp;&gt;" manifest:media-type="\ud55c"/></manifest:manifest>',
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
  'not xml',
  '',
]

const GENERATORS = [
  'hwp/hangul/13, 0, 0, 711/Windows_10',
  'LibreOffice/7.6.2.1$Linux',
  'OpenOffice.org/3.0',
  'StarOffice/8',
  'MicrosoftOffice/16.0 MSWORD',
  'Google Docs',
  'Polaris Office',
  'HANCOM Office',
  'ODFDOM/0.8.9',
  'x',
  '',
  'LIBREOFFICE',
  'hangul',
  'hwp',
  ' hwp/x',
  '\ud55c\uae00',
]

const META_XMLS = [
  '<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator>hwp/hangul/13, 0, 0, 711/Windows_10</meta:generator></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator> LibreOffice/7 &amp; <b>x</b> </meta:generator><meta:generator>second</meta:generator></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator/></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:meta/></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:m="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><m:generator>Microsoft Word</m:generator></office:meta></office:document-meta>',
  'text',
  '',
]

const DOCX_ZIPS: Uint8Array[] = [
  buildZip([
    {
      name: 'word/document.xml',
      data: '<w:document>\ud55c\uae00 \ud83d\ude00</w:document>',
      method: 8,
    },
    { name: 'x/\ud55c\uae00.xml', data: '<a/>', method: 0 },
  ]),
  buildZip([{ name: 'word/styles.xml', data: '', method: 0 }]),
  new TextEncoder().encode('not a zip'),
]

const bytesCases: Uint8Array[] = [
  new Uint8Array(),
  new Uint8Array([0]),
  new TextEncoder().encode('123456789'),
  new TextEncoder().encode('\ud55c\uae00 \ud83d\ude00'),
  new Uint8Array(1000).map((_, i) => (i * 31) & 0xff),
  new Uint8Array(256).map((_, i) => i),
]

function editedBlocks(blocks: Block[]): Block[] {
  return JSON.parse(JSON.stringify(blocks.slice(0, 40))) as Block[]
}

export const CORE: CallSpec[] = [
  {
    fn: 'odtCore.decodeXmlEntities',
    listed: surrogateClasses,
    call: (text) => xml.decodeXmlEntities(text),
    fromDocument: (parts) =>
      odfParts(parts)
        .flatMap((p) =>
          textRuns(p).concat(
            distinct(
              [...p.matchAll(/="([^"]*&[^"]*)"/g)].map((m) => m[1]!),
              20,
            ),
          ),
        )
        .map((text) => ({ text })),
    built: ENTITY_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'odtCore.escapeXmlText',
    call: (text) => xml.escapeXmlText(text),
    fromDocument: (parts) =>
      odfParts(parts)
        .flatMap((p) => textRuns(p))
        .map((text) => ({ text: xml.decodeXmlEntities(text) })),
    built: ESCAPE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'odtCore.escapeXmlAttr',
    call: (text) => xml.escapeXmlAttr(text),
    fromDocument: (parts) =>
      odfParts(parts)
        .flatMap((p) => textRuns(p))
        .map((text) => ({ text: xml.decodeXmlEntities(text) })),
    built: ESCAPE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'odtCore.readAttributes',
    listed: surrogateClasses,
    call: (text, args) => xml.readAttributes(text, args.nameEnd as number, args.tagEnd as number),
    fromDocument: (parts) =>
      odfParts(parts)
        .flatMap((p) => startTags(p, 30))
        .map((tag) => ({ text: tag, args: { nameEnd: nameEndOf(tag), tagEnd: tag.length } })),
    built: [
      ...TAG_CASES.map(([tag]) => ({
        text: tag,
        args: { nameEnd: nameEndOf(tag), tagEnd: tag.length },
      })),
      { text: '<a b="1" c="2">', args: { nameEnd: 2, tagEnd: 9 } },
      { text: '<a b="1" c="2">', args: { nameEnd: 0, tagEnd: 15 } },
      { text: '<a b="1" c="2">', args: { nameEnd: 5, tagEnd: 3 } },
      { text: '', args: { nameEnd: 0, tagEnd: 0 } },
      { text: '<a \ud83d\ude00="\ud83d\ude00">', args: { nameEnd: 2, tagEnd: 11 } },
    ],
  },
  {
    fn: 'odtCore.attributeMap',
    listed: surrogateClasses,
    call: (text, args) =>
      xml.attributeMap(
        text,
        args.nameEnd as number,
        args.tagEnd as number,
        prefixMapOf(args.prefixes),
      ),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      const attributes = content === undefined ? [] : rootAttributes(content)
      return startTags(content ?? '', 30).map((tag) => ({
        text: tag,
        args: { nameEnd: nameEndOf(tag), tagEnd: tag.length, prefixes: attributes },
      }))
    },
    built: [
      ...TAG_CASES.map(([tag]) => ({
        text: tag,
        args: {
          nameEnd: nameEndOf(tag),
          tagEnd: tag.length,
          prefixes: [{ name: 'xmlns:z', raw: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0' }],
        },
      })),
      {
        text: '<a z:p="1" text:p="2" y:p="3">',
        args: {
          nameEnd: 2,
          tagEnd: 30,
          prefixes: [{ name: 'xmlns:z', raw: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0' }],
        },
      },
      {
        text: '<a z:p="1" text:p="2">',
        args: {
          nameEnd: 2,
          tagEnd: 22,
          prefixes: [
            { name: 'xmlns:z', raw: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0' },
            { name: 'xmlns:text', raw: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0' },
          ],
        },
      },
      {
        text: '<a __proto__="1" constructor="2" toString="3">',
        args: { nameEnd: 2, tagEnd: 46, prefixes: [] },
      },
      {
        text: '<a z:p="&amp;&#65;">',
        args: {
          nameEnd: 2,
          tagEnd: 20,
          prefixes: [{ name: 'xmlns:z', raw: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0' }],
        },
      },
    ],
  },
  {
    fn: 'odtCore.readRoot',
    call: (text) => {
      const root = xml.readRoot(text)
      if (!root) return null
      return {
        name: root.name,
        tag: root.tag,
        start: root.start,
        end: root.end,
        attributes: root.attributes,
        prefixes: prefixList(
          root.attributes.map((a) => ({ name: a.name, raw: a.raw })),
          root.prefixes,
        ),
      }
    },
    fromDocument: (parts) => odfParts(parts).map((text) => ({ text })),
    built: TEXT_ODFS.map((text) => ({ text })),
  },
  {
    fn: 'odtCore.XmlScanner',
    listed: surrogateClasses,
    call: (text, args) => {
      const scanner = new xml.XmlScanner(
        text,
        args.from as number | undefined,
        args.to as number | undefined,
      )
      const tokens: unknown[] = []
      while (scanner.next())
        tokens.push({
          kind: scanner.kind,
          start: scanner.start,
          end: scanner.end,
          name: scanner.name,
          nameEnd: scanner.nameEnd,
        })
      return tokens
    },
    fromDocument: (parts) =>
      odfParts(parts).flatMap((p) => [
        { text: p.length > 20000 ? p.slice(0, 20000) : p, args: {} },
        {
          text: p.length > 20000 ? p.slice(0, 20000) : p,
          args: { from: Math.floor(p.length / 3), to: Math.floor(Math.min(p.length, 20000) / 2) },
        },
      ]),
    built: TEXT_ODFS.flatMap((text) => [
      { text, args: {} },
      { text, args: { from: 3, to: Math.max(3, text.length - 3) } },
    ]),
  },
  {
    fn: 'odtCore.walkElements',
    call: (text, args) => walkRecord(text, args),
    fromDocument: (parts) =>
      odfParts(parts).flatMap((p) => walkInputs(p.length > 20000 ? p.slice(0, 20000) : p)),
    built: TEXT_ODFS.flatMap((text) => walkInputs(text)),
  },
  {
    fn: 'odtCore.scanOdtBody',
    call: (text) => {
      const body = scan(text)
      return {
        text: body.text,
        blocks: body.blocks.map(projectNode),
        warnings: body.warnings,
        prefixes: prefixList(rootAttributes(text), body.prefixes),
      }
    },
    fromDocument: (parts) =>
      part(parts, 'content.xml') === undefined ? [] : [{ text: part(parts, 'content.xml')! }],
    built: [
      ...WITH_BOOKMARKS,
      ...TEXT_ODFS,
      contentWith('<text:p>unclosed'),
      contentWith('</text:p>stray<text:p/>'),
      contentWith(
        '<text:h text:outline-level="1">h</text:h><draw:custom-shape/><text:section/><dr3d:scene/>',
      ),
    ].map((text) => ({ text })),
  },
  {
    fn: 'odtCore.sliceNode',
    call: (text, args) =>
      ts.coreBody.sliceNode(
        text,
        args.node as {
          start: number
          openEnd: number
          closeStart: number
          end: number
          selfClosing: boolean
        },
      ),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      try {
        return scan(content)
          .blocks.slice(0, 25)
          .map((n) => ({
            text: content,
            args: {
              node: {
                start: n.start,
                openEnd: n.openEnd,
                closeStart: n.closeStart,
                end: n.end,
                selfClosing: n.selfClosing,
              },
            },
          }))
      } catch {
        return []
      }
    },
    built: [
      {
        text: 'abcdef',
        args: { node: { start: 1, openEnd: 2, closeStart: 4, end: 5, selfClosing: false } },
      },
      {
        text: 'abcdef',
        args: { node: { start: 0, openEnd: 6, closeStart: 6, end: 6, selfClosing: true } },
      },
      {
        text: 'abcdef',
        args: { node: { start: 4, openEnd: 4, closeStart: 4, end: 2, selfClosing: true } },
      },
      {
        text: '\ud55c\uae00\ud83d\ude00x',
        args: { node: { start: 2, openEnd: 3, closeStart: 3, end: 5, selfClosing: false } },
      },
      {
        text: 'abc',
        args: { node: { start: -1, openEnd: 0, closeStart: 0, end: 99, selfClosing: false } },
      },
    ],
  },
  {
    fn: 'odtCore.nodesOfKind',
    call: (text, args) =>
      ts.coreBody
        .nodesOfKind(scan(text).blocks, args.kind as ts.coreBody.OdtNodeKind)
        .map(projectNode),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      return content === undefined
        ? []
        : ['paragraph', 'table', 'frame', 'bookmark', 'note'].map((kind) => ({
            text: content,
            args: { kind },
          }))
    },
    built: [
      'paragraph',
      'table-cell',
      'bookmark-start',
      'annotation',
      'list-item',
      'shape',
      'nothing',
    ].map((kind) => ({ text: OBJECT_BODY, args: { kind } })),
  },
  {
    fn: 'odtCore.walkNodes',
    call: (text, args) => {
      const skip = new Set((args.skipKinds as string[]) ?? [])
      const visited: number[] = []
      ts.coreBody.walkNodes(scan(text).blocks, (node) => {
        visited.push(node.start)
        return skip.has(node.kind) ? false : undefined
      })
      return visited
    },
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      return content === undefined
        ? []
        : [
            { text: content, args: { skipKinds: [] } },
            { text: content, args: { skipKinds: ['table', 'list'] } },
          ]
    },
    built: [[], ['table'], ['paragraph', 'list'], ['frame', 'annotation']].map((skipKinds) => ({
      text: OBJECT_BODY,
      args: { skipKinds },
    })),
  },
  {
    fn: 'odtCore.pairBookmarks',
    call: (text) =>
      ts.coreBody.pairBookmarks(scan(text)).map((p) => ({
        name: p.name,
        start: p.start?.start ?? null,
        end: p.end?.start ?? null,
        point: p.point?.start ?? null,
      })),
    fromDocument: (parts) =>
      part(parts, 'content.xml') === undefined ? [] : [{ text: part(parts, 'content.xml')! }],
    built: WITH_BOOKMARKS.map((text) => ({ text })),
  },
  {
    fn: 'odtCore.pairAnnotations',
    call: (text) =>
      ts.coreBody
        .pairAnnotations(scan(text))
        .map((p) => ({ name: p.name, annotation: p.annotation.start, end: p.end?.start ?? null })),
    fromDocument: (parts) =>
      part(parts, 'content.xml') === undefined ? [] : [{ text: part(parts, 'content.xml')! }],
    built: WITH_BOOKMARKS.map((text) => ({ text })),
  },
  ...(['anchorType', 'cellSpan', 'bookmarkName'] as const).map((name): CallSpec => ({
    fn: `odtCore.${name}`,
    call: (_text, args) => {
      const attrs = (args.attrs ?? {}) as Record<string, string>
      const node = { attr: (key: string) => attrs[key] } as unknown as ts.coreBody.OdtNode
      return ts.coreBody[name](node)
    },
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      try {
        return scan(content)
          .blocks.slice(0, 40)
          .map((n) => ({ args: { attrs: n.attrs } }))
      } catch {
        return []
      }
    },
    built: [
      {
        'text:anchor-type': 'as-char',
        'text:name': 'a',
        'table:number-columns-spanned': '3',
        'table:number-rows-spanned': '2',
      },
      {
        'text:anchor-type': 'page',
        'text:name': '',
        'table:number-columns-spanned': '0',
        'table:number-rows-spanned': '-1',
      },
      { 'table:number-columns-spanned': 'x', 'table:number-rows-spanned': '2.9' },
      {
        'table:number-columns-spanned': ' 4',
        'table:number-rows-spanned': '5abc',
        'text:name': '\ud55c\uae00',
      },
      {},
    ].map((attrs) => ({ args: { attrs } })),
    mutation: 'none',
  })),
  {
    fn: 'odtCore.readManifest',
    listed: surrogateClasses,
    call: (text) => ts.coreManifest.readManifest(text),
    fromDocument: (parts) =>
      part(parts, 'META-INF/manifest.xml') === undefined
        ? []
        : [{ text: part(parts, 'META-INF/manifest.xml')! }],
    built: MANIFESTS.map((text) => ({ text })),
  },
  {
    fn: 'odtCore.classifyGenerator',
    call: (text, args) => ts.coreMeta.classifyGenerator(args.missing ? null : text),
    fromDocument: (parts) =>
      part(parts, 'meta.xml') === undefined
        ? []
        : [
            {
              text: ts.coreMeta.detectGenerator(part(parts, 'meta.xml')).name ?? '',
              args: { missing: ts.coreMeta.detectGenerator(part(parts, 'meta.xml')).name === null },
            },
          ],
    built: [...GENERATORS.map((text) => ({ text })), { text: '', args: { missing: true } }],
  },
  {
    fn: 'odtCore.detectGenerator',
    call: (text, args) => ts.coreMeta.detectGenerator(args.missing ? null : text),
    fromDocument: (parts) =>
      part(parts, 'meta.xml') === undefined ? [] : [{ text: part(parts, 'meta.xml')! }],
    built: [...META_XMLS.map((text) => ({ text })), { text: '', args: { missing: true } }],
  },
  {
    fn: 'odtCore.readOdtStyles',
    call: (text, args) => {
      const table = ts.coreStyles.readOdtStyles(
        args.missing ? null : text,
        args.contentXml as string,
      )
      return { all: table.all, masterPages: table.masterPages, containers: table.containers }
    },
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      const styles = part(parts, 'styles.xml')
      return [
        styles === undefined
          ? { text: '', args: { missing: true, contentXml: content } }
          : { text: styles, args: { contentXml: content } },
      ]
    },
    built: [
      { text: '', args: { missing: true, contentXml: contentWith('') } },
      { text: '', args: { contentXml: '' } },
      {
        text: '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:font-face-decls><style:font-face style:name="F" svg:font-family="\'Malgun Gothic\'" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"/></office:font-face-decls><office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:text-align="start"/></style:default-style><style:style style:name="A &amp; B" style:display-name="AB" style:family="paragraph" style:parent-style-name="Missing" style:next-style-name="B" style:default-outline-level="2"><style:paragraph-properties fo:margin-left="1cm"><style:tab-stops><style:tab-stop style:position="1cm"/></style:tab-stops></style:paragraph-properties><style:text-properties fo:font-weight="bold"/></style:style><text:list-style style:name="L"><text:list-level-style-number text:level="1" style:num-format="1"/><text:list-level-style-bullet text:level="2" text:bullet-char="x"/></text:list-style><text:outline-style style:name="O"><text:outline-level-style text:level="1"/></text:outline-style></office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm"><style:columns fo:column-count="2"/></style:page-layout-properties><style:header-style><style:header-footer-properties svg:height="1cm"/></style:header-style></style:page-layout><style:style style:name="P1" style:family="paragraph" style:master-page-name="M"/></office:automatic-styles><office:master-styles><style:master-page style:name="M" style:page-layout-name="pm1"><style:header><text:p/></style:header><style:footer-first><text:p/></style:footer-first></style:master-page></office:master-styles></office:document-styles>',
        args: { contentXml: contentWith('') },
      },
    ].map(({ text, args }) => ({ text, args })),
  },
  {
    fn: 'odtCore.OdtStyleTable.resolve',
    listed: surrogateClasses,
    call: (text, args) => {
      const table = ts.coreStyles.readOdtStyles(text, args.contentXml as string)
      return (
        table.resolve(
          args.name as string,
          args.family as string,
          args.scope as 'content' | 'styles',
        ) ?? null
      )
    },
    fromDocument: (parts) => {
      const styles = part(parts, 'styles.xml')
      const content = part(parts, 'content.xml')
      if (styles === undefined || content === undefined) return []
      const table = ts.coreStyles.readOdtStyles(styles, content)
      return table.all
        .filter((s) => s.kind === 'style' && s.family !== null)
        .slice(0, 30)
        .map((s) => ({
          text: styles,
          args: {
            contentXml: content,
            name: s.name,
            family: s.family,
            scope: s.part === 'content.xml' ? 'content' : 'styles',
          },
        }))
    },
    built: [],
  },
  {
    fn: 'odtCore.createBridgeMap',
    call: (_text, args) =>
      ts.coreConvert.createBridgeMap(args.doc as Pick<ts.coreOpen.OdtDocument, 'generator'>),
    built: [
      { name: null, producer: 'unknown' },
      { name: 'hwp/hangul/13', producer: 'hancom' },
      { name: '\ud55c\uae00', producer: 'other' },
    ].map((generator) => ({ args: { doc: { generator } } })),
    mutation: 'none',
  },
  {
    fn: 'odtCore.paragraphIdentityName',
    call: (_text, args) => ts.coreConvert.paragraphIdentityName(args.id as number),
    built: [0, 1, 7, 12345, 4294967295, 1e21].map((id) => ({ args: { id } })),
    mutation: 'none',
  },
  {
    fn: 'odtCore.markerBookmarkName',
    call: (_text, args) =>
      ts.coreConvert.markerBookmarkName(args.id as number, args.index as number),
    built: [
      [0, 0],
      [3, 2],
      [10, 100],
      [1e21, 5],
    ].map(([id, index]) => ({ args: { id, index } })),
    mutation: 'none',
  },
  {
    fn: 'odtCore.paragraphIdFromBookmarks',
    call: (_text, args) =>
      ts.coreConvert.paragraphIdFromBookmarks(
        args.names === null ? undefined : (args.names as string[]),
      ),
    built: [
      ['_odtp3'],
      ['x', '_odtp12', '_odtp7'],
      ['_odtp'],
      ['_odtp3x'],
      ['_ODTP3'],
      [],
      ['_odtm3_1'],
      ['_odtp007'],
      ['_odtp99999999999999999999'],
      ['a', 'b'],
    ]
      .map((names) => ({ args: { names } }))
      .concat([{ args: { names: null as never } }]),
    mutation: 'none',
  },
  {
    fn: 'odtCore.unquoteFamily',
    call: (text) => ts.coreConvert.unquoteFamily(text),
    fromDocument: (parts) =>
      odfParts(parts)
        .flatMap((p) =>
          [...p.matchAll(/font-family\w*="([^"]*)"/g)].map((m) => ({
            text: xml.decodeXmlEntities(m[1]!),
          })),
        )
        .slice(0, 40),
    built: texts0([
      "'Malgun Gothic'",
      '"Arial"',
      'Arial',
      "'",
      "''",
      '\'a"',
      "  'x'  ",
      '',
      "\u00a0'x'",
      "'\ud55c\uae00'",
    ]),
  },
  {
    fn: 'odtCore.applyTextPatches',
    call: (text, args) =>
      ts.coreConvert.applyTextPatches(text, args.patches as ts.coreConvert.TextPatch[]),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      const spots = distinct(
        [...content.matchAll(/<text:p[ >]/g)].map((m) => m.index!),
        6,
      )
      return [
        {
          text: content,
          args: {
            patches: spots.map((at) => ({
              part: 'content.xml',
              start: at,
              end: at,
              xml: '<!--x-->',
            })),
          },
        },
        {
          text: content,
          args: {
            patches: spots
              .slice(0, 2)
              .map((at) => ({ part: 'content.xml', start: at, end: at + 3, xml: '\ud55c' })),
          },
        },
      ]
    },
    built: [
      { text: 'abcdef', args: { patches: [] } },
      {
        text: 'abcdef',
        args: {
          patches: [
            { part: 'content.xml', start: 1, end: 3, xml: 'X' },
            { part: 'content.xml', start: 4, end: 4, xml: 'Y' },
          ],
        },
      },
      {
        text: 'abcdef',
        args: {
          patches: [
            { part: 'content.xml', start: 4, end: 4, xml: 'Y' },
            { part: 'content.xml', start: 4, end: 4, xml: 'Z' },
            { part: 'content.xml', start: 0, end: 2, xml: '' },
          ],
        },
      },
      {
        text: 'abcdef',
        args: {
          patches: [
            { part: 'content.xml', start: 1, end: 4, xml: 'X' },
            { part: 'content.xml', start: 2, end: 3, xml: 'Y' },
          ],
        },
      },
      {
        text: 'abcdef',
        args: {
          patches: [
            { part: 'styles.xml', start: 6, end: 6, xml: '!' },
            { part: 'styles.xml', start: 99, end: 99, xml: '?' },
          ],
        },
      },
      {
        text: '\ud55c\uae00\ud83d\ude00',
        args: { patches: [{ part: 'content.xml', start: 2, end: 2, xml: '-' }] },
      },
    ],
    mutation: 'none',
  },
  {
    fn: 'odtCore.readDocxPart',
    call: async (text, args) => ts.coreDocxPackage.readDocxPart(bytesOf(args.bytes), text),
    built: DOCX_ZIPS.flatMap((zip) =>
      ['word/document.xml', 'word/styles.xml', 'x/\ud55c\uae00.xml', ''].map((text) => ({
        text,
        args: { bytes: bytesArg(zip) },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtCore.crc32',
    call: (_text, args) => ts.assembleZip.crc32(bytesOf(args.bytes)),
    built: bytesCases.map((bytes) => ({ args: { bytes: bytesArg(bytes) } })),
    mutation: 'none',
  },
  {
    fn: 'odtCore.dosDateTime',
    call: (_text, args) => ts.assembleZip.dosDateTime(new Date(args.ms as number)),
    built: [
      0,
      315532800000,
      Date.UTC(2026, 10, 12, 3, 4, 6),
      Date.UTC(1979, 11, 31, 23, 59, 59),
      Date.UTC(2107, 11, 31, 23, 59, 59),
      Date.UTC(2200, 0, 1),
      1e12,
      Date.UTC(2024, 1, 29, 12, 30, 31),
    ].map((ms) => ({ args: { ms } })),
    mutation: 'none',
  },
  {
    fn: 'odtCore.editedItems',
    call: (_text, args) => ts.coreFlow.editedItems(args.edited as { blocks: Block[] }),
    fromModel: (doc) => [{ args: { edited: { blocks: editedBlocks(doc.blocks) } } }],
    built: [
      { blocks: [] },
      {
        blocks: [
          withFields(firstOf('paragraph'), { docxIndex: 0 }),
          withFields(firstOf('paragraph'), { docxIndex: 0 }),
          withFields(firstOf('table'), { docxIndex: 1, hidden: true }),
          withFields(firstOf('heading'), { docxIndex: 2 }),
          withFields(firstOf('paragraph'), { docxIndex: null, originalXml: null }),
        ],
      },
      {
        blocks: [
          withFields(firstOf('paragraph'), { docxIndex: 3 }),
          withFields(firstOf('paragraph'), { docxIndex: 3 }),
          withFields(firstOf('image'), { docxIndex: 4 }),
          withFields(firstOf('paragraph'), { docxIndex: null }),
          withFields(firstOf('table'), { docxIndex: 5, originalXml: null }),
        ],
      },
      { blocks: REAL_BLOCKS.slice(0, 12) },
    ].map((edited) => ({ args: { edited } })),
    mutation: 'none',
  },
  {
    fn: 'odtCore.paragraphBlockOf',
    call: (_text, args) => ts.coreFlow.paragraphBlockOf(args.item as ts.coreConvert.EditedItem),
    built: [
      { index: 0, xml: '<w:p/>', blocks: [firstOf('paragraph')] },
      { index: 1, xml: '<w:p/>', blocks: [firstOf('heading')] },
      { index: 2, xml: '<w:p/>', blocks: [withFields(firstOf('paragraph'), { type: 'listItem' })] },
      { index: 3, xml: '<w:tbl/>', blocks: [firstOf('table')] },
      { index: 4, xml: '', blocks: [] },
      { index: 5, xml: '', blocks: [firstOf('paragraph'), firstOf('paragraph')] },
      { index: 6, xml: '', blocks: [firstOf('image')] },
    ].map((item) => ({ args: { item } })),
    mutation: 'none',
  },
  constantSpec('odtCore', {
    ODT_MIMETYPE: () => ts.ODT_MIMETYPE,
    BRIDGE_MAP_VERSION: () => ts.coreConvert.BRIDGE_MAP_VERSION,
    ODF_NAMESPACES: () => ts.coreXml.ODF_NAMESPACES,
    BRIDGE_DOCUMENT_NAMESPACES: () => ts.coreDocxPackage.BRIDGE_DOCUMENT_NAMESPACES,
    ODT_TEXT_MEDIA_TYPE: () => ts.corePackage.ODT_TEXT_MEDIA_TYPE,
    ODT_ZIP_LIMITS: () => ts.corePackage.ODT_ZIP_LIMITS,
    ODT_NODE_KINDS: () => ts.coreBody.ODT_NODE_KINDS,
  }),
]

function texts0(list: string[]): Input[] {
  return list.map((text) => ({ text }))
}
