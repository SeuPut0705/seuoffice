/**
 * dc:language for an EPUB (spec §5): guessed from the script of the body
 * text, falling back to the UI language.
 *
 * This is a tunable heuristic, not language identification. Each script maps
 * to the language most books in it are written in, so a French book reads as
 * `en` and a Persian one as `ar`. The conversion dialog lets the user correct
 * it, and callers that know the language pass it explicitly. The constants
 * below are the knobs.
 */
import { runsText } from '../tree/inline'
import type { DocumentTree, InlineRun, TreeBlock } from '../tree/types'
import { languageTag } from './xml'

/** weighted letter count below which the text is too thin to guess from */
export const MIN_LANGUAGE_SCORE = 20
/**
 * weight of one Han / Kana / Hangul character against one letter of an
 * alphabet: a CJK character carries roughly a syllable or a word, so mixed
 * text with embedded English terms still reads as its CJK language
 */
export const CJK_WEIGHT = 2
/** share of kana in Han + kana from which Han text reads as Japanese, not Chinese */
export const KANA_SHARE_FOR_JA = 0.1
/** characters of body text sampled for the guess */
export const LANGUAGE_SAMPLE_CHARS = 100_000

/** alphabetic and abugida scripts → language tag */
const SCRIPT_LANGUAGES: [string, RegExp][] = [
  ['en', /\p{Script=Latin}/gu],
  ['ru', /\p{Script=Cyrillic}/gu],
  ['el', /\p{Script=Greek}/gu],
  ['ar', /\p{Script=Arabic}/gu],
  ['he', /\p{Script=Hebrew}/gu],
  ['hi', /\p{Script=Devanagari}/gu],
  ['bn', /\p{Script=Bengali}/gu],
  ['pa', /\p{Script=Gurmukhi}/gu],
  ['gu', /\p{Script=Gujarati}/gu],
  ['ta', /\p{Script=Tamil}/gu],
  ['te', /\p{Script=Telugu}/gu],
  ['kn', /\p{Script=Kannada}/gu],
  ['ml', /\p{Script=Malayalam}/gu],
  ['si', /\p{Script=Sinhala}/gu],
  ['th', /\p{Script=Thai}/gu],
  ['lo', /\p{Script=Lao}/gu],
  ['km', /\p{Script=Khmer}/gu],
  ['my', /\p{Script=Myanmar}/gu],
  ['ka', /\p{Script=Georgian}/gu],
  ['hy', /\p{Script=Armenian}/gu],
  ['am', /\p{Script=Ethiopic}/gu],
]
const HANGUL = /\p{Script=Hangul}/gu
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
const HAN = /\p{Script=Han}/gu

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0

/** language of the dominant script, or undefined when the text is too thin */
export function guessLanguageFromText(text: string): string | undefined {
  const sample = text.slice(0, LANGUAGE_SAMPLE_CHARS)
  const scores = new Map<string, number>()
  for (const [lang, re] of SCRIPT_LANGUAGES) scores.set(lang, count(sample, re))
  scores.set('ko', count(sample, HANGUL) * CJK_WEIGHT)
  const kana = count(sample, KANA)
  const han = count(sample, HAN)
  if (kana > 0 && kana / (kana + han) >= KANA_SHARE_FOR_JA) {
    scores.set('ja', (kana + han) * CJK_WEIGHT)
  } else {
    scores.set('zh', han * CJK_WEIGHT)
  }
  let best: string | undefined
  let bestScore = 0
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      best = lang
      bestScore = score
    }
  }
  return bestScore >= MIN_LANGUAGE_SCORE ? best : undefined
}

/** body text of the tree in reading order, up to the sample size */
export function treeSampleText(
  tree: DocumentTree,
  include: (block: { translationOf?: string }) => boolean = () => true,
): string {
  const parts: string[] = []
  let length = 0
  const add = (runs: InlineRun[], owner: { translationOf?: string }): boolean => {
    if (!include(owner)) return length < LANGUAGE_SAMPLE_CHARS
    const s = runsText(runs)
    parts.push(s)
    length += s.length + 1
    return length < LANGUAGE_SAMPLE_CHARS
  }
  const visit = (b: TreeBlock): boolean => {
    switch (b.kind) {
      case 'heading':
      case 'paragraph':
      case 'listItem':
        return add(b.runs, b)
      case 'table':
        if (b.caption && !add(b.caption.runs, b)) return false
        for (const c of b.table.cells) for (const p of c.paragraphs) if (!add(p, b)) return false
        return true
      case 'image':
        return b.caption ? add(b.caption.runs, b.caption) : true
      default:
        return true
    }
  }
  for (const b of tree.blocks) if (!visit(b)) return parts.join('\n')
  for (const f of tree.footnotes) for (const p of f.blocks) if (!add(p.runs, p)) break
  return parts.join('\n')
}

export interface EpubLanguageOptions {
  /** explicit dc:language; skips the guess */
  language?: string
  /** UI language, used when the guess finds no dominant script */
  uiLanguage?: string
}

/**
 * dc:language values, primary first: the explicit language; else the target
 * language of a translated tree; else the guess. A bilingual book lists the
 * source language (guessed from the original blocks) and the target.
 */
export function epubLanguages(tree: DocumentTree, options: EpubLanguageOptions): string[] {
  const explicit = languageTag(options.language)
  if (explicit) return [explicit]
  const fallback = languageTag(options.uiLanguage) ?? 'en'
  const target = languageTag(tree.targetLanguage)
  const guess = (include?: (b: { translationOf?: string }) => boolean): string =>
    languageTag(guessLanguageFromText(treeSampleText(tree, include))) ?? fallback
  if (tree.variant === 'translated') return [target ?? guess()]
  if (tree.variant === 'bilingual') {
    const source = guess((b) => b.translationOf === undefined)
    return target && target !== source ? [source, target] : [source]
  }
  return [guess()]
}
