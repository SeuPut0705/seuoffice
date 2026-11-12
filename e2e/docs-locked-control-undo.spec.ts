import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/**
 * A document nobody changed closes without asking. Found on Windows: text
 * typed into a content control locked against editing was refused, as it
 * should be; after one Ctrl+Z and one Ctrl+Y the document read as the file
 * again, and closing the tab still asked whether to save.
 *
 * The keys go through the browser (real key and input events), because that
 * is where it happened: an editor command would not show it.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const TEXT = 'Code: A-1 end'

/** one paragraph with a plain-text content control locked against editing, as Word writes it */
async function lockedControlDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style><w:style w:type="character" w:styleId="PlaceholderText"><w:name w:val="Placeholder Text"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:semiHidden/><w:rPr><w:color w:val="808080"/></w:rPr></w:style></w:styles>`,
  )
  zip.file(
    'word/settings.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:settings ${W}><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
  )
  const control =
    '<w:sdt><w:sdtPr><w:alias w:val="Code"/><w:tag w:val="Code"/><w:id w:val="-1551759219"/>' +
    '<w:lock w:val="contentLocked"/><w:placeholder><w:docPart w:val="DefaultPlaceholder_-1854013440"/></w:placeholder>' +
    '<w:text/></w:sdtPr><w:sdtContent><w:r><w:t>A-1</w:t></w:r></w:sdtContent></w:sdt>'
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>` +
      `<w:p><w:r><w:t xml:space="preserve">Code: </w:t></w:r>${control}<w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

interface TabsApi {
  list(): Promise<{ id: string }[]>
  close(id: string): Promise<void>
}

/** The view that holds the tab bar's API. */
async function tabsView(app: ElectronApplication): Promise<Page> {
  for (const candidate of app.windows()) {
    const has = await candidate
      .evaluate(() => typeof (window as { aiOfficeTabs?: unknown }).aiOfficeTabs === 'object')
      .catch(() => false)
    if (has) return candidate
  }
  throw new Error('no view with the tab bar API')
}

/** the tabs that hold the document, by what the tab bar knows of them */
async function documentTabs(app: ElectronApplication): Promise<number> {
  const view = await tabsView(app)
  return view.evaluate(async () => {
    const api = (window as unknown as { aiOfficeTabs: TabsApi }).aiOfficeTabs
    return (await api.list()).filter((t) => /locked-control\.docx/i.test(JSON.stringify(t))).length
  })
}

/** Close the document's tab as its close button does, and wait for the outcome. */
async function closeDocumentTab(app: ElectronApplication): Promise<void> {
  const view = await tabsView(app)
  await view.evaluate(async () => {
    const api = (window as unknown as { aiOfficeTabs: TabsApi }).aiOfficeTabs
    const tab = (await api.list()).find((t) => /locked-control\.docx/i.test(JSON.stringify(t)))
    if (tab) await api.close(tab.id)
  })
}

/** Count the close prompts and answer Cancel, so a prompted tab stays. */
async function countPrompts(app: ElectronApplication): Promise<() => Promise<number>> {
  await app.evaluate(({ dialog }) => {
    const scope = globalThis as { closePrompts?: number }
    scope.closePrompts = 0
    dialog.showMessageBox = (async () => {
      scope.closePrompts = (scope.closePrompts ?? 0) + 1
      return { response: 2, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  return () => app.evaluate(() => (globalThis as { closePrompts?: number }).closePrompts ?? 0)
}

/** One moment of the sequence, in the words a failure needs. */
interface Moment {
  step: string
  /** the paragraph as the page shows it: the text in the DOM */
  shown: string
  /** the paragraph as the editor holds it */
  held: string
  /** the editor's caret, as [anchor, head] */
  caret: [number, number]
  /** the page's caret: the text of the node it is in, and the offset in it */
  domCaret: string
  canUndo: boolean
  canRedo: boolean
  /** every transaction since the watch began that changed the document */
  changes: string[]
}
interface TracedEditor {
  can(): { undo(): boolean; redo(): boolean }
  on(event: 'transaction', listener: (event: { transaction: TracedTransaction }) => void): void
  state: { doc: { textContent: string }; selection: { anchor: number; head: number } }
  commands: { focus(): boolean; setTextSelection(pos: number): boolean }
}
interface TracedTransaction {
  docChanged: boolean
  steps: { toJSON(): unknown }[]
  meta?: Record<string, unknown>
}
type EditorWindow = Window & { __aidocs?: { editor: TracedEditor }; __changes?: string[] }

/** from here on, every transaction that changes the document is written down */
const watchChanges = (page: Page) =>
  page.evaluate(() => {
    const w = window as EditorWindow
    const changes: string[] = (w.__changes = [])
    w.__aidocs!.editor.on('transaction', ({ transaction }) => {
      if (!transaction.docChanged) return
      const steps = JSON.stringify(transaction.steps.map((step) => step.toJSON())).slice(0, 400)
      changes.push(`${Object.keys(transaction.meta ?? {}).join(',')}: ${steps}`)
    })
  })

const moment = (page: Page, step: string): Promise<Moment> =>
  page.evaluate((label) => {
    const w = window as EditorWindow
    const editor = w.__aidocs!.editor
    const can = editor.can()
    const selection = window.getSelection()
    const paragraph = [...document.querySelectorAll('.doc-page p')].find((p) =>
      (p.textContent ?? '').includes('Code:'),
    )
    return {
      step: label,
      shown: paragraph?.textContent ?? '',
      held: editor.state.doc.textContent,
      caret: [editor.state.selection.anchor, editor.state.selection.head] as [number, number],
      domCaret: `${JSON.stringify(selection?.focusNode?.textContent ?? null)}@${selection?.focusOffset ?? -1}`,
      canUndo: can.undo(),
      canRedo: can.redo(),
      changes: [...(w.__changes ?? [])],
    }
  }, step)

/** what every moment of an untouched document reads, whatever the caret does */
const untouched = (moments: Moment[]) =>
  moments.map(({ step, shown, held, canUndo, canRedo, changes }) => ({
    step,
    shown,
    held,
    canUndo,
    canRedo,
    changes,
  }))
const UNTOUCHED = (step: string) => ({
  step,
  shown: TEXT,
  held: TEXT,
  canUndo: false,
  canRedo: false,
  changes: [] as string[],
})

/** how the caret gets into the control: a click on it, or the editor putting it there */
const WAYS_IN = ['a click', 'the caret set by the editor'] as const

test.describe('a document with a locked content control', () => {
  for (const way of WAYS_IN) {
    test(`text it refused (caret put in by ${way}), then Ctrl+Z and Ctrl+Y, leave the document unchanged and the tab closes without asking`, async () => {
      const file = join(await mkdtemp(join(tmpdir(), 'seuoffice-locked-')), 'locked-control.docx')
      await writeFile(file, await lockedControlDocx())
      const launched = await launchShell({
        onboardingSeen: true,
        openFile: file,
        videoDir: 'docs-locked-control-undo',
      })
      const { app } = launched
      const moments: Moment[] = []
      try {
        const prompts = await countPrompts(app)
        const page = await waitForPageWithUrl(app, '://docs/')
        await page.locator('.doc-page p', { hasText: 'Code:' }).first().waitFor()
        const control = page.locator('.doc-page .doc-inline-wrap').first()
        await expect(control).toHaveText('A-1')
        // the page settles (fonts, pagination) before anything is compared
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await page.waitForTimeout(1500)
        await watchChanges(page)
        const note = async (step: string) => moments.push(await moment(page, step))
        await note('opened')

        if (way === 'a click') await control.click()
        else
          await page.evaluate(() => {
            const editor = (window as EditorWindow).__aidocs!.editor
            editor.commands.focus()
            // 'Code: ' is six characters: 8 is after the A of the control
            editor.commands.setTextSelection(8)
          })
        await note('caret in the control')
        // a key, then text handed over whole, as an input method hands it over
        await page.keyboard.type('x')
        await note('a key typed')
        await page.keyboard.insertText('y')
        await note('text inserted')
        await page.keyboard.press('ControlOrMeta+z')
        await note('undo')
        await page.keyboard.press('ControlOrMeta+y')
        await note('redo')

        // the whole sequence at once, so a failure shows every moment of it
        console.log(`[locked-control ${way}] ${JSON.stringify(moments, null, 1)}`)
        expect(untouched(moments)).toEqual(moments.map(({ step }) => UNTOUCHED(step)))
        // and the caret stayed where it was put: refused text moves nothing
        expect(new Set(moments.slice(1).map((m) => m.caret.join(':'))).size).toBe(1)

        await closeDocumentTab(app)
        expect(await prompts()).toBe(0)
        await expect.poll(() => documentTabs(app)).toBe(0)
      } finally {
        await closeAndSaveVideo(launched, 'docs-locked-control-undo')
      }
    })
  }
})
