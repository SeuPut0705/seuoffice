import { parseDocx } from '@genoffice/docx-engine'
import type { Json } from '@seuoffice/collab/client'
import { getSchema } from '@tiptap/core'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { MARK_ATTRS, NODE_ATTRS, type AttrClass, type Fields } from '../src/web/collab-attr-classes'
import { safeNode, safeStep } from '../src/web/collab-safety'
import { safeNode as nodeByKey, safeStep as stepByKey } from './helpers/collab-safety-by-key'
import { fixtureDocx } from './helpers/fixture-docx'

type JsonObject = { [key: string]: Json }

const schema = getSchema(editorExtensions)

/** whether the rules leave `json` as it is; a value they change or cannot make safe is refused */
function kept(safe: (json: Json) => Json, json: Json): boolean {
  try {
    return safe(json) === json
  } catch {
    return false
  }
}

describe('the table of attribute classes', () => {
  it('names every attribute of every node and mark type of the schema, and no other', () => {
    const problems: string[] = []
    const compare = (
      kind: 'node' | 'mark',
      table: { readonly [type: string]: Fields },
      types: { [name: string]: { spec: { attrs?: { [name: string]: unknown } | null } } },
    ) => {
      for (const [type, { spec }] of Object.entries(types)) {
        if (!Object.hasOwn(table, type)) {
          problems.push(`${kind} type ${type} has no entry`)
          continue
        }
        const declared = Object.keys(spec.attrs ?? {})
        for (const attr of declared)
          if (!Object.hasOwn(table[type], attr)) problems.push(`${type}.${attr} has no class`)
        for (const attr of Object.keys(table[type]))
          if (!declared.includes(attr))
            problems.push(`${type}.${attr} is classed, but the schema has no such attribute`)
      }
      for (const type of Object.keys(table))
        if (!Object.hasOwn(types, type))
          problems.push(`${kind} type ${type} is classed, but the schema has no such ${kind}`)
    }
    compare('node', NODE_ATTRS, schema.nodes)
    compare('mark', MARK_ATTRS, schema.marks)
    expect(problems).toEqual([])
  })

  it('gives an attribute name one class on every node type, so an attribute step can be judged', () => {
    // an attribute step names the attribute, not the node it lands on
    const classes = new Map<string, AttrClass>()
    const problems: string[] = []
    for (const [type, fields] of Object.entries(NODE_ATTRS)) {
      for (const [attr, cls] of Object.entries(fields)) {
        if (classes.has(attr) && classes.get(attr) !== cls)
          problems.push(`${type}.${attr} differs from the class ${attr} has on another node type`)
        classes.set(attr, cls)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('what the table does not name', () => {
  const paragraph = (attrs: JsonObject): Json => ({ type: 'docParagraph', attrs })
  const insert = (node: Json): Json => ({
    stepType: 'replace',
    from: 0,
    to: 0,
    slice: { content: [node] },
  })

  it('is refused: an attribute, in a pasted node, on a mark and set on its own', () => {
    const plain = insert(paragraph({ align: 'center' }))
    expect(safeStep(plain)).toBe(plain)

    // even a harmless value: nothing is guessed from the name or the value
    const unknown = insert(paragraph({ align: 'center', noSuchAttribute: 1 }))
    expect(safeStep(unknown)).toEqual(plain)
    const onMark = insert({
      type: 'docParagraph',
      content: [{ type: 'text', text: 'a', marks: [{ type: 'bold', attrs: { weight: 700 } }] }],
    })
    expect(kept(safeStep, onMark)).toBe(false)
    const set = { stepType: 'attr', pos: 0, attr: 'noSuchAttribute', value: 'x' }
    expect(safeStep(set)).toEqual({ ...set, value: null })
  })

  it('cannot be made safe: a node or mark type the schema lacks', () => {
    expect(() => safeStep(insert({ type: 'noSuchNode', attrs: {} }))).toThrow()
    expect(() =>
      safeStep({ stepType: 'addMark', from: 1, to: 2, mark: { type: 'noSuchMark' } }),
    ).toThrow()
    // a type named after something every object inherits is no entry either
    expect(() => safeStep(insert({ type: 'constructor', attrs: {} }))).toThrow()
    expect(() => safeNode({ type: 'toString' })).toThrow()
  })
})

/** values a hostile peer sends: each would end a declaration, open markup, run or load something */
const HOSTILE = [
  '000;position:fixed;inset:0;background:url(https://evil.example/beacon)',
  '<img src="x" onerror="alert(1)"><style>body{display:none}</style>',
  'x" onmouseover="alert(1)',
  "x';position:fixed;'",
  'javascript:alert(1)',
  `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')}`,
  'x\n;position:fixed',
  'expression(alert(1))',
  '@import url(https://evil.example/x.css)',
  'a/*',
  'a\\b',
  '}body{display:none',
]

/**
 * Where the table is looser than the rules that judged by the key's name, on
 * purpose: each is a value the old rules blanked although no page draws it as
 * anything but text, or draws it at all. `leaf`: the name that holds the value.
 */
const LOOSENED: { type: string; attr: string; leaf: string }[] = []

const loosened = (type: string, attr: string, leaf: string): boolean =>
  LOOSENED.some((l) => l.type === type && l.attr === attr && l.leaf === leaf)

/** one value of a node or mark, and what it becomes with `value` in its place */
interface Probe {
  /** `node type.attribute`, or `mark type.attribute` */
  type: string
  attr: string
  /** the name that holds the replaced value: the attribute, or a field inside it */
  leaf: string
  where: string
  /** the node (a text node carrying the mark) with the value replaced */
  with(value: Json): Json
}

const asNode = (type: string, attrs: JsonObject): Json => ({ type, attrs })
const asMark = (type: string, attrs: JsonObject): Json => ({
  type: 'text',
  text: 'x',
  marks: [{ type, attrs }],
})

/** `value` with what sits at `path` replaced; a `'#'` step reads the JSON text there and writes it back */
function replaced(value: Json, path: (string | number)[], put: Json): Json {
  if (path.length === 0) return put
  const [head, ...rest] = path
  if (head === '#') return JSON.stringify(replaced(JSON.parse(value as string) as Json, rest, put))
  if (Array.isArray(value))
    return value.map((item, i) => (i === head ? replaced(item, rest, put) : item))
  const object = value as JsonObject
  return { ...object, [head]: replaced(object[head], rest, put) }
}

/** every scalar inside `value`, through arrays, objects and JSON text */
function leaves(value: Json, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, [...path, i]))
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...path, key]))
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      return [path, ...leaves(JSON.parse(value) as Json, [...path, '#'])]
    } catch {
      return [path]
    }
  }
  return [path]
}

/** the probes a document offers: every value of every attribute its nodes and marks carry */
function probesOf(doc: Json, seen: Set<string>): Probe[] {
  const out: Probe[] = []
  const add = (type: string, attrs: JsonObject, wrap: (attrs: JsonObject) => Json) => {
    for (const [attr, value] of Object.entries(attrs)) {
      for (const path of leaves(value)) {
        // one probe per shape: array positions do not make a new one
        const where = `${type}.${attr}${path.map((p) => (typeof p === 'number' ? '[]' : `.${p}`)).join('')}`
        if (seen.has(where)) continue
        seen.add(where)
        const names = path.filter((p): p is string => typeof p === 'string' && p !== '#')
        out.push({
          type,
          attr,
          leaf: names.at(-1) ?? attr,
          where,
          with: (put) => wrap({ ...attrs, [attr]: replaced(value, path, put) }),
        })
      }
    }
  }
  const visit = (node: Json) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    if (typeof node.type === 'string' && node.attrs && typeof node.attrs === 'object')
      add(node.type, node.attrs as JsonObject, (attrs) => asNode(node.type as string, attrs))
    for (const mark of (node.marks as JsonObject[] | undefined) ?? [])
      add(mark.type as string, (mark.attrs ?? {}) as JsonObject, (attrs) =>
        asMark(mark.type as string, attrs),
      )
    for (const child of (node.content as Json[] | undefined) ?? []) visit(child)
  }
  visit(doc)
  return out
}

/** every field name a table classes, at any depth */
function classedNames(tables: { readonly [type: string]: Fields }[]): string[] {
  const names = new Set<string>()
  const done = new Set<Fields>()
  const walk = (fields: Fields) => {
    if (done.has(fields)) return
    done.add(fields)
    for (const [name, cls] of Object.entries(fields)) {
      names.add(name)
      if (typeof cls === 'object') walk(cls.fields)
    }
  }
  for (const table of tables) for (const fields of Object.values(table)) walk(fields)
  return [...names]
}

describe('next to the rules that judged an attribute by the name of its key', () => {
  it('the table refuses every hostile value they refused, in every value of the fixture documents', async () => {
    const seen = new Set<string>()
    const looser: string[] = []
    let probes = 0
    let refusedByKey = 0
    for (const path of fixtureDocx()) {
      let parsed
      try {
        parsed = await parseDocx(new Uint8Array(readFileSync(path)))
      } catch {
        // the encrypted fixtures and the deliberately broken ones
        continue
      }
      const doc = JSON.parse(JSON.stringify(blocksToPmDoc(parsed.blocks))) as Json
      for (const probe of probesOf(doc, seen)) {
        probes++
        for (const value of HOSTILE) {
          const node = probe.with(value)
          if (kept((json) => nodeByKey(json, {}), node)) continue
          refusedByKey++
          if (kept(safeNode, node) && !loosened(probe.type, probe.attr, probe.leaf))
            looser.push(`${probe.where} = ${JSON.stringify(value)}`)
        }
      }
    }
    expect(looser).toEqual([])
    // the documents really offered values, and the old rules really refused most of them
    expect(probes).toBeGreaterThan(1500)
    expect(refusedByKey).toBeGreaterThan(probes)
  }, 300_000)

  it('and in every attribute of the schema, whatever shape and field name carries the value', () => {
    // A field name matters only below an attribute the table gives a structure: there the
    // value sits under every name any table classes. Below the others every name is a token.
    const classed = [...classedNames([NODE_ATTRS, MARK_ATTRS]), 'noSuchField']
    const few = ['text', 'xml', 'href', 'dataUrl', 'paras', 'noSuchField']
    // one value per way out: a declaration, markup, a script link, a line break
    const short = [HOSTILE[0], HOSTILE[1], HOSTILE[4], HOSTILE[6]]
    const shapes: ((name: string, value: Json) => Json)[] = [
      (_, value) => value,
      (_, value) => [value],
      (name, value) => ({ [name]: value }),
      (name, value) => [{ [name]: value }],
      (name, value) => ({ [name]: [value] }),
      (name, value) => ({ inner: { [name]: value } }),
      (name, value) => JSON.stringify({ [name]: value }),
      (name, value) => JSON.stringify([{ [name]: [value] }]),
    ]
    const looser: string[] = []
    let refusedByKey = 0
    const judge = (
      where: string,
      type: string,
      attr: string,
      leaf: string,
      json: Json,
      byKey: (json: Json) => Json,
      byTable: (json: Json) => Json,
    ) => {
      if (kept(byKey, json)) return
      refusedByKey++
      if (kept(byTable, json) && !loosened(type, attr, leaf)) looser.push(where)
    }
    const each = (
      types: { [name: string]: { spec: { attrs?: { [name: string]: unknown } | null } } },
      table: { readonly [type: string]: Fields },
      wrap: (type: string, attrs: JsonObject) => Json,
      step: boolean,
    ) => {
      for (const [type, { spec }] of Object.entries(types)) {
        for (const attr of Object.keys(spec.attrs ?? {})) {
          const names = typeof table[type]?.[attr] === 'object' ? classed : few
          for (const [s, shape] of shapes.entries()) {
            // the first two shapes carry no field name
            for (const name of s < 2 ? [attr] : names) {
              for (const value of s < 2 ? HOSTILE : short) {
                const held = shape(name, value)
                const where = `${type}.${attr} shape ${s} ${name} = ${JSON.stringify(value)}`
                const node = wrap(type, { [attr]: held })
                judge(where, type, attr, name, node, (json) => nodeByKey(json, {}), safeNode)
                if (!step) continue
                // the same value set by an attribute step
                const set = { stepType: 'attr', pos: 0, attr, value: held }
                judge(`step ${where}`, type, attr, name, set, stepByKey, safeStep)
              }
            }
          }
        }
      }
    }
    each(schema.nodes, NODE_ATTRS, asNode, true)
    each(schema.marks, MARK_ATTRS, asMark, false)
    expect(looser).toEqual([])
    expect(refusedByKey).toBeGreaterThan(100_000)
  }, 300_000)
})
