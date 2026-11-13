/**
 * `@seuoffice/ai-search` as `apps/hwp/src/main/ai-image.ts` sees it: the
 * media call's signal, and `analyzeMediaTool` answering from the case's
 * `hosts.d2.hwp.analyze_media` as `FakeEngine::analyze_media` does (the tool's
 * result; `{"throws": message}` rejects; by default what it was asked), one
 * host-log line per call. `generateImageTool` belongs to batch A: the Rust
 * side registers no `hwp:ai-generate-image`, and no case calls it.
 */
import { world } from './common.ts'

interface Sender {
  id: number
}

let sender = 0

export async function withMediaCallSignal<T>(
  from: Sender,
  run: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  sender = from.id
  return await run(new AbortController().signal)
}

export async function analyzeMediaTool(
  settingsPath: string,
  input: { mediaUrls: string[]; requirements: string },
  options: { signal: AbortSignal },
): Promise<unknown> {
  const w = world()
  w.log.push(['analyzeMediaTool', input.mediaUrls, input.requirements])
  const answer = w.answers.next('analyze_media')
  if (answer !== undefined) {
    const throws = (answer as { throws?: unknown } | null)?.throws
    if (typeof throws === 'string') throw new Error(throws)
    return answer
  }
  return {
    view: sender,
    settingsPath,
    mediaUrls: input.mediaUrls,
    requirements: input.requirements,
    cancelled: options.signal.aborted,
  }
}

export function generateImageTool(): never {
  throw new Error('hwp:ai-generate-image is batch A')
}

export function documentMediaRoots(): string[] {
  return []
}
