import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { markedOdtBox, markedOdtChoice } from '@seuoffice/electron-utils/marked-odt'
import { askMarkedOdt, markedOdtRefusal } from '../src/main/odt-export'
import { clearHiddenMarks, holdsHiddenMarks, planMarkedOdt } from '../src/main/marked-html'

/**
 * An ODT cannot keep the hiding of content marked "hidden from AI": a page with
 * marks is not exported as ODT; Word instead, or the marks cleared for the copy.
 */

const SECRET = '13800138000'
const PAGES = {
  'an element': `<p>Call <span data-gx-redact="client phone">${SECRET}</span></p>`,
  'an attribute': `<a href="x" data-gx-redact-href="link">go</a>`,
  'a script literal': `<script>var k = /*gx:redact:key*/ "${SECRET}"</script>`,
  'single quotes and no value': `<b data-gx-redact='x'>${SECRET}</b><i data-gx-redact>y</i>`,
}

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

  it('is exported as ODT as it is when nothing is hidden, without asking', async () => {
    const ask = vi.fn()
    expect(await planMarkedOdt('<p>Plain</p>', ask)).toEqual({
      kind: 'write',
      html: '<p>Plain</p>',
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it.each(Object.values(PAGES))('is declined when nobody can be asked: %s', async (html) => {
    expect(await planMarkedOdt(html, null)).toEqual({ kind: 'declined' })
  })

  it('follows the choice: cancel, Word, or cleared', async () => {
    const html = PAGES['an element']
    expect(await planMarkedOdt(html, async () => 'cancel')).toEqual({ kind: 'declined' })
    expect(await planMarkedOdt(html, async () => 'docx')).toEqual({ kind: 'save-as-docx' })
    const written = await planMarkedOdt(html, async () => 'clear')
    expect(written).toEqual({ kind: 'write', html: `<p>Call <span>${SECRET}</span></p>` })
  })
})

describe('the choice box', () => {
  it.each(['en', 'ko'] as const)(
    'has three buttons in %s, Word first, cancel last',
    async (lang) => {
      const shown: unknown[] = []
      const choice = await askMarkedOdt(async (options) => {
        shown.push(options)
        return { response: 1 }
      }, lang)
      expect(choice).toBe('clear')
      const box = shown[0] as ReturnType<typeof markedOdtBox>
      expect(box.buttons).toHaveLength(3)
      expect(new Set(box.buttons).size).toBe(3)
      expect(box.cancelId).toBe(2)
      expect(markedOdtRefusal(lang).length).toBeGreaterThan(10)
    },
  )

  it('answers cancel for a closed box', () => {
    expect([0, 1, 2, -1].map(markedOdtChoice)).toEqual(['docx', 'clear', 'cancel', 'cancel'])
  })

  it('speaks Korean and English differently', async () => {
    const text = async (lang: 'en' | 'ko') => {
      let title = ''
      await askMarkedOdt(async (o) => ((title = o.title), { response: 2 }), lang)
      return title
    }
    expect(await text('ko')).not.toBe(await text('en'))
  })
})

const source = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('where the page is exported as ODT', () => {
  it('plans the write before the Word export is rendered, in the one writer both flows use', async () => {
    const main = await source('../src/main/html-main.ts')
    const start = main.indexOf('async function writeHtmlOdt(')
    const writer = main.slice(start, main.indexOf('\n}\n', start))
    expect(writer.indexOf('planMarkedOdt(')).toBeGreaterThan(-1)
    expect(writer.indexOf('planMarkedOdt(')).toBeLessThan(writer.indexOf('exportOdt('))
    // the menu export and Save As › ODT both call it
    expect(main.match(/writeHtmlOdt\(/g)!.length).toBeGreaterThanOrEqual(3)
  })
})
