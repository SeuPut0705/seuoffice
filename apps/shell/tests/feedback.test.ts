import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import {
  FEEDBACK_STRINGS,
  FEEDBACK_SURVEY_URL,
  feedbackDetails,
  feedbackText,
  platformLabel,
} from '../src/main/feedback'

/**
 * Fixed by reading the source (index.ts needs a running Electron): the
 * feedback entry is in whatever Help menu is installed, the survey is the only
 * thing the app opens, and the diagnostics carry version, OS and language and
 * nothing about the user's documents.
 */

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const index = src('../src/main/index.ts')

describe('feedback strings', () => {
  const keys = Object.keys(FEEDBACK_STRINGS.zh).sort()

  it('fills every key in all 21 languages', () => {
    expect(LANGS).toHaveLength(21)
    for (const lang of LANGS) {
      const dict = FEEDBACK_STRINGS[lang] as Record<string, string>
      expect(Object.keys(dict).sort(), lang).toEqual(keys)
      for (const key of keys) expect(dict[key].trim(), `${lang}.${key}`).not.toBe('')
    }
  })

  it('keeps the details placeholders in every language', () => {
    for (const lang of LANGS) {
      const dict = FEEDBACK_STRINGS[lang] as Record<string, string>
      for (const token of ['{version}', '{os}', '{language}'])
        expect(dict.details, `${lang}.details`).toContain(token)
    }
  })

  it('never types the product name', () => {
    expect(JSON.stringify(FEEDBACK_STRINGS)).not.toMatch(/IeumOffice|이음오피스|GenOffice/)
  })
})

describe('the diagnostics block', () => {
  it('carries version, OS and language, and substitutes every placeholder', () => {
    const text = feedbackDetails('en', {
      version: '0.12.1',
      os: 'Windows 10.0.22631',
      language: 'en',
    })
    expect(text).toContain('0.12.1')
    expect(text).toContain('Windows 10.0.22631')
    expect(text).toContain('en')
    expect(text).not.toMatch(/\{[a-z]+\}/)
  })

  it('names the three platforms the desktop app runs on', () => {
    expect(platformLabel('win32')).toBe('Windows')
    expect(platformLabel('darwin')).toBe('macOS')
    expect(platformLabel('linux')).toBe('Linux')
    expect(platformLabel('freebsd')).toBe('freebsd')
  })

  it('uses the same text as the strings the dialog renders', () => {
    expect(feedbackText('ko', 'btnCancel')).toBe(FEEDBACK_STRINGS.ko.btnCancel)
  })
})

describe('the survey address', () => {
  it('is the published Google Form, not a repository or a local path', () => {
    expect(FEEDBACK_SURVEY_URL).toMatch(/^https:\/\/(docs\.google\.com\/forms\/d\/e\/|forms\.gle\/)/)
    expect(FEEDBACK_SURVEY_URL).not.toMatch(/REPLACE|example\.com/)
    expect(FEEDBACK_SURVEY_URL).not.toMatch(/github\.com/)
    expect(FEEDBACK_SURVEY_URL).not.toMatch(/[\\/](Users|home)[\\/]/)
  })
})

describe('the shell wiring', () => {
  it('offers the feedback entry from whatever Help menu is installed', () => {
    expect(index).toMatch(/withHelpItems\(\)/)
    expect(index).toContain('FEEDBACK_MENU_ID')
    expect(index).toMatch(/id: FEEDBACK_MENU_ID/)
    expect(index).toMatch(/click: \(\) => void openFeedbackSurvey\(\)/)
  })

  it('copies the details and opens only the survey', () => {
    expect(index).toMatch(/clipboard\.writeText\(detail\)/)
    expect(index).toMatch(/shell\.openExternal\(FEEDBACK_SURVEY_URL\)/)
    expect(index).toMatch(/HOME_CHANNELS\.openFeedbackSurvey/)
  })

  it('exposes the entry through preload for Settings → About', () => {
    expect(src('../src/preload/index.ts')).toMatch(/openFeedbackSurvey\(\)/)
    expect(src('../src/shared/home-api.ts')).toMatch(/openFeedbackSurvey/)
    expect(src('../src/renderer/src/SettingsModal.tsx')).toMatch(
      /window\.aiOffice\.openFeedbackSurvey/,
    )
  })
})
