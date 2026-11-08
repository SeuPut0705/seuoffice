/**
 * Whether the annotation panel runs inside the shell (reading-assist spec
 * 4.3, 6): the result store channel exists only there, so a cheap probe of it
 * decides whether a Word document can be made. The probe reads nothing and
 * writes nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { probeShellHost } from '../src/renderer/annot-panel/host-capability'

describe('probeShellHost', () => {
  it('sees the shell when the store channel answers, even with a refusal', async () => {
    const passages = vi.fn(async () => ({ ok: false as const, error: 'not-granted' as const }))
    await expect(probeShellHost({ passages })).resolves.toBe(true)
    expect(passages).toHaveBeenCalledWith('')
  })

  it('sees a standalone window when the store channel is not available', async () => {
    const passages = vi.fn(async () => ({ ok: false as const, error: 'not-available' as const }))
    await expect(probeShellHost({ passages })).resolves.toBe(false)
  })

  it('sees a standalone window when there is no store or the call fails', async () => {
    await expect(probeShellHost(null)).resolves.toBe(false)
    await expect(
      probeShellHost({ passages: vi.fn(async () => Promise.reject(new Error('no handler'))) }),
    ).resolves.toBe(false)
  })
})
