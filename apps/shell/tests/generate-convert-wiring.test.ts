import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Fixed by reading the source (the tab manager and index.ts need a running
 * Electron): a conversion without AI (8.6) reaches no provider and no
 * subscription anywhere on its way, reads its source only through the
 * redaction-aware reader, and the shell wires its new tab once.
 */

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const CONVERT_PATH = [
  '../src/main/generate/convert.ts',
  '../src/main/generate/converted-tab.ts',
  '../../markdown/src/main/seed-main.ts',
  '../../mindmap/src/main/seed-main.ts',
  '../../slides/src/main/seed-deck.ts',
  '../../slides/src/main/seed-queue.ts',
]

describe('a conversion never reaches an AI', () => {
  it('imports nothing that talks to a provider or the AI channels', () => {
    for (const path of CONVERT_PATH) {
      const text = src(path)
      expect(text, path).not.toMatch(
        /@genoffice\/ai-provider|@genoffice\/agent-core|@genoffice\/ai-search|ai-ipc|ai-stream/,
      )
      expect(text, path).not.toMatch(/['"]ai:|subscription/i)
    }
  })

  it('keeps the conversion module free of Electron', () => {
    expect(src('../src/main/generate/convert.ts')).not.toMatch(/from 'electron'/)
  })

  it('reads the source only through the redaction-aware reader', () => {
    const text = src('../src/main/generate/convert.ts')
    expect(text).toMatch(/import \{ parseFileToText[^}]*\} from '@genoffice\/file-parse'/)
    const convert = text.slice(
      text.indexOf('export async function convertSource('),
      text.indexOf('// ---- map → PPT skeleton ----'),
    )
    expect(convert).toMatch(/parseFileToText/)
    expect(convert).not.toMatch(/readFile|openXmind/)
  })
})

describe('the shell wiring', () => {
  it('opens the converted tab from the window, through the tab manager', () => {
    const index = src('../src/main/index.ts')
    expect(index.match(/openConversionResult\(doc\)/g)).toHaveLength(1)
    const tabs = src('../src/main/tab-manager.ts')
    expect(tabs).toMatch(/queueConvertedContent\(contents, doc\)/)
    const tab = src('../src/main/generate/converted-tab.ts')
    expect(tab).toMatch(/recordGenerateConverted\(/)
  })

  it('has the window ask for a conversion over its own channel', () => {
    expect(src('../src/main/generate/generate-window.ts')).toMatch(
      /GENERATE_CHANNELS\.setConvert, \(event, kind: unknown\) => \{\n\s+if \(fromWindow\(event\)\)/,
    )
    expect(src('../src/preload/generate.ts')).toMatch(/GENERATE_CHANNELS\.setConvert/)
  })
})
