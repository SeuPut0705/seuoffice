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

/** @type {import('electron-builder').Configuration} */
const config = {
  ...shared,
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
