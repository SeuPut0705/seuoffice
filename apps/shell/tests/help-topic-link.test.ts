import { describe, expect, it } from 'vitest'
import { HELP_TOPICS, initialHelpTopic } from '../src/renderer/src/i18n/help/help-registry'

/**
 * A help link next to a setting (Settings → Skills) opens the manual at its
 * topic: the main process puts the id in the manual's URL and the screen
 * starts there. A missing or unknown id opens the manual as F1 does.
 */
describe('the topic the manual opens at', () => {
  it('starts at the topic the URL names', () => {
    expect(initialHelpTopic('?mode=help&topic=skills')).toBe('skills')
    expect(initialHelpTopic('?mode=help&topic=agent-mode')).toBe('agent-mode')
  })

  it('falls back to the first topic without a known one', () => {
    expect(initialHelpTopic('?mode=help')).toBe(HELP_TOPICS[0]!.id)
    expect(initialHelpTopic('?mode=help&topic=nope')).toBe(HELP_TOPICS[0]!.id)
  })
})
