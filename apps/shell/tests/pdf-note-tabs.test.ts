// @vitest-environment node
/**
 * The note of each PDF in the shell (reading-assist spec 4.9): open brings
 * the note's Markdown tab forward or opens the file in a new one; insert does
 * the same and then queues the text for that tab (never writing the file).
 * Only an existing absolute .md path is accepted.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  insertIntoNoteTab,
  isNoteFile,
  openNoteTab,
  type NoteTabHost,
} from '../src/main/pdf-note-tabs'
import type { NoteAppendContents } from '../../markdown/src/main/note-append'

function contents(id: number): NoteAppendContents & { sent: string[] } {
  const sent: string[] = []
  return {
    id,
    sent,
    isDestroyed: () => false,
    once: () => undefined,
    send: (channel: string) => void sent.push(channel),
  }
}

function note(name = 'Paper 노트.md', text = '# Paper\n'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'shell-note-')), name)
  writeFileSync(path, text)
  return path
}

function host(existing?: NoteAppendContents) {
  const opened = contents(2)
  const calls: string[] = []
  const h: NoteTabHost = {
    focusExisting: (path) => {
      calls.push(`focus:${path}`)
      return existing
    },
    openNew: (path) => {
      calls.push(`open:${path}`)
      return opened
    },
  }
  return { h, calls, opened }
}

describe('isNoteFile', () => {
  it('accepts an existing absolute .md file only', () => {
    const path = note()
    expect(isNoteFile(path)).toBe(true)
    expect(isNoteFile(path.replace(/\.md$/, '.txt'))).toBe(false)
    expect(isNoteFile('relative.md')).toBe(false)
    expect(isNoteFile(join(tmpdir(), 'missing-note-xyz.md'))).toBe(false)
    expect(isNoteFile(42)).toBe(false)
  })
})

describe('openNoteTab', () => {
  it('brings an open note tab forward without opening another', () => {
    const path = note()
    const tab = contents(1)
    const { h, calls } = host(tab)
    expect(openNoteTab(h, path)).toBe(tab)
    expect(calls).toEqual([`focus:${path}`])
  })

  it('opens the note in a new Markdown tab when none shows it', () => {
    const path = note()
    const { h, calls, opened } = host()
    expect(openNoteTab(h, path)).toBe(opened)
    expect(calls).toEqual([`focus:${path}`, `open:${path}`])
  })

  it('refuses a path that is not an existing note file', () => {
    const { h, calls } = host()
    expect(openNoteTab(h, join(tmpdir(), 'no-such-note.md'))).toBeNull()
    expect(openNoteTab(h, note('x.pdf'))).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('insertIntoNoteTab', () => {
  it('opens or activates the tab, then delivers the text to it; the file stays as it was', () => {
    const path = note()
    const tab = contents(7)
    const { h, calls } = host(tab)
    const queue = vi.fn()
    expect(insertIntoNoteTab(h, path, '> quote', queue)).toBe(true)
    expect(calls).toEqual([`focus:${path}`])
    expect(queue).toHaveBeenCalledWith(tab, path, '> quote')
    expect(readFileSync(path, 'utf8')).toBe('# Paper\n')
  })

  it('delivers to a newly opened tab through the real queue (with the nudge)', () => {
    const path = note()
    const { h, opened } = host()
    expect(insertIntoNoteTab(h, path, '> quote')).toBe(true)
    expect(opened.sent).toEqual(['markdown:note-append-ready'])
  })

  it('does nothing for blank text or a refused path', () => {
    const { h, calls } = host()
    const queue = vi.fn()
    expect(insertIntoNoteTab(h, note(), '  ', queue)).toBe(false)
    expect(insertIntoNoteTab(h, 'C:relative.md', 'x', queue)).toBe(false)
    expect(queue).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

describe('shell wiring', () => {
  it('injects both note calls into the pdf runtime through this module', () => {
    const index = readFileSync(
      fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
      'utf8',
    )
    const config = index.slice(index.indexOf('configurePdfRuntime({'))
    const block = config.slice(0, config.indexOf('})'))
    expect(block).toMatch(/openNote: \(path\) => openNoteTab\(noteTabHost, path\) !== null/)
    expect(block).toMatch(
      /insertIntoNote: \(path, text\) => insertIntoNoteTab\(noteTabHost, path, text\)/,
    )
    expect(index).toMatch(/findMarkdownTabByPath\(path\)/)
    expect(index).toMatch(/openMarkdownTab\(path\)/)
  })
})
