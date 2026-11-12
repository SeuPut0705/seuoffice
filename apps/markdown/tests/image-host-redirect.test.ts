// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { uploadImageToHost } from '../src/main/image-host'
import type { ImageHostConfig } from '../src/shared/ipc'
import {
  carriers,
  closeServers,
  collector,
  redirect,
  serve,
  type TestServer,
} from '../../../packages/ai-provider/tests/two-servers'

/**
 * An image upload carries the person's storage credential: an S3 signature,
 * the SM.MS token, a GitHub token. A followed redirect repeats the upload at
 * whatever address the answer names, so the upload stops at one.
 *
 * The hosts' addresses are https or fixed in the code, so the `fetchImpl` of
 * the test carries each request to a local server exactly as the upload built
 * it; the redirect is answered and handled by the real fetch and two real
 * servers.
 */

const SECRET = 'secret-host-token'
const IMAGE = Buffer.from('PRIVATE-IMAGE-BYTES')

afterEach(closeServers)

function carriedTo(host: TestServer) {
  return (url: string, init?: object) =>
    fetch(host.origin + new URL(url).pathname + new URL(url).search, init as RequestInit)
}

const hosts: [name: string, config: ImageHostConfig][] = [
  [
    'S3',
    {
      kind: 's3',
      endpoint: 'https://acc.r2.cloudflarestorage.com',
      bucket: 'notes',
      accessKeyId: SECRET,
      secretAccessKey: 'shhh',
    },
  ],
  ['SM.MS', { kind: 'smms', token: SECRET }],
  ['GitHub', { kind: 'github', token: SECRET, owner: 'ada', repo: 'notes' }],
]

describe('an image upload and a redirect', () => {
  it.each(hosts)(
    'stops a %s upload at the redirect and sends nothing on',
    async (_name, config) => {
      const other = await collector({
        success: true,
        data: { url: 'https://planted.example/a.png' },
        content: { download_url: 'https://planted.example/a.png' },
      })
      const host = await serve((seen, res) => redirect(res, 307, `${other.origin}${seen.path}`))

      const result = await uploadImageToHost(config, {
        bytes: IMAGE,
        ext: 'png',
        fetchImpl: carriedTo(host),
      })

      // neither the credential nor the picture reached the other party
      expect(other.seen).toEqual([])
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/redirect.*was not sent on/is)
      expect(result.url).toBeUndefined()
      expect(carriers(host.seen, SECRET)).toEqual(['authorization'])
    },
  )

  it('says what a GitHub redirect usually means', async () => {
    // GitHub answers a renamed or moved repository with a redirect to its new address
    const host = await serve((_seen, res) => redirect(res, 307, '/repositories/42/contents/x.png'))
    const result = await uploadImageToHost(hosts[2]![1], {
      bytes: IMAGE,
      ext: 'png',
      fetchImpl: carriedTo(host),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/renamed or moved/)
    expect(host.seen).toHaveLength(1)
  })

  it('still uploads when nothing redirects', async () => {
    const host = await collector({ content: { download_url: 'https://raw.example/ada/a.png' } })
    const result = await uploadImageToHost(hosts[2]![1], {
      bytes: IMAGE,
      ext: 'png',
      fetchImpl: carriedTo(host),
    })
    expect(result).toEqual({ ok: true, url: 'https://raw.example/ada/a.png' })
    expect(carriers(host.seen, SECRET)).toEqual(['authorization'])
  })
})
