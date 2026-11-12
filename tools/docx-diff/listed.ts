// The classes of divergences.json that inputs of comparison (f) fall in: where
// main decided that the Rust is right and the TypeScript is to be fixed, or
// where the answer is the host's. A spec names its class with `CallSpec.listed`;
// each predicate reads the input alone, and is as narrow as the input allows.

type Args = Record<string, unknown>

/** The filters of a revision call: its own, or those of its resolutions. */
function revisionFilters(args: Args): object[] {
  const resolutions = Array.isArray(args.resolutions) ? (args.resolutions as unknown[]) : []
  return [
    args.filter,
    ...resolutions.map((resolution) =>
      resolution && typeof resolution === 'object' && 'filter' in resolution ? resolution.filter : undefined,
    ),
  ].filter((filter): filter is object => !!filter && typeof filter === 'object')
}

/**
 * main's revisionDateMs reads a date that holds a T and ends in no zone as
 * UTC by appending Z: a date whose T is in a word ("GMT", "Tue") then no
 * longer parses, where Date.parse read it.
 */
function readAsZoneless(date: string): boolean {
  const s = date.trim()
  return (
    /T/i.test(s) &&
    !/(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(s) &&
    Number.isNaN(Date.parse(`${s}Z`)) &&
    !Number.isNaN(Date.parse(s))
  )
}

/**
 * The two known follow-ups of main's revision date filter: a `before` that is
 * not a string throws in the TypeScript (`iso.trim`), and a date with a T in a
 * word reads as NaN (readAsZoneless). Only a call with a `before` filter reads
 * dates.
 */
export function revisionDateClass(text: string, args: Args): string | undefined {
  const befores = revisionFilters(args)
    .flatMap((filter) => ('before' in filter ? [filter.before] : []))
  if (befores.length === 0) return undefined
  if (befores.some((before) => typeof before !== 'string')) return 'revision-before-not-a-string'
  const dates = [...text.matchAll(/\sw:date\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2] ?? '')
  const strings = befores.filter((before): before is string => typeof before === 'string')
  return [...strings, ...dates].some(readAsZoneless)
    ? 'revision-date-with-a-t-in-a-word-read-as-zoneless'
    : undefined
}

/** The names every plain object inherits from `Object.prototype`. */
const OBJECT_PROTOTYPE_MEMBERS = new Set([
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
])

/**
 * An a:custGeom naming an `Object.prototype` member as a guide, in an a:gd
 * name or formula or in a point or arc operand: parseCustGeom of the
 * TypeScript reads that name off the prototype (tools/pptx-diff's class of
 * the same id).
 */
export function custgeomInheritedGuide(text: string, _args: Args): string | undefined {
  for (const geom of text.matchAll(/<a:custGeom\b[\s\S]*?<\/a:custGeom>/g)) {
    for (const attr of geom[0].matchAll(/\b(?:name|fmla|x|y|wR|hR|stAng|swAng)\s*=\s*"([^"]*)"/g)) {
      if (attr[1]!.trim().split(/\s+/).some((token) => OBJECT_PROTOTYPE_MEMBERS.has(token))) {
        return 'custgeom-inherited-guide'
      }
    }
  }
  return undefined
}
