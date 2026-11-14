import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseKeepingOrder } from '../docx-diff/key-order'
import type { Input, Spec } from './spec'

const here = dirname(fileURLToPath(import.meta.url))

export function isolatedOutcomes(
  spec: Spec,
  input: Input,
  wasmPath: string,
): { typescript: unknown; rust: unknown; failures: string[] } {
  const failures: string[] = []
  const invoke = (side: 'typescript' | 'rust'): unknown => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(here, 'isolated-call.ts'),
        side,
        spec.fn,
        wasmPath,
        spec.engineFn ?? spec.fn,
      ],
      {
        cwd: resolve(here, '../..'),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        input: JSON.stringify({
          text: input.text,
          args: input.args,
          bytesBase64:
            input.bytes === undefined ? undefined : Buffer.from(input.bytes).toString('base64'),
        }),
      },
    )
    if (result.status !== 0) {
      const detail =
        result.error?.message ??
        `exit ${result.status}, signal ${result.signal}: ${result.stderr.slice(-500)}`
      failures.push(`${side}: ${detail}`)
      return { error: { name: 'SubprocessFailure', message: detail } }
    }
    try {
      return parseKeepingOrder(result.stdout)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${side}: invalid child output: ${detail}`)
      return { error: { name: 'SubprocessFailure', message: detail } }
    }
  }
  const typescript = invoke('typescript')
  const rust = invoke('rust')
  return { typescript, rust, failures }
}
