import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { LABEL, OWN_REDACT_NS, PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

/**
 * A table holding a nested table is flattened to text for a Markdown or HTML
 * copy: a hidden run in any of its cells, the nested table's own included,
 * reads as its placeholder there, as it does in every AI reader.
 */

const NO_APP = { env: { ...process.env, SEUOFFICE_APP_BIN: '/nonexistent/seuoffice' } }
const hidden = (text: string) =>
  `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${LABEL}"/></w:rPr><w:t>${text}</w:t></w:r>`
const plain = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const tbl = (rows: string) =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows}</w:tbl>`
const cell = (inner: string) => `<w:tc>${inner}</w:tc>`
const NESTED_PLAIN = tbl(
  `<w:tr>${cell(`<w:p>${plain('Inner')}</w:p>`)}${cell(`<w:p>${plain('Cell')}</w:p>`)}</w:tr>`,
)
const NESTED_HIDDEN = tbl(
  `<w:tr>${cell(`<w:p>${plain('Inner ')}${hidden(SECRET)}</w:p>`)}${cell(`<w:p>${plain('Cell')}</w:p>`)}</w:tr>`,
)

const CASES: Record<string, string> = {
  'a hidden run in a cell beside the nested table': tbl(
    `<w:tr>${cell(`${NESTED_PLAIN}<w:p/>`)}${cell(`<w:p>${plain('Call ')}${hidden(SECRET)}</w:p>`)}</w:tr>`,
  ),
  'a hidden run inside the nested table': tbl(
    `<w:tr>${cell(`${NESTED_HIDDEN}<w:p/>`)}${cell(`<w:p>${plain('Other')}</w:p>`)}</w:tr>`,
  ),
}

describe.each(Object.keys(CASES))('%s', (name) => {
  it.each(['md', 'html'])('converts to %s with no hidden word', async (to) => {
    const dir = tempDir()
    const file = join(dir, 'nested.docx')
    writeFileSync(file, await buildDocx({ bodyXml: `${CASES[name]}<w:p/>` }))
    const out = join(dir, `out.${to}`)
    const r = await run(['convert', file, '--to', to, '--out', out, '--json'], NO_APP)
    expect(r.stdout + r.stderr).not.toContain(SECRET)
    expect(r.code, r.stdout).toBe(0)
    const text = readFileSync(out, 'utf-8')
    expect(text).not.toContain(SECRET)
    expect(text).toContain(PLACEHOLDER)
  })
})
