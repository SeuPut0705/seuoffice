/**
 * The label presets of AI highlights (reading-assist spec 4.6) and the label
 * editing rules of the start window. A label's color is document data (it
 * becomes the accepted highlight's color), so it is a plain rgb triple, not a
 * theme token. Pure.
 */
import {
  highlightRunId,
  normalizeLabelName,
} from '../../../../../packages/pdf-structure/src/highlight'
import type {
  HighlightLabel,
  HighlightPresetId,
  HighlightRun,
} from '../../../../../packages/pdf-structure/src/store/reading'
import type { StringKey, TFunc } from '../i18n/locale'

export type Rgb = [number, number, number]

export const HIGHLIGHT_PRESETS: readonly HighlightPresetId[] = [
  'research',
  'contract',
  'textbook',
  'custom',
]

/** labels per run (spec 4.6: 1 to 5) */
export const MAX_LABELS = 5

/** the colors a label can take, in the order new labels get them */
export const LABEL_COLORS: readonly { id: string; key: StringKey; color: Rgb }[] = [
  { id: 'yellow', key: 'hlColorYellow', color: [1, 0.85, 0.3] },
  { id: 'green', key: 'hlColorGreen', color: [0.55, 0.85, 0.45] },
  { id: 'blue', key: 'hlColorBlue', color: [0.5, 0.75, 1] },
  { id: 'pink', key: 'hlColorPink', color: [1, 0.6, 0.75] },
  { id: 'orange', key: 'hlColorOrange', color: [1, 0.65, 0.3] },
  { id: 'purple', key: 'hlColorPurple', color: [0.75, 0.6, 1] },
]

export const PRESET_NAME_KEYS: Record<HighlightPresetId, StringKey> = {
  research: 'hlPresetResearch',
  contract: 'hlPresetContract',
  textbook: 'hlPresetTextbook',
  custom: 'hlPresetCustom',
}

const PRESET_LABEL_KEYS: Record<Exclude<HighlightPresetId, 'custom'>, StringKey[]> = {
  research: ['hlLabelClaim', 'hlLabelMethod', 'hlLabelResult', 'hlLabelLimit'],
  contract: ['hlLabelDuty', 'hlLabelDeadline', 'hlLabelAmount', 'hlLabelTermination'],
  textbook: ['hlLabelDefinition', 'hlLabelConcept', 'hlLabelExample', 'hlLabelCaution'],
}

/** a label as the start window edits it */
export interface DraftLabel {
  name: string
  color: Rgb
}

const colorAt = (i: number): Rgb => [...LABEL_COLORS[i % LABEL_COLORS.length]!.color]

/** the preset's default labels in the UI language; one empty label for 'custom' */
export function presetLabels(presetId: HighlightPresetId, t: TFunc): DraftLabel[] {
  if (presetId === 'custom') return [{ name: '', color: colorAt(0) }]
  return PRESET_LABEL_KEYS[presetId].map((key, i) => ({ name: t(key), color: colorAt(i) }))
}

/** the first palette color no label uses yet (the first one when all are taken) */
export function nextLabelColor(labels: readonly DraftLabel[]): Rgb {
  const used = new Set(labels.map((l) => l.color.join(',')))
  const free = LABEL_COLORS.find((c) => !used.has(c.color.join(',')))
  return [...(free ?? LABEL_COLORS[0]!).color]
}

export type LabelProblem = 'empty' | 'duplicate' | 'count'

/** why the labels cannot be used, or null */
export function labelProblem(labels: readonly DraftLabel[]): LabelProblem | null {
  if (labels.length < 1 || labels.length > MAX_LABELS) return 'count'
  const names = labels.map((l) => normalizeLabelName(l.name))
  if (names.some((n) => n === '')) return 'empty'
  if (new Set(names).size !== names.length) return 'duplicate'
  return null
}

/** the run's labels: ids by position, names normalized */
export function runLabels(labels: readonly DraftLabel[]): HighlightLabel[] {
  return labels.map((l, i) => ({
    id: `l${i + 1}`,
    name: normalizeLabelName(l.name),
    color: [l.color[0], l.color[1], l.color[2]],
  }))
}

/** the run id of a preset and its labels (changes whenever a name, its place or the preset does) */
export function runIdOf(presetId: HighlightPresetId, labels: readonly DraftLabel[]): string {
  return highlightRunId(
    presetId,
    labels.map((l) => l.name),
  )
}

/** the start window's choices brought back from a stored run (the resume offer) */
export function draftFromRun(run: HighlightRun): {
  presetId: HighlightPresetId
  labels: DraftLabel[]
  pages: number[]
} {
  return {
    presetId: run.presetId,
    labels: run.labels.map((l) => ({ name: l.name, color: [...l.color] as Rgb })),
    pages: [...run.pages],
  }
}

/** a document color as a CSS color (shown as it is, never through the theme) */
export function cssColor(c: readonly number[], alpha = 1): string {
  const [r, g, b] = [0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, c[i] ?? 0)) * 255))
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}
