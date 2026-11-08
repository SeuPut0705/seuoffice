// @vitest-environment node
/**
 * The page writer's system prompt. A request no built-in design template
 * applies to must send exactly the text it sent before templates existed: the
 * baseline fixture was captured from the inline string in AiPanel.tsx before
 * it was moved into buildPageSystemPrompt.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPageSystemPrompt,
  TEMPLATE_DEVICES_EXEMPTION,
} from '../src/renderer/ai/page-system-prompt'

const baseline = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/page-system-prompt.baseline.json'), 'utf8'),
) as Record<string, string>

const sizes = Object.keys(baseline).map((key) => {
  const [w, h] = key.split('x').map(Number)
  return { key, canvasW: w!, canvasH: h! }
})

describe('page writer system prompt', () => {
  it('pins the canvas the generator uses, and one more to pin the interpolation', () => {
    expect(Object.keys(baseline)).toEqual(['1280x720', '960x720'])
  })

  it.each(sizes)(
    'is byte-for-byte the pre-change text when no template applies ($key)',
    ({ key, canvasW, canvasH }) => {
      const prompt = buildPageSystemPrompt({ canvasW, canvasH })
      expect(Buffer.from(prompt, 'utf8').equals(Buffer.from(baseline[key]!, 'utf8'))).toBe(true)
      expect(buildPageSystemPrompt({ canvasW, canvasH, templateDevices: false })).toBe(prompt)
    },
  )

  it.each(sizes)(
    'adds only the exemption, after the unchanged text, when a template applies ($key)',
    ({ key, canvasW, canvasH }) => {
      const prompt = buildPageSystemPrompt({ canvasW, canvasH, templateDevices: true })
      expect(prompt).toBe(`${baseline[key]}\n${TEMPLATE_DEVICES_EXEMPTION}`)
    },
  )

  it('the exemption text never reaches a request without a template', () => {
    const plain = buildPageSystemPrompt({ canvasW: 1280, canvasH: 720 })
    expect(plain).not.toContain(TEMPLATE_DEVICES_EXEMPTION)
    expect(plain).not.toContain('design template')
  })

  it('the exemption names the four devices and keeps every other rule', () => {
    for (const device of [
      'bar on top of cards',
      'bar on the left of cards',
      'bar beside a title',
      'corner blocks',
    ]) {
      expect(TEMPLATE_DEVICES_EXEMPTION).toContain(device)
    }
    for (const kept of ['emoji', 'placeholders', 'fake photos', 'rainbow cards', 'layout rules']) {
      expect(TEMPLATE_DEVICES_EXEMPTION).toContain(kept)
    }
    expect(TEMPLATE_DEVICES_EXEMPTION).toContain('only where the style prescribes it')
  })

  it('the panel builds the prompt with this function and holds no copy of the text', () => {
    const panel = readFileSync(join(__dirname, '../src/renderer/ai/AiPanel.tsx'), 'utf8')
    expect(panel).toContain('buildPageSystemPrompt({')
    // the exemption is asked for only by a request that carries the template flag
    expect(panel).toContain('templateDevices: args.templateDevices === true')
    expect(panel).not.toContain('Anti-AI design rules')
    expect(panel).not.toContain('You are a professional slide visual designer')
  })
})
