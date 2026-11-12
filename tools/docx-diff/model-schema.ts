// The Word model of packages/docx-engine (types.ts and every type its fields
// name) as a schema, read from the TypeScript source with the compiler's
// parser. `model-gen.ts` writes the Rust model from it; `walkWire` checks a
// model value as it crosses the wire against it.
//
// The declarations are read from main at the commit MODEL_SOURCE pins, not
// from the working tree, because the model is what ships; the parser and the
// save side of this branch's TypeScript are older until main is merged.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export type SchemaNode =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  /** `true`, `false`, or a string literal that is one variant of a union */
  | { kind: 'literal'; value: string | boolean }
  /** a type of `ModelSchema.types`: named, or anonymous and named by its path */
  | { kind: 'ref'; name: string }
  | { kind: 'array'; element: SchemaNode }
  | { kind: 'tuple'; elements: SchemaNode[] }
  /** `T | null` */
  | { kind: 'nullable'; inner: SchemaNode }
  /** `T | undefined` as an array element: JSON writes it as null */
  | { kind: 'undefinable'; inner: SchemaNode }
  /** `Record<string, T>`, `Record<number, T>`: a JSON object */
  | { kind: 'record'; key: 'string' | 'number'; value: SchemaNode }
  /** `Map<K, V>`: on the wire `[[key, value], ...]`, the key keeping its type */
  | { kind: 'map'; key: 'string' | 'number'; value: SchemaNode }
  /** `Uint8Array`: on the wire `{ "$bytes": base64 }` */
  | { kind: 'bytes' }
  /** any JSON value: a field declared `unknown` */
  | { kind: 'opaque'; name: 'unknown' }
  /** a union that is neither nullable nor all string literals; exactly one variant matches a value */
  | { kind: 'union'; variants: SchemaNode[] }

export interface Field {
  name: string
  /** `name?:`: the key may be absent */
  optional: boolean
  type: SchemaNode
}

export type TypeDef =
  /** fields flattened from `extends`, `Pick`, `&` and `Partial<Record<finite keys, T>>` */
  | {
      kind: 'object'
      name: string
      fields: Field[]
      /** `interface X extends Base`: the fields of Base lead `fields` */
      base?: string
    }
  /** a union of string literals */
  | { kind: 'enum'; name: string; values: string[] }
  | { kind: 'alias'; name: string; type: SchemaNode }

export interface ModelSchema {
  /** what `parseDocx` returns: `ParsedDoc & { extras: ParseExtras }` */
  root: 'ParsedDocFull'
  /** in the order the types were first met, from the declarations of types.ts */
  types: ReadonlyMap<string, TypeDef>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
// the path the declarations have at the pinned commit (MODEL_SOURCE), which
// predates the frozen copy in tools/docx-diff/reference
const ENGINE_SRC = join(REPO_ROOT, 'packages/docx-engine/src')
const TYPES_PATH = join(ENGINE_SRC, 'types.ts')
export const ORDERS_PATH = join(HERE, 'model-orders.json')

/**
 * The commit of main the declarations are read from: every file the
 * extraction opens (types.ts, resolve-props.ts, parse.ts for the result of
 * parseDocx, and what they import) is `git show <commit>:<path>`. A clone
 * without the commit fails; the workflow fetches the whole history.
 */
export const MODEL_SOURCE = {
  ref: 'origin/main',
  commit: '0aeee843a4684e0359d296f70435f1396ae09967',
}

/** A file of the repository as the pinned commit holds it: the frozen
 * reference copy was packages/docx-engine/src there. */
function sourceAt(path: string): string {
  const home = relative(REPO_ROOT, path)
    .replaceAll('\\', '/')
    .replace(/^tools\/docx-diff\/reference\//, 'packages/docx-engine/src/')
  const at = `${MODEL_SOURCE.commit}:${home}`
  try {
    return execFileSync('git', ['show', at], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 << 20,
    })
  } catch (error) {
    throw new SchemaError(
      `cannot read ${at} (${MODEL_SOURCE.ref}); fetch it, a shallow clone lacks it: ${String(error)}`,
    )
  }
}

/** `parseDocx` returns the root type: `Promise<ParsedDoc & { extras: ParseExtras }>` today. */
const PARSE_PATH = join(ENGINE_SRC, 'parse.ts')
const PARSE_FUNCTION = 'parseDocx'

/** Fields declared `unknown`, read as any JSON value. */
const UNKNOWN_FIELDS = new Set(['ResolveDiff.old', 'ResolveDiff.eff'])

type Declaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration
type Where = 'field' | 'optionalField' | 'element' | 'other'

interface Module {
  path: string
  file: ts.SourceFile
  declarations: Map<string, Declaration>
  imports: Map<string, { from: string; name: string }>
}

export class SchemaError extends Error {}

function fail(node: ts.Node, message: string): never {
  const file = node.getSourceFile()
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart())
  const where = `${relative(REPO_ROOT, file.fileName).replaceAll('\\', '/')}:${line + 1}:${character + 1}`
  throw new SchemaError(`${where}: ${message}: ${node.getText()}`)
}

function parseModule(path: string, text: string): Module {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const declarations = new Map<string, Declaration>()
  const imports = new Map<string, { from: string; name: string }>()
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      if (declarations.has(statement.name.text)) fail(statement, 'declared twice')
      declarations.set(statement.name.text, statement)
    } else if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      if (!bindings || !ts.isNamedImports(bindings) || !specifier.startsWith('.')) continue
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          from: join(dirname(path), `${specifier}.ts`),
          name: (element.propertyName ?? element.name).text,
        })
      }
    }
  }
  return { path, file, declarations, imports }
}

interface Reference {
  name: string
  args: readonly ts.TypeNode[]
  node: ts.Node
}

function referenceOf(node: ts.TypeNode | ts.ExpressionWithTypeArguments): Reference | undefined {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return { name: node.typeName.text, args: node.typeArguments ?? [], node }
  }
  if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
    return { name: node.expression.text, args: node.typeArguments ?? [], node }
  }
  return undefined
}

function stringLiteral(node: ts.TypeNode): string | undefined {
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
    ? node.literal.text
    : undefined
}

class Extractor {
  readonly types = new Map<string, TypeDef | null>()
  private readonly modules = new Map<string, Module>()
  private readonly declaredIn = new Map<string, string>()
  /** each member is read once: an indexed access may read it before its interface does */
  private readonly fields = new Map<ts.TypeElement, Field | null>()

  module(path: string): Module {
    let module = this.modules.get(path)
    if (!module) {
      module = parseModule(path, sourceAt(path))
      this.modules.set(path, module)
    }
    return module
  }

  /**
   * Names `name` the type the function `functionName` of `module` resolves
   * its promise with, which no module names:
   * `Promise<ParsedDoc & { extras: ParseExtras }>`.
   */
  root(module: Module, functionName: string, name: string): void {
    const declaration = module.file.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
    )
    if (!declaration)
      throw new SchemaError(`${relative(REPO_ROOT, module.path)} declares no ${functionName}`)
    const returned = declaration.type ?? fail(declaration.name!, 'no declared return type')
    const promise = referenceOf(returned)
    if (
      promise?.name !== 'Promise' ||
      promise.args.length !== 1 ||
      module.declarations.has('Promise')
    ) {
      fail(returned, 'a return type that is no Promise<T>')
    }
    const node = this.node(module, promise.args[0]!, name, 'other')
    if (node.kind !== 'ref' || node.name !== name)
      fail(returned, `the result is no object type of its own`)
  }

  /** The schema name of a declared type, building its definition when first met. */
  named(module: Module, declaration: Declaration): string {
    const name = declaration.name.text
    const owner = this.declaredIn.get(name)
    if (owner !== undefined && owner !== module.path) {
      fail(declaration, `two modules declare ${name}`)
    }
    if (owner !== undefined) return name
    this.declaredIn.set(name, module.path)
    if (ts.isInterfaceDeclaration(declaration)) {
      this.reserve(name, declaration)
      const fields: Field[] = []
      const bases = (declaration.heritageClauses ?? []).flatMap((clause) => clause.types)
      for (const base of bases) merge(fields, this.shapeFields(module, base, name), base)
      merge(fields, this.members(module, declaration, name), declaration)
      const only = bases.length === 1 ? referenceOf(bases[0]!) : undefined
      const resolved =
        only && only.args.length === 0 && this.resolve(module, only.name, declaration)
      const base = resolved ? resolved.declaration.name.text : undefined
      this.types.set(name, {
        kind: 'object',
        name,
        fields,
        ...(base === undefined ? {} : { base }),
      })
      return name
    }
    const node = this.node(module, declaration.type, name, 'other')
    if (node.kind !== 'ref' || node.name !== name) {
      this.reserve(name, declaration)
      this.types.set(name, { kind: 'alias', name, type: node })
    }
    return name
  }

  private members(module: Module, declaration: ts.InterfaceDeclaration, path: string): Field[] {
    return declaration.members.map((member) => this.field(module, member, path))
  }

  /**
   * `X['key']` while X is still being read (`EffectiveRPr.bdr: Run['bdr']`
   * read from `Run.effective`): the field of that member, read once.
   */
  private pendingMember(module: Module, node: ts.TypeNode, key: string): Field | undefined {
    const reference = referenceOf(node)
    const resolved =
      reference && reference.args.length === 0 && this.resolve(module, reference.name, node)
    if (!resolved || !ts.isInterfaceDeclaration(resolved.declaration)) return undefined
    const name = resolved.declaration.name.text
    if (this.types.get(name) !== null) return undefined
    const member = resolved.declaration.members.find(
      (candidate) => candidate.name?.getText() === key,
    )
    return member && this.field(resolved.module, member, name)
  }

  private field(module: Module, member: ts.TypeElement, path: string): Field {
    const known = this.fields.get(member)
    if (known === null) fail(member, 'a field whose type reads itself')
    if (known) return known
    this.fields.set(member, null)
    const field = this.readField(module, member, path)
    this.fields.set(member, field)
    return field
  }

  private readField(module: Module, member: ts.TypeElement, path: string): Field {
    if (!ts.isPropertySignature(member) || !member.type) fail(member, 'not a property')
    if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
      fail(member, 'a computed key')
    }
    const name = member.name.text
    const optional = member.questionToken !== undefined
    const where = optional ? 'optionalField' : 'field'
    const type = this.node(module, member.type, `${path}.${name}`, where)
    // `unknown` holds undefined, which JSON writes as no key
    const unknown = type.kind === 'opaque' && type.name === 'unknown'
    return { name, optional: optional || unknown, type }
  }

  private reserve(name: string, at: ts.Node): void {
    if (this.types.has(name)) fail(at, `the schema name ${name} is taken`)
    this.types.set(name, null)
  }

  private object(path: string, at: ts.Node, fields: () => Field[]): SchemaNode {
    this.reserve(path, at)
    this.types.set(path, { kind: 'object', name: path, fields: fields() })
    return { kind: 'ref', name: path }
  }

  private enumeration(path: string, at: ts.Node, values: string[]): SchemaNode {
    if (new Set(values).size !== values.length) fail(at, 'a value twice')
    this.reserve(path, at)
    this.types.set(path, { kind: 'enum', name: path, values })
    return { kind: 'ref', name: path }
  }

  private resolve(
    module: Module,
    name: string,
    at: ts.Node,
  ): { module: Module; declaration: Declaration } | undefined {
    const local = module.declarations.get(name)
    if (local) return { module, declaration: local }
    const imported = module.imports.get(name)
    if (!imported) return undefined
    const target = this.module(imported.from)
    const declaration = target.declarations.get(imported.name)
    if (!declaration) fail(at, `${relative(REPO_ROOT, imported.from)} declares no ${imported.name}`)
    return { module: target, declaration }
  }

  /** The string literals of a finite key type, or undefined for `string` and `number`. */
  private keys(module: Module, node: ts.TypeNode): string[] | undefined {
    if (node.kind === ts.SyntaxKind.StringKeyword || node.kind === ts.SyntaxKind.NumberKeyword) {
      return undefined
    }
    const single = stringLiteral(node)
    if (single !== undefined) return [single]
    if (ts.isUnionTypeNode(node)) {
      return node.types.map((type) => stringLiteral(type) ?? fail(type, 'not a string literal key'))
    }
    const reference = referenceOf(node)
    const resolved = reference && this.resolve(module, reference.name, node)
    if (resolved && ts.isTypeAliasDeclaration(resolved.declaration)) {
      return this.keys(resolved.module, resolved.declaration.type) ?? fail(node, 'not finite keys')
    }
    return fail(node, 'not a key type')
  }

  /** The fields of a type that is an object shape. */
  shapeFields(
    module: Module,
    node: ts.TypeNode | ts.ExpressionWithTypeArguments,
    path: string,
  ): Field[] {
    if (ts.isParenthesizedTypeNode(node)) return this.shapeFields(module, node.type, path)
    if (ts.isTypeLiteralNode(node)) {
      return merge(
        [],
        node.members.map((member) => this.field(module, member, path)),
        node,
      )
    }
    if (ts.isIntersectionTypeNode(node)) {
      const fields: Field[] = []
      for (const type of node.types) merge(fields, this.shapeFields(module, type, path), type)
      return fields
    }
    const reference = referenceOf(node) ?? fail(node, 'not an object type')
    const resolved = this.resolve(module, reference.name, node)
    if (resolved === undefined && reference.name === 'Pick' && reference.args.length === 2) {
      const source = this.shapeFields(module, reference.args[0]!, path)
      const keys = this.keys(module, reference.args[1]!) ?? fail(node, 'Pick of every key')
      return keys.map(
        (key) => source.find((field) => field.name === key) ?? fail(node, `no field ${key}`),
      )
    }
    if (resolved === undefined && reference.name === 'Partial' && reference.args.length === 1) {
      const record = referenceOf(reference.args[0]!)
      if (record?.name !== 'Record') fail(node, 'Partial of anything but a Record')
      return this.shapeFields(module, reference.args[0]!, path).map((field) => ({
        ...field,
        optional: true,
      }))
    }
    if (resolved === undefined && reference.name === 'Record' && reference.args.length === 2) {
      const keys = this.keys(module, reference.args[0]!) ?? fail(node, 'not finite keys')
      const type = this.node(module, reference.args[1]!, `${path}{}`, 'other')
      return keys.map((name) => ({ name, optional: false, type }))
    }
    if (resolved === undefined) {
      return fail(node, 'not an object type')
    }
    if (reference.args.length > 0) fail(node, 'type arguments')
    const name = this.named(resolved.module, resolved.declaration)
    const definition = this.types.get(name)
    if (definition === null) fail(node, `${name} contains itself`)
    if (definition?.kind !== 'object') fail(node, `${name} is not an object type`)
    return definition.fields
  }

  node(module: Module, node: ts.TypeNode, path: string, where: Where): SchemaNode {
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { kind: 'string' }
      case ts.SyntaxKind.NumberKeyword:
        return { kind: 'number' }
      case ts.SyntaxKind.BooleanKeyword:
        return { kind: 'boolean' }
      case ts.SyntaxKind.UnknownKeyword:
        if (!UNKNOWN_FIELDS.has(path)) fail(node, `${path} is unknown`)
        return { kind: 'opaque', name: 'unknown' }
    }
    if (ts.isParenthesizedTypeNode(node)) return this.node(module, node.type, path, where)
    if (ts.isLiteralTypeNode(node)) {
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true }
      if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false }
      const value = stringLiteral(node) ?? fail(node, 'not a string or boolean literal')
      return this.enumeration(path, node, [value])
    }
    if (ts.isTypeLiteralNode(node) || ts.isIntersectionTypeNode(node)) {
      return this.object(path, node, () => this.shapeFields(module, node, path))
    }
    if (ts.isArrayTypeNode(node)) {
      return { kind: 'array', element: this.node(module, node.elementType, `${path}[]`, 'element') }
    }
    if (ts.isTupleTypeNode(node)) {
      return {
        kind: 'tuple',
        elements: node.elements.map((element, at) => {
          if (
            ts.isNamedTupleMember(element) ||
            ts.isOptionalTypeNode(element) ||
            ts.isRestTypeNode(element)
          ) {
            fail(element, 'a named, optional or rest tuple element')
          }
          return this.node(module, element, `${path}[${at}]`, 'other')
        }),
      }
    }
    if (ts.isUnionTypeNode(node)) return this.union(module, node, path, where)
    if (ts.isIndexedAccessTypeNode(node)) {
      const key = stringLiteral(node.indexType) ?? fail(node, 'an index that is no string literal')
      const field =
        this.pendingMember(module, node.objectType, key) ??
        this.shapeFields(module, node.objectType, path).find(
          (candidate) => candidate.name === key,
        ) ??
        fail(node, `no field ${key}`)
      if (field.optional && where !== 'optionalField') {
        fail(node, 'an optional field read where undefined is not allowed')
      }
      return field.type
    }
    const reference = referenceOf(node) ?? fail(node, 'unsupported type syntax')
    const resolved = this.resolve(module, reference.name, node)
    if (resolved !== undefined) {
      if (reference.args.length > 0) fail(node, 'type arguments')
      return { kind: 'ref', name: this.named(resolved.module, resolved.declaration) }
    }
    const [first, second] = reference.args
    switch (`${reference.name}/${reference.args.length}`) {
      case 'Array/1':
        return { kind: 'array', element: this.node(module, first!, `${path}[]`, 'element') }
      case 'Uint8Array/0':
        return { kind: 'bytes' }
      case 'Map/2':
      case 'Record/2': {
        const kind = reference.name === 'Map' ? 'map' : 'record'
        const keys = this.keys(module, first!)
        if (keys !== undefined) {
          if (kind === 'map') fail(node, 'a Map with literal keys')
          return this.object(path, node, () => this.shapeFields(module, node, path))
        }
        const key = first!.kind === ts.SyntaxKind.StringKeyword ? 'string' : 'number'
        return { kind, key, value: this.node(module, second!, `${path}{}`, 'other') }
      }
      case 'Partial/1':
      case 'Pick/2':
        return this.object(path, node, () => this.shapeFields(module, node, path))
    }
    return fail(node, `unknown type ${reference.name}`)
  }

  private union(module: Module, node: ts.UnionTypeNode, path: string, where: Where): SchemaNode {
    let nullable = false
    let undefinable = false
    const rest: ts.TypeNode[] = []
    for (const type of node.types) {
      if (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword) {
        nullable = true
      } else if (type.kind === ts.SyntaxKind.UndefinedKeyword) {
        undefinable = true
      } else {
        rest.push(type)
      }
    }
    if (nullable && undefinable) fail(node, 'both null and undefined')
    if (undefinable && where !== 'element') fail(node, 'undefined outside an array element')
    let inner: SchemaNode
    const literals = rest.map(stringLiteral)
    if (rest.length === 1) {
      inner = this.node(module, rest[0]!, path, 'other')
    } else if (literals.every((literal) => literal !== undefined)) {
      inner = this.enumeration(path, node, literals as string[])
    } else {
      this.reserve(path, node)
      const variants = rest.map((type, at): SchemaNode => {
        const literal = stringLiteral(type)
        if (literal !== undefined) return { kind: 'literal', value: literal }
        return this.node(module, type, `${path}|${at}`, 'other')
      })
      this.types.set(path, { kind: 'alias', name: path, type: { kind: 'union', variants } })
      inner = { kind: 'ref', name: path }
    }
    if (nullable) return { kind: 'nullable', inner }
    if (undefinable) return { kind: 'undefinable', inner }
    return inner
  }
}

/** Appends fields, refusing a name already there. */
function merge(into: Field[], fields: readonly Field[], at: ts.Node): Field[] {
  for (const field of fields) {
    if (into.some((other) => other.name === field.name)) fail(at, `the field ${field.name} twice`)
    into.push(field)
  }
  return into
}

/**
 * Reads the model from the declarations at MODEL_SOURCE. Throws `SchemaError`
 * on any syntax it does not model and when the commit is not in the clone.
 */
export function extractModelSchema(): ModelSchema {
  const extractor = new Extractor()
  const types = extractor.module(TYPES_PATH)
  for (const declaration of types.declarations.values()) extractor.named(types, declaration)
  extractor.root(extractor.module(PARSE_PATH), PARSE_FUNCTION, 'ParsedDocFull')
  const out = new Map<string, TypeDef>()
  for (const [name, definition] of extractor.types) out.set(name, definition!)
  return { root: 'ParsedDocFull', types: out }
}

export function typeDef(schema: ModelSchema, name: string): TypeDef {
  const definition = schema.types.get(name)
  if (!definition) throw new Error(`no model type ${name}`)
  return definition
}

/**
 * Per object type: its keys in the one order the Rust writes them, or
 * 'input' where the TypeScript's order follows the path the code took and
 * the Rust keeps the order it read.
 */
export type OrderTable = Record<string, string[] | 'input'>

export function loadOrders(): OrderTable {
  return JSON.parse(readFileSync(ORDERS_PATH, 'utf8')) as OrderTable
}

export interface ObjectVisit {
  type: string
  /** JSON pointer (RFC 6901) of the object in the walked value */
  path: string
  /** the keys of the object in the order the value holds them */
  keys: string[]
  /** the object itself */
  value: Record<string, unknown>
}

export class WireError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path === '' ? '(root)' : path}: ${message}`)
  }
}

const pointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`

/**
 * Padded base64 as `Buffer.toString('base64')` writes it: the bits the padding
 * leaves unused are zero, so the last sextet before `==` is one of A Q g w
 * (low 4 bits zero) and the one before `=` has its low 2 bits zero. The Rust
 * reads the same set.
 */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value

type Visit = (visit: ObjectVisit) => void

/**
 * Checks a model value in its wire form (`Map` as entries, `Uint8Array` as
 * `{ $bytes }`) against `type`, as strictly as the Rust reads it: an unknown
 * key, a missing required key, null where the type has none (a number
 * takes null: NaN and the infinities cross as null), a string no
 * enum holds, a union that more or fewer than one variant matches, each
 * throws `WireError`. Calls `onObject` for every object type met, parent first.
 */
export function walkWire(schema: ModelSchema, type: string, value: unknown, onObject: Visit): void {
  check(schema, { kind: 'ref', name: type }, value, '', onObject)
}

const fieldTables = new WeakMap<TypeDef, Map<string, Field>>()

function check(
  schema: ModelSchema,
  node: SchemaNode,
  value: unknown,
  path: string,
  onObject: Visit,
): void {
  const expect = (what: string): never => {
    throw new WireError(path, `expected ${what}, got ${describe(value)}`)
  }
  switch (node.kind) {
    case 'number':
      // JSON.stringify writes NaN and the infinities as null, which JsNum reads as NaN
      if (typeof value !== 'number' && value !== null) expect('a number')
      return
    case 'string':
    case 'boolean':
      if (typeof value !== node.kind) expect(`a ${node.kind}`)
      return
    case 'literal':
      if (value !== node.value) expect(JSON.stringify(node.value))
      return
    case 'ref':
      checkDefinition(schema, typeDef(schema, node.name), value, path, onObject)
      return
    case 'array':
      if (!Array.isArray(value)) return expect('an array')
      value.forEach((element, at) =>
        check(schema, node.element, element, pointer(path, at), onObject),
      )
      return
    case 'tuple':
      if (!Array.isArray(value) || value.length !== node.elements.length) {
        return expect(`an array of ${node.elements.length}`)
      }
      node.elements.forEach((element, at) =>
        check(schema, element, value[at], pointer(path, at), onObject),
      )
      return
    case 'nullable':
      if (value !== null) check(schema, node.inner, value, path, onObject)
      return
    case 'undefinable':
      if (value !== null && value !== undefined) check(schema, node.inner, value, path, onObject)
      return
    case 'record':
      if (!isPlainObject(value)) return expect('an object')
      for (const [key, entry] of Object.entries(value)) {
        if (node.key === 'number' && String(Number(key)) !== key) {
          throw new WireError(pointer(path, key), 'a key that is no number')
        }
        check(schema, node.value, entry, pointer(path, key), onObject)
      }
      return
    case 'map': {
      // a key equal to an earlier one is no error: JSON.stringify writes the
      // distinct keys NaN, Infinity and -Infinity all as null
      if (!Array.isArray(value)) return expect('the entries of a Map')
      value.forEach((entry: unknown, at) => {
        const where = pointer(path, at)
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new WireError(where, `expected a [${node.key}, value] entry`)
        }
        check(schema, { kind: node.key }, entry[0], pointer(where, 0), onObject)
        check(schema, node.value, entry[1], pointer(where, 1), onObject)
      })
      return
    }
    case 'bytes':
      if (
        !isPlainObject(value) ||
        Object.keys(value).join() !== '$bytes' ||
        typeof value.$bytes !== 'string' ||
        !BASE64.test(value.$bytes)
      ) {
        expect('{ $bytes: base64 }')
      }
      return
    case 'opaque':
      if (value === undefined) expect('a JSON value')
      return
    case 'union': {
      const matching = node.variants.filter((variant) => accepts(schema, variant, value, path))
      if (matching.length !== 1) {
        throw new WireError(path, `${matching.length} variants of a union match ${describe(value)}`)
      }
      check(schema, matching[0]!, value, path, onObject)
      return
    }
  }
}

function accepts(schema: ModelSchema, node: SchemaNode, value: unknown, path: string): boolean {
  try {
    check(schema, node, value, path, () => {})
    return true
  } catch (error) {
    if (error instanceof WireError) return false
    throw error
  }
}

function checkDefinition(
  schema: ModelSchema,
  definition: TypeDef,
  value: unknown,
  path: string,
  onObject: Visit,
): void {
  if (definition.kind === 'alias') {
    check(schema, definition.type, value, path, onObject)
    return
  }
  if (definition.kind === 'enum') {
    if (typeof value !== 'string' || !definition.values.includes(value)) {
      throw new WireError(
        path,
        `expected one of ${definition.values.join(', ')} (${definition.name}), got ${JSON.stringify(value)}`,
      )
    }
    return
  }
  if (!isPlainObject(value)) {
    throw new WireError(path, `expected an object (${definition.name}), got ${describe(value)}`)
  }
  let fields = fieldTables.get(definition)
  if (!fields) {
    fields = new Map(definition.fields.map((field) => [field.name, field]))
    fieldTables.set(definition, fields)
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined)
  for (const key of keys) {
    if (!fields.has(key))
      throw new WireError(pointer(path, key), `${definition.name} has no key ${key}`)
  }
  for (const field of definition.fields) {
    if (!field.optional && value[field.name] === undefined) {
      throw new WireError(path, `${definition.name} lacks its key ${field.name}`)
    }
  }
  onObject({ type: definition.name, path, keys, value })
  for (const key of keys) {
    check(schema, fields.get(key)!.type, value[key], pointer(path, key), onObject)
  }
}
