// Shared by the (f) specs of calls-odt*.ts.
//
// The wire convention of the groups (C3-PLAN.md, "Comparison (f)"): `text` is
// the first string parameter the function reads (empty when there is none),
// every other parameter is `args.<its TypeScript name>`. A `Uint8Array` crosses
// as `{ "$bytes": base64 }` in the arguments and in the result, a `Map` as its
// entries, a `Set` as its values, `undefined` as no value, a throw as an error.
// A parameter that may be `null` or `undefined` and is the one `text` stands for
// is absent as `args.missing = true`. A class instance a function takes or
// gives crosses as the plain data it is made of (each spec says which).
import { tagTokens } from '../docx-diff/fragments'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import * as ts from './ts'

export type Args = Record<string, unknown>

export const bytesArg = (bytes: Uint8Array): { $bytes: string } => ({
  $bytes: Buffer.from(bytes).toString('base64'),
})

/** The bytes of a `{ "$bytes" }` argument. */
export function bytesOf(value: unknown): Uint8Array {
  const base64 = (value as { $bytes: string }).$bytes
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/** A result in the wire's form: bytes as `$bytes`, a Map as its entries, a Set as its values. */
export function wire(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesArg(value)
  if (value instanceof Map) return [...value].map(([k, v]) => [wire(k), wire(v)])
  if (value instanceof Set) return [...value].map(wire)
  if (Array.isArray(value)) return value.map(wire)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wire(v)]))
  }
  return value
}

export const texts = (list: readonly string[]): Input[] => list.map((text) => ({ text }))

/** Distinct values of `list`, the first `cap`. */
export function distinct<T>(list: Iterable<T>, cap = 30): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of list) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= cap) break
  }
  return out
}

/** The start tags (open and self-closing) of `xml`, as slices. */
export function startTags(xml: string, cap = 40): string[] {
  const out: string[] = []
  for (const tag of tagTokens(xml)) {
    if (!tag.closing) out.push(xml.slice(tag.start, tag.end))
  }
  return distinct(out, cap)
}

/** The text between tags (entity references intact), not blank. */
export function textRuns(xml: string, cap = 40): string[] {
  return distinct(
    [...xml.matchAll(/>([^<>]+)</g)].map((m) => m[1]!).filter((t) => t.trim() !== ''),
    cap,
  )
}

/** Every value of an attribute called `name` (raw, as written). */
export function attributeValues(xml: string, name: string, cap = 30): string[] {
  const re = new RegExp(`\\b${name.replace(/[:.-]/g, (c) => '\\' + c)}="([^"]*)"`, 'g')
  return distinct(
    [...xml.matchAll(re)].map((m) => m[1]!),
    cap,
  )
}

export const ODT_PART_NAMES = [
  'content.xml',
  'styles.xml',
  'meta.xml',
  'META-INF/manifest.xml',
] as const

/** The attributes of a start tag `<name a="1" b='2'>` as `[name, raw]` pairs, as readAttributes reads the plain ones. */
export function rawAttributes(tag: string): Array<[string, string]> {
  return [...tag.matchAll(/\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
    m[1]!,
    m[2] ?? m[3] ?? '',
  ])
}

/** `<name ...>` → where the name ends (the `nameEnd` readAttributes takes). */
export const nameEndOf = (tag: string): number => /^<[^\s/>]*/.exec(tag)![0].length

/** Mixed XML text a function reading markup is given, written for what a corpus lacks. */
export const SAMPLE_BODY =
  '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0">' +
  '<office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style></office:automatic-styles>' +
  '<office:body><office:text>'

export const SAMPLE_TAIL = '</office:text></office:body></office:document-content>'

/** A content.xml around `inner`. */
export const contentWith = (inner: string): string => SAMPLE_BODY + inner + SAMPLE_TAIL

/** The root attributes `[{ name, raw }]` a PrefixMap is made of. */
export function rootPrefixes(text: string): Array<{ name: string; raw: string }> {
  const root = ts.coreXml.readRoot(text)
  return root ? root.attributes.map((a) => ({ name: a.name, raw: a.raw })) : []
}

/**
 * The exported constants of a group (and the functions that take nothing and
 * give the same answer every time) as one spec: `<group>.constant`, selected by
 * `args.name`. The Rust side answers each name with the value of its constant.
 * A constant has one value, so it is the set of names that gives the spec its
 * distinct results.
 */
export function constantSpec(group: string, constants: Record<string, () => unknown>): CallSpec {
  return {
    fn: `${group}.constant`,
    call: (_text, args) => wire(constants[args.name as string]!()),
    built: Object.keys(constants).map((name) => ({ args: { name } })),
    mutation: 'none',
  }
}
