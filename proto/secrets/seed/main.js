'use strict'
// Seeds (SEED_MODE=seed, default) or reads back (SEED_MODE=decrypt) Electron
// safeStorage secrets the way the real app does: app.setName('seuoffice')
// before ready, userData = <appData>/seuoffice, "sealed:v1:" + base64(blob).
// Run it with Electron 43.8.3 (the app's version): `electron proto/secrets/seed`.
//   BENCH_USER_DATA   userData override (the shells' contract; use it off the runners)
//   SEED_MODE         seed | decrypt
//   SEED_RESULT       decrypt mode: file that receives {key: plaintext|error}
//   SEED_LOG          also append every log line here (a GUI-subsystem exe has no console on Windows)
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.setName('seuoffice')
const userData = process.env.BENCH_USER_DATA || path.join(app.getPath('appData'), 'seuoffice')
app.setPath('userData', userData)

const mode = process.env.SEED_MODE || 'seed'
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'))
const SEALED_PREFIX = 'sealed:v1:'
const sealedFile = path.join(userData, 'proto-secrets.json')
const localState = path.join(userData, 'Local State')

// Keep log lines ASCII so a Windows console code page cannot mangle them.
const log = (o) => {
  const line = JSON.stringify(o).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  console.log(line)
  if (process.env.SEED_LOG) fs.appendFileSync(process.env.SEED_LOG, line + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function keyOnDisk() {
  try {
    const s = JSON.parse(fs.readFileSync(localState, 'utf8'))
    return typeof s?.os_crypt?.encrypted_key === 'string' && s.os_crypt.encrypted_key !== ''
  } catch {
    return false
  }
}

async function seed() {
  const sealed = {
    mcp: SEALED_PREFIX + safeStorage.encryptString(expected.mcp).toString('base64'),
    // same blob format as the Drive vault's token (which stores the bare base64)
    drive: SEALED_PREFIX + safeStorage.encryptString(expected.drive).toString('base64'),
  }
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(sealedFile, JSON.stringify(sealed, null, 2), 'utf8')
  for (const [k, v] of Object.entries(sealed)) {
    const blob = Buffer.from(v.slice(SEALED_PREFIX.length), 'base64')
    log({ kind: 'sealed', key: k, prefix: blob.subarray(0, 3).toString('latin1'), bytes: blob.length })
  }
  if (process.platform === 'win32') {
    // Chromium writes the DPAPI-wrapped key into Local State some seconds after first use
    for (let i = 0; i < 60 && !keyOnDisk(); i++) await sleep(500)
    log({ kind: 'local-state', keyOnDisk: keyOnDisk() })
  }
  log({ kind: 'plaintexts', ...expected })
}

function decrypt() {
  const sealed = JSON.parse(fs.readFileSync(sealedFile, 'utf8'))
  const result = {}
  let bad = 0
  for (const [k, v] of Object.entries(sealed)) {
    try {
      result[k] = safeStorage.decryptString(Buffer.from(v.slice(SEALED_PREFIX.length), 'base64'))
    } catch (e) {
      result[k] = { error: String(e && e.message) }
      bad++
    }
    if (result[k] !== expected[k]) bad++
  }
  if (process.env.SEED_RESULT) fs.writeFileSync(process.env.SEED_RESULT, JSON.stringify(result), 'utf8')
  log({ kind: 'decrypted', bad, result })
  return bad
}

app.whenReady().then(async () => {
  let code = 0
  try {
    log({
      kind: 'start', mode, electron: process.versions.electron, name: app.getName(), userData,
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : null,
    })
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage reports encryption unavailable')
    if (mode === 'seed') await seed()
    else if (mode === 'decrypt') code = decrypt() ? 1 : 0
    else throw new Error('unknown SEED_MODE ' + mode)
  } catch (e) {
    log({ kind: 'error', message: String(e && e.stack) })
    code = 1
  }
  // A clean quit lets Chromium flush Local State; exit() would skip it.
  app.exitCode = code
  app.quit()
})
