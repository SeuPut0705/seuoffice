/**
 * An AI run held as a proposal, end to end without a model: the real AgentLoop runs a
 * scripted conversation against the real hwp skill and plugin over a real rhwp document,
 * whose editor history (undo and redo) is modelled by snapshots as the editor records a
 * plugin transaction. The document is compared byte for byte.
 */
import { describe, expect, it } from 'vitest'
import { accept, holdRun, reject, type TurnProposal } from '../src/renderer/ai/turn-proposal'
import { EDITS, LINES, openEditor, runRequest, same, useEngine } from './ai-run-harness'

useEngine()

/** a run over the document, taken back out and held, with the states a test compares */
async function heldRun() {
  const editor = openEditor()
  const original = editor.bytes()
  const run = await runRequest(editor, EDITS)
  const proposal = await holdRun(editor.bridge, run.items.length, run.foreign)
  return { editor, original, run, proposal }
}

describe('an AI run held as a proposal', () => {
  it('edits the live document during the run and leaves it as it was when the run ends', async () => {
    const { editor, original, run, proposal } = await heldRun()
    expect(run.items).toHaveLength(EDITS.length)
    // the run really changed the document: this is not a vacuous comparison
    expect(same(run.live, original)).toBe(false)
    expect(proposal).toMatchObject({ kind: 'pending', steps: EDITS.length })
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.lines()).toEqual(LINES)
  })

  it('puts exactly the run back when it is accepted, and the run can then be undone as before', async () => {
    const { editor, original, run, proposal } = await heldRun()
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome.kind).toBe('applied')
    expect(same(editor.bytes(), run.live)).toBe(true)
    expect(editor.lines()).toContain('새로 넣은 문단이에요.')

    // the panel's undo of an applied run, with the count the accept handed back
    if (outcome.kind !== 'applied') return
    expect(await editor.bridge.undo(run.items.length, outcome.foreign)).toMatchObject({ ok: true })
    expect(same(editor.bytes(), original)).toBe(true)
  })

  it('leaves the document as it was when it is rejected', async () => {
    const { editor, original, proposal } = await heldRun()
    expect(proposal.kind).toBe('pending')
    expect(reject()).toEqual({ kind: 'none' })
    expect(same(editor.bytes(), original)).toBe(true)
  })

  it('refuses to accept after the person typed, and leaves their document alone', async () => {
    const { editor, proposal } = await heldRun()
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    expect(editor.typeIn()).toBe(true)
    const typed = editor.bytes()
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome).toEqual({ kind: 'stale', proposal: { kind: 'stale', steps: EDITS.length } })
    expect(same(editor.bytes(), typed)).toBe(true)
  })

  it('refuses to accept after a change the editor history does not show, too', async () => {
    const { editor, proposal } = await heldRun()
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    // the redo stack is intact here: only the plugin's foreign count says the document moved
    editor.outsideEdit()
    const before = editor.bytes()
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome.kind).toBe('stale')
    expect(same(editor.bytes(), before)).toBe(true)
  })

  it('strands a run when the document moved under it: nothing is taken out or put back', async () => {
    const editor = openEditor()
    const run = await runRequest(editor, EDITS)
    editor.outsideEdit()
    const proposal: TurnProposal = await holdRun(editor.bridge, run.items.length, run.foreign)
    expect(proposal).toEqual({ kind: 'stranded' })
    expect(same(editor.bytes(), run.live)).toBe(true)
  })
})
