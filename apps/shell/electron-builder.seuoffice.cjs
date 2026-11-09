/**
 * seuoffice release packaging, layered over the upstream electron-builder.cjs
 * (decision 0013). Pass it with `--config electron-builder.seuoffice.cjs`; a
 * plain `electron-builder` run keeps the upstream config, so development
 * builds are unchanged.
 *
 * seuoffice ships two packages only: Apple Silicon Mac (dmg, plus the zip the
 * app updates itself from) and x64 Windows (NSIS). Linux, Intel Mac and
 * Windows on ARM are neither built nor released.
 *
 * Mac signing: with CSC_LINK (a Developer ID Application certificate) the app
 * is signed with the hardened runtime and notarized (APPLE_ID,
 * APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, the names build/notarize-dmg.js
 * already reads). Without CSC_LINK it stays signed ad hoc, as upstream.
 *
 * Size: the editor modules' own main bundles stay out of the package (see
 * withoutModuleMains), and of Chromium's locales only those of the interface
 * languages (see ELECTRON_LANGUAGES).
 */

const { Arch } = require('electron-builder')
const base = require('./electron-builder.cjs')

/** The only package each platform gets: electron platform name -> CPU. */
const RELEASE_ARCH = { darwin: 'arm64', win32: 'x64' }

for (const name of ['GENOFFICE_MAC_X64', 'GENOFFICE_WIN_ARM64']) {
  if (process.env[name] === '1') {
    throw new Error(`${name}=1 asks for a package seuoffice does not release`)
  }
}

const mac = {
  ...base.mac,
  target: [
    { target: 'dmg', arch: [RELEASE_ARCH.darwin] },
    { target: 'zip', arch: [RELEASE_ARCH.darwin] },
  ],
}
const macSigned = Boolean(process.env.CSC_LINK)
if (macSigned) {
  const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter(
    (name) => !process.env[name],
  )
  // Gatekeeper refuses a Developer ID app that is not notarized
  if (missing.length > 0) {
    throw new Error(`CSC_LINK is set but notarization needs ${missing.join(', ')}`)
  }
  // no identity: electron-builder signs with the CSC_LINK certificate
  delete mac.identity
  mac.hardenedRuntime = true
  mac.notarize = true
}

const { linux: _linux, deb: _deb, rpm: _rpm, appImage: _appImage, ...shared } = base

/**
 * Upstream ships each editor module as extraResources `modules/<app>`, the
 * whole electron-vite out/ tree: main/, preload/, renderer/. The packaged shell
 * reads only a module's preload/ and renderer/ (and the diagram module's
 * drawio/ and bridge/): every editor's main code is already inside the shell's
 * own main bundle, and a module's out/main is what that editor runs on when it
 * is started alone in development. Left out, the ten main/ folders save
 * 67.7 MB installed and 15.2 MB of the Mac zip.
 *
 * Derived from the upstream list rather than repeated, and refusing a list with
 * no module entry: a renamed upstream destination must not bring the bytes back
 * unnoticed.
 */
function withoutModuleMains(extraResources) {
  let modules = 0
  const entries = extraResources.map((entry) => {
    if (typeof entry !== 'object' || !String(entry.to).startsWith('modules/')) return entry
    modules += 1
    return { ...entry, filter: [...[entry.filter ?? '**/*'].flat(), '!main/**'] }
  })
  if (modules === 0) {
    throw new Error('electron-builder.cjs lists no extraResources under modules/: nothing to trim')
  }
  return entries
}

/**
 * Chromium brings its own strings (context menus, the spelling menu, form and
 * dialog texts) in 55 locales; the interface exists in 21 languages (LANGS in
 * packages/i18n/src/index.ts). Only the locales of those languages ship, with
 * every regional variant Chromium has of them: language -> regions, '' being
 * the bare name.
 *
 * English stays whatever LANGS says: Chromium falls back to en-US for any
 * other system language, and the Windows app does not start without
 * locales/en-US.pak.
 */
const UI_LOCALES = {
  ar: [''],
  cs: [''],
  de: [''],
  en: ['', 'US', 'GB'],
  es: ['', '419'],
  fr: [''],
  he: [''],
  hi: [''],
  id: [''],
  it: [''],
  ja: [''],
  ko: [''],
  ms: [''],
  nl: [''],
  pl: [''],
  pt: ['BR', 'PT'],
  ru: [''],
  th: [''],
  vi: [''],
  zh: ['CN', 'TW'],
}

const MAC_GENDERS = ['FEMININE', 'MASCULINE', 'NEUTER']

/**
 * electron-builder keeps a locale file only when its name, lower-cased and
 * without the extension, equals a listed name or is the start of one up to a
 * `-` or `_` (`en-US` also keeps `en`, never the other way round). The file
 * names differ by platform, so each locale is listed in both spellings:
 *   Windows  locales/<name>.pak        en-US, en-GB, es-419, pt-BR, zh-CN
 *   Mac      <name>.lproj              en, en_GB, es_419, pt_BR, zh_CN
 *            <name>_<GENDER>.lproj     Chromium's gendered strings, one small
 *                                      folder per grammatical gender
 */
const ELECTRON_LANGUAGES = Object.entries(UI_LOCALES).flatMap(([language, regions]) =>
  regions.flatMap((region) => {
    if (!region) return [language, ...MAC_GENDERS.map((gender) => `${language}_${gender}`)]
    const mac = `${language}_${region}`
    return [`${language}-${region}`, mac, ...MAC_GENDERS.map((gender) => `${mac}_${gender}`)]
  }),
)

/** @type {import('electron-builder').Configuration} */
const config = {
  ...shared,
  extraResources: withoutModuleMains(shared.extraResources),
  electronLanguages: ELECTRON_LANGUAGES,
  mac,
  dmg: { ...base.dmg, sign: macSigned },
  win: { ...base.win, target: [{ target: 'nsis', arch: [RELEASE_ARCH.win32] }] },
  beforePack: async (context) => {
    const arch = Arch[context.arch]
    if (RELEASE_ARCH[context.electronPlatformName] !== arch) {
      throw new Error(`seuoffice does not release ${context.electronPlatformName} ${arch}`)
    }
    await base.beforePack(context)
  },
}

module.exports = config
