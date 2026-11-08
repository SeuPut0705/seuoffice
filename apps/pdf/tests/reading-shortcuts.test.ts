/**
 * Selection-bar shortcuts (reading-assist spec 4.1, 10.1): each key, the same
 * physical key under a Korean input method, and the cases that must be left
 * alone (composing, focus in a field, a modifier, a document that cannot be
 * edited).
 */
import { describe, expect, it } from 'vitest'
import { createI18n } from '@genoffice/i18n'
import { strings } from '../src/renderer/i18n/strings'
import {
  labelWithKey,
  selectionBarKey,
  type SelectionBarKeyEvent,
} from '../src/renderer/reading/shortcuts'

const key = (code: string, over: Partial<SelectionBarKeyEvent> = {}): SelectionBarKeyEvent => ({
  code,
  key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  target: document.body,
  ...over,
})

const editable = { visible: true, readOnly: false }

describe('selection-bar shortcuts', () => {
  it.each([
    ['KeyH', 'highlight'],
    ['KeyU', 'underline'],
    ['KeyS', 'strikeout'],
    ['KeyN', 'note'],
    ['KeyE', 'explain'],
    ['KeyT', 'translate'],
    ['Enter', 'ask'],
    ['NumpadEnter', 'ask'],
  ])('%s runs %s', (code, action) => {
    expect(selectionBarKey(key(code), editable)).toEqual({ action })
  })

  it('judges by the physical key: a Korean input method gives the same actions', () => {
    // with the 2-set Korean layout active, KeyH types ㅗ, KeyE ㄷ, KeyT ㅅ
    expect(selectionBarKey(key('KeyH', { key: 'ㅗ' }), editable)).toEqual({ action: 'highlight' })
    expect(selectionBarKey(key('KeyE', { key: 'ㄷ' }), editable)).toEqual({ action: 'explain' })
    expect(selectionBarKey(key('KeyT', { key: 'ㅅ' }), editable)).toEqual({ action: 'translate' })
  })

  it('leaves other keys alone', () => {
    expect(selectionBarKey(key('KeyA'), editable)).toBeNull()
    expect(selectionBarKey(key('Space', { key: ' ' }), editable)).toBeNull()
    expect(selectionBarKey(key('Escape'), editable)).toBeNull()
  })

  it('does nothing while the bar is hidden', () => {
    expect(selectionBarKey(key('KeyH'), { visible: false, readOnly: false })).toBeNull()
  })

  it('ignores a key while an input method is composing', () => {
    expect(selectionBarKey(key('KeyH', { isComposing: true }), editable)).toBeNull()
    expect(selectionBarKey(key('KeyH', { key: 'Process' }), editable)).toBeNull()
  })

  it('ignores Ctrl, Alt and Meta combinations and held-down repeats', () => {
    expect(selectionBarKey(key('KeyS', { ctrlKey: true }), editable)).toBeNull()
    expect(selectionBarKey(key('KeyH', { altKey: true }), editable)).toBeNull()
    expect(selectionBarKey(key('KeyT', { metaKey: true }), editable)).toBeNull()
    expect(selectionBarKey(key('KeyH', { repeat: true }), editable)).toBeNull()
  })

  it('ignores keys typed into an input, a textarea or an editable region', () => {
    const input = document.createElement('input')
    const area = document.createElement('textarea')
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    host.appendChild(inner)
    for (const target of [input, area, host, inner]) {
      expect(selectionBarKey(key('KeyH', { target }), editable)).toBeNull()
      expect(selectionBarKey(key('Enter', { target }), editable)).toBeNull()
    }
  })

  it('leaves Enter to a focused button or link', () => {
    const button = document.createElement('button')
    const link = document.createElement('a')
    link.href = '#x'
    expect(selectionBarKey(key('Enter', { target: button }), editable)).toBeNull()
    expect(selectionBarKey(key('Enter', { target: link }), editable)).toBeNull()
    // letter keys still reach the bar while a button has focus (no native meaning there)
    expect(selectionBarKey(key('KeyE', { target: button }), editable)).toEqual({
      action: 'explain',
    })
  })

  it('refuses file edits on a document that cannot be edited, and keeps the rest', () => {
    const ro = { visible: true, readOnly: true }
    for (const [code, action] of [
      ['KeyH', 'highlight'],
      ['KeyU', 'underline'],
      ['KeyS', 'strikeout'],
      ['KeyN', 'note'],
    ] as const) {
      expect(selectionBarKey(key(code), ro)).toEqual({ blocked: action, reason: 'read-only' })
    }
    expect(selectionBarKey(key('KeyE'), ro)).toEqual({ action: 'explain' })
    expect(selectionBarKey(key('KeyT'), ro)).toEqual({ action: 'translate' })
    expect(selectionBarKey(key('Enter'), ro)).toEqual({ action: 'ask' })
  })

  it('names the key in tooltips and accessible names', () => {
    const translate = createI18n(strings)
    const ko = (k: 'rdWithKey', p: { label: string; key: string }) => translate('ko', k, p)
    const en = (k: 'rdWithKey', p: { label: string; key: string }) => translate('en', k, p)
    expect(labelWithKey(ko, strings.ko.highlight, 'highlight')).toBe('형광펜 (H)')
    expect(labelWithKey(en, 'Ask AI', 'ask')).toBe('Ask AI (Enter)')
  })
})
