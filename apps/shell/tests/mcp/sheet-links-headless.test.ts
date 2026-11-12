import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { XlsxSidecarClient } from '../../../sheets/src/main/xlsx-sidecar-client'
import { createSheetsTools } from '../../src/main/mcp/tools/sheets-tools'
import { createSessionHost } from '../../src/main/mcp/tools/session-tools'
import { realCliRunner } from './real-cli'

/**
 * `sheet_links` against the real CLI (in-process) and a real workbook: what the
 * tool makes the engine do with the paths the WORKBOOK chose, and where it lets
 * a caller write. The argv the tool builds is covered with the fake CLI in
 * sheets-tools.test.ts.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
// the formula engine refuses a workbook without a style sheet
const STYLES = `<styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

// what the workbook says its two sources are: a host by UNC, a host by file URI
const UNC_TARGET = '\\\\fileserver\\share\\budget.xlsx'
const FILE_HOST_TARGET = 'file://fileserver/share/q3.xlsx'
const UNC_LINKS = [
  {
    index: 1,
    rawTarget: UNC_TARGET,
    source: UNC_TARGET,
    reachable: null,
    unchecked: 'remote',
    sheetNames: ['Sheet1'],
  },
  {
    index: 2,
    rawTarget: FILE_HOST_TARGET,
    source: '\\\\fileserver\\share\\q3.xlsx',
    reachable: null,
    unchecked: 'remote',
    sheetNames: ['Sheet1'],
  },
]

/** A workbook with two external links, `[1]` and `[2]`, each referenced by one formula. */
async function writeLinkedWorkbook(path: string, targets: [string, string]): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SHEET_TYPE}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SHEET_TYPE}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${SHEET_TYPE}.styles+xml"/><Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="${SHEET_TYPE}.externalLink+xml"/><Override PartName="/xl/externalLinks/externalLink2.xml" ContentType="${SHEET_TYPE}.externalLink+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  zip.file(
    'xl/workbook.xml',
    `${XML_DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><externalReferences><externalReference r:id="rId4"/><externalReference r:id="rId5"/></externalReferences></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML_DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId4" Type="${REL}/externalLink" Target="externalLinks/externalLink1.xml"/><Relationship Id="rId5" Type="${REL}/externalLink" Target="externalLinks/externalLink2.xml"/></Relationships>`,
  )
  zip.file('xl/styles.xml', XML_DECL + STYLES)
  targets.forEach((target, i) => {
    const n = i + 1
    zip.file(
      `xl/externalLinks/externalLink${n}.xml`,
      `${XML_DECL}<externalLink xmlns="${MAIN}" xmlns:r="${REL}"><externalBook r:id="rId1"><sheetNames><sheetName val="Sheet1"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>1</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
    )
    zip.file(
      `xl/externalLinks/_rels/externalLink${n}.xml.rels`,
      `${XML_DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/externalLinkPath" Target="${target}" TargetMode="External"/></Relationships>`,
    )
  })
  zip.file(
    'xl/worksheets/sheet1.xml',
    `${XML_DECL}<worksheet xmlns="${MAIN}"><dimension ref="A1:A2"/><sheetData><row r="1"><c r="A1"><f>[1]Sheet1!A1*2</f><v>2</v></c></row><row r="2"><c r="A2"><f>[2]Sheet1!A1*3</f><v>3</v></c></row></sheetData></worksheet>`,
  )
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

let dir: string
let book: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'genoffice-mcp-links-'))
  book = join(dir, 'received.xlsx')
  await writeLinkedWorkbook(book, [UNC_TARGET, FILE_HOST_TARGET])
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

function sheetLinks(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tools = createSheetsTools(
    { defaultSaveDir: () => dir, cli: realCliRunner(dir) },
    createSessionHost(),
  )
  const tool = tools.find((t) => t.name === 'sheet_links')!
  return Promise.resolve(tool.handler(args)) as Promise<Record<string, unknown>>
}

type EngineRequest = Record<string, unknown>

/**
 * Every request this process hands the xlsx engine: the lowest boundary the
 * JS side owns. Native tests exercise filesystem probes; this stand-in
 * checks what the MCP/CLI sends without depending on a prebuilt sidecar.
 */
function engineRequests(allowed: Record<string, unknown>): { sent: () => EngineRequest[] } {
  const proto = XlsxSidecarClient.prototype as unknown as {
    request: (command: EngineRequest, timeoutMs?: number) => Promise<unknown>
  }
  vi.stubEnv('XLSX_SIDECAR_PATH', join(dir, 'stand-in-sidecar'))
  const spy = vi.spyOn(proto, 'request').mockImplementation(async (command) => {
    const answer = allowed[String(command.command)]
    if (answer === undefined) throw new Error(`engine asked for ${String(command.command)}`)
    return answer
  })
  return { sent: () => spy.mock.calls.map(([command]) => command) }
}

describe('sheet_links never contacts a source the workbook places on another computer', () => {
  it('lists such links as not checked instead of looking for them', async () => {
    const engine = engineRequests({ read_external_links: UNC_LINKS })

    const listed = await sheetLinks({ path: book })

    expect(listed.links).toEqual(UNC_LINKS)
    expect(listed.summary).toContain('2 external link(s), 0 reachable, 2 not checked')
    // a listing is one read; nothing that opens a source was asked for
    expect(engine.sent()).toEqual([{ command: 'read_external_links', path: book }])
  })

  it('an update asked through MCP leaves those sources on their cached values', async () => {
    const engine = engineRequests({
      read_external_links: UNC_LINKS,
      update_external_links: {
        links: UNC_LINKS.map(({ unchecked: _, ...link }) => ({ ...link, reachable: false })),
        cells: [],
      },
    })
    const before = readFileSync(book)

    const updated = await sheetLinks({ path: book, update: true })

    expect(updated).toMatchObject({ updated: 0, reachable: 0, broken: 2, remoteSkipped: 2 })
    // no permission to read another computer's sources travels with the request
    expect(engine.sent()).toContainEqual({ command: 'update_external_links', path: book })
    expect(engine.sent().some((request) => 'allowRemoteSources' in request)).toBe(false)
    expect(readFileSync(book).equals(before)).toBe(true)
  })

  it('has no argument that asks for sources on another computer', async () => {
    const engine = engineRequests({
      read_external_links: UNC_LINKS,
      update_external_links: { links: [], cells: [] },
    })

    await sheetLinks({ path: book, update: true, remoteSources: true, 'remote-sources': true })

    expect(engine.sent().some((request) => 'allowRemoteSources' in request)).toBe(false)
  })
})
