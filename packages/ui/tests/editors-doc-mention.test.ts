/**
 * The `@` document list is in the AI input of the six editors that can attach
 * files, and nowhere else (the PDF and markdown editors have no attachments;
 * the home Ask and the agent window are out of its scope). These guards read
 * the panels' sources.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const source = (path: string): string => readFileSync(join(REPO, path), 'utf8')

/** where the list's actions are built, and the input that receives them */
const WIRED: Record<string, { actions: string; input: string; prop: RegExp }> = {
  docs: {
    actions: 'apps/docs/src/renderer/ai/AiPanel.tsx',
    input: 'apps/docs/src/renderer/ai/AiPanel.tsx',
    prop: /docs=\{docMention\}/,
  },
  sheets: {
    actions: 'apps/sheets/src/renderer/App.tsx',
    input: 'apps/sheets/src/renderer/ai/AiChatPanel.tsx',
    prop: /docs=\{docMention\}/,
  },
  slides: {
    actions: 'apps/slides/src/renderer/ai/AiPanel.tsx',
    input: 'apps/slides/src/renderer/ai/AiPanel.tsx',
    prop: /useComposerPickers\(\{[\s\S]*?docs: docMention,/,
  },
  hwp: {
    actions: 'apps/hwp/src/renderer/ai/AiPanel.tsx',
    input: 'apps/hwp/src/renderer/ai/AiPanel.tsx',
    prop: /docs=\{docMention\}/,
  },
  html: {
    actions: 'apps/html/src/renderer/ai/AiPanel.tsx',
    input: 'apps/html/src/renderer/ai/AiPanel.tsx',
    prop: /docs=\{docMention\}/,
  },
  mindmap: {
    actions: 'apps/mindmap/src/renderer/ai/AiPanel.tsx',
    input: 'apps/mindmap/src/renderer/ai/AiPanel.tsx',
    prop: /docs=\{docMention\}/,
  },
}

const NOT_WIRED = [
  'apps/pdf/src/renderer/ai/AiPanel.tsx',
  'apps/markdown/src/renderer/ai/AiPanel.tsx',
  'apps/shell/src/renderer/src/KbAskPanel.tsx',
  'apps/shell/src/renderer/src/agent/AgentWindow.tsx',
]

describe('the @ document list in the AI panels', () => {
  for (const [name, at] of Object.entries(WIRED)) {
    it(`${name}: attaches through the editor's own route and reaches the input`, () => {
      const actions = source(at.actions)
      expect(actions).toMatch(/docMentionActions\(\{[\s\S]*?add:[\s\S]*?addAttachmentPaths/)
      expect(actions).toMatch(/merge: (\(result\) => )?mergeAttachments/)
      expect(actions).toMatch(/const docMention: AiComposerDocs = \{[\s\S]*?attachments,\n {2}\}/)
      expect(source(at.input)).toMatch(at.prop)
    })
  }

  it('slides keeps one picker hook for skills and documents', () => {
    const slides = source('apps/slides/src/renderer/ai/AiPanel.tsx')
    expect(slides).not.toMatch(/useSkillPickerInput\(/)
    expect(slides).toMatch(/useComposerPickers\(/)
  })

  for (const path of NOT_WIRED) {
    it(`${path} has no @ document list`, () => {
      const text = source(path)
      expect(text).not.toMatch(/docMentionActions|docs=\{docMention\}|docs: docMention/)
    })
  }
})
