/**
 * Real-run check of the permission guard in a real Electron, without a build of the app.
 *
 * Bundles permission-guard-main.ts (which installs the real guard of packages/electron-utils)
 * and starts it with the Electron of this checkout, in a throwaway home and user-data folder.
 * The pages it opens ask for what the editors ask for: the HWP editor's copy, paste and font
 * list from its frame, the sheet editor's range copy and paste, the slides editor's microphone;
 * and a sandboxed frame asks for the same and must be refused. It prints one line per answer,
 * with the guard's request and check trace, and exits 1 when an answer is wrong.
 *
 * Not part of `npm test`: it starts Electron and it uses the system clipboard. What was on the
 * clipboard as text, HTML, RTF or a picture is put back at the end; copied files are not.
 *
 *   npx tsx apps/shell/tests/real-run/permission-guard-run.ts
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), 'permission-guard-run-'))
  try {
    const entry = join(work, 'main.cjs')
    await build({
      entryPoints: [join(here, 'permission-guard-main.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'warning',
    })
    // required from Node, the package answers the path of its binary
    const electron = createRequire(import.meta.url)('electron') as string
    const run = spawnSync(electron, [entry, `--user-data-dir=${join(work, 'user-data')}`], {
      env: { ...process.env, HOME: work, USERPROFILE: work },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    return run.status ?? 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

void main().then((status) => {
  process.exitCode = status
})
