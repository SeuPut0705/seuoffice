// The second line of evidence for model-orders.json: the producers in the
// TypeScript source. It reads every file of tools/docx-diff/reference with the
// compiler's type checker and finds each object literal whose contextual type
// is a model type, then the keys that literal can write in order: its own
// keys and spreads (a spread of a variable a literal initialized counts that
// literal's keys as set up to the spread), followed by the `x.k = v` and
// `Object.assign(x, ...)` on the same variable later in the same function.
//
//   tsx model-producers.ts           exit 1 on any finding
//
// A finding is a pair `a before b` that one producer can write while the
// committed order of that type, which is fixed (not "input"), has b before a.
// It says a document reaching that producer would show the TypeScript writing
// another order than the Rust: build such a document (model-bodies.ts) and
// re-observe. The committed order still comes from parse results only.
//
// Blind spots: an object literal without a contextual model type (an
// unannotated `const x = { ... }` passed along later) is not seen, and a key
// assigned to the object in another function (`para.listMarker = ...` on a
// parameter) is not tied to its producer. A spread or Object.assign of a
// typed value counts every key of its type, set or not, in no order. A spread
// of a call to a function of the source reads that function's returns
// instead. The branches of a conditional are separate ways of the producer,
// and `x[k] = v` with `k` a union of keys writes them in the order of the
// data, so a fixed order with two of them is a finding.
//
// EXCUSED lists the sites read and found not to be findings, each with the
// reason: those that cannot write the pair, and those whose value no document
// can carry. A new line in the output is a finding.
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { extractModelSchema, loadOrders } from './model-schema'

interface Excused {
  type: string
  file: string
  /** the named function the producer is in */
  within: string
  /** when given, the site is excused only while every pair it reports involves one of these keys */
  keys?: string[]
  reason: string
}

const EXCUSED: Excused[] = [
  {
    type: 'TableModel',
    file: 'parse.ts',
    within: 'extractTableModel',
    keys: ['dxaWidth'],
    reason: 'fixedLayout and dxaWidth are set in the two branches of one if/else',
  },
  {
    type: 'Block.pPrChangeInfo.old',
    file: 'parse.ts',
    within: 'buildTextParagraph',
    keys: ['level', 'bidiInherited', 'frameBox'],
    reason:
      'numId, ilvl, kind (a list item) and level (a heading) are set in exclusive branches; ' +
      'extractParaFormat(oldPPr) passes no style direction, so it never sets bidiInherited; ' +
      'frameBoxOf returns nothing for a w:framePr with w:dropCap',
  },
  {
    type: 'TextboxParaDisplay',
    file: 'parse.ts',
    within: 'collectTxbxParas',
    keys: ['eastAsiaLang', 'borderStyle', 'emptyRunFontFamily', 'markSizeHalfPoints', 'effective'],
    reason:
      'extractParaFormat and withCharIndents never set these five (foldEffectiveFormat and the body path do), ' +
      'so a text box paragraph cannot hold them; the Object.assign block counts every ParaFormat key',
  },
  {
    type: 'TextboxParaDisplay',
    file: 'parse.ts',
    within: 'paragraphStrayBox',
    keys: ['frameBox'],
    reason: 'frameBoxOf returns nothing for a w:framePr with w:dropCap, so frameBox and dropCap never meet',
  },
  ...[
    'ParaBorderSides',
    'ParaFormat.borderLines',
    'ParaFormat.borderPad',
    'TextboxDisplay.wrapDistPx',
    'HfImage.wrapDistPx',
  ].map(
    (type): Excused => ({
      type,
      file: 'generate.ts',
      within: 'buildAnchoredTextboxParagraphXml',
      reason: 'the default text box insets `{ l, t, r, b }`: no model value, its field set only matches these',
    }),
  ),
  {
    type: 'NumberingLevel',
    file: 'blank.ts',
    within: 'numberingLevelFromCustom',
    reason:
      'the level the list dialogs build for display, never a parse result: its order is its own, ' +
      'and a Rust port of it must write that order (crates/README.md counts its 67 results apart)',
  },
  {
    type: 'GeneratedBlock',
    file: 'compare.ts',
    within: 'generatedFrom',
    reason: 'a save-side input the comparison feature builds; no parse result holds a GeneratedBlock',
  },
  {
    type: 'SectionSettings',
    file: 'section.ts',
    within: 'sectionSettingsFromXml',
    reason: 'no parse result holds SectionSettings: sections cross only as call arguments',
  },
  {
    type: 'SectionSettings.pageBorderProps.sides',
    file: 'section.ts',
    within: 'pageBorderPropsOf',
    reason: 'the sides of w:pgBorders in the order of the document; no parse result holds SectionSettings',
  },
  ...['SectionInfo.headerRefs', 'SectionInfo.footerRefs'].map(
    (type): Excused => ({
      type,
      file: 'section.ts',
      within: 'hfRefs',
      reason: 'the references in the order of the sectPr; no parse result holds SectionInfo (readSections reads them)',
    }),
  ),
  {
    type: 'ParsedDocFull',
    file: 'parse.ts',
    within: 'parseDocx',
    keys: ['embeddedFonts'],
    reason: 'open: a document needs an obfuscated embedded font part to show embeddedFonts; none is built',
  },
  {
    type: 'DiagramShape',
    file: 'parse.ts',
    within: 'extractLockedCanvas',
    keys: ['imageDataUrl'],
    reason: 'imageDataUrl (an a:pic) and fillHex (an a:sp) are set in the two branches of one if/else',
  },
  {
    type: 'DiagramShape',
    file: 'parse.ts',
    within: 'extractDiagramDrawing',
    reason: 'open: a document needs a SmartArt drawing part (diagrams/drawing1.xml, dsp:sp) to show it; none is built',
  },
]

const root = resolve(import.meta.dirname, '../..')
const src = join(root, 'tools/docx-diff/reference')
const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .map((name) => join(src, name))
const config = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/docx-engine/tsconfig.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  },
})!
const program = ts.createProgram(files, config.options)
const checker = program.getTypeChecker()

const schema = extractModelSchema()
const orders = loadOrders()
const bySet = new Map<string, string[]>()
for (const definition of schema.types.values()) {
  if (definition.kind !== 'object') continue
  const set = definition.fields.map((field) => field.name).sort().join(',')
  bySet.set(set, [...(bySet.get(set) ?? []), definition.name])
}
const fieldsOf = (name: string): string[] => {
  const definition = schema.types.get(name)
  return definition?.kind === 'object' ? definition.fields.map((field) => field.name) : []
}

/** The schema name of a type declared in the model source: `TextboxDisplay.wrapDistPx`. */
function declaredName(type: ts.Type): string | undefined {
  const declaration = (type.aliasSymbol ?? type.getSymbol())?.declarations?.[0]
  if (!declaration) return undefined
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    return declaration.name.text
  }
  if (!ts.isTypeLiteralNode(declaration)) return undefined
  let path = ''
  for (let node: ts.Node = declaration; node.parent; node = node.parent) {
    const parent = node.parent
    if (ts.isArrayTypeNode(parent)) path = `[]${path}`
    else if (ts.isTypeReferenceNode(parent) && parent.typeName.getText() === 'Array') path = `[]${path}`
    else if (ts.isUnionTypeNode(parent)) {
      const rest = parent.types.filter(
        (member) =>
          member.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
      )
      if (rest.length > 1) path = `|${rest.indexOf(node as ts.TypeNode)}${path}`
    } else if (ts.isPropertySignature(parent)) path = `.${parent.name.getText()}${path}`
    else if (ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) {
      return `${parent.name.text}${path}`
    } else if (!ts.isTypeLiteralNode(parent) && !ts.isIntersectionTypeNode(parent) && !ts.isParenthesizedTypeNode(parent)) {
      return undefined
    }
  }
  return undefined
}

/** The model types a TypeScript type is: by its declaration, else by its property names. */
function modelTypes(type: ts.Type | undefined): string[] {
  if (!type) return []
  const out = new Set<string>()
  const visit = (member: ts.Type): void => {
    if (member.isUnion()) return member.types.forEach(visit)
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return
    if (checker.isArrayType(member)) {
      const element = checker.getIndexTypeOfType(member, ts.IndexKind.Number)
      if (element) visit(element)
      return
    }
    const declared = declaredName(member)
    if (declared !== undefined && orders[declared] !== undefined) {
      out.add(declared)
      return
    }
    const names = checker.getPropertiesOfType(member).map((property) => property.name).sort().join(',')
    for (const name of bySet.get(names) ?? []) out.add(name)
  }
  visit(type)
  return [...out]
}

/**
 * One step of a producer: a key; the block of keys a spread or Object.assign
 * of a typed value brings, in no order known here; or keys written in the
 * order of the data (`out[slot] = v` with `slot` a union of keys).
 */
type Step = { key: string } | { block: string[] } | { data: string[] }
/** The ways a producer can go: one step list per exclusive branch it can take. */
type Ways = Step[][]

/** More ways than this at one site is a site to read by hand, not to enumerate. */
const MAX_WAYS = 256

/** Drops a way whose steps all appear, in order, in another: it can write no pair that one cannot. */
function prune(ways: Ways): Ways {
  const texts = ways.map((way) => way.map((step) => JSON.stringify(step)))
  const within = (a: string[], b: string[]): boolean => {
    let at = 0
    for (const step of b) if (step === a[at]) at++
    return at === a.length
  }
  const unique = [...new Map(texts.map((text, at) => [text.join('\n'), at])).values()]
  return unique
    .filter((a) => !unique.some((b) => b !== a && texts[b]!.length > texts[a]!.length && within(texts[a]!, texts[b]!)))
    .map((at) => ways[at]!)
}

/** Every way of `first` followed by every way of `second`. */
function then(first: Ways, second: Ways, at: ts.Node): Ways {
  const ways = prune(first.flatMap((a) => second.map((b) => [...a, ...b])))
  if (ways.length > MAX_WAYS) {
    const where = at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1
    throw new Error(`${relative(src, at.getSourceFile().fileName)}:${where} can go ${ways.length} ways; read it by hand`)
  }
  return ways
}

const NO_KEYS: Ways = [[]]

/** The nearest enclosing function with a name: a declaration, a method, or a function a variable holds. */
function functionName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText()
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) {
      return at.parent.name.getText()
    }
  }
  return '(module)'
}

interface Producer {
  types: string[]
  file: string
  line: number
  /** the named function the literal is in: `extractCell` */
  within: string
  ways: Ways
}

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression
  return e
}

/** functions whose returns are being read: a call back into one counts its type's keys */
const reading = new Set<ts.Node>()

/**
 * The function of this source a call names (`axesOf(...)`), when it is a
 * declaration or a function a variable holds.
 */
function calledFunction(call: ts.CallExpression): ts.SignatureDeclaration | undefined {
  let symbol = checker.getSymbolAtLocation(call.expression)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const declaration = symbol?.valueDeclaration
  if (!declaration || !resolve(declaration.getSourceFile().fileName).startsWith(src)) return undefined
  if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer
  }
  return undefined
}

/** The expressions a function returns, outside the functions nested in it. */
function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as ts.FunctionLikeDeclarationBase).body
  if (!body) return []
  if (!ts.isBlock(body)) return [body]
  const out: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return out
}

function typeKeys(e: ts.Expression): string[] {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(e))
  return checker.getPropertiesOfType(type).map((property) => property.name)
}

function spreadWays(expression: ts.Expression): Ways {
  const e = unwrap(expression)
  if (ts.isConditionalExpression(e)) return prune([...spreadWays(e.whenTrue), ...spreadWays(e.whenFalse)])
  // `a && {...}` spreads the literal or nothing; `a ?? b` and `a || b` spread a or b
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return spreadWays(e.right)
  }
  if (
    ts.isBinaryExpression(e) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)
  ) {
    return prune([...spreadWays(e.left), ...spreadWays(e.right)])
  }
  if (ts.isObjectLiteralExpression(e)) return literalWays(e)
  if (ts.isIdentifier(e)) {
    const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrap(declaration.initializer)
      if (ts.isObjectLiteralExpression(initializer)) {
        return then(literalWays(initializer), tailWays(initializer, e.getStart()), e)
      }
      const constant = ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const
      if (constant && ts.isCallExpression(initializer)) return spreadWays(initializer)
    }
  }
  if (ts.isCallExpression(e)) {
    const fn = calledFunction(e)
    if (fn && !reading.has(fn)) {
      reading.add(fn)
      try {
        const returned = returnedExpressions(fn)
        if (returned.length > 0) return prune(returned.flatMap(spreadWays))
      } finally {
        reading.delete(fn)
      }
    }
  }
  return [[{ block: typeKeys(e) }]]
}

function literalWays(literal: ts.ObjectLiteralExpression): Ways {
  let ways = NO_KEYS
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) ways = then(ways, spreadWays(property.expression), property)
    else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      const key = property.name.text
      ways = ways.map((way) => [...way, { key }])
    }
  }
  return ways
}

/** The elements of an array the source spells out: a literal, or a const holding one, spreads included. */
function arrayElements(expression: ts.Expression): ts.Expression[] | undefined {
  const e = unwrap(expression)
  if (ts.isIdentifier(e)) {
    const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration
    const constant =
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    return constant && declaration.initializer ? arrayElements(declaration.initializer) : undefined
  }
  if (!ts.isArrayLiteralExpression(e)) return undefined
  const out: ts.Expression[] = []
  for (const element of e.elements) {
    if (!ts.isSpreadElement(element)) {
      out.push(element)
      continue
    }
    const inner = arrayElements(element.expression)
    if (!inner) return undefined
    out.push(...inner)
  }
  return out
}

/**
 * The keys, in order, a `for (const k of ...)` (or `for (const [k, v] of
 * ...)`) loop gives its variable when it walks an array the source spells
 * out, or `Object.entries` of an object literal: the loop writes them in that
 * order, whatever the data. Undefined when the order is the data's.
 */
function loopKeys(index: ts.Expression): string[][] | undefined {
  if (!ts.isIdentifier(index)) return undefined
  let declaration: ts.Node | undefined = checker.getSymbolAtLocation(index)?.valueDeclaration
  let position: number | undefined
  if (declaration && ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
    position = declaration.parent.elements.indexOf(declaration)
    declaration = declaration.parent.parent
  }
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined
  const loop = declaration.parent.parent
  if (!ts.isForOfStatement(loop)) return undefined
  const iterated = unwrap(loop.expression)
  if (ts.isCallExpression(iterated) && iterated.expression.getText() === 'Object.entries' && iterated.arguments[0]) {
    return entryKeys(iterated.arguments[0], position)
  }
  const items = arrayElements(iterated)
  if (!items) return undefined
  const keys: string[] = []
  for (const item of items) {
    let value: ts.Expression | undefined = unwrap(item)
    if (position !== undefined) {
      const element: ts.Expression | undefined = ts.isArrayLiteralExpression(value) ? value.elements[position] : undefined
      value = element && unwrap(element)
    }
    if (!value || !ts.isStringLiteralLike(value)) return undefined
    keys.push(value.text)
  }
  return [keys]
}

/**
 * `Object.entries(X)` of a const object literal: its property names
 * (position 0) or string values (position 1) in order, one list per way the
 * conditionals it spreads can go.
 */
function entryKeys(expression: ts.Expression, position: number | undefined): string[][] | undefined {
  if (position !== 0 && position !== 1) return undefined
  let e = unwrap(expression)
  if (ts.isIdentifier(e)) {
    const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined
    e = unwrap(declaration.initializer)
  }
  if (ts.isConditionalExpression(e)) {
    const a = entryKeys(e.whenTrue, position)
    const b = entryKeys(e.whenFalse, position)
    return a && b ? [...a, ...b] : undefined
  }
  if (!ts.isObjectLiteralExpression(e)) return undefined
  let ways: string[][] = [[]]
  for (const property of e.properties) {
    if (ts.isSpreadAssignment(property)) {
      const inner = entryKeys(property.expression, position)
      if (!inner) return undefined
      ways = ways.flatMap((way) => inner.map((keys) => [...way, ...keys]))
    } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      const value = unwrap(property.initializer)
      let key: string
      if (position === 0) key = property.name.text
      else if (ts.isStringLiteralLike(value)) key = value.text
      else return undefined
      ways = ways.map((way) => [...way, key])
    } else {
      return undefined
    }
  }
  return ways
}

/** The model type a type annotation names: `ParaBorderSides`, `NonNullable<ParaFormat['borderLines']>`. */
function annotationName(node: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText()
    if (!node.typeArguments) return orders[name] === undefined ? undefined : name
    return name === 'NonNullable' && node.typeArguments.length === 1 ? annotationName(node.typeArguments[0]!) : undefined
  }
  if (ts.isIndexedAccessTypeNode(node) && ts.isLiteralTypeNode(node.indexType) && ts.isStringLiteral(node.indexType.literal)) {
    const owner = ts.isTypeReferenceNode(node.objectType) ? node.objectType.typeName.getText() : annotationName(node.objectType)
    const name = owner && `${owner}.${node.indexType.literal.text}`
    return name && orders[name] !== undefined ? name : undefined
  }
  return undefined
}

/**
 * The one model type a literal is declared as (`const sides: ParaBorderSides
 * = {}`): a type of the same keys, matched by its keys, is not this literal's.
 */
function annotatedType(literal: ts.ObjectLiteralExpression): string[] | undefined {
  let at: ts.Node = literal.parent
  while (ts.isParenthesizedExpression(at)) at = at.parent
  const annotation = ts.isVariableDeclaration(at) ? at.type : ts.isAsExpression(at) ? at.type : undefined
  const name = annotation && annotationName(annotation)
  return name === undefined ? undefined : [name]
}

function enclosingFunction(node: ts.Node): ts.Node {
  let at: ts.Node | undefined = node.parent
  while (at && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent
  return at ?? node.getSourceFile()
}

/**
 * `x.k = v`, `x[k] = v` and `Object.assign(x, ...)` on the variable a literal
 * initializes, in source order, before `before`.
 */
function tailWays(literal: ts.ObjectLiteralExpression, before = Infinity): Ways {
  let declaration: ts.Node = literal.parent
  while (ts.isParenthesizedExpression(declaration) || ts.isAsExpression(declaration)) declaration = declaration.parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return NO_KEYS
  const symbol = checker.getSymbolAtLocation(declaration.name)
  if (!symbol) return NO_KEYS
  const steps: Array<[number, ts.Node, Ways]> = []
  const isVariable = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === symbol
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = node.left
      if (ts.isPropertyAccessExpression(left) && isVariable(left.expression)) {
        steps.push([node.getStart(), node, [[{ key: left.name.text }]]])
      } else if (ts.isElementAccessExpression(left) && isVariable(left.expression)) {
        const index = left.argumentExpression
        if (ts.isStringLiteralLike(index)) {
          steps.push([node.getStart(), node, [[{ key: index.text }]]])
        } else {
          const ordered = loopKeys(index)
          if (ordered) {
            steps.push([node.getStart(), node, ordered.map((keys) => keys.map((key) => ({ key })))])
          } else {
            const type = checker.getNonNullableType(checker.getTypeAtLocation(index))
            const members = type.isUnion() ? type.types : [type]
            const keys = members.every((member) => member.isStringLiteral())
              ? members.map((member) => (member as ts.StringLiteralType).value)
              : typeKeys(left.expression)
            steps.push([node.getStart(), node, [[{ data: keys }]]])
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'Object.assign' &&
      node.arguments[0] &&
      isVariable(node.arguments[0])
    ) {
      for (const source of node.arguments.slice(1)) steps.push([source.getStart(), source, spreadWays(source)])
    }
    ts.forEachChild(node, visit)
  }
  visit(enclosingFunction(literal))
  return steps
    .filter(([position]) => position > literal.getEnd() && position < before)
    .sort((a, b) => a[0] - b[0])
    .reduce((ways, [, node, next]) => then(ways, next, node), NO_KEYS)
}

const producers: Producer[] = []
for (const file of program.getSourceFiles()) {
  if (!resolve(file.fileName).startsWith(src)) continue
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const types = (annotatedType(node) ?? modelTypes(checker.getContextualType(node))).filter(
        (name) => orders[name] !== undefined,
      )
      if (types.length > 0) {
        producers.push({
          types,
          file: relative(src, file.fileName).replaceAll('\\', '/'),
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          within: functionName(node),
          ways: then(literalWays(node), tailWays(node), node),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

/** The pairs one way of a producer can write that the committed order has the other way round. */
function contradictions(steps: readonly Step[], type: string, order: readonly string[]): string[] {
  const rank = new Map(order.map((key, at) => [key, at]))
  const fields = new Set(fieldsOf(type))
  // the first place each key can take: a block is one group, its keys in no order between them
  const groups: string[][] = []
  const placed = new Set<string>()
  const pairs: string[] = []
  for (const step of steps) {
    const keys = ('key' in step ? [step.key] : 'block' in step ? step.block : step.data).filter(
      (key) => fields.has(key) && !placed.has(key),
    )
    keys.forEach((key) => placed.add(key))
    if (keys.length === 0) continue
    groups.push(keys)
    if (!('data' in step)) continue
    // keys in the order of the data: every pair can come either way
    const ranked = [...keys].sort((a, b) => rank.get(a)! - rank.get(b)!)
    ranked.forEach((a, at) => ranked.slice(at + 1).forEach((b) => pairs.push(`${b} before ${a}`)))
  }
  groups.forEach((group, at) => {
    for (const later of groups.slice(at + 1)) {
      for (const a of group) for (const b of later) if (rank.get(a)! > rank.get(b)!) pairs.push(`${a} before ${b}`)
    }
  })
  return pairs
}

let findings = 0
const excused = new Set<Excused>()
for (const producer of producers) {
  for (const type of producer.types) {
    const order = orders[type]
    if (order === undefined || order === 'input') continue
    const pairs = [...new Set(producer.ways.flatMap((steps) => contradictions(steps, type, order)))]
    if (pairs.length === 0) continue
    const known = EXCUSED.find(
      (site) =>
        site.type === type &&
        site.file === producer.file &&
        site.within === producer.within &&
        pairs.every((pair) => site.keys === undefined || pair.split(' before ').some((key) => site.keys!.includes(key))),
    )
    if (known) {
      excused.add(known)
      continue
    }
    findings++
    console.log(`${type} ${producer.file}:${producer.line} (${producer.within}): ${pairs.slice(0, 6).join('; ')}`)
  }
}
for (const site of EXCUSED) {
  if (!excused.has(site)) {
    findings++
    console.log(`EXCUSED names ${site.type} in ${site.file} (${site.within}), which no longer contradicts its order`)
  }
}
console.log(`${producers.length} producers of model types read, ${findings} findings, ${excused.size} sites excused`)
if (findings > 0) process.exitCode = 1
