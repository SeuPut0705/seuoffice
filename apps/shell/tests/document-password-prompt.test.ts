import { describe, expect, it, vi } from 'vitest'
import { createDocumentPasswordPrompt } from '../src/main/document-password-prompt'

function fakeWindow() {
  const shown: string[] = []
  let answer: ((value: string | null) => void) | null = null
  const window = {
    prompt: vi.fn((fileName: string) => {
      shown.push(fileName)
      return new Promise<string | null>((resolve) => {
        answer = resolve
      })
    }),
    close: vi.fn(),
  }
  return { window, shown, answer: (value: string | null) => answer?.(value) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createDocumentPasswordPrompt', () => {
  it('lets a second file wait until the first prompt closes', async () => {
    const { window, shown, answer } = fakeWindow()
    const first = createDocumentPasswordPrompt(window, 'a.xlsx')
    const second = createDocumentPasswordPrompt(window, 'b.pptx')
    const firstAnswer = first.ask(false)
    const secondAnswer = second.ask(false)
    await tick()
    expect(shown).toEqual(['a.xlsx'])
    answer('pw-a')
    expect(await firstAnswer).toBe('pw-a')
    first.close()
    await tick()
    expect(shown).toEqual(['a.xlsx', 'b.pptx'])
    answer('pw-b')
    expect(await secondAnswer).toBe('pw-b')
    second.close()
    expect(window.close).toHaveBeenCalledTimes(2)
  })

  it('does not close the window for a prompt that never showed', async () => {
    const { window } = fakeWindow()
    const prompt = createDocumentPasswordPrompt(window, 'quiet.xls')
    prompt.close()
    prompt.close()
    expect(window.close).not.toHaveBeenCalled()
    expect(await prompt.ask(false)).toBeNull()
    expect(window.prompt).not.toHaveBeenCalled()
    // the slot was released: the next prompt shows right away
    const next = createDocumentPasswordPrompt(window, 'next.xlsx')
    void next.ask(false)
    await tick()
    expect(window.prompt).toHaveBeenCalledTimes(1)
    next.close()
  })
})
