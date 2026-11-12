import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { docxHoldsHiddenContent } from '@seuoffice/docx-engine'
import { markedOdtChoice } from '@seuoffice/electron-utils/marked-odt'
import { generateDocx } from '../../../packages/html2docx/src/generate'
import { askMarkedExport, markedExportRefusal } from '../src/main/odt-export'
import { clearHiddenMarks, holdsHiddenMarks, planMarkedExport } from '../src/main/marked-html'

/**
 * Neither an ODT nor the Word export can keep the hiding of content marked
 * "hidden from AI" in a page: a page with marks is exported only with its marks
 * cleared, when the person agrees; or not at all.
 */

const SECRET = '13800138000'
const PAGES = {
  'an element': `<p>Call <span data-gx-redact="client phone">${SECRET}</span></p>`,
  'an attribute': `<a href="x" data-gx-redact-href="link">go</a>`,
  'a script literal': `<script>var k = /*gx:redact:key*/ "${SECRET}"</script>`,
  'single quotes and no value': `<b data-gx-redact='x'>${SECRET}</b><i data-gx-redact>y</i>`,
}

describe('why the Word export refuses a marked page', () => {
  it('writes the words and no mark: the export reads the rendered page, which has no run for a mark', async () => {
    // an element's text reaches the Word export as the text of its run
    const docx = new Uint8Array(
      await generateDocx([{ type: 'para', runs: [{ text: 'Call ' }, { text: SECRET }] }], {}),
    )
    expect(await docxHoldsHiddenContent(docx)).toBe(false)
    expect(new TextDecoder('latin1').decode(docx)).not.toContain('redact')
  })
})

describe('a page with content hidden from AI', () => {
  it.each(Object.entries(PAGES))(
    'is marked by %s, and clearing leaves its words',
    (_name, html) => {
      expect(holdsHiddenMarks(html)).toBe(true)
      const cleared = clearHiddenMarks(html)
      expect(holdsHiddenMarks(cleared)).toBe(false)
      if (html.includes(SECRET)) expect(cleared).toContain(SECRET)
    },
  )

  it('is not marked when it has none', () => {
    expect(holdsHiddenMarks('<p>Plain</p>')).toBe(false)
  })

  it('is exported as it is when nothing is hidden, without asking', async () => {
    const ask = vi.fn()
    expect(await planMarkedExport('<p>Plain</p>', ask)).toEqual({
      kind: 'write',
      html: '<p>Plain</p>',
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it.each(Object.values(PAGES))('is declined when nobody can be asked: %s', async (html) => {
    expect(await planMarkedExport(html, null)).toEqual({ kind: 'declined' })
  })

  it('follows the choice: cancel, or cleared', async () => {
    const html = PAGES['an element']
    expect(await planMarkedExport(html, async () => 'cancel')).toEqual({ kind: 'declined' })
    expect(await planMarkedExport(html, async () => 'clear')).toEqual({
      kind: 'write',
      html: `<p>Call <span>${SECRET}</span></p>`,
    })
  })
})

describe('the choice box', () => {
  it.each(['odt', 'docx'] as const)(
    'offers clearing and cancelling, and no Word, for %s',
    async (format) => {
      for (const lang of ['en', 'ko'] as const) {
        const shown: Array<{ buttons: string[]; cancelId: number; message: string }> = []
        const choice = await askMarkedExport(
          format,
          async (options) => {
            shown.push(options)
            return { response: 0 }
          },
          lang,
        )
        expect(choice).toBe('clear')
        expect(shown[0]!.buttons).toHaveLength(2)
        expect(shown[0]!.cancelId).toBe(1)
        expect(markedExportRefusal(lang).length).toBeGreaterThan(10)
      }
    },
  )

  it('says which format cannot keep the hiding', async () => {
    const message = async (format: 'odt' | 'docx') => {
      let out = ''
      await askMarkedExport(format, async (o) => ((out = o.message), { response: 1 }), 'en')
      return out
    }
    expect(await message('odt')).toContain('ODT')
    expect(await message('docx')).toContain('Word')
  })

  it('answers cancel for the cancel button and for a closed box', async () => {
    for (const response of [1, -1]) {
      expect(await askMarkedExport('odt', async () => ({ response }))).toBe('cancel')
    }
    expect([0, 1, 2].map((r) => markedOdtChoice(r, false))).toEqual(['clear', 'cancel', 'cancel'])
  })

  it('speaks Korean and English differently', async () => {
    const title = async (lang: 'en' | 'ko') => {
      let out = ''
      await askMarkedExport('odt', async (o) => ((out = o.title), { response: 1 }), lang)
      return out
    }
    expect(await title('ko')).not.toBe(await title('en'))
  })
})

const source = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('where the page is exported', () => {
  const writer = (main: string, name: string) => {
    const start = main.indexOf(`async function ${name}(`)
    return main.slice(start, main.indexOf('\n}\n', start))
  }

  it('plans the ODT write before the Word export is rendered, in the one writer both flows use', async () => {
    const main = await source('../src/main/html-main.ts')
    const odt = writer(main, 'writeHtmlOdt')
    expect(odt.indexOf('planMarkedExport(')).toBeGreaterThan(-1)
    expect(odt.indexOf('planMarkedExport(')).toBeLessThan(odt.indexOf('exportOdt('))
    expect(main.match(/writeHtmlOdt\(/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('plans the Word write before the page is rendered, in the one writer every flow uses', async () => {
    const main = await source('../src/main/html-main.ts')
    const docx = writer(main, 'writeHtmlDocx')
    expect(docx.indexOf('planMarkedExport(')).toBeGreaterThan(-1)
    expect(docx.indexOf('planMarkedExport(')).toBeLessThan(docx.indexOf('renderHtmlDocx('))
    // the menu export, Save As › Word, and the ODT flow's own calls all reach it
    expect(main.match(/writeHtmlDocx\(/g)!.length).toBeGreaterThanOrEqual(3)
    // nothing renders a Word export outside the two writers
    const outside = main.replace(docx, '').replace(writer(main, 'writeHtmlOdt'), '')
    expect(outside.match(/renderHtmlDocx\(/g)!.length).toBe(1)
  })
})
