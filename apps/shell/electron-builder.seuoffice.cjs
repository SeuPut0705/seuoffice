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
 * withoutModuleMains). Chromium's locales all stay (no electronLanguages):
 * without the pak of the system language Chromium runs as en-US, and every
 * date and number formatted with the default locale turns American.
 */

const { Arch } = require('electron-builder')
const base = require('./electron-builder.cjs')

/** The only package each platform gets: electron platform name -> CPU. */
const RELEASE_ARCH = { darwin: 'arm64', win32: 'x64' }

for (const name of ['SEUOFFICE_MAC_X64', 'SEUOFFICE_WIN_ARM64']) {
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
 * The Windows installer carries the app as a zip (nsis.useZip), which NSIS
 * unzips straight into the install folder. The default 7z package is first
 * unpacked into a temporary folder and then copied over, and the old
 * folder's files are deleted afterwards: on a GitHub Windows runner an update
 * install took 59-60 s that way and 28-30 s from the zip (decision 0028). The
 * installer grows from 205 to 269 MB.
 *
 * electron-builder writes the installer's .blockmap only for its 7z package
 * (differentialPackage), so writeInstallerBlockmap writes it: the updater
 * downloads only the blocks that changed (updater.ts), and the release
 * workflow checks and uploads the file. The block map's update info (size,
 * sha512, blockMapSize) goes on the event as the 7z path puts it there, so
 * the feed lists the installer's size: without it the updater refuses the
 * differential download ('size mismatch ... newSize: undefined') and fetches
 * the whole installer.
 */
async function writeInstallerBlockmap(event) {
  if (event.target?.name !== 'nsis' || !event.file.endsWith('.exe')) return
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
  event.updateInfo = await buildBlockMap(event.file, 'gzip', `${event.file}.blockmap`)
}

/** @type {import('electron-builder').Configuration} */
const config = {
  ...shared,
  extraResources: withoutModuleMains(shared.extraResources),
  mac,
  dmg: { ...base.dmg, sign: macSigned },
  win: { ...base.win, target: [{ target: 'nsis', arch: [RELEASE_ARCH.win32] }] },
  nsis: { ...base.nsis, useZip: true, differentialPackage: false },
  artifactBuildCompleted: writeInstallerBlockmap,
  beforePack: async (context) => {
    const arch = Arch[context.arch]
    if (RELEASE_ARCH[context.electronPlatformName] !== arch) {
      throw new Error(`seuoffice does not release ${context.electronPlatformName} ${arch}`)
    }
    await base.beforePack(context)
  },
}

module.exports = config
