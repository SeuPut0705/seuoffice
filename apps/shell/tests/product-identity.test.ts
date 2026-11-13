import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { GITHUB_REPO_NAME, GITHUB_REPO_OWNER, GITHUB_REPO_URL } from '@seuoffice/electron-utils'
import {
  createI18n,
  DEV_USER_DATA_DIR_NAME,
  LANGS,
  PRODUCT_NAME,
  UPSTREAM_PRODUCT_NAME,
  USER_DATA_DIR_NAME,
  productName,
} from '@seuoffice/i18n'
import { OFFICE_TYPES } from '../src/main/default-app'
import { HELP_TOPICS, helpBody } from '../src/renderer/src/i18n/help/help-registry'
import { topicTitle } from '../src/renderer/src/i18n/help/help-titles'
import { strings } from '../src/renderer/src/strings'

const require = createRequire(import.meta.url)
const SHELL = resolve(import.meta.dirname, '..')
const ROOT = resolve(SHELL, '../..')
const builderSource = readFileSync(join(SHELL, 'electron-builder.cjs'), 'utf8')

/** The packaging config as a build host with this environment would load it. */
function loadBuilderConfig(env: Record<string, string> = {}) {
  // Inspect packaging metadata without downloading Electron or compiling OCR
  // helpers (same approach as shell-new.test.ts).
  const configModule = { exports: {} as ReturnType<typeof require> }
  runInNewContext(builderSource, {
    module: configModule,
    __dirname: SHELL,
    process: { platform: 'win32', arch: 'x64', env: { ...env } },
    require: (id: string) =>
      id === 'node:fs' ? { ...require(id), existsSync: () => true } : require(id),
  })
  return configModule.exports
}

const config = loadBuilderConfig()
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const shellPackage = readJson(join(SHELL, 'package.json'))
const rootPackage = readJson(join(ROOT, 'package.json'))

/** What the upstream app registers on a machine; nothing here may reuse it. */
/** The upstream products' names; Apache-2.0 grants no rights to them (NOTICE, section 6). */
const UPSTREAM_NAMES = [UPSTREAM_PRODUCT_NAME, 'IeumOffice', '이음오피스']

const UPSTREAM = {
  appId: 'com.genoffice.app',
  productName: UPSTREAM_PRODUCT_NAME,
  progIds: ['Word Document', 'Excel Workbook', 'PowerPoint Presentation', 'PDF Document'],
}

describe('one product name', () => {
  it('is what the installer, the Electron app name and the UI agree on', () => {
    // Electron names the app after package.json "productName"; electron-builder
    // names the installer and the executable after its own. Both have to be the
    // name the UI shows. The userData folder is the one exception: it keeps the
    // v0.12.11 machine name, which differs from the display name only in case.
    expect(config.productName).toBe(PRODUCT_NAME)
    expect(shellPackage.productName).toBe(PRODUCT_NAME)
    expect(productName('en')).toBe(PRODUCT_NAME)
    expect(USER_DATA_DIR_NAME).toBe(PRODUCT_NAME.toLowerCase())
  })

  it('names the installer process with the product name', () => {
    // electron-builder writes package.json "description" into the NSIS
    // installer's FileDescription (the app exe gets productName). Task Manager
    // and Windows' "file in use" dialog show a running installer by that
    // field, so a sentence there hid a stuck installer from a user looking
    // for the product (external report, 2026-10-27).
    expect(shellPackage.description).toBe(PRODUCT_NAME)
  })

  it('titles every window document with the product name before any script runs', () => {
    // seuoffice: apps/web is the browser launcher, not an Electron window
    const apps = readdirSync(join(ROOT, 'apps')).filter((app) => app !== 'web')
    const pages = apps.flatMap((app) => {
      const dir = join(ROOT, 'apps', app, 'src/renderer')
      return readdirSync(dir)
        .filter((name) => name.endsWith('.html'))
        .map((name) => join(dir, name))
    })
    expect(pages.length).toBeGreaterThanOrEqual(apps.length)
    for (const page of pages) {
      const title = /<title>([^<]*)<\/title>/.exec(readFileSync(page, 'utf8'))?.[1] ?? ''
      expect(title, page).toContain(PRODUCT_NAME)
      for (const upstream of UPSTREAM_NAMES) expect(title, page).not.toContain(upstream)
    }
  })

  it('shows the same name in every UI language, Korean included', () => {
    // seuoffice has no localized name (yet)
    for (const lang of LANGS) expect(productName(lang), lang).toBe(PRODUCT_NAME)
  })

  it('is none of the names the license grants no rights to', () => {
    // Apache-2.0 section 6: no trademark rights in the upstream names
    const shown = [
      PRODUCT_NAME,
      config.productName,
      config.appId,
      shellPackage.productName,
      shellPackage.description,
      config.extraMetadata.name,
      ...LANGS.map((lang) => productName(lang)),
    ]
    for (const name of shown) {
      for (const upstream of UPSTREAM_NAMES) {
        expect(String(name).toLowerCase(), String(name)).not.toContain(upstream.toLowerCase())
      }
    }
  })
})

describe('the name in the shell UI', () => {
  const t = createI18n(strings)
  type Key = keyof typeof strings.en

  it('acknowledges the upstream project by its real name in every language', () => {
    for (const lang of LANGS) {
      // the dictionary takes the name as a parameter, so the literal stays in product.ts
      expect(strings[lang].setBasedOn, lang).toContain('{upstream}')
      const shown = t(lang, 'setBasedOn', { upstream: UPSTREAM_PRODUCT_NAME })
      expect(shown, lang).toContain(UPSTREAM_PRODUCT_NAME)
      expect(shown, lang).not.toContain('{')
      expect(shown, lang).not.toContain(productName(lang))
    }
  })

  it('shows the upstream name nowhere else', () => {
    for (const lang of LANGS) {
      for (const key of Object.keys(strings.en) as Key[]) {
        if (key === 'setBasedOn') continue
        expect(t(lang, key), `${lang}.${key}`).not.toContain(UPSTREAM_PRODUCT_NAME)
      }
    }
    expect(t('ko', 'onbTitle1')).toContain(PRODUCT_NAME)
    expect(t('en', 'onbTitle1')).toContain(PRODUCT_NAME)
  })

  it('names the product in the manual: titles and bodies', async () => {
    expect(topicTitle('install', 'en')).toBe(`Installing ${PRODUCT_NAME}`)
    expect(topicTitle('install', 'ko')).toBe(`${PRODUCT_NAME} 설치`)
    for (const lang of LANGS) {
      for (const topic of HELP_TOPICS) {
        expect(topicTitle(topic.id, lang)).not.toContain(UPSTREAM_PRODUCT_NAME)
        const body = (await helpBody(topic.id, lang)) ?? ''
        expect(body, `${topic.id}.${lang}`).not.toContain(UPSTREAM_PRODUCT_NAME)
      }
    }
    // file names keep the Latin name whatever the language
    expect(await helpBody('install', 'ko')).toContain(`${PRODUCT_NAME}-Setup-<version>.exe`)
    expect(await helpBody('getting-started', 'ko')).toContain(PRODUCT_NAME)
  })
})

describe('coexistence with the upstream app on one machine', () => {
  it('installs under its own product id and install name', () => {
    expect(config.appId).toBe('com.seuput.seuoffice')
    expect(config.appId).not.toBe(UPSTREAM.appId)
    expect(config.productName).not.toBe(UPSTREAM.productName)
    expect(config.nsis.artifactName).toBe('${productName}-Setup-${version}.${ext}')
    expect(loadBuilderConfig({ SEUOFFICE_WIN_ARM64: '1' }).nsis.artifactName).toBe(
      '${productName}-Setup-${version}-arm64.${ext}',
    )
    expect(shellPackage.desktopName).toBe('seuoffice.desktop')
    expect(config.linux.executableName).toBe('seuoffice')
    expect(config.deb.packageName).toBe('seuoffice')
    expect(config.deb.artifactName).toBe('seuoffice_${version}_${arch}.deb')
    expect(config.rpm.packageName).toBe('seuoffice')
    expect(config.rpm.artifactName).toBe('seuoffice-${version}.${arch}.rpm')
  })

  it('keeps its settings and data in its own folders', () => {
    // packaged: index.ts pins userData to <appData>/USER_DATA_DIR_NAME (the v0.12.11 profile);
    // unpacked runs set DEV_USER_DATA_DIR_NAME explicitly (src/main/index.ts).
    // The single-instance lock lives in userData, so it is separate as well.
    expect(USER_DATA_DIR_NAME).toBe('seuoffice')
    expect(DEV_USER_DATA_DIR_NAME).toBe('seuoffice-Dev')
    const main = readFileSync(join(SHELL, 'src/main/index.ts'), 'utf8')
    expect(main).toContain(
      "app.setPath('userData', join(app.getPath('appData'), DEV_USER_DATA_DIR_NAME))",
    )
    // nothing may adopt, move or copy a folder the upstream app owns
    for (const upstreamDir of [
      'GenOffice-Dev',
      'GenOffice Dev',
      'AI Office',
      'IeumOffice',
      'IeumOffice-Dev',
    ]) {
      expect(main, upstreamDir).not.toContain(`'${upstreamDir}'`)
    }
  })

  it('caches its installer and downloaded updates in its own folder', () => {
    // electron-builder (NSIS) and electron-updater both use
    // <local app data>/<packaged package.json name>-updater
    const upstreamName = shellPackage.name
    expect(upstreamName).toBe('@seuoffice/shell')
    expect(config.extraMetadata.name).toBe('seuoffice')
    expect(config.extraMetadata.name).not.toBe(upstreamName)
    // a plain name survives electron-builder's file-name sanitizing unchanged
    expect(config.extraMetadata.name).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('registers Windows file types under its own ProgIds', () => {
    // electron-builder appends a platform list to the top-level one: a shared
    // top-level list would register the unscoped names on Windows as well
    expect(config.fileAssociations).toBeUndefined()
    const progIds: string[] = config.win.fileAssociations.map(
      (entry: { name: string }) => entry.name,
    )
    expect(progIds.length).toBeGreaterThan(0)
    for (const progId of progIds) {
      expect(progId).toMatch(/^seuoffice\.[A-Za-z][A-Za-z0-9]*$/)
      // Windows limits a ProgId to 39 characters
      expect(progId.length, progId).toBeLessThanOrEqual(39)
      expect(UPSTREAM.progIds).not.toContain(progId)
    }
    // mac and Linux read `name` as a display label, so theirs stay as they were
    for (const platform of ['mac', 'linux'] as const) {
      const names = config[platform].fileAssociations.map((entry: { name: string }) => entry.name)
      expect(names).toContain('Word Document')
    }
  })

  it('names the mind map type within the ProgId rule, and keeps it off the Windows default path', () => {
    const entry = config.mac.fileAssociations.find(
      (candidate: { ext: string }) => candidate.ext === 'xmind',
    ) as { name: string; description?: string } | undefined
    expect(entry, '.xmind is not offered on mac / Linux').toBeTruthy()
    // the same derivation electron-builder.cjs applies to the Windows list;
    // the NSIS Open-With ProgId (build/installer.nsh) spells the same value out
    const progId = `${config.extraMetadata.name}.${entry!.name.replace(/[^A-Za-z0-9]/g, '')}`
    expect(progId).toMatch(/^seuoffice\.[A-Za-z][A-Za-z0-9]*$/)
    expect(progId.length, progId).toBeLessThanOrEqual(39)
    expect(UPSTREAM.progIds).not.toContain(progId)
    // the label is the product's own word for the type
    expect(`${entry!.name} ${entry!.description ?? ''}`).not.toMatch(/xmind/i)
    // Windows does not take the default for it: it stays off win.fileAssociations
    // and is only offered in "Open with" (with this icon) by the installer
    const winExts = config.win.fileAssociations.map((candidate: { ext: string }) => candidate.ext)
    expect(winExts).not.toContain('xmind')
    for (const type of OFFICE_TYPES) expect(type.ext).not.toBe('xmind')
    // it is offered Open-With only by the installer, under this same ProgId
    const nsh = readFileSync(join(SHELL, 'build/installer.nsh'), 'utf8')
    expect(nsh).toContain(`!define SEUOFFICE_MINDMAP_PROGID "${progId}"`)
  })

  it('names the book type within the ProgId rule, and keeps it off the Windows default path', () => {
    const entry = config.mac.fileAssociations.find(
      (candidate: { ext: string }) => candidate.ext === 'epub',
    ) as { name: string } | undefined
    expect(entry, '.epub is not offered on mac / Linux').toBeTruthy()
    // the same derivation electron-builder.cjs applies to the Windows list;
    // the NSIS Open-With ProgId (build/installer.nsh) spells the same value out
    const progId = `${config.extraMetadata.name}.${entry!.name.replace(/[^A-Za-z0-9]/g, '')}`
    expect(progId).toMatch(/^seuoffice\.[A-Za-z][A-Za-z0-9]*$/)
    expect(progId.length, progId).toBeLessThanOrEqual(39)
    expect(UPSTREAM.progIds).not.toContain(progId)
    const winExts = config.win.fileAssociations.map((candidate: { ext: string }) => candidate.ext)
    expect(winExts).not.toContain('epub')
    for (const type of OFFICE_TYPES) expect(type.ext).not.toBe('epub')
    const nsh = readFileSync(join(SHELL, 'build/installer.nsh'), 'utf8')
    expect(nsh).toContain(`!define SEUOFFICE_EPUB_PROGID "${progId}"`)
  })

  it('names the Visio drawing type within the ProgId rule, and keeps it off the Windows default path', () => {
    const entry = config.mac.fileAssociations.find(
      (candidate: { ext: string }) => candidate.ext === 'vsdx',
    ) as { name: string } | undefined
    expect(entry, '.vsdx is not offered on mac / Linux').toBeTruthy()
    const progId = `${config.extraMetadata.name}.${entry!.name.replace(/[^A-Za-z0-9]/g, '')}`
    expect(progId).toMatch(/^seuoffice\.[A-Za-z][A-Za-z0-9]*$/)
    expect(progId.length, progId).toBeLessThanOrEqual(39)
    expect(UPSTREAM.progIds).not.toContain(progId)
    const winExts = config.win.fileAssociations.map((candidate: { ext: string }) => candidate.ext)
    expect(winExts).not.toContain('vsdx')
    for (const type of OFFICE_TYPES) expect(type.ext).not.toBe('vsdx')
    const nsh = readFileSync(join(SHELL, 'build/installer.nsh'), 'utf8')
    expect(nsh).toContain(`!define SEUOFFICE_VSDX_PROGID "${progId}"`)
  })

  it('recognizes only its own ProgIds as "this app is the default"', () => {
    for (const type of OFFICE_TYPES) {
      const packaged = config.win.fileAssociations.find(
        (entry: { ext: string }) => entry.ext === type.ext,
      )
      expect(packaged, `.${type.ext} is not associated on Windows`).toBeTruthy()
      expect(type.progId, `.${type.ext}`).toBe(packaged.name)
    }
  })

  it('scopes the Explorer New templates to the same ProgIds', () => {
    const nsh = readFileSync(join(SHELL, 'build/installer.nsh'), 'utf8')
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      const progId = OFFICE_TYPES.find((type) => type.ext === ext)!.progId
      expect(nsh).toContain(`!insertmacro SeuOfficeRegisterShellNew "${ext}" "${progId}"`)
      expect(nsh).toContain(`!insertmacro SeuOfficeUnregisterShellNew "${ext}" "${progId}"`)
    }
    for (const progId of UPSTREAM.progIds) expect(nsh).not.toContain(`"${progId}"`)
  })
})

describe('repository coordinates', () => {
  it('feeds auto-update from the GitHub releases of the product repository', () => {
    expect(config.publish).toEqual([
      { provider: 'github', owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME, channel: 'latest' },
    ])
    // no environment variable switches the feed on or moves it elsewhere
    const withOldEnv = loadBuilderConfig({ SEUOFFICE_UPDATE_URL: 'https://updates.example.test/x' })
    expect(withOldEnv.publish).toEqual(config.publish)
  })

  it('packages the stable build with its own feed and installer name', () => {
    const stable = loadBuilderConfig({ SEUOFFICE_UPDATE_CHANNEL: 'stable' })
    expect(stable.publish).toEqual([{ ...config.publish[0], channel: 'stable' }])
    // both builds' installers are attached to one release
    expect(stable.nsis.artifactName).toBe('${productName}-Setup-${version}-stable.${ext}')
    expect(stable.nsis.artifactName).not.toBe(config.nsis.artifactName)
    // everything installed on the machine stays the same product
    expect(stable.appId).toBe(config.appId)
    expect(stable.productName).toBe(config.productName)
  })

  it('refuses a channel that has no feed', () => {
    for (const channel of ['beta', 'Stable', 'latest ']) {
      expect(() => loadBuilderConfig({ SEUOFFICE_UPDATE_CHANNEL: channel }), channel).toThrow(
        /SEUOFFICE_UPDATE_CHANNEL/,
      )
    }
  })

  it('names the same repository in the package metadata', () => {
    expect(GITHUB_REPO_URL).toBe('https://github.com/seuput-inc/seuoffice')
    expect(shellPackage.homepage).toBe(GITHUB_REPO_URL)
    expect((rootPackage.repository as { url: string }).url).toBe(`git+${GITHUB_REPO_URL}.git`)
  })

  it('credits the maintainer of this product in the Linux package metadata', () => {
    const maintainer = 'SeuPut <228744781+SeuPut0705@users.noreply.github.com>'
    expect(config.linux.maintainer).toBe(maintainer)
    expect(config.linux.vendor).toBe(maintainer)
  })
})

describe('what the installer no longer carries', () => {
  it('bundles no third-party command line next to the app', () => {
    const resources = [
      ...config.extraResources,
      ...config.mac.extraResources,
      ...config.win.extraResources,
      ...config.linux.extraResources,
    ] as Array<{ from: string; to: string }>
    for (const { from, to } of resources) {
      expect(`${from} -> ${to}`).not.toMatch(/commander/)
    }
  })

  it('injects no analytics keys or font server address into the packaged app', () => {
    const env = {
      SEUOFFICE_GA4_MEASUREMENT_ID: 'G-TEST',
      SEUOFFICE_GA4_API_SECRET: 'secret',
      SEUOFFICE_FONT_CDN_URL: 'https://fonts.example.test/v1',
    }
    expect(loadBuilderConfig(env).extraMetadata).toEqual({ name: 'seuoffice' })
    expect(builderSource).not.toMatch(/GA4|FONT_CDN|genofficeAnalytics|genofficeFontCdn/)
  })
})
