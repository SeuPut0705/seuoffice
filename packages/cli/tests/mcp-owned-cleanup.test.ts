import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileStore } from '../src/mcp/files'
import { tempDir } from './helpers'

describe('FileStore expires only directories it created for uploads', () => {
  it.each(['prefix', 'unowned-child', 'dot-segment'])(
    'keeps exposed output in a %s directory',
    (kind) => {
      const root = join(tempDir(), 'store')
      const store = new FileStore(root, 10)
      const dir =
        kind === 'prefix'
          ? join(root, 'uploads-keep')
          : kind === 'unowned-child'
            ? join(root, 'uploads', 'custom-output')
            : join(root, 'retained')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'report.docx')
      const canary = join(dir, 'unrelated.txt')
      writeFileSync(file, 'report')
      writeFileSync(canary, 'keep')
      // Every path is in this test's fresh temporary root.
      expect(resolve(dir).startsWith(resolve(root) + sep)).toBe(true)
      const exposed =
        kind === 'dot-segment'
          ? join(root, 'uploads') + sep + '..' + sep + 'retained' + sep + 'report.docx'
          : file
      try {
        const entry = store.expose(exposed)
        store.sweep(Date.now() + 100)
        expect(store.get(entry.id)).toBeUndefined()
        expect(readFileSync(file, 'utf-8')).toBe('report')
        expect(readFileSync(canary, 'utf-8')).toBe('keep')
      } finally {
        store.dispose()
      }
    },
  )

  it('removes an expired owned upload without removing another live upload', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = new FileStore(join(tempDir(), 'store'), 10)
    try {
      const old = store.uploadTarget('old.docx')
      writeFileSync(old, 'old')
      const entry = store.expose(old)
      vi.setSystemTime(1005)
      const live = store.uploadTarget('live.docx')
      writeFileSync(live, 'live')
      const keep = store.expose(live)
      store.sweep(1011)
      expect(store.get(entry.id)).toBeUndefined()
      expect(existsSync(dirname(old))).toBe(false)
      expect(store.get(keep.id)?.path).toBe(live)
      expect(readFileSync(live, 'utf-8')).toBe('live')
    } finally {
      store.dispose()
      vi.useRealTimers()
    }
  })

  it('cleans a vanished owned upload directory when get drops its entry', () => {
    const store = new FileStore(join(tempDir(), 'store'), 10)
    try {
      const file = store.uploadTarget('gone.docx')
      writeFileSync(file, 'gone')
      writeFileSync(join(dirname(file), 'receipt.txt'), 'owned auxiliary file')
      const entry = store.expose(file)
      unlinkSync(file)
      expect(store.get(entry.id)).toBeUndefined()
      expect(existsSync(dirname(file))).toBe(false)
    } finally {
      store.dispose()
    }
  })

  it('keeps an ordinary external output when its entry expires', () => {
    const dir = tempDir()
    const file = join(dir, 'original.docx')
    writeFileSync(file, 'original')
    const store = new FileStore(join(dir, 'store'), 10)
    try {
      store.expose(file)
      store.sweep(Date.now() + 100)
      expect(readFileSync(file, 'utf-8')).toBe('original')
    } finally {
      store.dispose()
    }
  })
})
