/**
 * ODT documents in the Word editor: switched-off features (every entry point
 * refuses with the notice; docx documents are untouched), Hancom's protected
 * cells and locked placeholders (user, AI and MCP edits all refused), paste
 * and AI inserts of switched-off kinds keep what they show, label boxes for
 * placeholders without a preview (screen, print notice, Save As docx).
 * Runs the real file actions on a real editor with a stub main process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'
import { buildBlankDocx, parseDocx, readDocxPartBase64 } from '@genoffice/docx-engine'
import { odtToDocx } from '@genoffice/odt-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { cleanOdtPaste } from '../src/renderer/editor/odt-guard'
import type { DocState } from '../src/renderer/doc-state'
import type { OpenDocxResult } from '../src/shared/ipc'
import { setFormatChangeHost } from '../src/renderer/components/format-change-bus'
import { setModuleLang, t } from '../src/renderer/i18n/locale'
import { ODT_OFF_FEATURES, isOdtSession, odtOffProps, refuseInOdt } from '../src/renderer/odt-gate'
import { AGENT_TOOLS, executeTool } from '../src/renderer/ai/tools'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import { ATTACHMENT_CARD_ICONS } from '../src/renderer/ai/AiPanel'
import { CommentsPanel } from '../src/renderer/components/CommentsPanel'
import { ProtectDialog } from '../src/renderer/components/ProtectDialog'
import {
  buildOdt,
  type OdtFixtureEntry,
} from '../../../packages/odt-engine/tests/helpers/build-odt'
import {
  FORMULA_CONTENT_XML,
  hAnnotation,
  hCell,
  hCustomShape,
  hPara,
  hParaWith,
  hRow,
  hTable,
} from '../../../packages/odt-engine/tests/helpers/hancom-fragments'

const handoff = new Map<string, Uint8Array>()
vi.mock('../src/renderer/doc-bytes', () => ({
  fetchDocBytes: async (url: string) => {
    const bytes = handoff.get(url)
    if (!bytes) throw new Error(`no bytes for ${url}`)
    handoff.delete(url)
    return bytes.slice()
  },
}))

const toast = vi.fn()
vi.mock('../src/renderer/components/toast-bus', () => ({
  showToast: (...args: unknown[]) => toast(...args),
  setToastEmitter: () => {},
}))

/** jsdom has no canvas: the label picture is a fixed PNG here */
const LABEL_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const labelPng = vi.fn(async () => LABEL_PNG)
vi.mock('../src/renderer/odt-label-png', () => ({
  renderLabelPng: (...args: unknown[]) => labelPng(...(args as [])),
}))

const { loadFile, save, printDoc } = await import('../src/renderer/file-actions')
const { installMcpBridge } = await import('../src/renderer/mcp-bridge')
type Ctx = Parameters<typeof loadFile>[0]

let urlSeq = 0
function openResult(path: string, bytes: Uint8Array): OpenDocxResult {
  const url = `test-bytes://${++urlSeq}`
  handoff.set(url, bytes)
  return { path, name: path.split('/').pop() ?? path, dataUrl: url, hash: 'h' }
}

let written: Array<{ channel: string; path: string; bytes: Uint8Array }> = []
let pickedPath: string | null = null

function installDesktop(): void {
  written = []
  const record = (channel: string) => async (path: string, data: ArrayBuffer) => {
    written.push({ channel, path, bytes: new Uint8Array(data) })
    return { ok: true, path }
  }
  ;(window as unknown as { desktop: unknown }).desktop = {
    getRecentFiles: vi.fn(async () => []),
    getSystemLocale: vi.fn(async () => 'en-US'),
    docPasswordIntentRevision: vi.fn(async () => 0),
    discardDocPasswordIntents: vi.fn(async () => ({ ok: true })),
    saveDocx: vi.fn(record('save')),
    saveDocxTo: vi.fn(record('save-to')),
    saveDocxNew: vi.fn(record('save-new')),
    saveDocxAs: vi.fn(record('save-as')),
    writeRecoveryCopy: vi.fn(record('recovery')),
    pickSaveAsPath: vi.fn(async () => (pickedPath ? { path: pickedPath } : null)),
    openDocxPath: vi.fn(async (path: string) => {
      const last = [...written].reverse().find((w) => w.path === path)
      return last ? openResult(path, last.bytes) : null
    }),
    captureRect: vi.fn(async () => null),
    materializeDocx: vi.fn(async () => null),
  }
}

const editors: Editor[] = []

function makeCtx(): Ctx {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
  const state: Record<string, unknown> = {
    editor,
    doc: null as DocState | null,
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    pendingMixedExportRef: { current: false },
    printAutoOpenedPreviewRef: { current: false },
    section: null,
    sectionDirty: false,
    sections: [],
    sectionsDirty: [],
    trailingStartType: null,
    pageColor: null,
    pageColorDirty: false,
    header: null,
    headerDirty: false,
    footer: null,
    footerDirty: false,
    hfVariants: {},
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    titlePg: false,
    titlePgDirty: false,
    evenOddHf: false,
    evenOddHfDirty: false,
    mirrorMargins: false,
    mirrorMarginsDirty: false,
    pgNumEdit: null,
    pgNumDirtySections: [],
    pendingNumbering: { newDefs: [], restartNums: [], levelEdits: [], picBullets: [] },
    numberingDirty: false,
    styleUpserts: {},
    comments: [],
    commentsDirty: false,
    watermark: null,
    watermarkDirty: false,
    watermarkStyle: null,
    watermarkPicture: null,
    inkAnnotations: [],
    inksDirty: false,
    footnotes: [],
    endnotes: [],
    notesDirty: false,
    sources: [],
    sourcesDirty: false,
    zoteroDocumentData: '',
    zoteroDocumentDataDirty: false,
    themeFonts: null,
    themeFontsDirty: false,
    themeColors: null,
    themeColorsDirty: false,
    protection: null,
    protectionDirty: false,
    writeProtection: null,
    writeProtectionDirty: false,
    removePersonalInfo: false,
    removePersonalInfoDirty: false,
    setDoc: (next: unknown) => {
      state.doc = typeof next === 'function' ? (next as (p: unknown) => unknown)(state.doc) : next
    },
    setComments: (next: unknown) => {
      state.comments =
        typeof next === 'function' ? (next as (p: unknown) => unknown)(state.comments) : next
    },
  }
  return new Proxy(state, {
    get(target, key) {
      if (
        typeof key === 'string' &&
        !(key in target) &&
        key !== 'settleFontSettings' &&
        /^(set|on|prompt|bump)/.test(key)
      )
        return () => {}
      return target[key as string]
    },
  }) as unknown as Ctx
}

const docOf = (ctx: Ctx): DocState => (ctx as unknown as { doc: DocState }).doc
const editorOf = (ctx: Ctx): Editor => (ctx as unknown as { editor: Editor }).editor

// ---- the ODT under test: a protected cell, two placeholders without preview, a comment ----

/** a formula object with no replacement picture: the neutral placeholder */
const formula =
  '<draw:frame draw:style-name="gr20" svg:width="2.000cm" svg:height="0.600cm" draw:z-index="30" text:anchor-type="as-char">' +
  '<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '</draw:frame>'
const formulaEntries: OdtFixtureEntry[] = [
  { name: 'Object 1/content.xml', data: FORMULA_CONTENT_XML, mediaType: 'text/xml' },
  { name: 'Object 1/', data: '', mediaType: 'application/vnd.oasis.opendocument.formula' },
]
const shape = hCustomShape('도형 글')
const memo = hAnnotation('memo1', '메모 내용', '메모가 달린 글')

async function sampleOdt(bodyOverride?: string): Promise<Uint8Array> {
  const body =
    bodyOverride ??
    hPara('첫 문단') +
      hTable('Table1', 2, [
        hRow([hCell(hPara('LOCKED'), { protected: true }), hCell(hPara('FREE'))]),
        hRow([hCell(hPara('가')), hCell(hPara('나'))]),
      ]) +
      hParaWith(`식 ${formula} 끝`) +
      hParaWith(shape.shape) +
      hParaWith(`앞 ${memo.xml} 뒤`)
  // JSZip does not recognise TextEncoder output across the jsdom realm (see odt-open-save)
  const Native = globalThis.TextEncoder
  class RealmEncoder extends Native {
    encode(input?: string): Uint8Array<ArrayBuffer> {
      return new Uint8Array(super.encode(input))
    }
  }
  globalThis.TextEncoder = RealmEncoder
  try {
    return await buildOdt({ body, extraEntries: formulaEntries })
  } finally {
    globalThis.TextEncoder = Native
  }
}

async function openSample(): Promise<Ctx> {
  const ctx = makeCtx()
  expect(await loadFile(ctx, openResult('/docs/hancom.odt', await sampleOdt()))).toBe('ok')
  return ctx
}

async function openDocx(): Promise<Ctx> {
  const ctx = makeCtx()
  expect(await loadFile(ctx, openResult('/docs/plain.docx', await buildBlankDocx({})))).toBe('ok')
  return ctx
}

/** position just inside the text `text` (first match) */
function textPos(doc: PmNode, text: string): number {
  let at = -1
  doc.descendants((node, pos) => {
    if (at >= 0) return false
    if (node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text)
    return true
  })
  if (at < 0) throw new Error(`no text ${text}`)
  return at
}

/** the placeholder pictures: [pos, node] */
function placeholders(doc: PmNode): Array<[number, PmNode]> {
  const out: Array<[number, PmNode]> = []
  doc.descendants((node, pos) => {
    const xmlName = /name="(odt-keep:[^"]+)"/.exec(String(node.attrs?.xml ?? ''))
    if (xmlName || (node.type.name === 'docProtected' && node.attrs.blockType === 'image'))
      out.push([pos, node])
    return true
  })
  return out
}

function tableBlockIndex(doc: PmNode): number {
  let index = -1
  doc.forEach((node, _offset, i) => {
    if (index < 0 && node.type.name === 'docTable') index = i
  })
  return index
}

const toastTexts = () => toast.mock.calls.map((c) => c[0] as string)

beforeEach(() => {
  ;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
  setModuleLang('ko')
  installDesktop()
  toast.mockClear()
  labelPng.mockClear()
  pickedPath = null
  setFormatChangeHost(null)
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  setFormatChangeHost(null)
})

describe('features switched off in an ODT document', () => {
  it('each refuses with the notice in ODT; nothing changes for docx', async () => {
    await openDocx()
    expect(isOdtSession()).toBe(false)
    for (const feature of ODT_OFF_FEATURES) expect(refuseInOdt(feature)).toBe(false)
    expect(odtOffProps(isOdtSession())).toEqual({})
    expect(toast).not.toHaveBeenCalled()

    await openSample()
    expect(isOdtSession()).toBe(true)
    const notice = 'ODT 문서에서는 쓸 수 없습니다. docx로 저장하면 쓸 수 있습니다'
    expect(t('appOdtOff')).toBe(notice)
    for (const feature of ODT_OFF_FEATURES) expect(refuseInOdt(feature)).toBe(true)
    expect(toastTexts()).toContain(notice)
    expect(odtOffProps(true)).toMatchObject({ disabled: true, 'data-tip-detail': notice })
  })

  it('the AI tool list leaves switched-off tools out and execution refuses them', async () => {
    const off = ['add_comment', 'reply_comment', 'resolve_comment', 'insert_chart', 'set_watermark']
    const docx = await openDocx()
    const skill = () =>
      createDocsSkill(
        () => editorOf(docx),
        () => ({ bullet: null, ordered: null }),
      )
    const docxNames = skill().tools.map((tool) => tool.name)
    for (const name of off) expect(docxNames).toContain(name)

    const ctx = await openSample()
    const editor = editorOf(ctx)
    const odtSkill = createDocsSkill(
      () => editor,
      () => ({ bullet: null, ordered: null }),
    )
    const names = odtSkill.tools.map((tool) => tool.name)
    for (const name of off) expect(names).not.toContain(name)
    expect(names).toContain('insert_content')
    expect(odtSkill.systemPrompt).toContain('ODT')

    const numIds = { bullet: null, ordered: null }
    for (const call of [
      { id: '1', name: 'add_comment', input: { blockIndex: 0, text: 'x', comment: 'y' } },
      { id: '2', name: 'insert_chart', input: {} },
      { id: '3', name: 'set_page_setup', input: { columns: { count: 2 } } },
      { id: '4', name: 'apply_ops', input: { ops: [{ op: 'insertToc' }] } },
      { id: '5', name: 'apply_ops', input: { ops: [{ op: 'insertField', type: 'SEQ' }] } },
    ]) {
      const result = await executeTool(editor, call, numIds)
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/not available in this ODT document/)
      expect(result.mutated).toBe(false)
    }
    // the same tools are offered for docx (the gate never fires there)
    expect(AGENT_TOOLS.some((tool) => tool.name === 'add_comment')).toBe(true)
  })
})

describe('protected cells', () => {
  it('user typing and deleting refuse with "보호된 칸"; an open cell edits normally', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const before = editor.state.doc
    editor.view.dispatch(editor.state.tr.insertText('X', textPos(before, 'LOCKED') + 1))
    expect(editor.state.doc.eq(before)).toBe(true)
    expect(toastTexts()).toContain(t('appOdtProtectedCell'))
    expect(t('appOdtProtectedCell')).toMatch(/^보호된 칸/)

    // deleting the whole table would delete the locked cell too
    let tablePos = -1
    editor.state.doc.forEach((node, offset) => {
      if (tablePos < 0 && node.type.name === 'docTable') tablePos = offset
    })
    const table = editor.state.doc.nodeAt(tablePos)!
    editor.view.dispatch(editor.state.tr.delete(tablePos, tablePos + table.nodeSize))
    expect(editor.state.doc.eq(before)).toBe(true)

    editor.view.dispatch(editor.state.tr.insertText('Y', textPos(before, 'FREE') + 1))
    expect(editor.state.doc.textContent).toContain('FYREE')
  })

  it('selecting a protected cell says so', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    toast.mockClear()
    // past the repeat window of an earlier test's identical notice
    const later = Date.now() + 60_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    editor.commands.setTextSelection(textPos(editor.state.doc, 'LOCKED') + 2)
    clock.mockRestore()
    expect(toastTexts()).toContain(t('appOdtProtectedCell'))
  })

  it('AI tools and MCP operations cannot change them', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const before = editor.state.doc
    const index = tableBlockIndex(before)
    const result = await executeTool(
      editor,
      {
        id: 'ai',
        name: 'replace_blocks',
        input: { startBlockIndex: index, endBlockIndex: index, html: '<p>gone</p>' },
      },
      { bullet: null, ordered: null },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/protected table cell/)
    expect(editor.state.doc.eq(before)).toBe(true)

    let handler: ((message: unknown) => void) | null = null
    const reports: Array<{ ok: boolean; error?: string }> = []
    Object.assign((window as unknown as { desktop: Record<string, unknown> }).desktop, {
      onMcpCommand: (fn: (message: unknown) => void) => {
        handler = fn
        return () => {}
      },
      reportMcpResult: (r: { ok: boolean; error?: string }) => reports.push(r),
      signalMcpReady: () => {},
    })
    const stop = installMcpBridge({ getCtx: () => ctx })
    handler!({
      requestId: 'r1',
      command: 'replace_blocks',
      payload: { startBlockIndex: index, endBlockIndex: index, html: '<p>gone</p>' },
    })
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    stop()
    expect(reports[0].ok).toBe(false)
    expect(reports[0].error).toMatch(/protected table cell/)
    expect(editor.state.doc.eq(before)).toBe(true)
  })
})

describe('locked placeholders', () => {
  it('resize and picture replacement are refused; deleting one whole is allowed', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const found = placeholders(editor.state.doc)
    expect(found.length).toBe(2)
    const inline = found.find(([, n]) => n.type.name === 'docInlineImage')!
    const block = found.find(([, n]) => n.type.name === 'docProtected')!

    const before = editor.state.doc
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(inline[0], undefined, { ...inline[1].attrs, widthPx: 500 }),
    )
    expect(editor.state.doc.eq(before)).toBe(true)
    expect(toastTexts()).toContain(t('appOdtLockedObject'))
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(block[0], undefined, {
        ...block[1].attrs,
        imageReplace: { base64: 'AAAA', mime: 'image/png' },
      }),
    )
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(block[0], undefined, { ...block[1].attrs, imageWidthPx: 9 }),
    )
    expect(editor.state.doc.eq(before)).toBe(true)

    editor.view.dispatch(editor.state.tr.delete(block[0], block[0] + block[1].nodeSize))
    expect(placeholders(editor.state.doc).length).toBe(1)
  })

  it('placeholders without a preview show their localized label box', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const srcs = [
      ...editor.view.dom.querySelectorAll<HTMLImageElement>(
        'img.doc-inline-img, img.doc-protected-img',
      ),
    ].map((img) => decodeURIComponent(img.getAttribute('src') ?? ''))
    expect(
      srcs.some((s) => s.startsWith('data:image/svg+xml') && s.includes('수식(한컴에서 보임)')),
    ).toBe(true)
    expect(srcs.some((s) => s.includes('도형(한컴에서 보임)'))).toBe(true)
    expect(editor.view.dom.querySelectorAll('.odt-keep').length).toBe(2)
  })

  it('print and PDF export show the label notice once', async () => {
    const ctx = await openSample()
    toast.mockClear()
    printDoc(ctx)
    printDoc(ctx)
    const notice = t('appOdtLabelNotice')
    expect(toastTexts().filter((text) => text === notice)).toHaveLength(1)

    // a docx document never shows it
    const docx = await openDocx()
    toast.mockClear()
    printDoc(docx)
    expect(toastTexts()).not.toContain(notice)
  })

  it('ODT → docx Save As writes label pictures for them', async () => {
    const ctx = await openSample()
    setFormatChangeHost((_request, answer) => answer(true))
    pickedPath = '/docs/hancom.docx'
    expect(await save(ctx, true)).toBe(true)
    const docx = written.find((w) => w.channel === 'save-as')!.bytes
    expect(labelPng).toHaveBeenCalledTimes(2)
    const part = async (name: string) => {
      const b64 = await readDocxPartBase64(docx, name)
      return b64 === null
        ? null
        : new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    }
    const documentXml = (await part('word/document.xml'))!
    const rels = (await part('word/_rels/document.xml.rels'))!
    const drawings = [...documentXml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)].map(
      (m) => m[0],
    )
    const keeps = drawings.filter((d) => d.includes('odt-keep:'))
    expect(keeps).toHaveLength(2)
    for (const drawing of keeps) {
      const rId = /r:embed="([^"]+)"/.exec(drawing)![1]
      expect(rId).toMatch(/^rIdOdtLabel/)
      expect(rels).toMatch(new RegExp(`Id="${rId}"[^>]*Target="media/odt-label-\\d+\\.png"`))
    }
    expect(await readDocxPartBase64(docx, 'word/media/odt-label-1.png')).not.toBeNull()
    expect(await part('[Content_Types].xml')).toMatch(/Extension="png"/i)
    // a valid docx the editor reopens (the tab is a docx document now)
    await parseDocx(docx)
    expect(docOf(ctx).format).toBe('docx')
    expect(isOdtSession()).toBe(false)
  })
})

describe('comments in an ODT document', () => {
  it('existing comments stay; their text edits; new comment marks never land', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const doc = docOf(ctx)
    expect(doc.parsed.comments).toHaveLength(1)
    const commented = textPos(editor.state.doc, '메모가')
    expect(editor.state.doc.nodeAt(commented)?.marks.some((m) => m.type.name === 'comment')).toBe(
      true,
    )
    editor.view.dispatch(editor.state.tr.insertText('새', commented + 1))
    expect(editor.state.doc.textContent).toContain('메새모가')

    const at = textPos(editor.state.doc, '첫 문단')
    editor.view.dispatch(
      editor.state.tr.addMark(at, at + 2, editor.schema.marks.comment.create({ ids: '99' })),
    )
    let stray = false
    editor.state.doc.descendants((node) => {
      if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.ids === '99')) stray = true
      return true
    })
    expect(stray).toBe(false)
  })

  it('the comments pane shows them read-only and the Protect dialog keeps only privacy', async () => {
    await openSample()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const comment = { id: '0', author: 'user', date: '2024-01-02T03:04:05Z', text: '메모 내용' }
    const onReply = vi.fn()
    await act(async () => {
      root.render(
        createElement(CommentsPanel, {
          comments: [comment],
          docNode: editors[0].state.doc,
          composing: false,
          onSubmitNew: vi.fn(),
          onReply,
          onEdit: vi.fn(),
          onResolve: vi.fn(),
          onCancelNew: vi.fn(),
          onDelete: vi.fn(),
          onClose: vi.fn(),
          odtLocked: true,
        }),
      )
    })
    expect(host.textContent).toContain('메모 내용')
    const actions = [...host.querySelectorAll<HTMLButtonElement>('.comment-thread-actions button')]
    expect(actions).toHaveLength(2)
    for (const button of actions) {
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('data-tip-detail')).toBe(t('appOdtOff'))
    }
    await act(async () => {
      root.render(
        createElement(ProtectDialog, {
          encrypted: false,
          writeProtection: null,
          protection: null,
          removePersonalInfo: false,
          odtLocked: true,
          onCancel: vi.fn(),
          onApply: vi.fn(),
        }),
      )
    })
    expect(host.querySelector<HTMLFieldSetElement>('fieldset.protect-odt-off')?.disabled).toBe(true)
    const privacy = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!
    expect(privacy.closest('fieldset')).toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })
})

describe('switched-off content arriving in an ODT document', () => {
  it('a paste keeps only what text boxes, equations and comments show', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const { schema } = editor
    const box = schema.nodes.docProtected.create({
      blockType: 'passthrough',
      textboxes: [{}],
      previewText: '상자 안 글',
    })
    const para = schema.nodes.docParagraph.create(null, [
      schema.text('메모 ', [schema.marks.comment.create({ ids: '7' })]),
      schema.nodes.docInlineMath.create({ latex: 'x^2' }),
    ])
    const slice = new Slice(Fragment.from([box, para]), 0, 0)
    // the document editor's transformPasted (App) runs this first
    const cleaned = cleanOdtPaste(slice, schema)
    expect(cleanOdtPaste(slice, schema)).not.toBe(slice)
    const kinds: string[] = []
    cleaned.content.descendants((node) => {
      kinds.push(node.type.name)
      if (node.marks.some((m) => m.type.name === 'comment')) kinds.push('comment-mark')
      return true
    })
    expect(kinds).not.toContain('docProtected')
    expect(kinds).not.toContain('docInlineMath')
    expect(kinds).not.toContain('comment-mark')
    expect(cleaned.content.textBetween(0, cleaned.content.size, '\n')).toBe('상자 안 글\n메모 x^2')
  })

  it('an AI insert of an equation lands as its plain text', async () => {
    const ctx = await openSample()
    const editor = editorOf(ctx)
    const result = await executeTool(
      editor,
      {
        id: 'ai',
        name: 'insert_content',
        input: { html: '<p>식은 <formula>x^2</formula></p>', afterBlockIndex: 0 },
      },
      { bullet: null, ordered: null },
    )
    expect(result.isError).toBeFalsy()
    let maths = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'docInlineMath') maths++
      return true
    })
    expect(maths).toBe(0)
    expect(editor.state.doc.textContent).toContain('x^2')
  })

  it('docx documents keep equations as they are', async () => {
    const ctx = await openDocx()
    const editor = editorOf(ctx)
    await executeTool(
      editor,
      { id: 'ai', name: 'insert_content', input: { html: '<p><formula>x^2</formula></p>' } },
      { bullet: null, ordered: null },
    )
    let maths = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'docInlineMath') maths++
      return true
    })
    expect(maths).toBe(1)
  })
})

describe('AI panel attachments', () => {
  it('an .odt attachment shows the Word icon', () => {
    expect(ATTACHMENT_CARD_ICONS.odt).toBe(ATTACHMENT_CARD_ICONS.docx)
  })
})

it('the ODT label for every kind is localized', async () => {
  await openSample()
  const { labelText } = await import('../src/renderer/odt-gate')
  expect(labelText('equation')).toBe('수식(한컴에서 보임)')
  expect(labelText('shape')).toBe('도형(한컴에서 보임)')
  await odtToDocx(await sampleOdt())
})

describe('typing in a table cell that also holds a nested table', () => {
  const hostBody = () =>
    hPara('앞') +
    hTable('Table1', 2, [
      hRow([
        hCell(hPara('HOST') + hTable('Table2', 1, [hRow([hCell(hPara('INNER'))])])),
        hCell(hPara('옆 칸')),
      ]),
    ]) +
    hPara('뒤')

  const decode = async (zip: Uint8Array, name: string) => {
    const b64 = await readDocxPartBase64(zip, name)
    return new TextDecoder().decode(Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0)))
  }

  it('an ODT save keeps the typed host-cell text and the nested table', async () => {
    const ctx = makeCtx()
    expect(await loadFile(ctx, openResult('/docs/nested.odt', await sampleOdt(hostBody())))).toBe(
      'ok',
    )
    const editor = editorOf(ctx)
    editor.view.dispatch(editor.state.tr.insertText('Z', textPos(editor.state.doc, 'HOST') + 1))
    expect(await save(ctx, false)).toBe(true)
    const odt = written.find((w) => w.channel === 'save')!.bytes
    const content = await decode(odt, 'content.xml')
    expect(content).toContain('HZOST')
    expect(content).toContain('INNER')
  })

  it('a docx save keeps the typed host-cell text and the nested table too', async () => {
    // the bridge docx of that ODT, opened as an ordinary docx
    const docx = (await odtToDocx(await sampleOdt(hostBody()))).docxBytes
    const ctx = makeCtx()
    expect(await loadFile(ctx, openResult('/docs/nested.docx', docx))).toBe('ok')
    const editor = editorOf(ctx)
    editor.view.dispatch(editor.state.tr.insertText('Z', textPos(editor.state.doc, 'HOST') + 1))
    expect(await save(ctx, false)).toBe(true)
    const saved = written.find((w) => w.channel === 'save')!.bytes
    const xml = await decode(saved, 'word/document.xml')
    expect(xml).toContain('HZOST')
    expect(xml).toContain('INNER')
    expect(xml).toContain('옆 칸')
  })
})
