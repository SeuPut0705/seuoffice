// The second line of evidence for model-orders.json: the producers in the
// TypeScript source. It reads every file of packages/docx-engine/src with the
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
// parameter) is not tied to its producer. A spread or Object.assign of another
// value counts every key of its type, set or not.
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
    keys: ['level'],
    reason: 'numId, ilvl, kind (a list item) and level (a heading) are set in exclusive branches',
  },
  {
    type: 'ChartDisplay',
    file: 'chart.ts',
    within: 'parseChartPartXml',
    keys: ['noLegend'],
    reason: 'noLegend is written only without a legend, legendFontPt only with one',
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
    keys: ['eastAsiaLang', 'borderStyle', 'emptyRunFontFamily', 'markSizeHalfPoints', 'effective'],
    reason: 'as in collectTxbxParas: extractParaFormat never sets these five',
  },
  ...['ParaBorderSides', 'ParaFormat.borderLines', 'ParaFormat.borderPad', 'TextboxDisplay.wrapDistPx'].map(
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
const src = join(root, 'packages/docx-engine/src')
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

/** One step of a producer: a key, or the block of keys a spread or Object.assign of another value brings. */
type Step = { key: string } | { block: string[] }

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
  steps: Step[]
}

function spreadSteps(expression: ts.Expression): Step[] {
  let e = expression
  while (ts.isParenthesizedExpression(e)) e = e.expression
  if (ts.isConditionalExpression(e)) return [...spreadSteps(e.whenTrue), ...spreadSteps(e.whenFalse)]
  if (
    ts.isBinaryExpression(e) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
      e.operatorToken.kind,
    )
  ) {
    return spreadSteps(e.right)
  }
  if (ts.isObjectLiteralExpression(e)) return literalSteps(e)
  if (ts.isIdentifier(e)) {
    const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isObjectLiteralExpression(declaration.initializer)
    ) {
      return [...literalSteps(declaration.initializer), ...tailSteps(declaration.initializer, e.getStart())]
    }
  }
  const type = checker.getNonNullableType(checker.getTypeAtLocation(e))
  return [{ block: checker.getPropertiesOfType(type).map((property) => property.name) }]
}

function literalSteps(literal: ts.ObjectLiteralExpression): Step[] {
  const steps: Step[] = []
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) steps.push(...spreadSteps(property.expression))
    else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      steps.push({ key: property.name.text })
    }
  }
  return steps
}

function enclosingFunction(node: ts.Node): ts.Node {
  let at: ts.Node | undefined = node.parent
  while (at && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent
  return at ?? node.getSourceFile()
}

/** `x.k = v` and `Object.assign(x, ...)` on the variable a literal initializes, in source order, before `before` */
function tailSteps(literal: ts.ObjectLiteralExpression, before = Infinity): Step[] {
  const declaration = literal.parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return []
  const symbol = checker.getSymbolAtLocation(declaration.name)
  if (!symbol) return []
  const steps: Array<[number, Step]> = []
  const isVariable = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === symbol
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isPropertyAccessExpression(node.left) &&
      isVariable(node.left.expression)
    ) {
      steps.push([node.getStart(), { key: node.left.name.text }])
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'Object.assign' &&
      node.arguments[0] &&
      isVariable(node.arguments[0])
    ) {
      for (const source of node.arguments.slice(1)) {
        for (const step of spreadSteps(source)) steps.push([source.getStart(), step])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(enclosingFunction(literal))
  return steps
    .filter(([position]) => position > literal.getEnd() && position < before)
    .sort((a, b) => a[0] - b[0])
    .map(([, step]) => step)
}

const producers: Producer[] = []
for (const file of program.getSourceFiles()) {
  if (!resolve(file.fileName).startsWith(src)) continue
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const types = modelTypes(checker.getContextualType(node)).filter((name) => orders[name] !== undefined)
      if (types.length > 0) {
        producers.push({
          types,
          file: relative(src, file.fileName).replaceAll('\\', '/'),
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          within: functionName(node),
          steps: [...literalSteps(node), ...tailSteps(node)],
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

/** The pairs a producer can write that the committed order has the other way round. */
function contradictions(producer: Producer, type: string, order: readonly string[]): string[] {
  const rank = new Map(order.map((key, at) => [key, at]))
  const fields = new Set(fieldsOf(type))
  // the first place each key can take: a block is one group, its keys in no order between them
  const groups: string[][] = []
  const placed = new Set<string>()
  for (const step of producer.steps) {
    const keys = ('key' in step ? [step.key] : step.block).filter((key) => fields.has(key) && !placed.has(key))
    keys.forEach((key) => placed.add(key))
    if (keys.length > 0) groups.push(keys)
  }
  const pairs: string[] = []
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
    const pairs = contradictions(producer, type, order)
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
