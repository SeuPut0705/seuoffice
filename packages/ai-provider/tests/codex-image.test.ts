/**
 * Image generation through the Codex subscription is not part of this build
 * (see src/codex-image.ts). Loading its entry point must leave the feature
 * declared unavailable, which is what hides the Codex image option and sends an
 * image request to a key provider or to "unavailable".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as codexImage from '../src/codex-image'
import {
  codexImageGenerationAvailable,
  imageProviderSelection,
  resolveImageBackend,
} from '../src/image-backend'
import { defaultAiMediaSettings } from '../src/media'
import type { AiSubscriptionStatus } from '../src/types'

const source = readFileSync(
  fileURLToPath(new URL('../src/codex-image.ts', import.meta.url)),
  'utf8',
)

const READY: AiSubscriptionStatus = { provider: 'codex', state: 'ready', meteredAccepted: false }

describe('the Codex image entry point', () => {
  it('declares nothing available when it loads', () => {
    expect(Object.keys(codexImage)).toEqual([])
    expect(codexImageGenerationAvailable()).toBe(false)
  })

  it('leaves a selected Codex without an image backend, even on a ready subscription', () => {
    const media = defaultAiMediaSettings()
    media.imageProvider = 'codex'
    expect(resolveImageBackend({ media }, { codex: READY })).toEqual({ kind: 'none' })
    expect(imageProviderSelection({ media })).toBe('none')
  })

  it('holds no code: nothing that starts a program, and no word of the login file', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code.trim()).toBe('export {}')
    expect(source).not.toMatch(/auth\.json/i)
    expect(source).not.toMatch(/CODEX_HOME/)
  })
})
