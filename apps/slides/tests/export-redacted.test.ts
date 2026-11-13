import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// file-actions pulls the offscreen render stack (Konva/canvas) in at import
// time; the renderers are stand-ins, what is asserted is what gets written.
vi.mock('../src/renderer/export-render', () => ({
  renderSlidesToImageBase64: vi.fn(async (slides: unknown[]) => slides.map(() => 'cG5n')),
  renderSlidesToPngBase64: vi.fn(),
}))
vi.mock('../src/renderer/export-pages', () => ({
  renderSlidesToPdfPages: vi.fn(async () => ({ pages: [{ svg: '<svg/>' }], fontCss: '' })),
}))
vi.mock('../src/renderer/selection-image', () => ({
  renderSelectionToPngBase64: vi.fn(async () => 'cG5n'),
}))
vi.mock('../src/renderer/components/toast-bus', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/i18n/locale', () => ({ t: (key: string) => key, getLang: () => 'en' }))

import type { ActionCtx } from '../src/renderer/action-context'
import { exportImages, exportPdf } from '../src/renderer/file-actions'
import { saveSelectionAsPicture } from '../src/renderer/picture-edit-actions'

/** A picture the reader hid from the AI. */
const HIDDEN_PICTURE = { type: 'picture', sourceId: 'pic-1', redact: 'client logo' }
/** Words the reader hid from the AI, inside a text box. */
const HIDDEN_TEXT = {
  type: 'text',
  sourceId: 'tx-1',
  paragraphs: [{ runs: [{ text: 'Seoul 02-1234-5678', redact: 'client phone' }] }],
}
const PLAIN_TEXT = {
  type: 'text',
  sourceId: 'tx-2',
  paragraphs: [{ runs: [{ text: 'Quarterly review' }] }],
}

interface TestSlide {
  hidden: boolean
  widthPx: number
  heightPx: number
  nodes: unknown[]
}

function slide(nodes: unknown[], hidden = false): TestSlide {
  return { hidden, widthPx: 1280, heightPx: 720, nodes }
}

const askWithheldExport = vi.fn()
const exportPdfOp = vi.fn()
const exportImagesOp = vi.fn()
const savePicture = vi.fn()

beforeEach(() => {
  askWithheldExport.mockReset()
  exportPdfOp.mockReset().mockResolvedValue({ ok: true, path: '/docs/deck.pdf' })
  exportImagesOp.mockReset().mockResolvedValue({ ok: true, paths: ['/docs/deck-1.png'] })
  savePicture.mockReset().mockResolvedValue({ ok: true, path: '/docs/Picture.png' })
  vi.stubGlobal('window', {
    slidesApi: {
      askWithheldExport,
      exportPdf: exportPdfOp,
      exportImages: exportImagesOp,
      savePicture,
      pickExportDir: vi.fn(async () => '/docs'),
      pickExportPdfPath: vi.fn(async () => '/docs/deck.pdf'),
      getSlideLinks: vi.fn(async () => []),
      getRunLinks: vi.fn(async () => []),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function context(slides: TestSlide[], selectedIds: string[] = []) {
  const requestSaveAs = vi.fn()
  const setStatus = vi.fn()
  const ctx = {
    slides,
    slide: slides[0],
    current: 0,
    selectedIds,
    enteredGroupId: null,
    images: new Map(),
    path: '/docs/deck.pptx',
    setStatus,
    requestSaveAs,
  } as unknown as ActionCtx
  return { ctx, requestSaveAs, setStatus }
}

describe.each([
  ['a hidden picture', [HIDDEN_PICTURE]],
  ['hidden words in a text box', [HIDDEN_TEXT]],
])('exporting a deck with %s as PDF', (_what, nodes) => {
  it('asks before anything is written, and writes the pages when the person exports without the marks', async () => {
    askWithheldExport.mockResolvedValue('export')
    const { ctx, requestSaveAs } = context([slide(nodes)])
    expect(await exportPdf(ctx)).toBe(true)
    expect(askWithheldExport).toHaveBeenCalledTimes(1)
    expect(askWithheldExport).toHaveBeenCalledWith('PDF')
    expect(exportPdfOp).toHaveBeenCalledTimes(1)
    expect(askWithheldExport.mock.invocationCallOrder[0]).toBeLessThan(
      exportPdfOp.mock.invocationCallOrder[0]!,
    )
    expect(requestSaveAs).not.toHaveBeenCalled()
  })

  it('writes nothing when the person cancels', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { ctx, requestSaveAs } = context([slide(nodes)])
    expect(await exportPdf(ctx)).toBe(false)
    expect(exportPdfOp).not.toHaveBeenCalled()
    expect(requestSaveAs).not.toHaveBeenCalled()
  })

  it('goes to Save As .pptx and writes no PDF when the person asks for that', async () => {
    askWithheldExport.mockResolvedValue('pptx')
    const { ctx, requestSaveAs } = context([slide(nodes)])
    expect(await exportPdf(ctx)).toBe(false)
    expect(exportPdfOp).not.toHaveBeenCalled()
    expect(requestSaveAs).toHaveBeenCalledTimes(1)
  })

  it('asks for a Save As › PDF target too', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { ctx } = context([slide(nodes)])
    expect(await exportPdf(ctx, '/docs/copy.pdf')).toBe(false)
    expect(askWithheldExport).toHaveBeenCalledTimes(1)
    expect(exportPdfOp).not.toHaveBeenCalled()
  })

  it('refuses an export nobody can be asked about, and writes nothing', async () => {
    const { ctx } = context([slide(nodes)])
    await expect(exportPdf(ctx, '/out/deck.pdf', { silent: true })).rejects.toThrow(
      'appExportRefusedHidden',
    )
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(exportPdfOp).not.toHaveBeenCalled()
  })
})

describe('exporting a deck with nothing hidden from the AI as PDF', () => {
  it('writes without a box, silent or not', async () => {
    const { ctx } = context([slide([PLAIN_TEXT])])
    expect(await exportPdf(ctx)).toBe(true)
    expect(await exportPdf(ctx, '/out/deck.pdf', { silent: true })).toBe(true)
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(exportPdfOp).toHaveBeenCalledTimes(2)
  })

  it('does not count a mark on a slide the export leaves out', async () => {
    const { ctx } = context([slide([PLAIN_TEXT]), slide([HIDDEN_PICTURE], true)])
    expect(await exportPdf(ctx)).toBe(true)
    expect(askWithheldExport).not.toHaveBeenCalled()
  })
})

describe('exporting a deck with a hidden picture as images', () => {
  it.each([
    ['png', 'PNG'],
    ['jpg', 'JPG'],
  ] as const)(
    'asks before writing %s, and writes them when the person exports without the marks',
    async (format, label) => {
      askWithheldExport.mockResolvedValue('export')
      const { ctx } = context([slide([HIDDEN_PICTURE])])
      await exportImages(ctx, format)
      expect(askWithheldExport).toHaveBeenCalledWith(label)
      expect(exportImagesOp).toHaveBeenCalledTimes(1)
    },
  )

  it('writes nothing when the person cancels', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { ctx, requestSaveAs } = context([slide([HIDDEN_PICTURE])])
    await exportImages(ctx, 'png')
    expect(exportImagesOp).not.toHaveBeenCalled()
    expect(requestSaveAs).not.toHaveBeenCalled()
  })

  it('goes to Save As .pptx when the person asks for that', async () => {
    askWithheldExport.mockResolvedValue('pptx')
    const { ctx, requestSaveAs } = context([slide([HIDDEN_PICTURE])])
    await exportImages(ctx, 'png', '/docs/deck.png')
    expect(exportImagesOp).not.toHaveBeenCalled()
    expect(requestSaveAs).toHaveBeenCalledTimes(1)
  })

  it('does not ask about a deck that hides nothing', async () => {
    const { ctx } = context([slide([PLAIN_TEXT])])
    await exportImages(ctx, 'png')
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(exportImagesOp).toHaveBeenCalledTimes(1)
  })
})

describe('Save as Picture of a selection', () => {
  it('asks when a selected element is hidden from the AI, and writes nothing on cancel', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { ctx } = context([slide([HIDDEN_PICTURE, PLAIN_TEXT])], ['pic-1'])
    await saveSelectionAsPicture(ctx)
    expect(askWithheldExport).toHaveBeenCalledWith('PNG')
    expect(savePicture).not.toHaveBeenCalled()
  })

  it('writes the picture when the person exports without the marks', async () => {
    askWithheldExport.mockResolvedValue('export')
    const { ctx } = context([slide([HIDDEN_PICTURE, PLAIN_TEXT])], ['pic-1'])
    await saveSelectionAsPicture(ctx)
    expect(savePicture).toHaveBeenCalledTimes(1)
  })

  it('does not ask when only other elements are selected', async () => {
    const { ctx } = context([slide([HIDDEN_PICTURE, PLAIN_TEXT])], ['tx-2'])
    await saveSelectionAsPicture(ctx)
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(savePicture).toHaveBeenCalledTimes(1)
  })
})
