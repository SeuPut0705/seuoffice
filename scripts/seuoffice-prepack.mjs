/**
 * npm `prepack` step of the published seuoffice packages; runs with the
 * package directory as cwd. Copies the repository LICENSE, LICENSE-APACHE and
 * NOTICE next to package.json so they ship in the tarball (the copies are
 * git-ignored), and with `--require <path>` fails when a build output the
 * package ships is missing.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const file of ['LICENSE', 'LICENSE-APACHE', 'NOTICE']) {
  copyFileSync(resolve(repo, file), resolve(file))
}

const args = process.argv.slice(2)
const at = args.indexOf('--require')
if (at >= 0) {
  const required = args[at + 1]
  if (!required || !existsSync(resolve(required))) {
    console.error(`prepack: ${required} is missing; build the package before packing it`)
    process.exit(1)
  }
}
