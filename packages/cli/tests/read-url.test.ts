import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, runWithInline } from '../src/mcp/run'
import { buildArgv, resolveTools } from '../src/mcp/tools'
import { run, tempDir } from './helpers'

// read-url fetches the page itself; the tool is replaced so no test reaches the network.
const fakes = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock('@genoffice/ai-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-search')>()),
  readUrlTool: fakes.read,
}))

/** A data folder as the app keeps it: ai-settings.json and nothing else. */
function dataFolder(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir()
  writeFileSync(join(dir, 'ai-settings.json'), JSON.stringify({ provider: 'auto', providers: {} }))
  return {
    dir,
    env: {
      ...process.env,
      HTTPS_PROXY: '',
      https_proxy: '',
      HTTP_PROXY: '',
      http_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
      GENOFFICE_USER_DATA: dir,
      GENOFFICE_AI_SETTINGS: '',
      GENOFFICE_AUDIT_LOG: 'off',
      GENOFFICE_ALLOWED_ROOTS: '',
    },
  }
}

function success(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    url: 'https://example.com/guide',
    title: 'Guide',
    text: 'hello world',
    offset: 0,
    totalChars: 11,
    truncated: false,
    ...overrides,
  }
}

beforeEach(() => {
  fakes.read.mockReset()
})

describe('read-url command', () => {
  it('is registered with its usage and offset option', () => {
    const def = defaultRegistry().get('read-url')!
    expect(def.usage).toBe('read-url <url> [--offset <n>]')
    expect(def.options?.map((o) => [o.name, o.value])).toEqual([['offset', 'n']])
  })

  it('returns the tool result keys, the host summary and the settings path it used', async () => {
    fakes.read.mockResolvedValue(success())
    const { env, dir } = dataFolder()
    const r = await run(['read-url', 'https://example.com/guide', '--json'], { env })
    expect(r.code).toBe(0)
    const ok = r.json()
    expect(Object.keys(ok).sort()).toEqual(['command', 'detail', 'status', 'summary'].sort())
    expect(ok.command).toBe('read-url')
    expect(ok.status).toBe('ok')
    expect(ok.summary).toBe('example.com: characters 0..11 of 11 (end)')
    expect(ok.detail).toEqual({
      url: 'https://example.com/guide',
      title: 'Guide',
      text: 'hello world',
      offset: 0,
      totalChars: 11,
      truncated: false,
    })
    expect(fakes.read).toHaveBeenCalledTimes(1)
    expect(fakes.read).toHaveBeenCalledWith(
      join(dir, 'ai-settings.json'),
      'https://example.com/guide',
      0,
    )
    // no provider, subscription or automatic-call ledger is touched
    expect(existsSync(join(dir, 'headless-subscription-ledger.json'))).toBe(false)
    expect(existsSync(join(dir, 'headless-subscription.lock'))).toBe(false)
  })

  it('continues a long page: nextOffset, offset in the summary and detail', async () => {
    fakes.read.mockResolvedValue(
      success({
        url: 'https://example.com/long',
        text: 'def',
        offset: 3,
        totalChars: 10,
        truncated: true,
        nextOffset: 6,
      }),
    )
    const { env } = dataFolder()
    const r = await run(['read-url', 'https://example.com/long', '--offset', '3', '--json'], {
      env,
    })
    expect(r.code).toBe(0)
    expect(r.json().summary).toBe('example.com: characters 3..6 of 10 (continue with --offset 6)')
    expect(r.json().detail).toMatchObject({ offset: 3, nextOffset: 6, truncated: true })
    expect(fakes.read.mock.calls[0]![2]).toBe(3)
  })

  it('omits title and nextOffset when the tool does not return them', async () => {
    fakes.read.mockResolvedValue({
      ok: true,
      url: 'https://example.com/bare',
      text: '',
      offset: 0,
      totalChars: 0,
      truncated: false,
    })
    const { env } = dataFolder()
    const r = await run(['read-url', 'https://example.com/bare', '--json'], { env })
    expect(r.code).toBe(0)
    expect(Object.keys(r.json().detail).sort()).toEqual(
      ['offset', 'text', 'totalChars', 'truncated', 'url'].sort(),
    )
  })

  it('answers missing_argument when the address is absent', async () => {
    const { env } = dataFolder()
    const r = await run(['read-url', '--json'], { env })
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('missing_argument')
    expect(r.json().detail).toBeUndefined()
    expect(fakes.read).not.toHaveBeenCalled()
  })

  it.each(['abc', '-1', '2.5', '1e3', ''])(
    'rejects --offset "%s" as invalid_argument before fetching',
    async (bad) => {
      const { env } = dataFolder()
      const r = await run(['read-url', 'https://example.com', '--offset', bad, '--json'], { env })
      expect(r.code).toBe(1)
      expect(r.json().error).toBe('invalid_argument')
      expect(fakes.read).not.toHaveBeenCalled()
    },
  )

  it.each(['9007199254740992', '9007199254740993', '9'.repeat(400)])(
    'rejects an unrepresentable offset %s before fetching',
    async (offset) => {
      fakes.read.mockResolvedValue(success())
      const { env } = dataFolder()
      const r = await run(['read-url', 'https://example.com', '--offset', offset, '--json'], {
        env,
      })
      expect(r.code).toBe(1)
      expect(r.json().error).toBe('invalid_argument')
      expect(fakes.read).not.toHaveBeenCalled()
    },
  )

  it.each(['0', '0003', ' 3 ', '9007199254740991'])(
    'preserves the supported integer offset %s',
    async (offset) => {
      fakes.read.mockResolvedValue(success())
      const { env } = dataFolder()
      const r = await run(['read-url', 'https://example.com', '--offset', offset, '--json'], {
        env,
      })
      expect(r.code).toBe(0)
      expect(fakes.read).toHaveBeenCalledWith(
        expect.any(String),
        'https://example.com',
        Number(offset),
      )
    },
  )

  it('rejects an --offset with no value', async () => {
    const { env } = dataFolder()
    const r = await run(['read-url', 'https://example.com', '--offset', '--json'], { env })
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('invalid_argument')
    expect(fakes.read).not.toHaveBeenCalled()
  })
})

describe('read-url failure mapping', () => {
  it.each([
    ['invalid_url', 'Not a usable web address: x', 1, 'invalid_argument', undefined],
    [
      'blocked',
      'Refused to fetch that address: it is, or redirects to, a private or loopback address.',
      1,
      'unsupported',
      { reason: 'blocked' },
    ],
    [
      'unsupported_type',
      'This address is a application/pdf file, not a web page. Download it and attach the file instead.',
      1,
      'unsupported',
      {},
    ],
    ['empty', 'The page had no readable text.', 1, 'unsupported', { reason: 'no_text' }],
    [
      'too_large',
      'The page is larger than 10 MB. Download it and attach the file instead.',
      4,
      'resource_limit',
      { max_bytes: 10485760 },
    ],
    [
      'network',
      'Could not reach the address: fetch failed',
      4,
      'app_unavailable',
      { errorCode: 'network' },
    ],
    [
      'timeout',
      'The page did not answer within 30 seconds.',
      4,
      'app_unavailable',
      { errorCode: 'timeout' },
    ],
    [
      'http_error',
      'The server answered with HTTP 503.',
      4,
      'app_unavailable',
      { errorCode: 'http_error', status: 503 },
    ],
    [
      'auth',
      'GitHub answered with HTTP 404. If this file is in a private repository, add a GitHub token in the AI settings; otherwise check the address.',
      4,
      'app_unavailable',
      { errorCode: 'auth' },
    ],
  ] as const)('maps %s to exit %i and %s', async (errorCode, error, code, reason, detail) => {
    // like ReadUrlFailure: only http_error carries the HTTP status
    fakes.read.mockResolvedValue({
      ok: false,
      error,
      errorCode,
      ...(errorCode === 'http_error' ? { status: 503 } : {}),
    })
    const { env } = dataFolder()
    const r = await run(['read-url', 'https://example.com/x', '--json'], { env })
    expect(r.code).toBe(code)
    const failure = r.json()
    expect(failure.message).toBe(error)
    expect(failure.error).toBe(reason)
    expect(failure.detail).toEqual(detail)
    if (errorCode === 'auth') expect(failure.suggestion).toContain('GitHub token')
    if (errorCode === 'unsupported_type') expect(failure.message).toContain('attach the file')
    if (errorCode === 'network') expect(failure.suggestion).toContain('network')
  })

  it('keeps an HTTP status the tool reports', async () => {
    fakes.read.mockResolvedValue({
      ok: false,
      error: 'The server answered with HTTP 503.',
      errorCode: 'http_error',
      status: 503,
    })
    const { env } = dataFolder()
    const r = await run(['read-url', 'https://example.com/x', '--json'], { env })
    expect(r.code).toBe(4)
    expect(r.json().error).toBe('app_unavailable')
    expect(r.json().detail).toEqual({ errorCode: 'http_error', status: 503 })
  })

  it('prints the summary in human mode and the message on stderr', async () => {
    fakes.read.mockResolvedValue(success())
    const { env } = dataFolder()
    const ok = await run(['read-url', 'https://example.com/guide'], { env })
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('example.com: characters 0..11 of 11 (end)')
    expect(ok.stderr).toBe('')

    fakes.read.mockResolvedValue({
      ok: false,
      error: 'The page had no readable text.',
      errorCode: 'empty',
    })
    const failed = await run(['read-url', 'https://example.com/empty'], { env })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('The page had no readable text.')
  })
})

describe('read_url MCP tool', () => {
  const tools = new Map(resolveTools(defaultRegistry()).map((t) => [t.name, t]))

  it('is listed as a read-only open-world tool with the url and offset', () => {
    const tool = tools.get('read_url')!
    expect(tool).toBeDefined()
    expect(tool.command).toBe('read-url')
    expect(tool.readOnly).toBe(true)
    expect(tool.openWorld).toBe(true)
    expect(tool.positionals?.map((p) => p.key)).toEqual(['url'])
    expect(tool.params.map((p) => [p.key, p.kind])).toEqual([['offset', 'integer']])
  })

  it('runs the read-url command with its offset', async () => {
    fakes.read.mockResolvedValue(
      success({ url: 'https://example.com/tool', text: 'c', offset: 2, totalChars: 3 }),
    )
    const { env, dir } = dataFolder()
    const ctx = createContext({ cwd: dir, env, log: () => undefined })
    try {
      const call = buildArgv(tools.get('read_url')!, {
        url: 'https://example.com/tool',
        offset: 2,
      })
      expect(call.argv).toEqual(['read-url', 'https://example.com/tool', '--offset', '2'])
      const outcome = await runWithInline(call.argv, call.inline, ctx)
      expect(outcome.error).toBeUndefined()
      expect(outcome.ok?.command).toBe('read-url')
      expect(outcome.ok?.summary).toBe('example.com: characters 2..3 of 3 (end)')
      expect(fakes.read.mock.calls[0]![1]).toBe('https://example.com/tool')
      expect(fakes.read.mock.calls[0]![2]).toBe(2)
    } finally {
      disposeContext(ctx)
    }
  })
})
