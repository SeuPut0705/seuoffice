import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { buildFormCatalog, type RawFormAnnotation } from '../src/renderer/form-catalog'

function fakeDoc(pages: RawFormAnnotation[][]): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: async (page: number) => ({
      getAnnotations: async () => pages[page - 1] ?? [],
    }),
  } as unknown as PDFDocumentProxy
}

describe('a PDF signed in an earlier version', () => {
  it('still ties its visual signature to the field it names, not to the one it lies on', async () => {
    const catalog = await buildFormCatalog(
      fakeDoc([
        [
          {
            id: 'sig',
            subtype: 'Widget',
            fieldType: 'Sig',
            fieldName: 'signature',
            rect: [20, 20, 200, 60],
          },
          {
            id: 'other-sig',
            subtype: 'Widget',
            fieldType: 'Sig',
            fieldName: 'otherSignature',
            rect: [300, 300, 400, 350],
          },
          {
            subtype: 'Stamp',
            rect: [300, 300, 400, 350],
            contentsObj: { str: 'GenOffice visual signature field: signature' },
          },
        ],
      ]),
    )

    expect(catalog.widgets.find((widget) => widget.fieldName === 'signature')?.signed).toBe(true)
    expect(catalog.widgets.find((widget) => widget.fieldName === 'otherSignature')?.signed).toBe(
      false,
    )
  })
})
