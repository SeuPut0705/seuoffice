/**
 * An earlier deb linked /usr/bin/ieumoffice into the install dir. The new
 * post-install adds /usr/bin/seuoffice and leaves that link alone (the old
 * launcher still ships beside the new one); a real uninstall removes both of
 * our links and never the upstream app's.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const BUILD = join(__dirname, '..', 'build')

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'old-names-postinst-'))
  roots.push(root)
  const opt = join(root, 'opt', 'seuoffice')
  const bin = join(root, 'usr', 'bin')
  const cli = join(opt, 'resources', 'cli')
  mkdirSync(cli, { recursive: true })
  mkdirSync(bin, { recursive: true })
  for (const name of ['seuoffice', 'ieumoffice']) {
    writeFileSync(join(cli, name), '#!/bin/sh\n')
    chmodSync(join(cli, name), 0o755)
  }
  const script = (name: string) => {
    const file = join(root, name)
    const body = readFileSync(join(BUILD, name), 'utf-8')
      .replaceAll('/opt/SeuOffice', opt)
      .replaceAll('/usr/bin/', `${bin}/`)
    writeFileSync(file, body)
    return (arg = '') => spawnSync('sh', [file, arg], { encoding: 'utf-8' }).status
  }
  return {
    root,
    bin,
    cli,
    install: script('linux-after-install.sh'),
    remove: script('linux-after-remove.sh'),
  }
}

describe.skipIf(process.platform === 'win32')('the command link an earlier deb made', () => {
  it('keeps working after an upgrade and goes with a real uninstall', () => {
    const t = makeRoot()
    const old = join(t.bin, 'ieumoffice')
    symlinkSync(join(t.cli, 'ieumoffice'), old)

    expect(t.install()).toBe(0)
    expect(readlinkSync(join(t.bin, 'seuoffice'))).toBe(join(t.cli, 'seuoffice'))
    expect(readlinkSync(old)).toBe(join(t.cli, 'ieumoffice'))
    expect(t.remove('upgrade')).toBe(0)
    expect(existsSync(old)).toBe(true)

    expect(t.remove('remove')).toBe(0)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(t.bin, 'seuoffice'))).toBe(false)
  })

  it('never removes a link under the old name that points elsewhere, nor the upstream one', () => {
    const t = makeRoot()
    const upstream = join(t.root, 'opt', 'GenOffice', 'resources', 'cli', 'genoffice')
    mkdirSync(join(upstream, '..'), { recursive: true })
    writeFileSync(upstream, '#!/bin/sh\n')
    symlinkSync(upstream, join(t.bin, 'genoffice'))
    const vendor = join(t.root, 'opt', 'vendor', 'ieumoffice')
    mkdirSync(join(vendor, '..'), { recursive: true })
    writeFileSync(vendor, '#!/bin/sh\n')
    symlinkSync(vendor, join(t.bin, 'ieumoffice'))

    expect(t.install()).toBe(0)
    expect(t.remove('remove')).toBe(0)
    expect(readlinkSync(join(t.bin, 'genoffice'))).toBe(upstream)
    expect(readlinkSync(join(t.bin, 'ieumoffice'))).toBe(vendor)
    expect(existsSync(join(t.bin, 'seuoffice'))).toBe(false)
  })
})
