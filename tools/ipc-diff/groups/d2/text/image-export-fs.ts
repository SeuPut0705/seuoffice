/**
 * `node:fs/promises` as the Markdown page image exports import it: `mkdtemp`
 * names its folder with the next counted id's first six characters, as the
 * Rust side's `mkdtemp_suffix` does.
 */
import { mkdir } from 'node:fs/promises'
import { countedUuid } from './fakes.ts'

export * from 'node:fs/promises'

export async function mkdtemp(prefix: string): Promise<string> {
  const dir =
    prefix +
    countedUuid()
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 6)
  await mkdir(dir, { mode: 0o700 })
  return dir
}
