import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from '@genoffice/i18n'

interface LicenseTextModule {
  LICENSE_FILE: RegExp
  licenseFiles(dir: string): string[]
  licenseText(name: string, dir: string): string | null
}

const require = createRequire(import.meta.url)
const root = join(__dirname, '../../..')
const shellRoot = join(root, 'apps/shell')
const HEADER = `${PRODUCT_NAME} — Third-Party Software Notices`
const NOTICE = readFileSync(join(root, 'NOTICE'), 'utf8').trim()

const loadLicenseText = async () =>
  (await import(pathToFileURL(join(root, 'tools/license-text.mjs')).href)) as LicenseTextModule

describe('third-party license aggregation', () => {
  it('includes the PDFium wrapper and binary redistribution terms', async () => {
    const { licenseText } = await loadLicenseText()
    const text = licenseText('@embedpdf/pdfium', join(root, 'node_modules/@embedpdf/pdfium'))

    expect(text).toContain('MIT License')
    expect(text).toContain('Copyright 2014 PDFium Authors')
    expect(text).toContain('Apache License')
  })

  it('recognizes every license file name a package or crate uses', async () => {
    const { LICENSE_FILE } = await loadLicenseText()
    for (const name of [
      'LICENSE',
      'LICENSE.md',
      'LICENSE.txt',
      'license',
      'LICENCE',
      'LICENSE-MIT',
      'LICENSE-APACHE',
      'LICENSE-MIT.md',
      'LICENSE-WHATWG',
      'LICENSE_MIT',
      'LICENSE.pdfium',
      'COPYING',
      'COPYRIGHT',
    ]) {
      expect(LICENSE_FILE.test(name), name).toBe(true)
    }
    for (const name of ['LICENSES', 'README.md', 'licensee.txt', 'NOTICE', 'COPYRIGHTS']) {
      expect(LICENSE_FILE.test(name), name).toBe(false)
    }
  })

  it('keeps every text of a dual-licensed crate, in a stable order', async () => {
    const { licenseFiles, licenseText } = await loadLicenseText()
    const dir = mkdtempSync(join(tmpdir(), 'license-text-'))
    try {
      writeFileSync(join(dir, 'LICENSE-MIT'), 'Copyright (c) 2024 Someone\n\nMIT terms\n')
      writeFileSync(join(dir, 'LICENSE-APACHE'), 'Apache License\nVersion 2.0\n')
      writeFileSync(join(dir, 'COPYRIGHT'), 'Copyrights are retained by their contributors.\n')
      writeFileSync(join(dir, 'license.js'), 'module.exports = "not a license text"\n')
      mkdirSync(join(dir, 'LICENSE-texts'))

      expect(licenseFiles(dir)).toEqual(['COPYRIGHT', 'LICENSE-APACHE', 'LICENSE-MIT'])
      const text = licenseText('dual', dir)
      expect(text).toBe(
        'Copyrights are retained by their contributors.\n\n' +
          'Apache License\nVersion 2.0\n\n' +
          'Copyright (c) 2024 Someone\n\nMIT terms',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates the notice consumed by every shell packaging entrypoint', () => {
    // a dev run: no cargo or network is required, so the strict CI mode is off here
    execFileSync(process.execPath, [join(root, 'tools/gen-third-party-notices.mjs')], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, CI: '', IEUM_RELEASE: '' },
    })
    const text = readFileSync(join(root, 'apps/shell/build/THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(text).toContain('@embedpdf/pdfium')
    expect(text).toContain('Copyright 2014 PDFium Authors')
    expect(text).toContain('Apache License')

    const shellPackage = JSON.parse(
      readFileSync(join(root, 'apps/shell/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    for (const target of ['dist:mac', 'dist:win', 'dist:linux']) {
      expect(shellPackage.scripts[target]).toContain('npm run notices')
    }
    const builder = readFileSync(join(root, 'apps/shell/electron-builder.cjs'), 'utf8')
    expect(builder).toContain('ensureThirdPartyNotices()')
  })

  it('opens with the NOTICE of the work, then names the product in its own header', () => {
    const text = readFileSync(join(root, 'apps/shell/build/THIRD-PARTY-NOTICES.txt'), 'utf8')
    // Apache-2.0 §4(d): the attribution notice, upstream name included, comes first
    expect(text.startsWith(NOTICE)).toBe(true)
    const afterNotice = text.slice(NOTICE.length)
    expect(afterNotice).toMatch(/^\s+The Apache License, Version 2\.0, .*\n.*LICENSE\.txt next/)
    // the generator's own text starts at its header and names this product only
    const own = afterNotice.slice(afterNotice.indexOf(HEADER))
    expect(afterNotice.indexOf(HEADER)).toBeGreaterThan(0)
    expect(own.split('\n', 1)[0]).toBe(HEADER)
    expect(own).not.toContain(`${UPSTREAM_PRODUCT_NAME} — Third-Party Software Notices`)
  })

  it('credits the libraries compiled into the shipped WebAssembly and the template fonts', () => {
    const text = readFileSync(join(root, 'apps/shell/build/THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(text).toContain('Portions of this software are copyright © The FreeType Project')
    expect(text).toContain(
      'This software is based in part on the work of the Independent JPEG Group.',
    )
    expect(text).toContain('PNG Reference Library License version 2')
    expect(text).toContain('Little CMS (lcms2) — MIT License')
    expect(text).toContain('[wasm/quickjs-eval.wasm] QuickJS — MIT License')
    expect(text).toContain('[wasm/LICENSE_OPENJPEG]')
    expect(text).toContain('[standard_fonts/LICENSE_FOXIT]')
    expect(text).toMatch(
      /dompurify v\S+ — Apache-2\.0 \(dual MPL-2\.0\/Apache-2\.0, used under Apache-2\.0\)/,
    )
    for (const family of [
      'Pretendard',
      'Noto Serif KR',
      'Black Han Sans',
      'Do Hyeon',
      'Gowun Dodum',
      'Gowun Batang',
      'Bebas Neue',
      'Space Grotesk',
      'Playfair Display',
      'Archivo Black',
    ]) {
      expect(text, family).toMatch(
        new RegExp(`\\n${family} [\\d.]+ \\(slide design templates, resources/template-fonts\\)`),
      )
    }
    expect(text).toContain('Copyright (c) 2021, Kil Hyung-jin')
    expect(text).toContain('3. Rust crates (rhwp HWP engine, compiled into rhwp_bg.wasm)')
  })
})

interface ExtraResource {
  from: string
  to: string
}

describe('license files in the installer', () => {
  it('ships the license, the NOTICE and the Unicode license of the work as resources', () => {
    const config = require(join(shellRoot, 'electron-builder.cjs')) as {
      extraResources: ExtraResource[]
    }
    const shipped = new Map(config.extraResources.map((e) => [e.to, e.from]))
    expect(shipped.get('LICENSE.txt')).toBe('../../LICENSE')
    expect(shipped.get('NOTICE.txt')).toBe('../../NOTICE')
    expect(shipped.get('LICENSE-UNICODE.txt')).toBe('../../LICENSE-UNICODE.txt')
    expect(shipped.get('THIRD-PARTY-NOTICES.txt')).toBe('build/THIRD-PARTY-NOTICES.txt')
    for (const to of ['LICENSE.txt', 'NOTICE.txt', 'LICENSE-UNICODE.txt']) {
      expect(existsSync(resolve(shellRoot, shipped.get(to)!)), to).toBe(true)
    }
    // packaging asserts the three sources exist, as it does for the wasm files
    const builder = readFileSync(join(shellRoot, 'electron-builder.cjs'), 'utf8')
    const assertion = builder.slice(builder.indexOf('function assertExtraResourceSources'))
    for (const rel of ['../../LICENSE', '../../NOTICE', '../../LICENSE-UNICODE.txt']) {
      expect(assertion.slice(0, assertion.indexOf('}\n'))).toContain(`'${rel}'`)
    }
  })
})

const shellPackage = JSON.parse(readFileSync(join(shellRoot, 'package.json'), 'utf-8')) as {
  version: string
}

/** a notice the packaging gate accepts */
const VALID_NOTICE = [
  NOTICE,
  HEADER,
  '@embedpdf/pdfium',
  'Copyright 2014 PDFium Authors',
  'Apache License',
  '144 crates, all under permissive terms:',
  '138 crates, all under permissive terms:',
  '',
].join('\n')

/**
 * Drives the real beforePack hook with the notice on disk replaced by `notice`
 * (null: no file). `regenerated` is what the generator run leaves behind.
 */
function packWithNotice(notice: string | null, regenerated: string | null) {
  const generatorRuns: Array<{ script: string; release: string | undefined }> = []
  let current = notice
  const configModule = { exports: {} as Record<string, unknown> }
  runInNewContext(readFileSync(join(shellRoot, 'electron-builder.cjs'), 'utf8'), {
    module: configModule,
    __dirname: shellRoot,
    process: { platform: 'linux', arch: 'x64', env: {}, execPath: '/usr/bin/node' },
    require: (id: string) => {
      if (id === './package.json') return shellPackage
      if (id === 'node:child_process') {
        return {
          execFileSync: (_file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
            if (args[0].replace(/\\/g, '/').endsWith('tools/gen-third-party-notices.mjs')) {
              generatorRuns.push({ script: args[0], release: opts.env?.IEUM_RELEASE })
              current = regenerated
            }
            return Buffer.from('')
          },
        }
      }
      if (id === 'node:fs') {
        const fs = require('node:fs') as typeof import('node:fs')
        return {
          ...fs,
          existsSync: () => true,
          readdirSync: (path: string) =>
            String(path).replace(/\\/g, '/').endsWith('out/main')
              ? ['pdf-structure-process-test.js']
              : fs.readdirSync(path),
          readFileSync: (path: string, encoding: BufferEncoding) => {
            if (String(path).endsWith('genoffice.cjs')) {
              return `const __cliAppVersion = ${JSON.stringify(shellPackage.version)};\n`
            }
            if (String(path).endsWith('THIRD-PARTY-NOTICES.txt')) {
              if (current === null) throw new Error('ENOENT')
              return current
            }
            return fs.readFileSync(path, encoding)
          },
        }
      }
      return require(id)
    },
  })
  const config = configModule.exports as {
    beforePack: (context: { electronPlatformName: string }) => Promise<void>
  }
  return { pack: () => config.beforePack({ electronPlatformName: 'linux' }), generatorRuns }
}

describe('packaging gate on the third-party notice', () => {
  it('packages a complete, current notice as it is', async () => {
    const { pack, generatorRuns } = packWithNotice(VALID_NOTICE, null)
    await pack()
    expect(generatorRuns).toEqual([])
  })

  it('regenerates a stale notice in release mode', async () => {
    const stale = VALID_NOTICE.replace(
      HEADER,
      `${UPSTREAM_PRODUCT_NAME} — Third-Party Software Notices`,
    )
    const { pack, generatorRuns } = packWithNotice(stale, VALID_NOTICE)
    await pack()
    expect(generatorRuns).toHaveLength(1)
    expect(generatorRuns[0].release).toBe('1')
  })

  it('refuses a notice whose Rust sections degraded to a pointer', async () => {
    const partial = VALID_NOTICE.replace(
      '138 crates, all under permissive terms:',
      'crate list unavailable at generation time',
    )
    const { pack, generatorRuns } = packWithNotice(partial, partial)
    await expect(pack()).rejects.toThrow(/1 of 2 Rust crate sections are listed/)
    expect(generatorRuns).toHaveLength(1)
  })

  it('refuses a notice that does not open with the NOTICE of the work', async () => {
    const withoutNotice = VALID_NOTICE.slice(NOTICE.length)
    const { pack } = packWithNotice(withoutNotice, withoutNotice)
    await expect(pack()).rejects.toThrow(/does not open with the current NOTICE/)
  })

  it('refuses a missing notice the generator could not write', async () => {
    const { pack } = packWithNotice(null, null)
    await expect(pack()).rejects.toThrow(/the file is missing/)
  })
})
