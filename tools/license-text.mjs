import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const LICENSE_PATH = { electron: 'dist/LICENSE' }
/**
 * A license or copyright file, with any suffix: LICENSE, LICENSE.md,
 * LICENSE-MIT, LICENSE-APACHE, LICENCE.txt, COPYING, COPYRIGHT, LICENSE-WHATWG.
 * Dual-licensed packages (most Rust crates) carry one file per license, and
 * every one of them is kept: the MIT file holds the copyright line the
 * Apache text lacks.
 */
export const LICENSE_FILE = /^(LICEN[CS]E|COPYING|COPYRIGHT)([-._].*)?$/i
/** source files that happen to share the name (license.js, LICENSE.rs) are not texts */
const NOT_TEXT = /\.(m?[jt]sx?|cjs|json|map|rs|py|go|sh)$/i

/** the license file names in a directory, in a stable (code point) order */
export function licenseFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name) && !NOT_TEXT.test(e.name))
    .map((e) => e.name)
    .sort()
}

export function licenseText(name, dir) {
  const override = LICENSE_PATH[name]
  if (override && existsSync(join(dir, override))) {
    return readFileSync(join(dir, override), 'utf8').trim()
  }
  const texts = licenseFiles(dir)
    .map((file) => readFileSync(join(dir, file), 'utf8').trim())
    .filter(Boolean)
  const unique = [...new Set(texts)]
  return unique.length > 0 ? unique.join('\n\n') : null
}
