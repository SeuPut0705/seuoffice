/**
 * Content a person marked "hidden from AI" in an HTML page (the redactor's three
 * marks: `data-gx-redact` on an element, `data-gx-redact-<attr>` beside an
 * attribute, `/*gx:redact:label*\/` before a script literal). An ODT cannot keep
 * the hiding, so the ODT export refuses marked pages and offers the two ways
 * out: Word instead, or the marks cleared for the copy that is exported (the
 * page itself keeps them).
 */

/** the same test the redactor and the skill-template check start with */
const ANY_MARK = /data-gx-redact|gx:redact:/i

export function holdsHiddenMarks(html: string): boolean {
  return ANY_MARK.test(html)
}

const ATTRIBUTE_MARK = /\sdata-gx-redact(?:-[\w:.-]+)?(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?/gi
const SCRIPT_MARK = /\/\*\s*gx:redact:[^]*?\*\//gi

/** the page as it is with every mark taken off; throws when a trace is left, so a copy never claims to be clear when it is not */
export function clearHiddenMarks(html: string): string {
  const cleared = html.replace(ATTRIBUTE_MARK, '').replace(SCRIPT_MARK, '')
  if (holdsHiddenMarks(cleared)) throw new Error('could not clear the marks of this page')
  return cleared
}

export type MarkedOdtChoice = 'docx' | 'clear' | 'cancel'

export type MarkedOdtPlan =
  { kind: 'write'; html: string } | { kind: 'save-as-docx' } | { kind: 'declined' }

/**
 * What the ODT export may write for this page. `ask` null: nobody can be asked
 * (a headless export), so a marked page is declined.
 */
export async function planMarkedOdt(
  html: string,
  ask: (() => Promise<MarkedOdtChoice>) | null,
): Promise<MarkedOdtPlan> {
  if (!holdsHiddenMarks(html)) return { kind: 'write', html }
  if (!ask) return { kind: 'declined' }
  const choice = await ask()
  if (choice === 'docx') return { kind: 'save-as-docx' }
  if (choice === 'clear') return { kind: 'write', html: clearHiddenMarks(html) }
  return { kind: 'declined' }
}
