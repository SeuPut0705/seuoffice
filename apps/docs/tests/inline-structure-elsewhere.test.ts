import { Editor } from '@tiptap/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseDocx, saveDocx, type ParsedDocFull } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import type { AiDocWriter } from '../src/renderer/ai/doc-writer'
import { executeTool } from '../src/renderer/ai/tools'
import { FindPanel } from '../src/renderer/components/FindPanel'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { mergeAllRecords } from '../src/renderer/mail-merge/template'
import { takeOdtRefusal } from '../src/renderer/odt-gate'

/**
 * Run-level wrappers the editor carries without a model (inline content
 * controls, w:smartTag...) in the places that are not typing: replacing a
 * word, the AI tools, mail merge. The typing side is in
 * inline-wrapper-survival.test.ts.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const deleted = (text: string, id: number) =>
  `<w:del w:id="${id}" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>${text}</w:delText></w:r></w:del>`
const SDT_PR = (lock = '') => `<w:sdtPr><w:tag w:val="due"/><w:id w:val="5"/>${lock}</w:sdtPr>`
const control = (text: string, lock = '') =>
  `<w:sdt>${SDT_PR(lock)}<w:sdtContent>${run(text)}</w:sdtContent></w:sdt>`
const LOCK = '<w:lock w:val="contentLocked"/>'
const SMART_OPEN =
  '<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="place">'
const smart = (text: string) => `${SMART_OPEN}${run(text)}</w:smartTag>`
const OTHER = `<w:p>${run('Other paragraph')}</w:p>`
const NUM_IDS = { bullet: null, ordered: null }

/** the xml with every text run reduced to [its text] */
const skeleton = (xml: string) =>
  xml.replace(/<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g, '[$1]')
const occurrences = (xml: string, part: string) => xml.split(part).length - 1

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  takeOdtRefusal()
})

async function open(bodyXml: string) {
  const source = await buildDocx({ bodyXml })
  const parsed = await parseDocx(source)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  return { editor, parsed, source }
}

async function buildDocxOf(doc: PmNode, parsed: ParsedDocFull): Promise<Uint8Array> {
  return saveDocx(parsed, pmDocToSavePlan(doc, parsed.blocks).saveBlocks)
}

async function savedXml(doc: PmNode, parsed: ParsedDocFull): Promise<string> {
  return (await parseDocx(await buildDocxOf(doc, parsed))).internal.documentXml
}

function texts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(node.textContent))
  return out
}

/** the Find panel on its Replace tab, with `find` and `replacement` typed and the scan done */
function findPanel(editor: Editor, find: string, replacement: string) {
  Element.prototype.scrollIntoView = () => {}
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(FindPanel, { editor, onClose: () => {} })))
  act(() => container.querySelectorAll<HTMLButtonElement>('.find-tab')[1].click())
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = container.querySelectorAll<HTMLInputElement>('.find-input')
  // the scan runs after a pause in typing: the pause passes on a clock the test moves
  vi.useFakeTimers()
  try {
    act(() => type(inputs[0], find))
    act(() => type(inputs[1], replacement))
    act(() => {
      vi.advanceTimersByTime(200)
    })
  } finally {
    vi.useRealTimers()
  }
  const buttons = container.querySelectorAll<HTMLButtonElement>('.find-action')
  return {
    replace: () => act(() => buttons[0].click()),
    replaceAll: () => act(() => buttons[1].click()),
    close() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('replacing a word that is exactly the content of a wrapper', () => {
  const body = (inner: string) => `<w:p>${run('I live in ')}${inner}${run(' now')}</w:p>${OTHER}`

  it('Replace All keeps the smart tag around the new word', async () => {
    const { editor, parsed } = await open(body(smart('Paris')))
    const panel = findPanel(editor, 'Paris', 'London')
    panel.replaceAll()
    panel.close()
    const xml = await savedXml(editor.getJSON() as PmNode, parsed)
    expect(skeleton(xml)).toContain(`[I live in ]${SMART_OPEN}[London]</w:smartTag>[ now]`)
  })

  it('Replace keeps the content control around the new word', async () => {
    const { editor, parsed } = await open(body(control('Paris')))
    const panel = findPanel(editor, 'Paris', 'London')
    panel.replace()
    panel.close()
    const xml = await savedXml(editor.getJSON() as PmNode, parsed)
    expect(occurrences(xml, '<w:sdt>')).toBe(1)
    expect(skeleton(xml)).toContain(
      `<w:sdt>${SDT_PR()}<w:sdtContent>[London]</w:sdtContent></w:sdt>`,
    )
  })

  it('Replace on a match inside a locked control changes nothing and moves on', async () => {
    const { editor, parsed, source } = await open(body(control('Paris', LOCK)))
    const panel = findPanel(editor, 'Paris', 'London')
    panel.replace()
    panel.replaceAll()
    panel.close()
    expect(texts(editor)[0]).toBe('I live in Paris now')
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(await saveDocx(parsed, plan.saveBlocks)).toEqual(source)
  })
})

describe('AI tools and a control locked against editing', () => {
  it('accept_changes applies the others and names the one it left', async () => {
    const { editor } = await open(
      `<w:p>${run('Due on ')}<w:sdt>${SDT_PR(LOCK)}<w:sdtContent>${run('5/6/2024')}${deleted('?', 9)}</w:sdtContent></w:sdt></w:p>` +
        `<w:p>${run('Other ')}${deleted('gone', 11)}</w:p>`,
    )
    const result = await executeTool(
      editor,
      { id: 'ai', name: 'accept_changes', input: { all: true } },
      NUM_IDS,
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/Accepted 1 tracked change/)
    expect(result.output).toMatch(/1 tracked change\(s\).*left.*locked/)
    expect(texts(editor)).toEqual(['Due on 5/6/2024?', 'Other '])
  })

  it('write_document does not replace a document that holds one', async () => {
    const { editor } = await open(`<w:p>${run('Due on ')}${control('5/6/2024', LOCK)}</w:p>`)
    const writer: AiDocWriter = {
      write: async (_spec, onProgress) => {
        onProgress('<p>new</p>')
        return { ok: true, html: '<p>new</p>', truncated: false }
      },
    }
    const result = await executeTool(
      editor,
      { id: 'ai', name: 'write_document', input: { plan: 'p', replaceDocument: true } },
      NUM_IDS,
      undefined,
      undefined,
      null,
      undefined,
      undefined,
      writer,
    )
    expect(result.isError).toBe(true)
    expect(result.mutated).toBeFalsy()
    expect(texts(editor)).toEqual(['Due on 5/6/2024'])
  })
})

describe('mail merge: every letter after the first goes without what carries an id', () => {
  it('writes the content control once, the smart tag in each letter', async () => {
    const { editor, parsed } = await open(
      `<w:p>${run('Dear ')}${control('Ada')}${run(' of ')}${smart('Paris')}${run(' sign')}</w:p>`,
    )
    const merged = mergeAllRecords(editor.getJSON() as PmNode, [{}, {}, {}])
    const xml = await savedXml(merged, parsed)
    expect(occurrences(xml, '<w:p>')).toBe(3)
    expect(occurrences(xml, '<w:sdt>')).toBe(1)
    expect(occurrences(xml, 'w:val="5"')).toBe(1)
    expect(occurrences(xml, SMART_OPEN)).toBe(3)
    // the text of every letter is whole
    const letters = (await parseDocx(await buildDocxOf(merged, parsed))).blocks.map((block) =>
      (block.runs ?? []).map((r) => r.text).join(''),
    )
    expect(letters.filter(Boolean)).toEqual(Array(3).fill('Dear Ada of Paris sign'))
  })
})
