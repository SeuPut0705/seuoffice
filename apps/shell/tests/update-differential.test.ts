import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { ClientRequest, IncomingMessage, RequestOptions, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CancellationToken, HttpExecutor } from 'builder-util-runtime'
import { NoOpLogger, NsisUpdater } from 'electron-updater'

/**
 * The updater downloads only the blocks of the new installer that differ from
 * the running version's (updater.ts turns differential downloads on). This
 * runs electron-updater's own Windows download step (NsisUpdater's task, its
 * blockmap planning, range requests and sha512 check) against a local server
 * holding two releases, and checks what reaches the disk and when the whole
 * file is downloaded instead.
 */

const BLOCK = 1024
const block = (fill: number): Buffer => Buffer.alloc(BLOCK, fill)
const OLD = Buffer.concat([block(1), block(2), block(3), block(4)])
const NEW = Buffer.concat([block(1), block(9), block(3), block(4)])
const sha512 = (data: Buffer): string => createHash('sha512').update(data).digest('base64')

/** a blockmap as electron-builder publishes it: gzipped JSON, one file, fixed blocks */
function blockmap(data: Buffer): Buffer {
  const checksums: string[] = []
  const sizes: number[] = []
  for (let at = 0; at < data.length; at += BLOCK) {
    const piece = data.subarray(at, at + BLOCK)
    checksums.push(createHash('sha256').update(piece).digest('base64'))
    sizes.push(piece.length)
  }
  return gzipSync(
    JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums, sizes }] }),
  )
}

/** builder-util-runtime's executor over node:http, as ElectronHttpExecutor is over Electron's net */
class NodeExecutor extends HttpExecutor<ClientRequest> {
  fullDownloads: string[] = []

  createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest {
    return request(options, callback)
  }

  override async download(url: URL, destination: string): Promise<string> {
    this.fullDownloads.push(url.pathname)
    writeFileSync(destination, NEW)
    return destination
  }
}

let server: Server
let base = ''
let dir = ''
/** what the server holds, by path */
let files: Map<string, Buffer>
/** the Range headers the server was asked for */
let ranges: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seuoffice-differential-'))
  ranges = []
  files = new Map([
    ['/SeuOffice-Setup-0.1.0.exe.blockmap', blockmap(OLD)],
    ['/SeuOffice-Setup-0.2.0.exe.blockmap', blockmap(NEW)],
    ['/SeuOffice-Setup-0.2.0.exe', NEW],
  ])
  server = createServer((req, res) => {
    const body = files.get(req.url ?? '')
    if (!body) {
      res.writeHead(404).end()
      return
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''))
    if (!range) {
      res.writeHead(200, { 'content-length': body.length }).end(body)
      return
    }
    ranges.push(String(req.headers.range))
    const part = body.subarray(Number(range[1]), Number(range[2]) + 1)
    res
      .writeHead(206, {
        'content-length': part.length,
        'content-range': `bytes ${range[1]}-${range[2]}/${body.length}`,
      })
      .end(part)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

/**
 * NsisUpdater's download step for 0.2.0, run from the 0.1.0 install whose
 * installer copy (`installer.exe`) holds `installedCopy`, or none. Only what
 * the step reads is set; executeDownload hands the task its destination.
 */
async function downloadUpdate(installedCopy: Buffer | null): Promise<{
  file: Buffer
  executor: NodeExecutor
}> {
  const cacheDir = join(dir, 'seuoffice-updater')
  const pendingDir = join(cacheDir, 'pending')
  mkdirSync(pendingDir, { recursive: true })
  if (installedCopy) writeFileSync(join(cacheDir, 'installer.exe'), installedCopy)
  const executor = new NodeExecutor()
  const updater = Object.create(NsisUpdater.prototype) as NsisUpdater
  const bag = updater as unknown as Record<string, unknown>
  bag._logger = new NoOpLogger()
  bag._events = {}
  bag.app = { version: '0.1.0' }
  bag.httpExecutor = executor
  bag.configOnDisk = { value: Promise.resolve({}) }
  bag.downloadedUpdateHelper = { cacheDir, cacheDirForPendingUpdate: pendingDir }
  const destination = join(pendingDir, 'SeuOffice-Setup-0.2.0.exe')
  bag.executeDownload = (options: {
    task: (dest: string, opts: object, pkg: null, cleanup: () => Promise<void>) => Promise<void>
  }) => options.task(destination, {}, null, async () => {})
  const url = new URL(`${base}/SeuOffice-Setup-0.2.0.exe`)
  const info = { url: 'SeuOffice-Setup-0.2.0.exe', sha512: sha512(NEW), size: NEW.length }
  const provider = {
    resolveFiles: () => [{ url, info }],
    getBlockMapFiles: (newUrl: URL, oldVersion: string, newVersion: string) => [
      new URL(newUrl.href.replaceAll(newVersion, oldVersion) + '.blockmap'),
      new URL(`${newUrl.href}.blockmap`),
    ],
    isUseMultipleRangeRequest: false,
  }
  const run = (updater as unknown as { doDownloadUpdate(o: object): Promise<unknown> })
    .doDownloadUpdate
  await run.call(updater, {
    updateInfoAndProvider: { info: { version: '0.2.0', files: [info] }, provider },
    requestHeaders: {},
    cancellationToken: new CancellationToken(),
    disableWebInstaller: true,
    disableDifferentialDownload: false,
  })
  return { file: readFileSync(destination), executor }
}

describe('differential update download', () => {
  it('fetches only the changed block and rebuilds the new installer from the installed one', async () => {
    const { file, executor } = await downloadUpdate(OLD)
    expect(sha512(file)).toBe(sha512(NEW))
    expect(ranges).toEqual([`bytes=${BLOCK}-${2 * BLOCK - 1}`])
    expect(executor.fullDownloads).toEqual([])
  })

  it('downloads the whole installer when the running release is gone from the feed', async () => {
    files.delete('/SeuOffice-Setup-0.1.0.exe.blockmap')
    const { file, executor } = await downloadUpdate(OLD)
    expect(executor.fullDownloads).toEqual(['/SeuOffice-Setup-0.2.0.exe'])
    expect(sha512(file)).toBe(sha512(NEW))
  })

  it('downloads the whole installer when no copy of the installed one is kept', async () => {
    const { executor } = await downloadUpdate(null)
    expect(executor.fullDownloads).toEqual(['/SeuOffice-Setup-0.2.0.exe'])
  })

  it('downloads the whole installer when the rebuilt one fails the feed sha512', async () => {
    // the kept copy is not what its blockmap says: the copied blocks are wrong
    const { file, executor } = await downloadUpdate(
      Buffer.concat([block(7), block(2), block(3), block(4)]),
    )
    expect(executor.fullDownloads).toEqual(['/SeuOffice-Setup-0.2.0.exe'])
    expect(sha512(file)).toBe(sha512(NEW))
  })
})
