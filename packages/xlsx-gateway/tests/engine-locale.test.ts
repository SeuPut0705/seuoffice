import { describe, expect, it } from 'vitest'
import { engineLocaleFor } from '../src/shared/engine-locale'

describe('engineLocaleFor', () => {
  it('reads a system tag down to the code the engine keys its tables by', () => {
    expect(engineLocaleFor('ja-JP')).toBe('ja')
    expect(engineLocaleFor('ja')).toBe('ja')
    expect(engineLocaleFor('ko_KR')).toBe('ko')
    expect(engineLocaleFor('de-DE')).toBe('de')
    expect(engineLocaleFor('pt-BR')).toBe('pt')
    expect(engineLocaleFor(' NL-nl ')).toBe('nl')
  })

  it('reads the tags a browser reports, region and all', () => {
    expect(engineLocaleFor('ko-KR')).toBe('ko')
    expect(engineLocaleFor('en-US')).toBe('en')
    expect(engineLocaleFor('ja-JP')).toBe('ja')
    expect(engineLocaleFor('zh-CN')).toBe('zh')
    expect(engineLocaleFor('zh-TW')).toBe('zh-TW')
    expect(engineLocaleFor('xx-XX')).toBe('en')
  })

  it('tells traditional-script Chinese from simplified', () => {
    expect(engineLocaleFor('zh-CN')).toBe('zh')
    expect(engineLocaleFor('zh')).toBe('zh')
    expect(engineLocaleFor('zh-Hans')).toBe('zh')
    expect(engineLocaleFor('zh-TW')).toBe('zh-TW')
    expect(engineLocaleFor('zh_HK')).toBe('zh-TW')
    expect(engineLocaleFor('zh-Hant-MO')).toBe('zh-TW')
  })

  it('reads the legacy codes some systems report for Indonesian and Hebrew', () => {
    expect(engineLocaleFor('in')).toBe('id')
    expect(engineLocaleFor('in_ID')).toBe('id')
    expect(engineLocaleFor('iw-IL')).toBe('he')
  })

  it('reads a language the engine has no code for, and no value, as English', () => {
    expect(engineLocaleFor('sv-SE')).toBe('en')
    expect(engineLocaleFor('en-GB')).toBe('en')
    expect(engineLocaleFor('india')).toBe('en')
    expect(engineLocaleFor('')).toBe('en')
    expect(engineLocaleFor(null)).toBe('en')
    expect(engineLocaleFor(undefined)).toBe('en')
  })
})
