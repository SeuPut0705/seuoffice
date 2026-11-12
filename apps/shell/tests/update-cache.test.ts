import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneUpdateCache } from '../src/main/update-cache'

/**
 * What an installed update leaves in electron-updater's cache folder
 * (src/main/update-cache.ts): the downloaded installer stays in `pending/`
 * and, on Windows, the installer leaves a second copy of itself beside it.
 * At a start the app removes what the running version no longer needs and
 * keeps everything that belongs to an update still on its way.
 */

let cacheDir: string
let lines: string[]

const log = (...args: unknown[]): void => {
  lines.push(args.map(String).join(' '))
}

/** a finished download as electron-updater leaves it: the file and the record naming it */
function downloaded(fileName: string): void {
  mkdirSync(join(cacheDir, 'pending'), { recursive: true })
  writeFileSync(join(cacheDir, 'pending', fileName), 'installer bytes')
  writeFileSync(
    join(cacheDir, 'pending', 'update-info.json'),
    JSON.stringify({ fileName, sha512: 'c2hhNTEy', isAdminRightsRequired: false }),
  )
}

const pending = (): string[] =>
  existsSync(join(cacheDir, 'pending')) ? readdirSync(join(cacheDir, 'pending')).sort() : []

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'seuoffice-updater-'))
  lines = []
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

describe('pruneUpdateCache', () => {
  it('removes the download of the version now running, keeping the copies the next update builds on', () => {
    downloaded('SeuOffice-Setup-0.12.31-stable.exe')
    writeFileSync(join(cacheDir, 'installer.exe'), 'installer bytes')
    writeFileSync(join(cacheDir, 'update.zip'), 'zip bytes')

    // the new version's block map: electron-updater copies it out of pending/
    writeFileSync(join(cacheDir, 'pending', 'current.blockmap'), 'block map')
    writeFileSync(join(cacheDir, 'current.blockmap'), 'block map')

    expect(pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })).toBe(true)

    expect(pending()).toEqual([])
    // the base of the next differential download
    expect(existsSync(join(cacheDir, 'current.blockmap'))).toBe(true)
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true)
    expect(existsSync(join(cacheDir, 'update.zip'))).toBe(true)
    expect(lines.join('\n')).toContain('0.12.31')
  })

  it('removes the download of a version older than the one running', () => {
    downloaded('SeuOffice-Setup-0.12.9-arm64.exe')

    pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })

    expect(pending()).toEqual([])
  })

  it('removes the zip a Mac update was unpacked from', () => {
    downloaded('SeuOffice-0.12.31-arm64-mac-stable.zip')

    pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })

    expect(pending()).toEqual([])
  })

  it('keeps a downloaded update that is not installed yet', () => {
    downloaded('SeuOffice-Setup-0.12.32-stable.exe')

    pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })

    expect(pending()).toEqual(['SeuOffice-Setup-0.12.32-stable.exe', 'update-info.json'])
  })

  it('keeps a download it cannot place against a pre-release build', () => {
    // 0.13.0-beta.2 and the final 0.13.0 both follow 0.13.0-beta.1
    downloaded('SeuOffice-Setup-0.13.0-beta.2.exe')

    pruneUpdateCache({ cacheDir, runningVersion: '0.13.0-beta.1', log })

    expect(pending()).toEqual(['SeuOffice-Setup-0.13.0-beta.2.exe', 'update-info.json'])
  })

  it('keeps a partial download and what a resumed one needs', () => {
    mkdirSync(join(cacheDir, 'pending'))
    mkdirSync(join(cacheDir, 'resume'))
    writeFileSync(join(cacheDir, 'pending', 'temp-SeuOffice-Setup-0.12.30.exe'), 'half')
    writeFileSync(join(cacheDir, 'resume', 'temp-SeuOffice-Setup-0.12.30.exe.part'), 'half')
    writeFileSync(join(cacheDir, 'resume', 'temp-SeuOffice-Setup-0.12.30.exe.part.json'), '{}')

    pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })

    expect(pending()).toEqual(['temp-SeuOffice-Setup-0.12.30.exe'])
    expect(readdirSync(join(cacheDir, 'resume')).sort()).toEqual([
      'temp-SeuOffice-Setup-0.12.30.exe.part',
      'temp-SeuOffice-Setup-0.12.30.exe.part.json',
    ])
  })

  it('leaves a partial download beside the finished one of the running version', () => {
    downloaded('SeuOffice-Setup-0.12.31.exe')
    writeFileSync(join(cacheDir, 'pending', 'temp-SeuOffice-Setup-0.12.32.exe'), 'half')

    pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })

    expect(pending()).toEqual(['temp-SeuOffice-Setup-0.12.32.exe'])
  })

  it('touches nothing outside the cache folder, whatever the record names', () => {
    const outside = join(cacheDir, 'SeuOffice-Setup-0.12.1.exe')
    writeFileSync(outside, 'not in pending')
    mkdirSync(join(cacheDir, 'pending'))
    writeFileSync(
      join(cacheDir, 'pending', 'update-info.json'),
      JSON.stringify({ fileName: '../SeuOffice-Setup-0.12.1.exe' }),
    )

    pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })

    expect(existsSync(outside)).toBe(true)
    expect(pending()).toEqual(['update-info.json'])
  })

  it('keeps what a record it cannot read stands for', () => {
    mkdirSync(join(cacheDir, 'pending'))
    writeFileSync(join(cacheDir, 'pending', 'SeuOffice-Setup-0.12.1.exe'), 'installer bytes')
    writeFileSync(join(cacheDir, 'pending', 'update-info.json'), '{ not json')

    expect(() => pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })).not.toThrow()

    expect(pending()).toEqual(['SeuOffice-Setup-0.12.1.exe', 'update-info.json'])
  })

  it('does nothing, quietly, where there is no cache', () => {
    const missing = join(cacheDir, 'never-created')

    expect(() =>
      pruneUpdateCache({ cacheDir: missing, runningVersion: '0.12.31', log }),
    ).not.toThrow()

    expect(lines).toEqual([])
  })

  // a folder that refuses the removal stands in for a file the installer still holds open
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says so and carries on when a file cannot be removed',
    () => {
      downloaded('SeuOffice-Setup-0.12.31.exe')
      chmodSync(join(cacheDir, 'pending'), 0o555)
      try {
        expect(() => pruneUpdateCache({ cacheDir, runningVersion: '0.12.31', log })).not.toThrow()
        // the record stays with the file it names, so the next start tries again
        expect(pending()).toEqual(['SeuOffice-Setup-0.12.31.exe', 'update-info.json'])
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('SeuOffice-Setup-0.12.31.exe')
      } finally {
        chmodSync(join(cacheDir, 'pending'), 0o755)
      }
    },
  )
})
