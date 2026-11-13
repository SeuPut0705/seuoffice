import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocx } from './reference/parse'
import { buildDocx } from '../../packages/docx-engine/tests/helpers/build-docx'
import { PROPS_TEXTS } from './props-synthetic'
import { buildModelBody, MODEL_BODIES } from './model-bodies'
import { modelJson, type ModelInput } from './model-wire'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface ModelRefusal {
  where: string
  population: ModelInput['population']
  error: string
}

export function requireModelNode(): void {
  if (Number(process.versions.node.split('.')[0]) !== 22) {
    throw new Error(`docx model comparison requires Node 22, got ${process.version}`)
  }
}

export function corpusDocuments(): string[] {
  return execFileSync('git', ['ls-files', '-z', '*.docx'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

/** Actual parser results only. Refusals are counted separately, never silently skipped. */
export async function* parsedModels(refused: ModelRefusal[]): AsyncGenerator<ModelInput> {
  requireModelNode()
  const parse = async (
    where: string,
    population: ModelInput['population'],
    bytes: Uint8Array,
  ): Promise<ModelInput | null> => {
    try {
      return { where, population, type: 'ParsedDocFull', json: modelJson(await parseDocx(bytes)) }
    } catch (error) {
      refused.push({ where, population, error: String(error) })
      return null
    }
  }
  for (const path of corpusDocuments()) {
    const input = await parse(path, 'corpus', new Uint8Array(readFileSync(resolve(root, path))))
    if (input) yield input
  }
  // Existing gate inputs include fields, ruby, revision markers and unusual property values
  // absent from the tracked documents. Here they cross the full parser, not only readers.
  for (const [group, texts] of Object.entries(PROPS_TEXTS)) {
    for (const [index, bodyXml] of texts.entries()) {
      const input = await parse(
        `props ${group} ${index}`,
        'built',
        await buildDocx({
          bodyXml,
          withNumbering: true,
          withImage: true,
        }),
      )
      if (input) yield input
    }
  }
  for (const { name, ...options } of MODEL_BODIES) {
    const input = await parse(`model body ${name}`, 'built', await buildModelBody(options))
    if (input) yield input
  }
}
