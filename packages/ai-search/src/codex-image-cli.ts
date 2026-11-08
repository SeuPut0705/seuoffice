/**
 * Codex subscription image generation, through the official CLI (the same path the
 * `codex-image` community skill documents): `codex exec` uses the account's OAuth login and
 * its built-in `image_gen` tool (gpt-image-2), and the generated file is read back here.
 *
 * Why a separate `codex exec` and not the chat session: the app's chat loop deliberately runs
 * Codex with every built-in tool it can turn off turned off. This call is one image, in a
 * throw-away folder, with the image tool on; nothing of the chat goes through it.
 *
 * What it does NOT do: read `~/.codex/auth.json` (or any login store). The CLI authenticates
 * itself; this module only starts it and reads the image file it writes. The image is charged
 * to the signed-in ChatGPT plan (Plus/Team/Enterprise; a free plan did not expose the tool).
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { setCodexImageGenerationAvailable } from '@genoffice/ai-provider'
import {
  resolveSubscriptionProgram,
  runSubscriptionProgram,
  type SubscriptionProgram,
  type SubscriptionRunner,
} from '@genoffice/ai-provider/subscription'
import type { CodexImageGenerator } from './codex-image-generator'
import { readAiSettingsFile } from './media-tools'

/** The image tool may take a couple of minutes; the skill times out at 2 minutes. */
export const CODEX_IMAGE_TIMEOUT_MS = 180_000
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export interface CodexImageCliOptions {
  /** `ai-settings.json`: the Codex `cliPath` setting wins over the automatic lookup */
  settingsPath(): string
  /** the app's temp folder; a dedicated folder is made per call */
  tempRoot(): string
  /** injected in tests; the real one runs the CLI and ends its whole tree on abort */
  run?: SubscriptionRunner
  /** injected in tests; the real one locates the installed Codex */
  resolveProgram?: (configuredPath: string | undefined) => Promise<SubscriptionProgram>
  /** injected in tests; the real one makes a folder under `tempRoot` */
  makeTempDir?: (parent: string) => Promise<string>
}

/** The size the skill passes; gpt-image-2 takes these three shapes. */
function sizeFor(aspectRatio: string | undefined): string {
  switch (aspectRatio) {
    case '16:9':
    case '3:2':
    case '4:3':
      return '1536x1024'
    case '9:16':
    case '2:3':
    case '3:4':
      return '1024x1536'
    default:
      return '1024x1024'
  }
}

/** `imageSize` is the app's token budget; the CLI calls the same idea "quality". */
function qualityFor(imageSize: string | undefined): string {
  switch (imageSize) {
    case '0.5k':
      return 'low'
    case '2k':
    case '3k':
    case '4k':
      return 'high'
    case '1k':
      return 'medium'
    default:
      return 'auto'
  }
}

/** The prompt the skill sends, with one image and an exact output path. */
function codexPrompt(prompt: string, outPath: string, size: string, quality: string): string {
  const out = outPath.replace(/\\/g, '/')
  return [
    'Perform the following tasks:',
    '1. Use the built-in image_gen tool to generate exactly one image.',
    '2. The prompt is between the markers below:',
    '<<<PROMPT',
    prompt,
    'PROMPT>>>',
    `3. Size: ${size}`,
    `4. Quality: ${quality}`,
    `5. Save the generated image as the absolute path "${out}". If the tool saved it somewhere else, copy it there.`,
    '6. Print the saved file path and its size.',
    'Do not draw the image with code or SVG, and do not use any tool other than image_gen and the file copy.',
  ].join('\n')
}

function codexArgs(prompt: string, workDir: string): string[] {
  return [
    'exec',
    prompt,
    '-C',
    workDir,
    '-s',
    'workspace-write',
    '--skip-git-repo-check',
    // no session file: this call is not a conversation the user will resume
    '--ephemeral',
    '-c',
    'features.image_generation=true',
    // the same built-in tools the chat route keeps off; the image call needs none of them
    '-c',
    'features.plugins=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.memories=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'history.persistence="none"',
    '-c',
    'model_reasoning_effort="medium"',
  ]
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** The image file the call wrote: the asked-for path, else the newest image in the folder. */
async function findImage(workDir: string, wanted: string): Promise<string | null> {
  try {
    const info = await stat(wanted)
    if (info.isFile() && info.size > 0) return wanted
  } catch {
    // the model may have written another name; look at the folder below
  }
  try {
    const names = await readdir(workDir)
    const candidates: { path: string; time: number; size: number }[] = []
    for (const name of names) {
      if (!IMAGE_EXT.has(extname(name).toLowerCase())) continue
      const path = join(workDir, name)
      const info = await stat(path)
      if (info.isFile() && info.size > 0)
        candidates.push({ path, time: info.mtimeMs, size: info.size })
    }
    candidates.sort((a, b) => b.time - a.time || b.size - a.size)
    return candidates[0]?.path ?? null
  } catch {
    return null
  }
}

function mimeOf(path: string, bytes: Uint8Array): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  // a PNG is what the tool returns; sniff rather than trust a name
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  return 'image/png'
}

/** The last lines of a failed run, for the model and the log; never the whole transcript. */
function failureDetail(stdout: string, stderr: string): string {
  const text = `${stderr}\n${stdout}`.trim()
  return text.split('\n').slice(-8).join('\n').slice(0, 1200)
}

function planHint(detail: string): string {
  if (
    /not exposed|image_gen|image generation|image tool|model.*not supported|not supported.*model/i.test(
      detail,
    )
  ) {
    return (
      'Codex did not offer its image generation tool in this session (the account or its ' +
      'default model does not support it). ChatGPT Plus/Team/Enterprise is needed for Codex ' +
      'image generation; connect an image provider key or use image search instead.'
    )
  }
  return 'Codex image generation failed.'
}

/**
 * Builds the generator the app registers for Codex. Every failure is an Error with a sentence
 * the model can act on; `generateImageTool` turns it into a tool error.
 */
export function createCodexImageCliGenerator(options: CodexImageCliOptions): CodexImageGenerator {
  const run = options.run ?? runSubscriptionProgram
  const makeTempDir =
    options.makeTempDir ?? ((parent: string) => mkdtemp(join(parent, 'ieum-codex-image-')))
  const resolve =
    options.resolveProgram ??
    ((configuredPath: string | undefined) =>
      resolveSubscriptionProgram('codex', { configuredPath }))

  return async (request) => {
    const settings = readAiSettingsFile(options.settingsPath())
    const program = await resolve(settings.providers.codex.cliPath?.trim() || undefined)
    const workDir = await makeTempDir(options.tempRoot())
    const outPath = join(workDir, 'image.png')
    try {
      const prompt = codexPrompt(
        request.prompt,
        outPath,
        sizeFor(request.aspectRatio),
        qualityFor(request.imageSize),
      )
      const result = await run(program, codexArgs(prompt, workDir), {
        signal: request.signal ?? new AbortController().signal,
        timeoutMs: CODEX_IMAGE_TIMEOUT_MS,
        cwd: workDir,
      })
      const imagePath = await findImage(workDir, outPath)
      if (!imagePath) {
        const detail = failureDetail(result.stdout, result.stderr)
        // A plan without the tool will not grow one this run: hide the route until the
        // app restarts (an upgraded plan is picked up then) instead of failing every call.
        if (/not exposed|image tool|model.*not supported|not supported.*model/i.test(detail)) {
          setCodexImageGenerationAvailable(false)
        }
        throw new Error(
          `${planHint(detail)}${detail ? ` Codex said: ${detail}` : ` (exit code ${String(result.code)})`}`,
        )
      }
      const bytes = new Uint8Array(await readFile(imagePath))
      if (bytes.byteLength === 0) throw new Error('Codex wrote an empty image file.')
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Codex wrote an image larger than ${MAX_IMAGE_BYTES} bytes.`)
      }
      return { bytes, mime: mimeOf(imagePath, bytes) }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
