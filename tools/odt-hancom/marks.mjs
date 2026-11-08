// The texts the edited copies carry, so Hangul's reading can be searched for them.
export const MARK_TEXT = {
  text: '이음글자검증',
  para: '이음오피스검증문단',
  cell: '검증채움',
  header: '이음머리검증',
  footnote: '이음각주검증',
  field: '이음누름틀값',
}

/** The new paragraph's whole text (para kind). */
export const PARA_TEXT = `${MARK_TEXT.para} 둘 ABC 123`

/** Marks hancom.py looks up with --marks, by kind. */
export const LOOK_MARKS = { text: [MARK_TEXT.text], para: [MARK_TEXT.para] }
