import { describe, expect, it } from 'vitest'
import { SIDEBAR_OPEN_KEY, loadSidebarOpen, saveSidebarOpen } from '../src/renderer/view-config'

describe('sidebar open state', () => {
  it('remembers a closed sidebar, open by default', () => {
    const mem = new Map<string, string>()
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    }
    expect(loadSidebarOpen(storage)).toBe(true)
    saveSidebarOpen(false, storage)
    expect(mem.get(SIDEBAR_OPEN_KEY)).toBe('0')
    expect(loadSidebarOpen(storage)).toBe(false)
    saveSidebarOpen(true, storage)
    expect(loadSidebarOpen(storage)).toBe(true)
  })

  it('opens and keeps working when storage is unavailable', () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error('denied')
      },
      setItem: (): void => {
        throw new Error('denied')
      },
    }
    expect(loadSidebarOpen(storage)).toBe(true)
    expect(() => saveSidebarOpen(false, storage)).not.toThrow()
  })
})
