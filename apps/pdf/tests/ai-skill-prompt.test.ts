import { describe, expect, it } from 'vitest'
import { PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from '@genoffice/i18n'
import { createPdfSkill } from '../src/renderer/ai/pdf-skill'
import type { PdfAiDeps } from '../src/renderer/ai/tools'

const skillWith = (imageGenAvailable?: () => boolean) =>
  createPdfSkill({ imageGenAvailable } as unknown as PdfAiDeps)

const toolNames = (skill: ReturnType<typeof createPdfSkill>) => skill.tools.map((t) => t.name)

describe('pdf skill prompt', () => {
  it('names the product, not the upstream project', () => {
    const prompt = skillWith(() => true).systemPrompt
    expect(prompt.startsWith(`You are ${PRODUCT_NAME}'s PDF assistant`)).toBe(true)
    expect(prompt).not.toContain(UPSTREAM_PRODUCT_NAME)
  })

  it('offers generate_image while an image route is available', () => {
    const skill = skillWith(() => true)
    expect(toolNames(skill)).toContain('generate_image')
    expect(skill.systemPrompt).not.toContain('currently unavailable')
  })

  it('withdraws generate_image and says why when no image route is available', () => {
    const skill = skillWith(() => false)
    expect(toolNames(skill)).not.toContain('generate_image')
    expect(toolNames(skill)).toContain('image_search')
    expect(skill.systemPrompt).toContain('generate_image is currently unavailable')
    expect(skill.systemPrompt).toContain('Codex subscription')
    expect(skill.systemPrompt).toContain('media API key')
  })

  it('follows the availability as it changes between requests', () => {
    let available = false
    const skill = skillWith(() => available)
    expect(toolNames(skill)).not.toContain('generate_image')
    available = true
    expect(toolNames(skill)).toContain('generate_image')
  })
})
