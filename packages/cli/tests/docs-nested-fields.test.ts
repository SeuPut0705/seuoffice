import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'
const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }
const mark = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
const instr = (text: string) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
const text = (value: string) => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`
const field = (instruction: string, cached: string) =>
  mark('begin') + instr(instruction) + mark('separate') + cached + mark('end')
const nested = (outer: string, inner: string, result: string) =>
  mark('begin') +
  instr(outer + ' ') +
  inner +
  instr(outer === '=' ? ' + 1' : ' = 1 "yes" "no"') +
  mark('separate') +
  result +
  mark('end')

describe('nested Word field cache checks', () => {
  it.each([
    {
      name: 'empty outer IF',
      xml: nested('IF', field('MERGEFIELD name', text('1')), ''),
      expected: ['IF'],
    },
    {
      name: 'empty outer formula',
      xml: nested('=', field('PAGE', text('1')), ''),
      expected: ['field'],
    },
    {
      name: 'three empty levels',
      xml: nested('IF', nested('IF', field('PAGE', ''), ''), ''),
      expected: ['PAGE', 'IF', 'IF'],
    },
    {
      name: 'resultless child keeps outer',
      xml: field('IF 1 = 1 "yes" "no"', field('XE entry', '')),
      expected: ['IF'],
    },
    {
      name: 'outer continues after child',
      xml: nested('IF', field('PAGE', text('1')), '') + field('DATE', ''),
      expected: ['IF', 'DATE'],
    },
    {
      name: 'cached outer and inner',
      xml: nested('IF', field('PAGE', text('1')), text('yes')),
      expected: [],
    },
    {
      name: 'inner result supplies outer cache',
      xml: field('IF 1 = 1 "yes" "no"', field('PAGE', text('1'))),
      expected: [],
    },
    {
      name: 'empty inner with cached outer',
      xml: field('IF 1 = 1 "yes" "no"', text('yes') + field('PAGE', '')),
      expected: ['PAGE'],
    },
    { name: 'plain cached field', xml: field('PAGE', text('3')), expected: [] },
    { name: 'plain empty field', xml: field('PAGE', ''), expected: ['PAGE'] },
  ])('reports $name without losing the parent field state', async ({ xml, expected }) => {
    const zip = await JSZip.loadAsync(await buildBlankDocx())
    const part = await zip.file('word/document.xml')!.async('string')
    zip.file('word/document.xml', part.replace('<w:sectPr', `<w:p>${xml}</w:p><w:sectPr`))
    const file = join(tempDir(), 'fields.docx')
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
    const before = readFileSync(file)
    const r = await run(['docs', 'check', file, '--json'], { env })
    expect(r.code).toBe(0)
    const messages = r
      .json()
      .detail.issues.filter((i: { message: string }) => i.message.includes('has no cached result'))
      .map((i: { message: string }) => i.message.split(' has no cached result')[0])
    expect(messages).toEqual(expected)
    expect(readFileSync(file)).toEqual(before)
  })
})
