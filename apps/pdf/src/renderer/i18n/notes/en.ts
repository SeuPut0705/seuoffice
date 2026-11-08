import type { zh } from './zh'

export const en = {
  ntOpen: 'Open note',
  ntOpenTip: 'Open the Markdown note linked to this PDF',
  ntInsert: 'Add to note',
  ntInsertTip: 'Put this at the end of the note. Save it in the note tab',
  ntSaveFirst: 'Save the PDF first',
  ntUnavailable: 'Notes open only inside the GenOffice app',
  ntFailed: 'The note could not be opened. {reason}',
  ntInserted: 'Added to the note',
} satisfies Record<keyof typeof zh, string>
