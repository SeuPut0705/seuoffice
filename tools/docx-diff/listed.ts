// The classes of divergences.json that inputs of comparison (f) fall in: where
// main decided that the Rust is right and the TypeScript is to be fixed, or
// where the answer is the host's. A spec names its class with `CallSpec.listed`;
// each predicate reads the input alone, and is as narrow as the input allows.

type Args = Record<string, unknown>

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
