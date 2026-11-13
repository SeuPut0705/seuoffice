/**
 * An ODT cannot hold the mark that hides content from AI: a marked run written
 * into one reads as plain words to every reader. The editors that write ODT
 * (Word, HTML, Markdown) refuse to write marked content as ODT and offer the
 * two ways out, asked in one message box: save as Word instead, or clear the
 * marks and write the ODT. Kept free of Electron: the box is described here and
 * shown by the app's main process.
 */

export type MarkedOdtChoice = 'docx' | 'clear' | 'cancel'

/** the words of the box, in the app's language */
export interface MarkedOdtText {
  title: string
  message: string
  detail: string
  /** absent: the app's Word export cannot keep the hiding either, so Word is not offered */
  saveDocx?: string
  clearMarks: string
  cancel: string
}

export interface MarkedOdtBox {
  type: 'warning'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: 0
  cancelId: number
  noLink: true
}

export function markedOdtBox(text: MarkedOdtText): MarkedOdtBox {
  const buttons =
    text.saveDocx === undefined
      ? [text.clearMarks, text.cancel]
      : [text.saveDocx, text.clearMarks, text.cancel]
  return {
    type: 'warning',
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  }
}

/**
 * the button pressed in `markedOdtBox` (`withDocx`: Word was offered); anything
 * else (closing the box) is a cancel
 */
export function markedOdtChoice(response: number, withDocx = true): MarkedOdtChoice {
  if (!withDocx) return response === 0 ? 'clear' : 'cancel'
  return response === 0 ? 'docx' : response === 1 ? 'clear' : 'cancel'
}
