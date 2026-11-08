import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl, type LaunchedApp } from './helpers'

/**
 * Agent mode (decision 0032) against the real Claude Code / Codex of this PC.
 *
 * It spends the person's subscription, so it never runs in the normal suite:
 * set IEUM_AGENT_REAL to `claude`, `codex` or `both` (docs/operations.md,
 * "실제 구독으로 확인하기"). Claude runs on haiku, the smallest model.
 *
 * What it checks, through the built app and its agent window:
 * - a session starts in a project folder and the window shows its progress;
 * - the agent edits a Word document open in a tab through the app's MCP tools,
 *   and the paragraph lands exactly once;
 * - a command asks first, and the answer from the window reaches the program;
 * - Codex: a command the person allowed still runs in the sandbox, so it can
 *   write in the project but not in Documents;
 * - closing the window, also in the middle of a turn, ends every program the
 *   app started for it.
 */

const REAL = process.env.IEUM_AGENT_REAL ?? ''
const ASSET = join(__dirname, 'assets', 'justify-pagegap-fr.docx')
const XLSX_ASSET = join(__dirname, '..', 'apps', 'shell', 'build', 'shell-new', 'blank.xlsx')
const PPTX_ASSET = join(
  __dirname,
  '..',
  'packages',
  'pptx-engine',
  'tests',
  'fixtures',
  '01_standard_business.pptx',
)

test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)

interface Setup {
  launched: LaunchedApp
  project: string
}

interface SetupOptions {
  mode?: 'ask-commands' | 'ask-writes' | 'trust-project'
  /** more files copied into the project and opened in tabs: name → source */
  files?: Record<string, string>
  /** the in-app MCP server's port, for reading the documents back */
  mcpPort?: number
}

async function setup(
  provider: 'claude-code' | 'codex',
  { mode = 'ask-commands', files = {}, mcpPort }: SetupOptions = {},
): Promise<Setup> {
  const project = await mkdtemp(join(tmpdir(), 'ieum-agent-e2e-'))
  await copyFile(ASSET, join(project, 'report.docx'))
  for (const [name, source] of Object.entries(files)) await copyFile(source, join(project, name))
  const userDataDir = await mkdtemp(join(tmpdir(), 'ieum-agent-e2e-data-'))
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'auto',
      providers: { 'claude-code': { apiKey: '', model: 'haiku' } },
      subscriptionNoticeSeen: true,
    }),
  )
  const launched = await launchShell({
    userDataDir,
    videoDir: 'agent-real',
    onboardingSeen: true,
    openFile: join(project, 'report.docx'),
    openFiles: Object.keys(files).map((name) => join(project, name)),
    settings: {
      agent: { provider, mode, recentFolders: [project], warningAccepted: 1 },
      ...(mcpPort ? { mcpEnabled: true, mcpPort } : {}),
    },
  })
  return { launched, project }
}

async function openAgentWindow(launched: LaunchedApp): Promise<Page> {
  await waitForPageWithUrl(launched.app, '://docs/', 60_000)
  // the Home page (the shell window's own), not the document tab that opened at launch
  const home = await waitForPageWithUrl(launched.app, 'renderer/index.html', 30_000)
  await home.evaluate(() =>
    (window as unknown as { aiOfficeAgent?: { open(): Promise<void> } }).aiOfficeAgent?.open(),
  )
  return waitForPageWithUrl(launched.app, 'agent.html', 30_000)
}

/** pids of the programs the app started, from its child record */
interface AppChild {
  pid: number
  provider: string
  startedAt: number
}

/** programs the app started for this session: the provider's, started after "Start" was pressed */
async function sessionChildren(
  userDataDir: string,
  provider: string,
  since: number,
): Promise<AppChild[]> {
  return (await appChildren(userDataDir)).filter(
    (child) => child.provider === provider && child.startedAt >= since,
  )
}

async function appChildren(userDataDir: string): Promise<AppChild[]> {
  const files = (await readdir(userDataDir)).filter((name) =>
    name.startsWith('subscription-children-'),
  )
  const children: AppChild[] = []
  for (const file of files) {
    try {
      const record = JSON.parse(await readFile(join(userDataDir, file), 'utf8')) as {
        children?: AppChild[]
      }
      children.push(...(record.children ?? []))
    } catch {
      // being rewritten; the next read sees it
    }
  }
  return children
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for the turn to end, answering permission cards with `decide` */
async function runTurn(
  agent: Page,
  decide: (detail: string) => 'allow' | 'deny',
): Promise<string[]> {
  const asked: string[] = []
  const deadline = Date.now() + 300_000
  for (;;) {
    const card = agent.locator('.agent-perm').first()
    if (await card.isVisible().catch(() => false)) {
      const detail = (await card.locator('.agent-perm-detail').textContent()) ?? ''
      asked.push(detail)
      const choice = decide(detail)
      await card.getByRole('button', { name: choice === 'allow' ? 'Allow' : 'Decline' }).click()
      continue
    }
    const busy = await agent.locator('.agent').getAttribute('data-busy')
    if (busy === 'false') return asked
    if (Date.now() > deadline) throw new Error('the turn did not end in time')
    await agent.waitForTimeout(1000)
  }
}

async function docsText(app: ElectronApplication): Promise<string> {
  const docs = await waitForPageWithUrl(app, '://docs/', 10_000)
  return docs.evaluate(() => document.body.innerText)
}

async function closeAgentWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().includes('agent.html')) win.close()
    }
  })
}

async function expectEnded(pids: number[]): Promise<void> {
  await expect
    .poll(() => pids.filter(alive), { timeout: 20_000 })
    .toEqual([])
    .catch(async (error: unknown) => {
      // name what is left, for the report
      const { execFileSync } = await import('node:child_process')
      for (const pid of pids.filter(alive)) {
        const line = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
        })
        console.log('LEFT', line.trim())
      }
      throw error
    })
}

test('Claude Code: edits an open document, asks before a command, ends on close', async () => {
  test.skip(REAL !== 'claude' && REAL !== 'both', 'set IEUM_AGENT_REAL=claude or both')
  const { launched, project } = await setup('claude-code')
  try {
    const agent = await openAgentWindow(launched)
    const start = agent.getByRole('button', { name: 'Start' })
    await expect(start).toBeEnabled({ timeout: 60_000 })
    const since = Date.now() - 1000
    await start.click()
    await expect(agent.locator('.agent-input')).toBeVisible({ timeout: 60_000 })

    await agent
      .locator('.agent-input')
      .fill(
        'Do exactly these two things, then answer in one short sentence. ' +
          '1) With the ieumoffice-editor tools, add one new paragraph with exactly the text AGENT-E2E-CLAUDE at the end of the open Word document report.docx. ' +
          "2) Run this shell command in the project folder: node -e \"require('fs').writeFileSync('agent-cmd.txt','ok')\"",
      )
    await agent.getByRole('button', { name: 'Send' }).click()
    const pidsDuring: number[] = []
    const asked = await runTurn(agent, () => {
      return 'allow'
    })
    for (const child of await sessionChildren(launched.userDataDir, 'claude-code', since)) {
      pidsDuring.push(child.pid)
    }

    expect(asked.some((detail) => detail.includes('agent-cmd.txt'))).toBe(true)
    expect(existsSync(join(project, 'agent-cmd.txt'))).toBe(true)
    const text = await docsText(launched.app)
    expect(text.split('AGENT-E2E-CLAUDE').length - 1).toBe(1)
    await agent.screenshot({
      path: join(__dirname, 'artifacts', 'screenshots', 'agent-claude.png'),
    })

    // a second message, closed in the middle of its turn
    await agent
      .locator('.agent-input')
      .fill('Write a numbered list of 200 short facts about paper, one per line.')
    await agent.getByRole('button', { name: 'Send' }).click()
    await agent.waitForTimeout(3000)
    for (const child of await sessionChildren(launched.userDataDir, 'claude-code', since)) {
      pidsDuring.push(child.pid)
    }
    console.log(
      'CLAUDE PIDS',
      JSON.stringify(await appChildren(launched.userDataDir)),
      'since',
      since,
    )
    expect(pidsDuring.length).toBeGreaterThan(0)
    await closeAgentWindow(launched.app)
    await expectEnded([...new Set(pidsDuring)])
  } finally {
    await closeAndSaveVideo(launched, 'agent-claude')
  }
})

test('Codex: edits an open document, keeps allowed commands in its sandbox, ends on close', async () => {
  test.skip(REAL !== 'codex' && REAL !== 'both', 'set IEUM_AGENT_REAL=codex or both')
  const { launched, project } = await setup('codex')
  const outside = join(homedir(), 'Documents', `ieum-agent-e2e-${Date.now()}.txt`)
  try {
    const agent = await openAgentWindow(launched)
    const start = agent.getByRole('button', { name: 'Start' })
    await expect(start).toBeEnabled({ timeout: 60_000 })
    const since = Date.now() - 1000
    await start.click()
    await expect(agent.locator('.agent-input')).toBeVisible({ timeout: 90_000 })

    await agent
      .locator('.agent-input')
      .fill(
        'Do exactly these two things, then answer in one short sentence. ' +
          '1) With the ieumoffice-editor tools, add one new paragraph with exactly the text AGENT-E2E-CODEX at the end of the open Word document report.docx. ' +
          '2) Run this command in the project folder: cmd /c "echo ok> codex-cmd.txt" ' +
          `3) Run this command: cmd /c "echo x> ${outside}" ` +
          'If a command fails, do not retry it in another form; just say so.',
      )
    await agent.getByRole('button', { name: 'Send' }).click()
    const asked = await runTurn(agent, () => 'allow')
    const pids = (await sessionChildren(launched.userDataDir, 'codex', since)).map(
      (child) => child.pid,
    )
    console.log(
      'CODEX PIDS',
      JSON.stringify(await appChildren(launched.userDataDir)),
      'since',
      since,
    )

    expect(asked.some((detail) => detail.includes('codex-cmd.txt'))).toBe(true)
    expect(existsSync(join(project, 'codex-cmd.txt'))).toBe(true)
    // allowed by the person, refused by the sandbox
    expect(existsSync(outside)).toBe(false)
    const text = await docsText(launched.app)
    expect(text.split('AGENT-E2E-CODEX').length - 1).toBe(1)
    await mkdir(join(__dirname, 'artifacts', 'screenshots'), { recursive: true })
    await agent.screenshot({ path: join(__dirname, 'artifacts', 'screenshots', 'agent-codex.png') })
    test.info().annotations.push({ type: 'asked', description: JSON.stringify(asked) })

    expect(pids.length).toBeGreaterThan(0)
    await closeAgentWindow(launched.app)
    await expectEnded(pids)
  } finally {
    await rm(outside, { force: true })
    await closeAndSaveVideo(launched, 'agent-codex')
  }
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** One tool call on the in-app MCP server, to read a document back as the app holds it */
async function appMcpCall(port: number, name: string, args: Record<string, unknown>) {
  const post = async (sessionId: string | null, payload: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    const line = text.split('\n').find((entry) => entry.startsWith('data: '))
    const body = (line ? JSON.parse(line.slice(6)) : text ? JSON.parse(text) : null) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    } | null
    return { sessionId: response.headers.get('mcp-session-id'), body }
  }
  const init = await post(null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  })
  await post(init.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const called = await post(init.sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  return {
    isError: called.body?.result?.isError === true,
    text: called.body?.result?.content?.map((part) => part.text ?? '').join('') ?? '',
  }
}

test('Codex: edits an open workbook and deck, and the new file opens in a tab', async () => {
  test.skip(REAL !== 'codex' && REAL !== 'both', 'set IEUM_AGENT_REAL=codex or both')
  const mcpPort = await freePort()
  const { launched, project } = await setup('codex', {
    // trust: nothing asks, so Codex's own check before each app tool must still pass
    mode: 'trust-project',
    files: { 'data.xlsx': XLSX_ASSET, 'deck.pptx': PPTX_ASSET },
    mcpPort,
  })
  try {
    await waitForPageWithUrl(launched.app, '://sheets', 60_000)
    await waitForPageWithUrl(launched.app, '://slides', 60_000)
    const agent = await openAgentWindow(launched)
    const start = agent.getByRole('button', { name: 'Start' })
    await expect(start).toBeEnabled({ timeout: 60_000 })
    const since = Date.now() - 1000
    await start.click()
    await expect(agent.locator('.agent-input')).toBeVisible({ timeout: 90_000 })

    await agent
      .locator('.agent-input')
      .fill(
        'Do exactly these three things with the ieumoffice-editor tools and your file editing tool, then answer in one short sentence. ' +
          '1) In the open workbook data.xlsx, set cell A1 of the first sheet to the text AGENT-E2E-SHEET. ' +
          '2) In the open presentation deck.pptx, add a text box with exactly the text AGENT-E2E-SLIDE to the first slide. ' +
          '3) Create a new file notes.md in the project folder containing the line AGENT-E2E-NOTE, with your file editing tool (not a shell command).',
      )
    await agent.getByRole('button', { name: 'Send' }).click()
    const asked = await runTurn(agent, () => 'allow')
    const pids = (await sessionChildren(launched.userDataDir, 'codex', since)).map(
      (child) => child.pid,
    )
    test.info().annotations.push({ type: 'asked', description: JSON.stringify(asked) })
    await mkdir(join(__dirname, 'artifacts', 'screenshots'), { recursive: true })
    await agent.screenshot({
      path: join(__dirname, 'artifacts', 'screenshots', 'agent-codex-sheet-deck.png'),
    })

    const sheet = await appMcpCall(mcpPort, 'read_sheet', {
      addresses: ['A1'],
      document: join(project, 'data.xlsx'),
    })
    expect(sheet.isError, sheet.text).toBe(false)
    expect(sheet.text).toContain('AGENT-E2E-SHEET')
    const deck = await appMcpCall(mcpPort, 'read_deck', { document: join(project, 'deck.pptx') })
    expect(deck.isError, deck.text).toBe(false)
    expect(deck.text.split('AGENT-E2E-SLIDE').length - 1).toBe(1)

    // the new file: its line offers "Open", and that opens it in a tab
    expect(existsSync(join(project, 'notes.md'))).toBe(true)
    // the line of the write that made it (a later command reading it has no "Open")
    const open = agent
      .locator('.agent-tool', { hasText: 'notes.md' })
      .getByRole('button', { name: 'Open' })
    await expect(open).toHaveCount(1)
    // the button keeps its width beside a long path
    expect(await open.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true)
    await open.click()
    const notes = await waitForPageWithUrl(launched.app, '://markdown', 30_000)
    await expect
      .poll(() => notes.evaluate(() => document.body.innerText))
      .toContain('AGENT-E2E-NOTE')

    expect(pids.length).toBeGreaterThan(0)
    await closeAgentWindow(launched.app)
    await expectEnded(pids)
  } finally {
    await closeAndSaveVideo(launched, 'agent-codex-sheet-deck')
  }
})
