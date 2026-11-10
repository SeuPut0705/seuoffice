/**
 * What a person does in the PDF editor, as the App's handlers turn it into
 * edit ops, and a random pick among them for the conformance kit.
 */
import type { Op } from '../../src/renderer/edit-ops'
import type { DrawingInput, FormFieldInput } from '../../src/shared/ipc'
import { pageCount } from '../../src/web/collab-model'
import type { HeadlessPdf } from './headless'

type Rgb = [number, number, number]

export const YELLOW: Rgb = [1, 0.87, 0.35]
export const GREEN: Rgb = [0.4, 0.9, 0.4]

const applied = (app: HeadlessPdf, ops: Op[]): boolean => app.apply(ops).failures.length === 0

export function highlight(app: HeadlessPdf, pageIndex: number, color: Rgb = YELLOW): boolean {
  return applied(app, [
    {
      op: 'addMarkup',
      markup: { pageIndex, type: 'highlight', color, quads: [[0, 10, 50, 10, 0, 0, 50, 0]] },
    },
  ])
}

export function draw(app: HeadlessPdf, drawing: DrawingInput): boolean {
  return applied(app, [{ op: 'addDrawing', drawing }])
}

export const ink = (pageIndex: number): DrawingInput => ({
  kind: 'ink',
  pageIndex,
  color: [0, 0, 0],
  width: 2,
  paths: [[10, 10, 20, 20, 30, 15]],
})

export const note = (
  pageIndex: number,
  contents: string,
  replyToLocalId?: string,
): DrawingInput => ({
  kind: 'note',
  pageIndex,
  color: YELLOW,
  at: [40, 40],
  contents,
  createdMs: 1_700_000_000_000,
  ...(replyToLocalId ? { replyToLocalId } : {}),
})

export const stamp = (pageIndex: number, base64Bytes: number): DrawingInput => ({
  kind: 'image',
  pageIndex,
  image: 'A'.repeat(base64Bytes),
  rect: [10, 10, 110, 60],
})

/** App.insertBlankPage: the next page index, after the page the person stands on */
export function addBlankPage(app: HeadlessPdf, after: number | null): boolean {
  return applied(app, [
    {
      op: 'insertBlankPage',
      after,
      pageIndex: pageCount(app.state, app.basePages),
      width: 595,
      height: 842,
    },
  ])
}

export const rotate = (app: HeadlessPdf, pages: number[], dir: 90 | -90 | 180): boolean =>
  applied(app, [{ op: 'rotatePages', pages, dir }])

export const deletePage = (app: HeadlessPdf, pageIndex: number): boolean =>
  applied(app, [{ op: 'deletePage', pageIndex }])

/** App.commitOrder: the visible pages in their new order, deleted ones trailing */
export function reorder(app: HeadlessPdf, visible: number[]): boolean {
  const all = Array.from({ length: pageCount(app.state, app.basePages) }, (_, i) => i)
  return applied(app, [
    { op: 'setPageOrder', order: [...visible, ...all.filter((p) => !visible.includes(p))] },
  ])
}

export const field = (
  name: string,
  pageIndex: number,
  kind: FormFieldInput['kind'] = 'text',
): FormFieldInput => ({
  name,
  kind,
  pageIndex,
  rect: [20, 20, 120, 40],
  ...(kind === 'radio' ? { exportValue: 'on' } : {}),
})

export const addField = (app: HeadlessPdf, input: FormFieldInput): boolean =>
  applied(app, [{ op: 'addFormField', field: input }])

/** App.deleteNoteItem for a pending thread: the note and every reply under it */
export function deleteThread(app: HeadlessPdf, rootId: string): boolean {
  const ids = [rootId]
  for (let i = 0; i < ids.length; i++) {
    for (const d of app.state.drawings) {
      if (d.input.kind === 'note' && d.input.replyToLocalId === ids[i]) ids.push(d.id)
    }
  }
  return applied(
    app,
    ids.map((id): Op => ({ op: 'removeDrawing', id })),
  )
}

export const savedNote = (objNum: number, contents = 'on disk') => ({
  pageIndex: 0,
  objNum,
  type: 'note' as const,
  rect: [0, 0, 20, 20] as [number, number, number, number],
  color: null,
  author: 'A',
  contents,
  timeMs: null,
  inReplyTo: null,
})

const pick = <T>(r: () => number, items: readonly T[]): T | undefined =>
  items[Math.floor(r() * items.length)]

/**
 * One random action of a person, through the App's own handlers; false when
 * the App refused it or it changed nothing. `tag` names whatever it adds.
 */
export function randomAction(app: HeadlessPdf, r: () => number, tag: string): boolean {
  const s = app.state
  const pages = app.visible()
  const page = pick(r, pages) ?? 0
  const roll = r()
  const choose = <T>(items: readonly T[]) => pick(r, items)
  if (roll < 0.12) return highlight(app, page, r() < 0.5 ? YELLOW : GREEN)
  if (roll < 0.17) {
    const m = choose(s.markups)
    return (
      !!m && applied(app, [{ op: 'recolorMarkup', id: m.id, color: r() < 0.5 ? YELLOW : GREEN }])
    )
  }
  if (roll < 0.21) {
    const m = choose(s.markups)
    return !!m && applied(app, [{ op: 'removeMarkup', id: m.id }])
  }
  if (roll < 0.27) return draw(app, ink(page))
  if (roll < 0.32) return draw(app, note(page, `note ${tag}`))
  if (roll < 0.36) {
    const parent = choose(s.drawings.filter((d) => d.input.kind === 'note'))
    return !!parent && draw(app, note(parent.input.pageIndex, `reply ${tag}`, parent.id))
  }
  if (roll < 0.4) {
    const d = choose(s.drawings)
    return !!d && applied(app, [{ op: 'moveDrawing', id: d.id, dx: 5, dy: -3 }])
  }
  if (roll < 0.43) {
    const n = choose(s.drawings.filter((d) => d.input.kind === 'note'))
    return !!n && applied(app, [{ op: 'setNoteContents', id: n.id, contents: `edited ${tag}` }])
  }
  if (roll < 0.47) {
    const n = choose(s.drawings.filter((d) => d.input.kind === 'note' && !d.input.replyToLocalId))
    if (n) return deleteThread(app, n.id)
    const d = choose(s.drawings)
    return !!d && applied(app, [{ op: 'removeDrawing', id: d.id }])
  }
  if (roll < 0.49) return draw(app, stamp(page, 200))
  if (roll < 0.53) {
    const name = choose(['name', 'email', 'agree'])!
    return applied(app, [
      { op: 'setFormValue', value: { name, kind: 'text', value: `${name} ${tag}` } },
    ])
  }
  if (roll < 0.57)
    return addField(app, field(choose(['f1', 'f2', 'group'])!, page, r() < 0.3 ? 'radio' : 'text'))
  if (roll < 0.59) {
    const f = choose(s.formFields)
    return (
      !!f && applied(app, [{ op: 'patchFormField', id: f.id, input: { rect: [30, 30, 140, 52] } }])
    )
  }
  if (roll < 0.61) {
    const f = choose(s.formFields)
    return !!f && applied(app, [{ op: 'removeFormField', id: f.id }])
  }
  if (roll < 0.63) {
    const widgetId = choose(['w1', 'w2'])!
    return applied(app, [
      {
        op: 'editFormWidget',
        widgetId,
        fieldName: `field ${widgetId}`,
        input: { required: r() < 0.5 },
      },
    ])
  }
  if (roll < 0.66) {
    const annot = savedNote(1 + Math.floor(r() * 2))
    return applied(app, [{ op: 'editSavedNote', annot, contents: `saved ${tag}` }])
  }
  if (roll < 0.7) return addBlankPage(app, r() < 0.2 ? null : page)
  if (roll < 0.74) return rotate(app, [page], choose([90, -90, 180] as const)!)
  if (roll < 0.77) return deletePage(app, page)
  if (roll < 0.81) {
    const moved = [...pages]
    const from = Math.floor(r() * moved.length)
    const [p] = moved.splice(from, 1)
    moved.splice(Math.floor(r() * (moved.length + 1)), 0, p!)
    return reorder(app, moved)
  }
  if (roll < 0.83) {
    const cfg =
      r() < 0.3
        ? null
        : {
            wm: { text: `wm ${tag}`, color: '#ff0000', opacity: 0.3, angle: 45, sizeRatio: 0.1 },
            hf: null,
          }
    return applied(app, [{ op: 'setStamps', cfg }])
  }
  if (roll < 0.85) return applied(app, [{ op: 'setMetadata', metadata: { title: `title ${tag}` } }])
  if (roll < 0.92) return app.undo()
  if (roll < 0.97) return app.redo()
  // the web cannot save these: the session refuses them and nothing changes
  const before = app.state
  applied(app, [
    {
      op: 'putTextEdit',
      input: { pageIndex: page, rect: [0, 0, 10, 10], oldText: 'a', newText: tag },
    },
  ])
  if (app.state !== before) throw new Error('a text edit got through while co-editing')
  return false
}
