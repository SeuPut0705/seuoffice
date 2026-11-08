/**
 * Hancom-like ODT files for the CLI tests, built with the ODT engine's own
 * synthetic-fixture helpers (never a real document).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildOdt } from '../../odt-engine/tests/helpers/build-odt'
import {
  FORMULA_CONTENT_XML,
  hCell,
  hFormulaObject,
  hPara,
  hParaWith,
  hRow,
  hTable,
} from '../../odt-engine/tests/helpers/hancom-fragments'

/**
 * Blocks: 0 "Title", 1 a body table (Table1, 3 columns) whose first column
 * is locked (`table:protected="true"`: "Name", "Age"), 2 a paragraph holding
 * an equation object (a locked stand-in in the editor), 3 "The end".
 */
export function formOdt(): Promise<Uint8Array> {
  const table = hTable('Table1', 3, [
    hRow([hCell(hPara('Name'), { protected: true }), hCell(hPara('alpha')), hCell(hPara('beta'))]),
    hRow([hCell(hPara('Age'), { protected: true }), hCell(hPara('gamma')), hCell(hPara('delta'))]),
  ])
  return buildOdt({
    body:
      hPara('Title') +
      table +
      hParaWith('see ' + hFormulaObject().frame + ' here') +
      hPara('The end'),
    extraEntries: [
      { name: 'Object 1/content.xml', data: FORMULA_CONTENT_XML, mediaType: 'text/xml' },
      { name: 'Object 1/', data: '', mediaType: 'application/vnd.oasis.opendocument.formula' },
    ],
  })
}

/**
 * Blocks: 0 "Form", 1 a body table (3 columns) whose first row's first two
 * cells are locked and empty; the other rows hold empty unlocked cells that
 * look exactly like them (the way Hancom forms leave blanks), 2 "End".
 */
export function lockedBlanksOdt(): Promise<Uint8Array> {
  const blank = (locked = false) => hCell(hPara(''), locked ? { protected: true } : {})
  const table = hTable('Table1', 3, [
    hRow([blank(true), blank(true), hCell(hPara('x'))]),
    hRow([blank(), blank(), hCell(hPara('y'))]),
    hRow([blank(), blank(), hCell(hPara('z'))]),
  ])
  return buildOdt({ body: hPara('Form') + table + hPara('End') })
}

/** A password-protected ODT (the manifest marks the parts encrypted). */
export function encryptedOdt(): Promise<Uint8Array> {
  return buildOdt({ encrypted: true })
}

export async function writeFormOdt(dir: string, name = 'form.odt'): Promise<string> {
  const path = join(dir, name)
  writeFileSync(path, await formOdt())
  return path
}

/** Every entry of a zip, uncompressed, by name. */
export async function zipEntries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, Buffer>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) out.set(name, await file.async('nodebuffer'))
  }
  return out
}
