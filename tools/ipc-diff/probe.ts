/**
 * crates/ipc-probe as a child process: one request line in, one answer line
 * out, one process per group.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Case } from './types.ts'

const crates = fileURLToPath(new URL('../../crates', import.meta.url))
/** built by build.mjs; IPC_DIFF_PROBE names another binary */
export const probePath =
  process.env.IPC_DIFF_PROBE ??
  join(crates, 'target', 'debug', process.platform === 'win32' ? 'ipc-probe.exe' : 'ipc-probe')

export class Probe {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly waiting: ((line: string) => void)[] = []
  private stderr = ''

  constructor() {
    this.child = spawn(probePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString()
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.waiting.shift()?.(line))
    this.child.on('exit', (code, signal) => {
      const line = JSON.stringify({
        bad: `ipc-probe ended (${code ?? signal}): ${this.stderr.slice(-2000)}`,
      })
      for (const answer of this.waiting.splice(0)) answer(line)
    })
  }

  /**
   * The Rust answer of one case, as the line ipc-probe wrote. `batch` is the
   * group's: the probe keeps what that batch sends while it registers and
   * drops what the others send, as the TypeScript side loads only its module.
   */
  run(dir: string, c: Case, batch: string): Promise<string> {
    return new Promise((resolve) => {
      this.waiting.push(resolve)
      this.child.stdin.write(`${JSON.stringify({ dir, case: { ...c, batch } })}\n`)
    })
  }

  close(): void {
    this.child.stdin.end()
  }
}
