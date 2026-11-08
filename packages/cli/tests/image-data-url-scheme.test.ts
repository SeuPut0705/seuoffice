import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { readImageSource } from '../src/formats/image-source'
import { run, tempDir } from './helpers'

const encoded =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const bytes = Buffer.from(encoded, 'base64')
for (const scheme of ['data:', 'DATA:', 'DaTa:'])
  for (const mime of ['image/png', 'IMAGE/PNG'])
    it(`reads ${scheme}${mime} without using a file path`, async () => {
      const r = await readImageSource(scheme + mime + ';BASE64,' + encoded, {
        cwd: tempDir(),
        env: {},
      })
      expect(r).not.toBeNull()
      expect(Buffer.from(r!.bytes)).toEqual(bytes)
      expect(r).toMatchObject({ ext: 'png', mime: 'image/png' })
    })
it('still rejects a non-image data URL', async () => {
  expect(
    await readImageSource('DATA:text/plain;base64,QQ==', { cwd: tempDir(), env: {} }),
  ).toBeNull()
})
it('embeds an uppercase-scheme image through a real Word operation', async () => {
  const dir = tempDir(),
    input = join(dir, 'source.docx'),
    output = join(dir, 'result.docx'),
    ops = join(dir, 'ops.json'),
    original = Buffer.from(await buildBlankDocx())
  writeFileSync(input, original)
  writeFileSync(
    ops,
    JSON.stringify([
      {
        op: 'insert_picture',
        url: 'DATA:IMAGE/PNG;BASE64,' + encoded,
        afterBlockIndex: -1,
        width: '12pt',
      },
    ]),
  )
  const r = await run(['docs', 'apply', input, '--ops', ops, '--out', output, '--json'])
  expect(r.code, r.stdout).toBe(0)
  const zip = await JSZip.loadAsync(readFileSync(output)),
    images = Object.keys(zip.files).filter((p) => /^word\/media\//.test(p) && !zip.files[p]!.dir)
  expect(images).toHaveLength(1)
  expect(await zip.file(images[0]!)!.async('nodebuffer')).toEqual(bytes)
  expect(readFileSync(input)).toEqual(original)
})
