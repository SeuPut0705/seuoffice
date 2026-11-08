import { describe, expect, it, vi } from 'vitest'

// The module stamps live renderers through `webContents`; only the import has
// to resolve here, as in tests/ui-scale.test.ts.
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => [] } }))

const { parseCursorBaseSize, readPointerSize } = await import('../src/main/pointer-size')

const regOutput = (value: string): string =>
  `\r\nHKEY_CURRENT_USER\\Control Panel\\Cursors\r\n    CursorBaseSize    REG_DWORD    ${value}\r\n\r\n`

describe('pointer size from the Windows setting', () => {
  it('reads the DWORD reg prints in hex', () => {
    expect(parseCursorBaseSize(regOutput('0x20'))).toBe(32)
    expect(parseCursorBaseSize(regOutput('0x100'))).toBe(256)
  })

  it('treats a missing or implausible value as no setting', () => {
    expect(parseCursorBaseSize('')).toBeNull()
    expect(parseCursorBaseSize(regOutput('0x0'))).toBeNull()
    expect(parseCursorBaseSize(regOutput('0x10000'))).toBeNull()
    expect(parseCursorBaseSize(regOutput('big'))).toBeNull()
  })

  it('asks reg for the current user key, without a shell', async () => {
    const run = vi.fn(async () => regOutput('0x60'))
    expect(await readPointerSize(run, 'win32')).toBe(96)
    expect(run).toHaveBeenCalledWith('reg', [
      'query',
      'HKCU\\Control Panel\\Cursors',
      '/v',
      'CursorBaseSize',
    ])
  })

  it('answers null when reg fails or off Windows', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ERROR: The system was unable to find the specified registry key or value.')
    })
    expect(await readPointerSize(failing, 'win32')).toBeNull()
    const run = vi.fn(async () => regOutput('0x40'))
    expect(await readPointerSize(run, 'darwin')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})
