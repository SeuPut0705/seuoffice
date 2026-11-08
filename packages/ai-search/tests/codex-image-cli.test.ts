import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  codexImageGenerationAvailable,
  setCodexImageGenerationAvailable,
} from '@genoffice/ai-provider'
import { createCodexImageCliGenerator } from '../src/codex-image-cli'
import type { SubscriptionProgram, SubscriptionRunner } from '@genoffice/ai-provider/subscription'

/**
 * The Codex CLI image generator: the command shape the codex-image skill documents, the
 * generated file read back, and the failures turned into a sentence the model can act on.
 * The CLI itself is replaced by `run`, so no process, login or network is touched.
 */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])

const PROGRAM: SubscriptionProgram = {
  provider: 'codex',
  command: 'codex',
  prefixArgs: [],
  env: {},
  entry: 'codex',
  source: 'path',
}

async function settingsFile(cliPath = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-image-settings-'))
  const path = join(dir, 'ai-settings.json')
  await writeFile(
    path,
    JSON.stringify({
      provider: 'codex',
      providers: { codex: { apiKey: '', model: '', ...(cliPath ? { cliPath } : {}) } },
      subscriptionNoticeSeen: true,
    }),
  )
  return path
}

/** A run that saves PNG bytes to the path the prompt names, like the model's file copy. */
function writingRun(bytes = PNG): SubscriptionRunner {
  return vi.fn(async (_program, args) => {
    const prompt = args[1] ?? ''
    const match = /"([^"]+image\.png)"/.exec(prompt)
    if (!match?.[1]) throw new Error(`no output path in the prompt: ${prompt}`)
    await writeFile(match[1], bytes)
    return { code: 0, stdout: 'saved', stderr: '' }
  })
}

function generator(run: SubscriptionRunner, overrides: Record<string, unknown> = {}) {
  return createCodexImageCliGenerator({
    settingsPath: () => '',
    tempRoot: () => tmpdir(),
    run,
    resolveProgram: async () => PROGRAM,
    ...overrides,
  })
}

describe('createCodexImageCliGenerator', () => {
  it("runs the skill's codex exec with the image tool on and reads the file back", async () => {
    const run = writingRun()
    const settings = await settingsFile('C:/tools/codex.exe')
    const resolveProgram = vi.fn(async () => PROGRAM)
    const gen = createCodexImageCliGenerator({
      settingsPath: () => settings,
      tempRoot: () => tmpdir(),
      run,
      resolveProgram,
    })
    const result = await gen({ prompt: 'a red apple', aspectRatio: '16:9', imageSize: '2k' })
    expect(result).toEqual({ bytes: PNG, mime: 'image/png' })
    expect(resolveProgram).toHaveBeenCalledWith('C:/tools/codex.exe')

    const [program, args, options] = (run as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [SubscriptionProgram, string[], { timeoutMs: number; cwd: string }]
    expect(program).toBe(PROGRAM)
    expect(args[0]).toBe('exec')
    expect(args).toContain('workspace-write')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('features.image_generation=true')
    expect(options.timeoutMs).toBe(180_000)
    const prompt = args[1]!
    expect(prompt).toContain('a red apple')
    expect(prompt).toContain('Size: 1536x1024')
    expect(prompt).toContain('Quality: high')
    expect(prompt).toContain('<<<PROMPT')
    expect(prompt).toContain('image.png')
  })

  it('uses the portrait size for a vertical request and auto quality by default', async () => {
    const run = writingRun()
    const gen = generator(run)
    await gen({ prompt: 'a tower', aspectRatio: '9:16' })
    const prompt = (run as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as string[]
    expect(prompt[1]).toContain('Size: 1024x1536')
    expect(prompt[1]).toContain('Quality: auto')
  })

  it('finds an image the model saved under another name', async () => {
    const run: SubscriptionRunner = vi.fn(async (_program, _args, options) => {
      await writeFile(join(options.cwd!, 'generated.png'), PNG)
      return { code: 0, stdout: 'saved', stderr: '' }
    })
    const result = await generator(run)({ prompt: 'x' })
    expect(result).toEqual({ bytes: PNG, mime: 'image/png' })
  })

  it('turns a session without the image tool into the plan hint and stops offering it', async () => {
    setCodexImageGenerationAvailable(true)
    const run: SubscriptionRunner = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'The built-in image tool is not exposed in this session',
    }))
    await expect(generator(run)({ prompt: 'x' })).rejects.toThrow(
      /ChatGPT Plus\/Team\/Enterprise.*image tool is not exposed/s,
    )
    expect(codexImageGenerationAvailable()).toBe(false)
  })

  it('reports a run that finished without writing a file', async () => {
    const run: SubscriptionRunner = vi.fn(async () => ({ code: 0, stdout: 'done', stderr: '' }))
    await expect(generator(run)({ prompt: 'x' })).rejects.toThrow(/Codex image generation failed/)
  })

  it('removes the throw-away folder after the call', async () => {
    const made: string[] = []
    const gen = createCodexImageCliGenerator({
      settingsPath: () => '',
      tempRoot: () => tmpdir(),
      run: writingRun(),
      resolveProgram: async () => PROGRAM,
      makeTempDir: async (parent) => {
        const dir = await mkdtemp(join(parent, 'codex-image-test-'))
        made.push(dir)
        return dir
      },
    })
    await gen({ prompt: 'x' })
    expect(made).toHaveLength(1)
    await expect(readFile(join(made[0]!, 'image.png'))).rejects.toThrow()
  })
})
