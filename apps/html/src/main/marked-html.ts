/**
 * Content a person marked "hidden from AI" in an HTML page (the redactor's three
 * marks: `data-gx-redact` on an element, `data-gx-redact-<attr>` beside an
 * attribute, `/*gx:redact:label*\/` before a script literal). Neither an ODT
 * nor the Word export can keep the hiding (the Word export reads the rendered
 * page: attribute and script marks have no run to sit on, and an element's
 * pixels are screenshotted), so both refuse marked pages and offer to write the
 * copy with the marks cleared (the page itself keeps them).
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

export type MarkedExportChoice = 'clear' | 'cancel'

export type MarkedExportPlan = { kind: 'write'; html: string } | { kind: 'declined' }

/**
 * What an export that cannot keep the hiding (the ODT export; the Word export,
 * which writes the page's words and no mark) may write for this page. `ask`
 * null: nobody can be asked (a headless export), so a marked page is declined.
 */
export async function planMarkedExport(
  html: string,
  ask: (() => Promise<MarkedExportChoice>) | null,
): Promise<MarkedExportPlan> {
  if (!holdsHiddenMarks(html)) return { kind: 'write', html }
  if (!ask) return { kind: 'declined' }
  return (await ask()) === 'clear'
    ? { kind: 'write', html: clearHiddenMarks(html) }
    : { kind: 'declined' }
}
