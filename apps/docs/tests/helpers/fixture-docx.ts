import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Every docx this repository keeps as a fixture: the corpus the co-editing safety tests open */
export function fixtureDocx(): string[] {
  const root = join(__dirname, '../../../..')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.docx')) found.push(path)
    }
  }
  for (const dir of ['apps/docs/tests', 'packages/docx-engine/tests', 'packages/docx2hwp/tests'])
    walk(join(root, dir))
  walk(join(root, 'fixtures'))
  return found
}
