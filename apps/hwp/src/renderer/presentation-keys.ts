import { presentationKeyOf, type PresentationKey, type PresentationKeyInput } from '@genoffice/ui'

/**
 * Hancom's F5 opens a cell block and its Shift+F5 a block that grows by the arrow
 * keys, so only Ctrl+F5 (Cmd+F5 on a Mac) starts the show here. F5 and Esc still
 * end it.
 */
export function hwpPresentationKeyOf(
  input: PresentationKeyInput,
  presenting: boolean,
): PresentationKey | null {
  const action = presentationKeyOf(input, presenting)
  if (action === 'exit') return action
  if (!action || input.shiftKey || !(input.ctrlKey || input.metaKey)) return null
  return action
}
