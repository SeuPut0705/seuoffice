/**
 * GitHub addresses and connections for skills: the five accepted forms and
 * the refused ones, the three allowed hosts (redirects included), no
 * credentials, failure kinds, and the archive size cap. No network: `fetch`
 * is a fake.
 */
import { describe, expect, it } from 'vitest'
import {
  SkillImportError,
  downloadGitHubArchive,
  githubSkillGet,
  parseGitHubSkillAddress,
  resolveGitHubSkillAddress,
  type SkillFetch,
} from '../src/user-skills'

const SHA = 'a'.repeat(40)

interface Call {
  url: string
  init: RequestInit
}

function fake(handler: (url: URL) => Response | Promise<Response>): {
  fetch: SkillFetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetch: SkillFetch = async (url, init) => {
    calls.push({ url, init })
    return handler(new URL(url))
  }
  return { fetch, calls }
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SkillImportError) return error.kind
    throw error
  }
  return 'resolved'
}

describe('parseGitHubSkillAddress', () => {
  it('reads a repository address', () => {
    expect(parseGitHubSkillAddress('https://github.com/anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: undefined,
      path: '',
      skill: undefined,
      refPath: undefined,
    })
    expect(parseGitHubSkillAddress('  https://github.com/o/r.git/  ')).toMatchObject({
      owner: 'o',
      repo: 'r',
    })
    expect(parseGitHubSkillAddress('https://GitHub.com/o/r#readme')).toMatchObject({
      owner: 'o',
      repo: 'r',
      path: '',
    })
  })

  it('reads a tree address with a branch and a folder', () => {
    expect(parseGitHubSkillAddress('https://github.com/o/r/tree/main/skills/pdf')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'skills/pdf',
      skill: undefined,
      refPath: ['main', 'skills', 'pdf'],
    })
    expect(parseGitHubSkillAddress('https://github.com/o/r/tree/dev')).toMatchObject({
      ref: 'dev',
      path: '',
    })
    expect(parseGitHubSkillAddress('https://github.com/o/r/tree/main/my%20skill')).toMatchObject({
      path: 'my skill',
    })
  })

  it('reads a blob address of a SKILL.md as its folder', () => {
    expect(
      parseGitHubSkillAddress('https://github.com/o/r/blob/main/skills/pdf/SKILL.md'),
    ).toMatchObject({ ref: 'main', path: 'skills/pdf', refPath: ['main', 'skills', 'pdf'] })
    expect(parseGitHubSkillAddress('https://github.com/o/r/blob/main/SKILL.md')).toMatchObject({
      ref: 'main',
      path: '',
    })
  })

  it('reads owner/repo and owner/repo@skill', () => {
    expect(parseGitHubSkillAddress('o/r')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: undefined,
      path: '',
      skill: undefined,
      refPath: undefined,
    })
    expect(parseGitHubSkillAddress('some-org/skill.repo@meeting-minutes')).toMatchObject({
      owner: 'some-org',
      repo: 'skill.repo',
      skill: 'meeting-minutes',
    })
  })

  it.each([
    '',
    'http://github.com/o/r',
    'https://gitlab.com/o/r',
    'https://github.com.evil.example/o/r',
    'https://evil.example/github.com/o/r',
    'https://user@github.com/o/r',
    'https://github.com@evil.example/o/r',
    'https://github.com:8443/o/r',
    'https://www.github.com/o/r',
    'https://api.github.com/repos/o/r',
    'https://github.com/o/r?ref=main',
    'https://github.com/o/r/tree/main?x=1',
    'https://github.com/o',
    'https://github.com/o/r/pulls',
    'https://github.com/o/r/tree',
    'https://github.com/o/r/tree/main/../x',
    'https://github.com/o/r/tree/main/%2e%2e/x',
    'https://github.com/o/r/tree/main/a%2Fb',
    'https://github.com/o/r/tree/main/a%5Cb',
    'https://github.com/o/r/tree/main/a%00b',
    'https://github.com/o/r/tree/ma..in/x',
    'https://github.com/o/r/blob/main/README.md',
    'https://github.com/o/r/blob/SKILL.md',
    'https://github.com/o/r\\..\\x',
    'https://github.com/o/r/tree/main//x',
    'git@github.com:o/r.git',
    'github.com/o/r',
    'o/r/extra',
    'o/r@',
    'o/r@bad name',
    'o/r@a/b',
    '-o/r',
    'o-/r',
    'o/..',
    'o/.',
    'o r/x',
  ])('refuses %j', (input) => {
    expect(parseGitHubSkillAddress(input)).toBeUndefined()
  })
})

describe('githubSkillGet', () => {
  it('sends no credentials and checks every redirect by hand', async () => {
    const { fetch, calls } = fake((url) =>
      url.hostname === 'api.github.com'
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://codeload.github.com/o/r/zip/x' },
          })
        : new Response('ok'),
    )
    const response = await githubSkillGet('https://api.github.com/repos/o/r/zipball', '*/*', {
      fetch,
    })
    expect(await response.text()).toBe('ok')
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/o/r/zipball',
      'https://codeload.github.com/o/r/zip/x',
    ])
    for (const { init } of calls) {
      expect(init.redirect).toBe('manual')
      expect(init.credentials).toBe('omit')
      const headers = new Headers(init.headers)
      expect(headers.has('authorization')).toBe(false)
      expect(headers.has('cookie')).toBe(false)
    }
  })

  it.each([
    'https://evil.example/archive.zip',
    'http://codeload.github.com/o/r/zip/x',
    'https://codeload.github.com:444/o/r/zip/x',
    'https://user:pw@codeload.github.com/o/r/zip/x',
    'https://github.com.evil.example/x',
  ])('refuses a redirect to %s without requesting it', async (target) => {
    const { fetch, calls } = fake(
      () => new Response(null, { status: 301, headers: { location: target } }),
    )
    expect(await kindOf(githubSkillGet('https://github.com/o/r', '*/*', { fetch }))).toBe('unsafe')
    expect(calls).toHaveLength(1)
  })

  it('refuses to start at another host', async () => {
    const { fetch, calls } = fake(() => new Response('x'))
    expect(await kindOf(githubSkillGet('https://example.com/', '*/*', { fetch }))).toBe('unsafe')
    expect(calls).toHaveLength(0)
  })

  it('tells failures apart', async () => {
    const answer = (response: Response) => fake(() => response).fetch
    const get = (fetch: SkillFetch) =>
      kindOf(githubSkillGet('https://github.com/o/r', '*/*', { fetch }))
    expect(await get(answer(new Response('', { status: 404 })))).toBe('not-found')
    expect(await get(answer(new Response('', { status: 401 })))).toBe('not-found')
    expect(
      await get(
        answer(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })),
      ),
    ).toBe('rate-limited')
    expect(await get(answer(new Response('', { status: 429 })))).toBe('rate-limited')
    expect(await get(answer(new Response('', { status: 503 })))).toBe('network')
    expect(
      await get(async () => {
        throw new TypeError('fetch failed')
      }),
    ).toBe('network')
    const controller = new AbortController()
    controller.abort()
    expect(
      await kindOf(
        githubSkillGet('https://github.com/o/r', '*/*', {
          signal: controller.signal,
          fetch: async () => {
            throw new DOMException('aborted', 'AbortError')
          },
        }),
      ),
    ).toBe('cancelled')
  })
})

describe('resolveGitHubSkillAddress', () => {
  it('uses the default branch when none is given', async () => {
    const { fetch, calls } = fake((url) => {
      if (url.pathname === '/repos/o/r') return Response.json({ default_branch: 'trunk' })
      if (url.pathname === '/repos/o/r/commits/trunk') return new Response(`${SHA}\n`)
      return new Response('', { status: 404 })
    })
    const resolved = await resolveGitHubSkillAddress(parseGitHubSkillAddress('o/r@pdf')!, {
      fetch,
    })
    expect(resolved).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'trunk',
      path: '',
      commit: SHA,
      skill: 'pdf',
    })
    expect(new Headers(calls[1]!.init.headers).get('accept')).toBe('application/vnd.github.sha')
  })

  it('settles a branch name holding a slash', async () => {
    const { fetch, calls } = fake((url) =>
      url.pathname === '/repos/o/r/commits/feature/x'
        ? new Response(SHA)
        : new Response('', { status: 422 }),
    )
    const resolved = await resolveGitHubSkillAddress(
      parseGitHubSkillAddress('https://github.com/o/r/tree/feature/x/skills/a')!,
      { fetch },
    )
    expect(resolved).toMatchObject({ ref: 'feature/x', path: 'skills/a', commit: SHA })
    expect(calls).toHaveLength(2)
  })

  it('stops at once when GitHub is limiting requests', async () => {
    const { fetch, calls } = fake(() => new Response('', { status: 429 }))
    expect(
      await kindOf(
        resolveGitHubSkillAddress(parseGitHubSkillAddress('https://github.com/o/r/tree/a/b/c')!, {
          fetch,
        }),
      ),
    ).toBe('rate-limited')
    expect(calls).toHaveLength(1)
  })

  it('refuses an answer that is not a commit', async () => {
    const { fetch } = fake(() => new Response('<html>'))
    expect(
      await kindOf(
        resolveGitHubSkillAddress(parseGitHubSkillAddress('https://github.com/o/r/tree/main')!, {
          fetch,
        }),
      ),
    ).toBe('network')
  })
})

describe('downloadGitHubArchive', () => {
  it('downloads the commit archive from codeload', async () => {
    const { fetch, calls } = fake(() => new Response(new Uint8Array([1, 2, 3])))
    const bytes = await downloadGitHubArchive('o', 'r', SHA, { fetch })
    expect([...bytes]).toEqual([1, 2, 3])
    expect(calls[0]!.url).toBe(`https://codeload.github.com/o/r/zip/${SHA}`)
  })

  it('refuses an archive over the cap by its declared length', async () => {
    const { fetch } = fake(
      () => new Response('x', { headers: { 'content-length': String(51 * 1024 * 1024) } }),
    )
    expect(await kindOf(downloadGitHubArchive('o', 'r', SHA, { fetch }))).toBe('too-large')
  })

  it('stops reading once the cap is passed', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(400))
      },
    })
    const { fetch } = fake(() => new Response(body))
    expect(await kindOf(downloadGitHubArchive('o', 'r', SHA, { fetch, maxBytes: 1000 }))).toBe(
      'too-large',
    )
    expect(pulled).toBeLessThan(10)
  })
})
