// The main-process answer to a template-font URL, shared by the Word editor's media
// scheme (which serves every editor inside the shell) and a standalone sheets app:
// listed files only, read when asked for, from the one folder.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TEMPLATE_FONT_FILES, templateFontUrl } from '@genoffice/ui/template-fonts'

import { templateFontResponse } from '../src/template-font-response'

const FOLDER = resolve(import.meta.dirname, '../../ui/template-fonts')

describe('templateFontResponse', () => {
  it('serves every listed file with its own bytes and type, with CORS for the dev origin', async () => {
    for (const file of TEMPLATE_FONT_FILES) {
      const res = await templateFontResponse(templateFontUrl(file), FOLDER)
      expect(res?.status, file).toBe(200)
      expect(res!.headers.get('Content-Type')).toBe(file.endsWith('.otf') ? 'font/otf' : 'font/ttf')
      expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('*')
      const body = Buffer.from(await res!.arrayBuffer())
      expect(body.equals(readFileSync(join(FOLDER, file))), file).toBe(true)
    }
  })

  it('reads a file only when its URL is requested, brackets in the name included', async () => {
    const read = vi.fn((path: string) => Promise.resolve(new Uint8Array(readFileSync(path))))
    const response = await templateFontResponse(
      templateFontUrl('PlayfairDisplay[wght].ttf'),
      FOLDER,
      read,
    )
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(join(FOLDER, 'PlayfairDisplay[wght].ttf'))
    expect(response!.status).toBe(200)
  })

  it('leaves every other URL alone without touching the disk', async () => {
    const read = vi.fn(() => Promise.resolve(new Uint8Array(4)))
    const urls = [
      'genoffice-docx-media://template-fonts/README.md',
      'genoffice-docx-media://template-fonts/Pretendard-OFL.txt',
      'genoffice-docx-media://template-fonts/..%2F..%2Fpackage.json',
      `genoffice-docx-media://${'a'.repeat(64)}/Pretendard-Bold.otf`,
      'genoffice-docx-media://handoff/x',
      'genoffice-app://template-fonts/Pretendard-Bold.otf',
      'not a url',
    ]
    for (const url of urls) expect(await templateFontResponse(url, FOLDER, read), url).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('answers 404 when the folder lacks a listed file', async () => {
    const missing = await templateFontResponse(
      templateFontUrl('BebasNeue-Regular.ttf'),
      join(FOLDER, 'no-such-folder'),
    )
    expect(missing?.status).toBe(404)
  })
})
