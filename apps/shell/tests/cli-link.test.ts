import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0' } }))

import { isEphemeralInstall, launcherFilePath, writeLauncherFile } from '../src/main/cli-link'

describe('seuoffice launcher file', () => {
  it('lives in the seuoffice auth directory, overridable like auth.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'seuoffice-home-'))
    mkdirSync(join(home, '.genoffice')) // the upstream app's own record lives there: never ours to write
    expect(launcherFilePath({}, home)).toBe(join(home, '.seuoffice', 'launcher'))
    expect(launcherFilePath({ SEUOFFICE_AUTH_DIR: '/tmp/x' }, home)).toBe(
      join('/tmp/x', 'launcher'),
    )
  })

  it('writes one line, creates the directory, and only rewrites on change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seuoffice-launcher-'))
    const file = join(dir, 'nested', 'launcher')
    expect(writeLauncherFile(file, '/Applications/SeuOffice.app/Contents/Resources/cli')).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('/Applications/SeuOffice.app/Contents/Resources/cli\n')
    const before = statSync(file).mtimeMs
    expect(writeLauncherFile(file, '/Applications/SeuOffice.app/Contents/Resources/cli')).toBe(
      false,
    )
    expect(statSync(file).mtimeMs).toBe(before)
    expect(writeLauncherFile(file, 'C:\\Programs\\IeumOffice\\resources\\cli')).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('C:\\Programs\\IeumOffice\\resources\\cli\n')
  })

  it('treats dmg and AppImage mounts as temporary', () => {
    expect(isEphemeralInstall('/Volumes/SeuOffice/SeuOffice.app/Contents/Resources', {})).toBe(true)
    expect(isEphemeralInstall('/tmp/.mount_GenOfxyz/resources', {})).toBe(true)
    expect(isEphemeralInstall('/opt/SeuOffice/resources', { APPIMAGE: '/home/u/G.AppImage' })).toBe(
      true,
    )
    expect(isEphemeralInstall('/Applications/SeuOffice.app/Contents/Resources', {})).toBe(false)
  })
})
