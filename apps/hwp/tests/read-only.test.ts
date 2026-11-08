/**
 * The read-only studio of a page opened only to view a document (studio-plugin/read-only.mjs):
 * which commands it keeps, and the engine document guard that stops every change whatever path
 * reaches it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import {
  READ_ONLY_ATTRIBUTE,
  askedReadOnly,
  readOnlyAllows,
  readOnlyDocument,
} from '../studio-plugin/read-only.mjs'

const require = createRequire(import.meta.url)
const CORE = dirname(require.resolve('@rhwp/core'))

beforeAll(async () => {
  await init({ module_or_path: readFileSync(join(CORE, 'rhwp_bg.wasm')) })
})

function open(name: string): HwpDocument {
  return new HwpDocument(new Uint8Array(readFileSync(join(__dirname, 'fixtures', name))))
}

describe('a read-only engine document', () => {
  it('refuses every change and keeps the text, while the plain document takes them', () => {
    const plain = open('memo.hwp')
    const guarded = readOnlyDocument(open('memo.hwp'))
    try {
      const text = guarded.getTextFileText()
      const changes: Array<[string, (doc: HwpDocument) => unknown]> = [
        ['insertText', (doc) => doc.insertText(0, 0, 0, 'SEU')],
        ['deleteText', (doc) => doc.deleteText(0, 0, 0, 1)],
        ['splitParagraph', (doc) => doc.splitParagraph(0, 0, 1)],
        ['applyCharFormat', (doc) => doc.applyCharFormat(0, 0, 0, 1, '{"bold":true}')],
        ['replaceAll', (doc) => doc.replaceAll(text.trim().slice(0, 1), 'X', false)],
      ]
      for (const [call, change] of changes) {
        expect(() => change(guarded), call).toThrow(`read-only document: ${call}`)
      }
      expect(guarded.getTextFileText()).toBe(text)

      for (const [, change] of changes) change(plain)
      expect(plain.getTextFileText()).not.toBe(text)
    } finally {
      plain.free()
      guarded.free()
    }
  })

  it('still shows, finds, copies, moves the caret and exports', () => {
    const doc = readOnlyDocument(open('memo.hwp'))
    try {
      const text = doc.getTextFileText()
      expect(doc.pageCount()).toBeGreaterThan(0)
      expect(doc.renderPageSvg(0)).toContain('<svg')
      expect(JSON.parse(doc.getCursorRect(0, 0, 0))).toHaveProperty('pageIndex', 0)
      expect(() => doc.moveVertical(0, 0, 0, 1, -1, -1, -1, -1, -1)).not.toThrow()
      expect(() => doc.searchText(text.trim().slice(0, 1), 0, 0, 0, true, false)).not.toThrow()
      expect(() => doc.copySelection(0, 0, 0, 0, 1)).not.toThrow()
      const saved = new HwpDocument(doc.exportHwp())
      try {
        expect(saved.getTextFileText()).toBe(text)
      } finally {
        saved.free()
      }
    } finally {
      doc.free()
    }
  })

  it('takes a call it does not know, as a later engine may add, for a change', () => {
    class Engine {
      pageCount(): number {
        return 1
      }
      reshapeEverything(): string {
        return 'changed'
      }
    }
    const doc = readOnlyDocument(new Engine())
    expect(doc.pageCount()).toBe(1)
    expect(() => doc.reshapeEverything()).toThrow('read-only document: reshapeEverything')
  })

  // the studio's own list of the document-changing calls, where a build has fetched it
  const registry = join(
    __dirname,
    '..',
    'node_modules',
    '.cache',
    'rhwp-studio',
    JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).rhwp.tag,
    'rhwp-studio/src/core/mutation-method-registry.ts',
  )
  it.skipIf(!existsSync(registry))(
    'refuses every call the studio itself counts as a change',
    () => {
      const listed = readFileSync(registry, 'utf8').split('export const MUTATING_METHODS')[1]
      const mutating = [...listed.split('];')[0].matchAll(/'(\w+)'/g)].map((match) => match[1])
      const engineCalls = mutating.filter((call) => call in HwpDocument.prototype)
      expect(engineCalls.length).toBeGreaterThan(100)
      const doc = readOnlyDocument(open('memo.hwp'))
      try {
        for (const call of engineCalls) {
          const change = (doc as unknown as Record<string, () => unknown>)[call]
          expect(() => change(), call).toThrow(`read-only document: ${call}`)
        }
      } finally {
        doc.free()
      }
    },
  )
})

describe('a read-only studio', () => {
  it('keeps the commands that read and drops the ones that edit', () => {
    for (const command of [
      'edit:copy',
      'edit:select-all',
      'edit:find',
      'edit:find-again',
      'view:zoom-in',
      'view:para-mark',
      'ext:ieum-save',
    ]) {
      expect(readOnlyAllows(command), command).toBe(true)
    }
    for (const command of [
      'edit:undo',
      'edit:redo',
      'edit:cut',
      'edit:paste',
      'edit:delete',
      'edit:find-replace',
      'edit:format-paste',
      'format:bold',
      'insert:table',
      'table:insert-row-below',
      'page:setup',
      'file:page-setup',
      'view:form-mode',
    ]) {
      expect(readOnlyAllows(command), command).toBe(false)
    }
  })

  it('is asked for by its parent page only', () => {
    const page = (marked: boolean) => ({
      document: {
        documentElement: { hasAttribute: (name: string) => marked && name === READ_ONLY_ATTRIBUTE },
      },
    })
    const frameIn = (parent: unknown) => ({ parent }) as unknown as Window
    expect(askedReadOnly(frameIn(page(true)))).toBe(true)
    expect(askedReadOnly(frameIn(page(false)))).toBe(false)
    // a top-level studio is its own parent
    const top = { ...page(true) } as unknown as Window & { parent: unknown }
    top.parent = top
    expect(askedReadOnly(top)).toBe(false)
    // a parent on another origin throws on reading its document
    const foreign = {
      get document(): never {
        throw new DOMException('Blocked a frame', 'SecurityError')
      },
    }
    expect(askedReadOnly(frameIn(foreign))).toBe(false)
  })
})
