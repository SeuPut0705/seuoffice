import { describe, expect, it } from 'vitest'
import { seededStudioSettings, studioLocale, studioUrl } from '../src/renderer/studio-settings'

describe('seededStudioSettings', () => {
  it('turns the recovery drafts off and follows the app theme on a first run', () => {
    expect(JSON.parse(seededStudioSettings(null, 'dark'))).toEqual({
      theme: { mode: 'dark' },
      autosave: { recoveryEnabled: false, idleSaveEnabled: false },
    })
  })

  it('keeps what the editor stored itself', () => {
    const stored = JSON.stringify({
      version: 3,
      theme: { mode: 'light', skin: 'flat', skinChosen: true },
      view: { toolbarFormat: false },
      autosave: { recoveryEnabled: true, recoveryIntervalMinutes: 10, idleSaveEnabled: true },
    })
    expect(JSON.parse(seededStudioSettings(stored, 'system'))).toEqual({
      version: 3,
      theme: { mode: 'system', skin: 'flat', skinChosen: true },
      view: { toolbarFormat: false },
      autosave: { recoveryEnabled: false, recoveryIntervalMinutes: 10, idleSaveEnabled: false },
    })
  })

  it('starts over from a value that is not a settings object', () => {
    for (const broken of ['not json', '[]', '"text"', 'null']) {
      expect(JSON.parse(seededStudioSettings(broken, 'light'))).toEqual({
        theme: { mode: 'light' },
        autosave: { recoveryEnabled: false, idleSaveEnabled: false },
      })
    }
  })
})

describe('studio locale and url', () => {
  it('uses Korean for Korean and English for every other UI language', () => {
    expect(studioLocale('ko')).toBe('ko')
    expect(studioLocale('en')).toBe('en')
    expect(studioLocale('ja')).toBe('en')
    expect(studioLocale('zh-TW')).toBe('en')
  })

  it('always asks for the embed profile, so the editor cannot swap the tab document', () => {
    expect(studioUrl('ko')).toBe('./studio/index.html?chrome=embed&lang=ko')
    expect(studioUrl('fr')).toBe('./studio/index.html?chrome=embed&lang=en')
  })
})
