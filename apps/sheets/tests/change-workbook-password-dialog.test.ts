/** @vitest-environment jsdom */
/**
 * Review › Change Password: the dialog refuses a password Excel could not take
 * and says so, before anything is asked of the main process.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'

import { ChangeWorkbookPasswordDialog } from '../src/renderer/ChangeWorkbookPasswordDialog'
import { strings } from '../src/renderer/i18n/strings'
import { WORKBOOK_PASSWORD_MAX_LENGTH } from '../src/shared/desktop-api'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function type(input: HTMLInputElement, value: string): void {
  // React tracks the value through the element's own setter
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** type the password twice and press the dialog's button */
async function submitPassword(password: string, onSubmit: (password: string) => Promise<null>) {
  act(() => root.render(createElement(ChangeWorkbookPasswordDialog, { onSubmit, onClose() {} })))
  const [first, second] = [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')]
  type(first!, password)
  type(second!, password)
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button.primary-action')!.click()
  })
  return host.querySelector('[role="alert"]')?.textContent ?? null
}

describe('the new password length', () => {
  it('is Excel’s limit', () => {
    expect(WORKBOOK_PASSWORD_MAX_LENGTH).toBe(255)
  })

  it('one character over is refused in the dialog, with the limit in the message', async () => {
    const onSubmit = vi.fn(async () => null)
    const shown = await submitPassword('x'.repeat(WORKBOOK_PASSWORD_MAX_LENGTH + 1), onSubmit)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(shown).toContain('255')
    expect(shown).toContain('Excel')
  })

  it('the longest allowed password is sent on', async () => {
    const onSubmit = vi.fn(async () => null)
    const password = 'x'.repeat(WORKBOOK_PASSWORD_MAX_LENGTH)
    expect(await submitPassword(password, onSubmit)).toBeNull()
    expect(onSubmit).toHaveBeenCalledWith(password)
  })

  it('has its message in every language, each naming the limit', () => {
    const messages = Object.entries(strings).map(([lang, table]) => [
      lang,
      (table as Record<string, string>).appPasswordTooLong,
    ])
    expect(messages.map(([lang]) => lang).sort()).toEqual([...LANGS].sort())
    for (const [lang, message] of messages) {
      expect(message, lang).toContain('{max}')
      expect(message, lang).toContain('Excel')
    }
  })
})
