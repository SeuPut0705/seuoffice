import { isRecord, type XmindSheet } from './types'

/**
 * How deep below the central topic a topic may sit. Far beyond any real map;
 * the limit exists so the recursive walks over the tree (the view, and what
 * later modules add) and `JSON.stringify` on save cannot run out of stack on a
 * file built to do that. A deeper file is unreadable, not a crash.
 */
export const MAX_TOPIC_DEPTH = 256

/** The kinds under `children` whose value must be a list of topics. */
const KNOWN_CHILD_KINDS = new Set(['attached', 'detached', 'summary', 'callout'])

export type StructureCheck = { ok: true; sheets: XmindSheet[] } | { ok: false; problem: string }

/**
 * The structure check behind `unreadable`: the top level is a list of sheets,
 * every sheet has a central topic, and no topic id repeats inside one sheet.
 * The same id in two different sheets is fine: topics are matched per sheet.
 *
 * It checks the shape the rest of the engine walks without looking again (ids
 * are strings, `children` holds lists of topics) and nothing else. A format
 * version it does not know, unknown keys and unknown kinds of children all
 * pass. Never throws: the input is whatever was in the file.
 */
export function checkContentStructure(content: unknown): StructureCheck {
  if (!Array.isArray(content)) return bad('the top level is not a list of sheets')
  if (content.length === 0) return bad('the file has no sheet')
  for (const [index, sheet] of content.entries()) {
    if (!isRecord(sheet)) return bad(`sheet ${index} is not an object`)
    const problem = checkSheetTopics(sheet.rootTopic)
    if (problem) return bad(`sheet ${index}: ${problem}`)
  }
  return { ok: true, sheets: content as XmindSheet[] }
}

/** Walks one sheet's topics with an explicit stack: depth is the attacker's to choose. */
function checkSheetTopics(rootTopic: unknown): string | null {
  if (rootTopic === undefined) return 'no central topic'
  const seen = new Set<string>()
  const pending: { topic: unknown; depth: number }[] = [{ topic: rootTopic, depth: 0 }]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { topic, depth } = next
    if (!isRecord(topic)) return 'a topic is not an object'
    const id = topic.id
    if (typeof id !== 'string' || id === '') return 'a topic has no id'
    if (seen.has(id)) return `topic id ${id} is used more than once`
    seen.add(id)
    const children = topic.children
    if (children === undefined) continue
    if (!isRecord(children)) return `the children of topic ${id} are not an object`
    for (const [kind, list] of Object.entries(children)) {
      const known = KNOWN_CHILD_KINDS.has(kind)
      if (!Array.isArray(list)) {
        if (known) return `children.${kind} of topic ${id} is not a list`
        continue
      }
      // A kind from a later format version is held to the id rule wherever it
      // holds topics, and is otherwise left alone.
      const topics = known ? list : list.filter(looksLikeTopic)
      if (topics.length > 0 && depth + 1 > MAX_TOPIC_DEPTH) {
        return `topics are nested deeper than ${MAX_TOPIC_DEPTH} levels`
      }
      for (const child of topics) pending.push({ topic: child, depth: depth + 1 })
    }
  }
  return null
}

function looksLikeTopic(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && value.id !== ''
}

function bad(problem: string): StructureCheck {
  return { ok: false, problem }
}
