/**
 * The context gate and tools-off switch must be on every AI path, not only the
 * editors that happen to have a focused test: a transport without the gate
 * sends a prompt nobody confirmed, and a loop without `toolsAllowed` sends tool
 * definitions to a model that reported it has none. These guards read the
 * sources so a new panel or transport cannot quietly skip either.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const source = (path: string): string => readFileSync(join(REPO, path), 'utf8')

/** every renderer-side transport over `createIpcTransport` (the PDF/EPUB job calls use these) */
const TRANSPORTS = [
  'apps/docs/src/renderer/ai/transport.ts',
  'apps/sheets/src/renderer/ai/transport.ts',
  'apps/slides/src/renderer/ai/transport.ts',
  'apps/pdf/src/renderer/ai/transport.ts',
  'apps/markdown/src/renderer/ai/transport.ts',
  'apps/html/src/renderer/ai/transport.ts',
  'apps/mindmap/src/renderer/ai/transport.ts',
  'apps/hwp/src/renderer/ai/transport.ts',
  'apps/epub/src/renderer/ai/transport.ts',
  'apps/shell/src/renderer/src/KbAskPanel.tsx',
  'apps/epub/src/renderer/translate/model-call.ts',
] as const

/** every AgentLoop call site: the panels, the home question panel, and the slide QC pass */
const LOOPS = [
  'apps/docs/src/renderer/ai/AiPanel.tsx',
  'apps/sheets/src/renderer/App.tsx',
  'apps/slides/src/renderer/ai/AiPanel.tsx',
  'apps/slides/src/renderer/ai/slide-qc.ts',
  'apps/pdf/src/renderer/ai/AiPanel.tsx',
  'apps/markdown/src/renderer/ai/AiPanel.tsx',
  'apps/html/src/renderer/ai/AiPanel.tsx',
  'apps/mindmap/src/renderer/ai/AiPanel.tsx',
  'apps/hwp/src/renderer/ai/AiPanel.tsx',
  'apps/epub/src/renderer/ai/AiPanel.tsx',
  'apps/shell/src/renderer/src/KbAskPanel.tsx',
] as const

/** the AI panels that show the tools-off notice (slide QC and the PDF jobs are internal, text-only passes) */
const NOTICE_PANELS = [
  'apps/docs/src/renderer/ai/AiPanel.tsx',
  'apps/sheets/src/renderer/ai/AiChatPanel.tsx',
  'apps/slides/src/renderer/ai/AiPanel.tsx',
  'apps/pdf/src/renderer/ai/AiPanel.tsx',
  'apps/markdown/src/renderer/ai/AiPanel.tsx',
  'apps/html/src/renderer/ai/AiPanel.tsx',
  'apps/mindmap/src/renderer/ai/AiPanel.tsx',
  'apps/hwp/src/renderer/ai/AiPanel.tsx',
  'apps/epub/src/renderer/ai/AiPanel.tsx',
  'apps/shell/src/renderer/src/KbAskPanel.tsx',
] as const

describe('every transport confirms a large prompt', () => {
  it.each(TRANSPORTS)('%s passes contextLimit and confirmContext', (path) => {
    const text = source(path)
    expect(text).toMatch(/contextLimit: \(settings\) => localContextLimit\(settings\)/)
    expect(text).toMatch(/confirmContext: \(warning\) =>\s*window\.confirm\(/)
    expect(text).toContain('aiContextConfirmText(')
  })
})

describe('every loop turns tools off for a model without them', () => {
  it.each(LOOPS)('%s passes toolsAllowed', (path) => {
    expect(source(path)).toContain('toolsAllowed:')
  })
})

describe('every AI panel shows the tools-off notice', () => {
  it.each(NOTICE_PANELS)('%s renders AiToolsUnsupportedNotice', (path) => {
    const text = source(path)
    expect(text).toContain('AiToolsUnsupportedNotice')
    expect(text).toContain('localModelCapabilities(')
  })
})

describe('the document jobs share one confirmation per job', () => {
  it.each([
    'apps/pdf/src/renderer/doc-jobs/model-call.ts',
    'apps/epub/src/renderer/translate/model-call.ts',
  ])('%s owns a contextGate and sends its runId', (path) => {
    const text = source(path)
    expect(text).toContain('contextGate')
    expect(text).toContain('runId')
    expect(text).toMatch(/tools: \[\], runId/)
  })
})

describe('the deck generation calls confirm a large prompt', () => {
  // runLlmAttempt goes straight to ai:stream, past the panel's transport
  it('apps/slides/src/renderer/ai/AiPanel.tsx checks the deck gate before ai:stream', () => {
    const text = source('apps/slides/src/renderer/ai/AiPanel.tsx')
    expect(text).toMatch(/contextLimit: \(settings\) => localContextLimit\(settings\)/)
    expect(text).toMatch(/confirm: \(warning\) => window\.confirm\(aiContextConfirmText\(/)
    const attempt = text.slice(text.indexOf('const runLlmAttempt = ('))
    const check = attempt.indexOf('deckContextGate.allows(settings, system, user, signal)')
    const send = attempt.indexOf('.aiStream(')
    expect(check).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(check)
  })

  it('apps/slides/src/renderer/ai/slides-skill.ts gives the page redo the run signal', () => {
    const text = source('apps/slides/src/renderer/ai/slides-skill.ts')
    const redo = text.slice(
      text.indexOf("case 'regenerate_slide'"),
      text.indexOf("case 'generate_deck'"),
    )
    expect(redo).toContain('...(signal ? { signal } : {})')
  })
})
