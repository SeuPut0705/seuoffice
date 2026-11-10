import type { EditJournal } from '../../src/renderer/edit-journal'
import type { SheetOp } from '../../src/web/collab-adapter'
import { fingerprintText } from '../../src/web/collab-fingerprint'
import { fileOf, openBook, type OpenedBook, workbookData } from './sheets-workbook'

/** The first place two fingerprint texts part, with some context */
export function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && a[at] === b[at]) at++
  const from = Math.max(0, at - 200)
  return `  shown:    ${a.slice(from, at + 200)}\n  expected: ${b.slice(from, at + 200)}`
}

/** What travels: every op goes through its JSON form */
function wire(from: OpenedBook, ops: readonly SheetOp[], to: OpenedBook): SheetOp[] {
  return ops.map((op) => to.adapter.decode(JSON.parse(JSON.stringify(from.adapter.encode(op)))))
}

/**
 * A shared document driven step by step: a base file, its pages and the
 * server's log. It makes the same adapter calls the engine makes: a page's
 * unconfirmed ops go to `integrate` with each foreign change, and an appended
 * submit is `confirmed`.
 */
export class Room {
  readonly base: Uint8Array
  readonly log: { from: OpenedBook; ops: SheetOp[] }[] = []
  readonly pages: OpenedBook[] = []
  readonly #sent = new Map<OpenedBook, number>()
  /** the ops of each page not yet in the log, rewritten as remote changes arrive */
  readonly #pending = new Map<OpenedBook, SheetOp[]>()
  /** how far each page has applied the log */
  readonly #seen = new Map<OpenedBook, number>()

  constructor(cells: Record<number, Record<number, unknown>> = {}) {
    this.base = fileOf(workbookData(cells))
  }

  /** `journal`: a save journal the page feeds, as the app's page does */
  join(journal?: EditJournal): OpenedBook {
    const page = openBook(this.base, {}, journal)
    this.pages.push(page)
    this.#sent.set(page, 0)
    this.#pending.set(page, [])
    this.#seen.set(page, 0)
    this.catchUp(page)
    return page
  }

  #collect(page: OpenedBook): void {
    const sent = this.#sent.get(page)!
    this.#pending.get(page)!.push(...page.emitted.slice(sent))
    this.#sent.set(page, page.emitted.length)
  }

  /** With COLLAB_CHECK set: throw when `page` does not show its log plus its pending ops */
  check(page: OpenedBook, what: string): void {
    this.#collect(page)
    const expected = this.#shadow(page, this.#seen.get(page)!, this.#pending.get(page)!)
    if (expected === null) return
    const shown = fingerprintText(page.workbook)
    if (shown !== expected)
      throw new Error(
        `after ${what}, page ${this.pages.indexOf(page)} is off its log plus pending\n${firstDifference(shown, expected)}\n  trace:\n    ${page.trace.slice(-12).join('\n    ')}`,
      )
  }

  /** bring `page` up to the head of the log, or to version `upTo` */
  catchUp(page: OpenedBook, upTo = this.log.length): void {
    this.#collect(page)
    for (let v = this.#seen.get(page)!; v < upTo; v++) {
      const change = this.log[v]!
      this.#seen.set(page, v + 1)
      if (change.from === page) continue
      const local = this.#pending.get(page)!
      const shownBefore =
        this.#shadow(page, v, local) === null ? null : fingerprintText(page.workbook)
      const before = this.#shadow(page, v, local)
      const traced = page.trace.length
      this.#pending.set(page, page.adapter.integrate(wire(change.from, change.ops, page), local))
      const after = this.#shadow(page, v + 1, this.#pending.get(page)!)
      if (before !== null && after !== null) {
        const shown = fingerprintText(page.workbook)
        if (shown !== after) {
          const describe = (ops: readonly SheetOp[]) =>
            ops
              .map((op) => `${op.id}: ${JSON.stringify(op.mutations).slice(0, 600)}`)
              .join('\n      ')
          throw new Error(
            `integrate of version ${v + 1} left page ${this.pages.indexOf(page)} off its log plus pending; it matched before: ${before === shownBefore}\n${firstDifference(shown, after)}\n  remote:\n      ${describe(change.ops)}\n  local:\n      ${describe(local)}\n  trace:\n    ${page.trace.slice(traced).join('\n    ')}`,
          )
        }
      }
    }
  }

  /**
   * With COLLAB_CHECK set: the fingerprint text of the log up to `version`
   * with `pending` applied on top, which is what `page` must show.
   */
  #shadow(page: OpenedBook, version: number, pending: SheetOp[]): string | null {
    if (!process.env.COLLAB_CHECK) return null
    const shadow = openBook(this.base)
    try {
      for (const change of this.log.slice(0, version))
        shadow.adapter.integrate(wire(change.from, change.ops, shadow), [])
      if (pending.length > 0) shadow.adapter.integrate(wire(page, pending, shadow), [])
      return fingerprintText(shadow.workbook)
    } finally {
      shadow.dispose()
    }
  }

  /** the server appends the page's pending ops as the next version */
  submit(page: OpenedBook): void {
    this.catchUp(page)
    const ops = this.#pending.get(page)!
    if (ops.length === 0) return
    this.log.push({ from: page, ops })
    page.adapter.confirmed(ops)
    this.#pending.set(page, [])
    this.#seen.set(page, this.log.length)
  }

  /** every page submits in the given order, then all catch up */
  settle(...order: OpenedBook[]): void {
    for (const page of order) this.submit(page)
    for (const page of this.pages) this.catchUp(page)
  }

  late(journal?: EditJournal): OpenedBook {
    return this.join(journal)
  }
}
