import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPptx } from '@genoffice/pptx-engine'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import type * as Embed from '@seuoffice/embed'
import initRhwp, { HwpDocument } from '@rhwp/core'
import { strFromU8, unzipSync } from 'fflate'
import { build, type Rollup } from 'vite'

/**
 * A host page that embeds a document with `@seuoffice/embed` and offers AI
 * through `ai.request`. Its gateway is a script in the host page: it records
 * each request body and answers with canned chat-completions SSE, so nothing
 * leaves the machine. The page reaches it only through the embed channel.
 */
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const DOCX = `${repo}fixtures/generated/simple.docx`
const XLSX = fileURLToPath(
  new URL('../../sheets/fixtures/generated/compatibility-edit.xlsx', import.meta.url),
)
const PPTX = `${repo}packages/pptx-engine/tests/fixtures/01_standard_business.pptx`

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const DONE = 'data: [DONE]\n\n'

/** One model turn that answers with text only */
const textReply = (text: string): string =>
  sse({ choices: [{ index: 0, delta: { content: text } }] }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  DONE

/**
 * One model turn with some text and one tool call, its arguments streamed in
 * two pieces split after the first field (a placeholder stays whole)
 */
const toolReply = (text: string, name: string, input: unknown): string => {
  const args = JSON.stringify(input)
  const half = args.indexOf(',') + 1
  const call = (fn: Record<string, string>, first: boolean) =>
    sse({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              first
                ? { index: 0, id: 'call_1', type: 'function', function: fn }
                : { index: 0, function: fn },
            ],
          },
        },
      ],
    })
  return (
    sse({ choices: [{ index: 0, delta: { content: text } }] }) +
    call({ name, arguments: args.slice(0, half) }, true) +
    call({ arguments: args.slice(half) }, false) +
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
    DONE
  )
}

let embedScript = ''

test.beforeAll(async () => {
  // the host's copy of @seuoffice/embed, from its source, as one classic script
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { conditions: ['seuoffice-source'] },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: `${repo}packages/embed/src/index.ts`,
        formats: ['iife'],
        name: 'SeuofficeEmbed',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0]! : (result as Rollup.RollupOutput)).output
  embedScript = output[0].code
})

/** The parts of a gateway-complete request body the tests read */
interface GatewayBody {
  model?: string
  stream?: boolean
  messages: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function: { name: string } }>
}

interface HostState {
  bodies: GatewayBody[]
  aborted: number
  /** `ai_request` messages the page posted, whether or not the host offers AI */
  asked: number
  /** the bytes of each document the page saved to the host */
  saves: number[][]
}

/** The host page's globals: the embed script, the open document and what the host saw */
type HostWindow = Window & {
  SeuofficeEmbed: typeof Embed
  hostState: HostState
  embedded: Embed.EmbeddedDocument
}

/** Stands in a canned reply for the active sheet's id, which the app names in the prompt */
const SHEET_ID = '__SHEET_ID__'

/**
 * Open the host page and embed `file`. `replies` are the gateway's answers in
 * order (the last one repeats); `'hang'` answers one text piece and then
 * waits until the request is aborted. Without `replies` the host offers no AI.
 */
async function openHost(
  page: Page,
  file: string,
  options: { mode: 'view' | 'edit'; replies?: string[] },
): Promise<FrameLocator> {
  await page.route('**/ai-host.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0"><div id="viewer" style="height:900px"></div></body></html>',
    }),
  )
  await page.goto('/ai-host.html')
  await page.addScriptTag({ content: embedScript })
  const bytes = [...(await readFile(file))]
  const fileName = file.slice(file.lastIndexOf('/') + 1)
  await page.evaluate(
    async ({ bytes, fileName, mode, replies, sheetId }) => {
      // the globals this page's scripts put there
      const host = window as unknown as HostWindow
      const embed = host.SeuofficeEmbed
      const state: HostState = { bodies: [], aborted: 0, asked: 0, saves: [] }
      window.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === 'ai_request') state.asked++
      })
      host.hostState = state
      const encoder = new TextEncoder()
      const ai = replies && {
        request: async (body: unknown, signal: AbortSignal): Promise<Response> => {
          state.bodies.push(body as GatewayBody)
          signal.addEventListener('abort', () => state.aborted++)
          const canned = replies[Math.min(state.bodies.length, replies.length) - 1]!
          // a sheet id exists only once the workbook is open: the app's context line names it
          const id = /Active sheet: [^(]*\(id=([^,)]+)/.exec(JSON.stringify(body))?.[1] ?? ''
          const reply = canned.replaceAll(sheetId, id)
          if (reply !== 'hang') {
            return new Response(reply, { headers: { 'Content-Type': 'text/event-stream' } })
          }
          const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '생각하는 중' } }] })}\n\n`
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(first))
              signal.addEventListener('abort', () => controller.error(signal.reason))
            },
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
        },
      }
      const viewer = document.getElementById('viewer')!
      const base = {
        baseUrl: new URL('./', location.href).href,
        bytes: new Uint8Array(bytes),
        fileName,
      }
      const doc =
        mode === 'edit'
          ? embed.openDocument(viewer, {
              ...base,
              mode,
              onSave: async ({ bytes }) => void state.saves.push([...bytes]),
              ...(ai ? { ai } : {}),
            })
          : embed.openDocument(viewer, { ...base, ...(ai ? { ai } : {}) })
      host.embedded = doc
      await doc.opened
    },
    { bytes, fileName, mode: options.mode, replies: options.replies, sheetId: SHEET_ID },
  )
  return page.frameLocator('#viewer iframe')
}

const hostState = (page: Page): Promise<HostState> =>
  page.evaluate(() => {
    const host = window as unknown as HostWindow
    return host.hostState
  })

/** Open the docs AI panel and send one prompt */
async function askDocs(frame: FrameLocator, prompt: string): Promise<void> {
  await expect(frame.locator('.ProseMirror')).toBeVisible({ timeout: 30_000 })
  const input = frame.locator('.ai-input-box textarea')
  if (!(await input.isVisible())) await frame.locator('.ai-entry').click()
  await input.fill(prompt)
  await input.press('Enter')
}

test('docs: the AI answer comes through the host and its edit lands as a tracked change', async ({
  page,
}) => {
  const frame = await openHost(page, DOCX, {
    mode: 'edit',
    replies: [
      toolReply('맨 앞에 문단을 넣겠습니다.', 'insert_content', {
        html: '<p>호스트를 거친 AI 문단</p>',
        afterBlockIndex: -1,
      }),
      textReply('문단을 넣었습니다.'),
    ],
  })
  await askDocs(frame, '맨 앞에 문단 하나를 넣어 줘')

  await expect(frame.locator('.ai-msg-assistant').last()).toContainText('문단을 넣었습니다.', {
    timeout: 30_000,
  })
  const inserted = frame.locator('.ProseMirror span.doc-ins[data-ins-author="AI Assistant"]')
  await expect(inserted).toContainText('호스트를 거친 AI 문단')

  const { bodies } = await hostState(page)
  expect(bodies).toHaveLength(2)
  const [first, second] = bodies
  expect(first!.stream).toBe(true)
  expect(first!.model).toBe('')
  expect(first!.messages[0]!.role).toBe('system')
  expect(JSON.stringify(first!.messages.at(-1))).toContain('맨 앞에 문단 하나를 넣어 줘')
  expect(first!.tools?.map((tool) => tool.function.name)).toContain('insert_content')
  // the second request carries the tool's result back to the gateway
  expect(second!.messages.some((m) => m.role === 'tool')).toBe(true)
})

test('docs: without AI from the host the panel asks to connect and nothing is sent', async ({
  page,
}) => {
  const frame = await openHost(page, DOCX, { mode: 'edit' })
  await askDocs(frame, '안녕')
  await expect(frame.getByText('AI를 쓰려면 먼저 연결하세요')).toBeVisible()
  await expect(frame.locator('.ai-msg-assistant')).toHaveCount(0)
  expect((await hostState(page)).asked).toBe(0)
})

test('docs: stopping a turn cancels the host request', async ({ page }) => {
  const frame = await openHost(page, DOCX, { mode: 'edit', replies: ['hang'] })
  await askDocs(frame, '긴 글을 써 줘')
  await expect(frame.locator('.ai-msg-assistant').last()).toContainText('생각하는 중', {
    timeout: 30_000,
  })
  await frame.locator('button.ai-stop-btn').click()
  await expect.poll(async () => (await hostState(page)).aborted).toBe(1)
  await expect(frame.locator('button.ai-stop-btn')).toHaveCount(0)
  await expect(frame.locator('.ProseMirror span.doc-ins')).toHaveCount(0)
})

const XLSX_TEXT = 'AI가 넣은 값'

/** Whether a saved workbook carries the AI's cell text */
function savedHasAiText(bytes: number[]): boolean {
  const parts = unzipSync(new Uint8Array(bytes))
  return Object.values(parts).some((part) => strFromU8(part).includes(XLSX_TEXT))
}

test('sheets: the AI edit is held as a proposal until it is accepted', async ({ page }) => {
  const frame = await openHost(page, XLSX, {
    mode: 'edit',
    replies: [
      toolReply('A1을 바꾸겠습니다.', 'propose_operations', {
        summary: 'A1에 값을 넣는다',
        operations: [{ op: 'set_cell', sheetId: SHEET_ID, address: 'A1', value: XLSX_TEXT }],
      }),
      textReply('A1을 바꿨습니다.'),
    ],
  })
  await expect(frame.locator('footer.status-bar')).toContainText('모두 로드', { timeout: 30_000 })
  const input = frame.locator('.ai-input-box textarea')
  if (!(await input.isVisible())) await frame.getByLabel('AI 도우미 열기').click()
  await input.fill('A1에 값을 넣어 줘')
  await input.press('Enter')

  const proposal = frame.getByRole('region', { name: '변경 미리 보기' })
  await expect(proposal).toBeVisible({ timeout: 30_000 })
  expect((await hostState(page)).bodies).toHaveLength(2)
  // held, not applied: a save now refuses, and nothing reached the host
  const heldSave = await page.evaluate(() =>
    (window as unknown as HostWindow).embedded.save().then(
      () => 'saved',
      () => 'refused',
    ),
  )
  expect(heldSave).toBe('refused')
  expect((await hostState(page)).saves).toHaveLength(0)

  await proposal.getByRole('button', { name: '받아들이기' }).click()
  await expect(proposal).toHaveCount(0)
  await page.evaluate(() => (window as unknown as HostWindow).embedded.save())
  const { saves } = await hostState(page)
  expect(saves).toHaveLength(1)
  expect(savedHasAiText(saves[0]!)).toBe(true)
})

/** The text bodies of a saved deck's first slide, read back with the engine the app saves with */
async function savedFirstSlide(bytes: number[]): Promise<string[]> {
  const opened = await openPptx(new Uint8Array(bytes))
  return opened.deck.slides[0]!.elements.flatMap((el) =>
    'text' in el && el.text
      ? [el.text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')]
      : [],
  )
}

/** What these tests read of the slides page's bridge (pptx-render RenderSlide) */
type SlidesPage = Window & {
  slidesApi: {
    getRenderSlides(): Promise<Array<{
      nodes: Array<{ text?: { lines: Array<{ runs: Array<{ text: string }> }> } }>
    }> | null>
  }
}

/** The first slide's text as the page draws it now */
async function shownFirstSlide(page: Page): Promise<string[]> {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!
  return frame.evaluate(async () => {
    const slides = await (window as unknown as SlidesPage).slidesApi.getRenderSlides()
    return (slides?.[0]?.nodes ?? []).flatMap((node) =>
      node.text ? [node.text.lines.map((l) => l.runs.map((r) => r.text).join('')).join('\n')] : [],
    )
  })
}

/** An `apply_ops` call that rewrites slide 1's subtitle */
const setSubtitle = (text: string): string =>
  toolReply('부제를 바꾸겠습니다.', 'apply_ops', {
    ops: [
      {
        op: 'setText',
        target: { slide: 0, el: 'sp_1' },
        paragraphs: [{ runs: [{ text }] }],
      },
    ],
  })

async function askSlides(frame: FrameLocator, prompt: string): Promise<void> {
  await expect(frame.locator('.thumb')).toHaveCount(5, { timeout: 30_000 })
  const input = frame.locator('.ai-input-box textarea')
  if (!(await input.isVisible())) await frame.locator('.stage-ai-btn').click()
  await input.fill(prompt)
  await input.press('Enter')
}

/** The host's save: 'saved' or 'refused' */
const hostSave = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (window as unknown as HostWindow).embedded.save().then(
      () => 'saved',
      () => 'refused',
    ),
  )

test('slides: the AI edit is held as a proposal until it is accepted, and a reject leaves the deck', async ({
  page,
}) => {
  const frame = await openHost(page, PPTX, {
    mode: 'edit',
    // run 1 edits, then its next turn waits until stopped; run 2 edits and finishes
    replies: [setSubtitle('AI 2027'), 'hang', setSubtitle('AI 2099'), textReply('바꿨습니다.')],
  })
  await askSlides(frame, '부제를 바꿔 줘')

  // the run's edit is in the deck while it runs: the host cannot store that deck
  await expect.poll(async () => (await hostState(page)).bodies.length, { timeout: 30_000 }).toBe(2)
  expect(await hostSave(page)).toBe('refused')
  expect((await hostState(page)).saves).toHaveLength(0)

  // stopping ends the run: its edit is taken out and held as a proposal
  await frame.locator('button.ai-stop-btn').click()
  const proposal = frame.getByRole('group', { name: '변경 제안' })
  await expect(proposal).toBeVisible({ timeout: 30_000 })
  expect(await shownFirstSlide(page)).toEqual(['Q3 Business Review', 'Fiscal Year 2026'])
  // a host save meanwhile stores the deck as it was before the run
  expect(await hostSave(page)).toBe('saved')
  expect(await savedFirstSlide((await hostState(page)).saves[0]!)).toEqual([
    'Q3 Business Review',
    'Fiscal Year 2026',
  ])

  await proposal.getByRole('button', { name: '받아들이기' }).click()
  await expect(proposal).toHaveCount(0)
  expect(await shownFirstSlide(page)).toEqual(['Q3 Business Review', 'AI 2027'])
  expect(await hostSave(page)).toBe('saved')
  expect(await savedFirstSlide((await hostState(page)).saves[1]!)).toEqual([
    'Q3 Business Review',
    'AI 2027',
  ])

  // a second run, rejected: the deck and its save stay as accepted
  await askSlides(frame, '부제를 다시 바꿔 줘')
  await expect(proposal).toBeVisible({ timeout: 30_000 })
  await proposal.getByRole('button', { name: '거부' }).click()
  await expect(proposal).toHaveCount(0)
  expect(await shownFirstSlide(page)).toEqual(['Q3 Business Review', 'AI 2027'])
  expect(await hostSave(page)).toBe('saved')
  expect(await savedFirstSlide((await hostState(page)).saves[2]!)).toEqual([
    'Q3 Business Review',
    'AI 2027',
  ])
})

test('slides: in view mode the AI answers but cannot edit the deck', async ({ page }) => {
  const frame = await openHost(page, PPTX, {
    mode: 'view',
    replies: [setSubtitle('AI 2027'), textReply('이 문서는 읽기 전용입니다.')],
  })
  await askSlides(frame, '부제를 바꿔 줘')
  await expect(frame.locator('.ai-msg-assistant').last()).toContainText('읽기 전용입니다', {
    timeout: 30_000,
  })
  // the edit tool was refused and its error went back to the model
  const { bodies } = await hostState(page)
  expect(bodies[1]!.messages.some((m) => m.role === 'tool')).toBe(true)
  await expect(frame.getByRole('group', { name: '변경 제안' })).toHaveCount(0)
  expect(await shownFirstSlide(page)).toEqual(['Q3 Business Review', 'Fiscal Year 2026'])
})

const HWPX = `${repo}apps/hwp/tests/fixtures/memo.hwpx`

/** The document's text as the engine reads it back */
async function hwpText(bytes: number[]): Promise<string> {
  const require = createRequire(import.meta.url)
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await initRhwp({ module_or_path: readFileSync(wasm) })
  const doc = new HwpDocument(new Uint8Array(bytes))
  try {
    return doc.getTextFileText().replace(/\r\n?/g, '\n')
  } finally {
    doc.free()
  }
}

test('hwp: the AI edit is held as a proposal until it is accepted', async ({ page }) => {
  const frame = await openHost(page, HWPX, {
    mode: 'edit',
    replies: [
      toolReply('문단을 바꾸겠습니다.', 'replace_text', {
        find: '본문 메모 앵커',
        replace: '호스트를 거친 AI 문장',
      }),
      textReply('바꿨습니다.'),
    ],
  })
  await expect(frame.locator('.hwp-app[data-phase="ready"]')).toHaveCount(1, { timeout: 60_000 })
  const input = frame.locator('.ai-input-box textarea')
  if (!(await input.isVisible())) await frame.locator('.ai-entry').click()
  await input.fill('첫 문장을 바꿔 줘')
  await input.press('Enter')

  const proposal = frame.locator('.ai-changes-proposed')
  await expect(proposal).toBeVisible({ timeout: 30_000 })
  // held, not applied: a host save now stores the document as it was before the run
  expect(await hostSave(page)).toBe('saved')
  const held = await hwpText((await hostState(page)).saves[0]!)
  expect(held).toContain('본문 메모 앵커')
  expect(held).not.toContain('호스트를 거친 AI 문장')

  await proposal.getByRole('button', { name: '받아들이기' }).click()
  await expect(proposal).toHaveCount(0)
  expect(await hostSave(page)).toBe('saved')
  const accepted = await hwpText((await hostState(page)).saves[1]!)
  expect(accepted).toContain('호스트를 거친 AI 문장')
  expect(accepted).not.toContain('본문 메모 앵커')
})
