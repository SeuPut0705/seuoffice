/**
 * Compile the Windows Explorer Quick Look helper (win-quicklook.cs -> win-quicklook.exe)
 * using the in-box .NET Framework 4.x compiler (csc.exe). Requires no external SDK.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'win-quicklook.cs')
const out = join(here, 'win-quicklook.exe')

if (process.platform !== 'win32') {
  console.error('build-win.mjs only runs on Windows')
  process.exit(1)
}

if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
  console.log('win-quicklook.exe is up to date')
  process.exit(0)
}

const windir = process.env.WINDIR ?? 'C:\\Windows'
const cscCandidates = [
  join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]
const csc = cscCandidates.find((candidate) => existsSync(candidate))
if (!csc) {
  console.error('csc.exe not found under Microsoft.NET\\Framework(64)\\v4.0.30319')
  process.exit(1)
}

execFileSync(
  csc,
  [
    '/nologo',
    '/optimize+',
    '/target:exe',
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Windows.Forms.dll',
    '/r:Microsoft.CSharp.dll',
    `/out:${out}`,
    src,
  ],
  { stdio: 'inherit' },
)
console.log('built', out)
