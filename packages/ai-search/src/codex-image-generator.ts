/**
 * The slot the Codex subscription image backend registers itself in. This
 * package only routes: it knows when a request goes to Codex, not how Codex
 * makes an image. A process in which nothing registered a generator has no
 * Codex image generation, and its requests go to a key provider or end in
 * "unavailable".
 */

import type { MediaBlob } from '@genoffice/ai-provider'

export interface CodexImageRequest {
  /** the prompt as the tool received it, trimmed; any script, never transliterated */
  prompt: string
  /** 1:1 | 4:3 | 16:9 | 9:16 | 3:4 | 2:3 | 3:2 | auto */
  aspectRatio?: string | undefined
  /** auto | 0.5k | 1k | 2k | 3k | 4k */
  imageSize?: string | undefined
  /** the caller wants real alpha (icons, logos, cutouts); a generator without such a control ignores it */
  transparent?: boolean | undefined
  /** aborts when the caller cancels; the generator must stop its child process tree */
  signal?: AbortSignal | undefined
}

/**
 * What the generator made: the image bytes, which the tool puts in the
 * generated-image store like a key provider's answer, or a URL the insert
 * pipelines can already fetch.
 */
export type CodexImageResult = MediaBlob | { url: string }

export type CodexImageGenerator = (request: CodexImageRequest) => Promise<CodexImageResult>

let generator: CodexImageGenerator | null = null

/** Called once by the process that can run the Codex image backend; `null` takes it out again. */
export function registerCodexImageGenerator(fn: CodexImageGenerator | null): void {
  generator = fn
}

export function codexImageGenerator(): CodexImageGenerator | null {
  return generator
}
