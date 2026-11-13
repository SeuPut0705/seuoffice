/**
 * The IPC channel inventory of stage 3 (docs/seuoffice/3단계-셸-계약.md):
 * every channel a renderer reaches through `ipcRenderer` (the preloads and
 * the `*-bridge` modules they bundle), with the main-process modules that
 * answer it, and the area batch that ports it to the Rust shell.
 *
 * A channel argument is read through the type checker, so a constant
 * (`HWP_CHANNELS.printPages`, `C.list`, a loop over a literal array) counts
 * as the literal it holds. A main module answers a channel when it registers
 * it on `ipcMain`; for an event (renderer `on`/`once`) the modules that name
 * the channel in any expression are its senders. Sites whose channel is only
 * a `string` (a parameter, a computed name) are listed as unresolved.
 *
 * Batches own main modules, not channels: a module sits in exactly one batch,
 * and a channel goes to the batch of the module that answers it.
 *
 *   npx tsx tools/shell-inventory/channels.ts             # writes out/channels.json
 *   npx tsx tools/shell-inventory/channels.ts --markdown  # and prints the tables
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const tool = dirname(fileURLToPath(import.meta.url))
const root = resolve(tool, '../..')
const rel = (abs: string): string => relative(root, abs).split(sep).join('/')

const isSource = (name: string): boolean =>
  /\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')

function sourcesUnder(path: string): string[] {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return isSource(path) ? [path] : []
  return readdirSync(path)
    .filter((name) => name !== 'node_modules' && name !== 'tests' && name !== '__tests__')
    .flatMap((name) => sourcesUnder(join(path, name)))
}

const apps = readdirSync(join(root, 'apps')).filter((app) =>
  existsSync(join(root, 'apps', app, 'src')),
)
const packages = readdirSync(join(root, 'packages')).filter((p) =>
  existsSync(join(root, 'packages', p, 'src')),
)
const mentions = (file: string, word: string): boolean => readFileSync(file, 'utf8').includes(word)

/** Renderer side: the preloads and every package module that calls ipcRenderer */
const rendererFiles = [
  ...apps.flatMap((app) => sourcesUnder(join(root, 'apps', app, 'src', 'preload'))),
  ...packages
    .filter((p) => p !== 'web-platform')
    .flatMap((p) => sourcesUnder(join(root, 'packages', p, 'src')))
    .filter((f) => mentions(f, 'ipcRenderer')),
]

/** The webview kind a preload serves: `docs`, `shell`, `shell-agent` */
const preloads = rendererFiles.filter((f) => f.includes(`${sep}preload${sep}`))
const surfaceOf = (preload: string): string => {
  const parts = rel(preload).split('/')
  const name = parts[4].replace(/\.ts$/, '')
  return name === 'index' ? parts[1] : `${parts[1]}-${name}`
}
/** The surfaces whose preload bundles a renderer file: itself, or the preloads importing it */
const surfacesOf = new Map(
  rendererFiles.map((f) => {
    if (preloads.includes(f)) return [f, [surfaceOf(f)]]
    const stem = f.split(sep).pop()!.replace(/\.ts$/, '')
    const users = preloads.filter((p) =>
      new RegExp(`['/]${stem}['.]`).test(readFileSync(p, 'utf8')),
    )
    return [f, users.map(surfaceOf).sort()]
  }),
)

/** Main side, one module per file or folder directly under its root (as tools/main-inventory) */
interface MainRoot {
  owner: string
  dir: string
}
const mainRoots: MainRoot[] = [
  ...apps
    .filter((app) => existsSync(join(root, 'apps', app, 'src', 'main')))
    .map((app) => ({ owner: app, dir: join(root, 'apps', app, 'src', 'main') })),
  ...packages
    .filter((p) =>
      sourcesUnder(join(root, 'packages', p, 'src')).some(
        (f) => !f.includes(`${sep}shims${sep}`) && mentions(f, 'ipcMain'),
      ),
    )
    .map((p) => ({ owner: p, dir: join(root, 'packages', p, 'src') })),
]
const mainFiles = mainRoots.flatMap((r) =>
  sourcesUnder(r.dir).filter((f) => !rendererFiles.includes(f)),
)

function moduleOf(file: string): string | undefined {
  for (const r of mainRoots) {
    const inner = relative(r.dir, file)
    if (inner.startsWith('..')) continue
    const parts = inner.split(sep)
    return parts.length > 1
      ? `${r.owner}/${parts[0]}/`
      : `${r.owner}/${parts[0].replace(/\.(ts|tsx|mts)$/, '')}`
  }
  return undefined
}

const base = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')) as {
  compilerOptions: Record<string, unknown>
}
const options = ts.convertCompilerOptionsFromJson(
  { ...base.compilerOptions, types: [], noEmit: true, allowJs: false },
  root,
).options
const program = ts.createProgram([...rendererFiles, ...mainFiles], options)
const checker = program.getTypeChecker()

/**
 * The literal values an expression may hold, or undefined when it is only
 * `string`. A parameter (`function outcome(channel: string, ...)`) is read
 * through the calls of its function in the same file, one level deep.
 */
function literalsOf(node: ts.Expression, deep = true): string[] | undefined {
  if (ts.isStringLiteralLike(node)) return [node.text]
  const type = checker.getTypeAtLocation(node)
  const parts = type.isUnion() ? type.types : [type]
  const values: string[] = []
  for (const t of parts) {
    if (!t.isStringLiteral()) return deep ? throughCalls(node) : undefined
    values.push(t.value)
  }
  return values.length > 0 ? values : undefined
}

function throughCalls(node: ts.Expression): string[] | undefined {
  const param = ts.isIdentifier(node)
    ? checker.getSymbolAtLocation(node)?.valueDeclaration
    : undefined
  if (!param || !ts.isParameter(param)) return undefined
  const fn = param.parent
  const name =
    ts.isFunctionDeclaration(fn) && fn.name
      ? fn.name.text
      : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
        ? fn.parent.name.text
        : undefined
  if (!name) return undefined
  const index = fn.parameters.indexOf(param)
  const values: string[] = []
  let complete = true
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      const arg = n.arguments[index]
      const found = arg ? literalsOf(arg, false) : undefined
      if (found) values.push(...found)
      else complete = false
    }
    ts.forEachChild(n, visit)
  }
  visit(param.getSourceFile())
  return complete && values.length > 0 ? values : undefined
}

type RendererKind = 'invoke' | 'send' | 'sendSync' | 'event' | 'port'
const RENDERER_METHODS: Record<string, RendererKind> = {
  invoke: 'invoke',
  send: 'send',
  sendSync: 'sendSync',
  on: 'event',
  once: 'event',
  addListener: 'event',
  removeListener: 'event',
  removeAllListeners: 'event',
  off: 'event',
  postMessage: 'port',
}
const MAIN_METHODS = ['handle', 'handleOnce', 'on', 'once', 'removeHandler']

interface Site {
  file: string
  line: number
}
interface Unresolved extends Site {
  side: 'renderer' | 'main'
  method: string
  expr: string
  module?: string
}
interface Channel {
  name: string
  kinds: RendererKind[]
  renderer: Site[]
  /** modules that register it on ipcMain */
  handlers: string[]
  /** modules that name it outside an ipcMain registration (senders of an event) */
  senders: string[]
  /** the preloads that reach it: the webviews allowed to use it */
  surfaces: string[]
  batch?: string
  owner?: string
}

const channels = new Map<string, Channel>()
const unresolved: Unresolved[] = []
const preloadApis = new Map<string, Set<string>>()
/** surface → the window globals its preload exposes */
const globals = new Map<string, string[]>()
const channelOf = (name: string): Channel => {
  let c = channels.get(name)
  if (!c) {
    c = { name, kinds: [], renderer: [], handlers: [], senders: [], surfaces: [] }
    channels.set(name, c)
  }
  return c
}
const push = <T>(list: T[], v: T): void => {
  if (!list.includes(v)) list.push(v)
}
const siteOf = (sf: ts.SourceFile, node: ts.Node): Site => ({
  file: rel(sf.fileName),
  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
})

/** `ipcRenderer.x(...)`, `electron.ipcRenderer.x(...)`, or a bridge's `ipc` parameter */
const isOn = (expr: ts.Expression, names: string[]): boolean =>
  (ts.isIdentifier(expr) && names.includes(expr.text)) ||
  (ts.isPropertyAccessExpression(expr) && names.includes(expr.name.text))

for (const file of rendererFiles) {
  const sf = program.getSourceFile(file)
  if (!sf) continue
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'electron'
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        const apis = preloadApis.get(rel(file)) ?? new Set<string>()
        for (const el of bindings.elements) {
          if (!el.isTypeOnly && !node.importClause?.isTypeOnly)
            apis.add((el.propertyName ?? el.name).text)
        }
        preloadApis.set(rel(file), apis)
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exposeInMainWorld' &&
      node.arguments.length > 0
    ) {
      for (const s of surfacesOf.get(file)!) {
        const list = globals.get(s) ?? []
        for (const name of literalsOf(node.arguments[0]) ?? ['?']) push(list, name)
        globals.set(s, list)
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text in RENDERER_METHODS &&
      isOn(node.expression.expression, ['ipcRenderer', 'ipc']) &&
      node.arguments.length > 0
    ) {
      const method = node.expression.name.text
      const names = literalsOf(node.arguments[0])
      if (!names) {
        unresolved.push({
          side: 'renderer',
          method,
          expr: node.arguments[0].getText(sf),
          ...siteOf(sf, node),
        })
      } else {
        for (const name of names) {
          const c = channelOf(name)
          push(c.kinds, RENDERER_METHODS[method])
          c.renderer.push(siteOf(sf, node))
          for (const s of surfacesOf.get(file)!) push(c.surfaces, s)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

/** Expressions worth asking the checker about: they may hold a channel name */
const candidate = (node: ts.Node): node is ts.Expression =>
  ts.isStringLiteralLike(node) ||
  (ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessExpression(node.parent)) ||
  ts.isElementAccessExpression(node) ||
  (ts.isIdentifier(node) &&
    !ts.isPropertyAccessExpression(node.parent) &&
    !ts.isPropertyAssignment(node.parent) &&
    !ts.isVariableDeclaration(node.parent) &&
    !ts.isBindingElement(node.parent) &&
    !ts.isImportSpecifier(node.parent) &&
    !ts.isParameter(node.parent) &&
    !ts.isTypeReferenceNode(node.parent))

for (const file of mainFiles) {
  const sf = program.getSourceFile(file)
  const mod = moduleOf(file)
  if (!sf || !mod) continue
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MAIN_METHODS.includes(node.expression.name.text) &&
      isOn(node.expression.expression, ['ipcMain']) &&
      node.arguments.length > 0
    ) {
      const names = literalsOf(node.arguments[0])
      if (!names) {
        unresolved.push({
          side: 'main',
          method: node.expression.name.text,
          expr: node.arguments[0].getText(sf),
          module: mod,
          ...siteOf(sf, node),
        })
      } else {
        for (const name of names) push(channelOf(name).handlers, mod)
      }
      for (const arg of node.arguments.slice(1)) visit(arg)
      return
    }
    if (candidate(node)) {
      const names = literalsOf(node, false)
      if (names) {
        for (const name of names) {
          const c = channels.get(name)
          if (c) push(c.senders, mod)
        }
        if (ts.isStringLiteralLike(node)) return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

/**
 * The area batches of stage 3, first rule that matches a channel name. A
 * channel nothing matches goes by the app of the module that answers it.
 */
const BATCHES = [
  {
    id: 'U',
    title:
      '업데이트·충돌·실행 복구: 업데이터와 업데이트 창, 충돌 감시, 실행 복구 목록. 각 앱의 문서 복구는 그 문서 상태를 가진 D1·D2에',
    en: 'Updates, crash and launch recovery',
    rule: /^update[:-]|^recovery:(?:get|submit)-launch-list$|crash|relaunch/,
  },
  {
    id: 'A',
    title:
      'AI·네트워크·비밀값: 에이전트 창, MCP, 사용자 스킬, 생성, 각 앱의 AI, 드라이브, 연동, 지식 창고, safeStorage',
    en: 'AI, network and secrets',
    rule: /^ai[:-]|:ai[-:]|-ai[-:]|:free-ai|^agent|^skills|^mcp|^generate|^drive|^zotero|^kb:|^integrations|subscription|outbound|internet|doc-attach|:mcp-|^inbox/,
  },
  {
    id: 'M',
    title:
      '메뉴·인쇄·앱 설정: 앱 메뉴, 문맥 메뉴, 단축키, 인쇄, 언어·테마·글꼴·작성자·화면 배율 같은 앱 전역 질의',
    en: 'Menus, printing and app-wide settings',
    rule: /^app:|^menu|context-menu|print|theme|language|locale|font|author|ui-scale|zoom|spell|shortcut|^user:|^seuoffice:/,
  },
  {
    id: 'W',
    title:
      '창과 탭: 홈 화면, 탭, 분리·분할 창, 프로젝트 폴더, 문서 고르기, 빠른 보기, preload 다시 만들기',
    en: 'Windows, tabs and the re-created preloads',
    rule: /^home:|^tabs:|^win:|^shell:|^project|^doc-picker|^quick-look|^files:|^split|^doc:/,
  },
  {
    id: 'D1',
    title: '문서 1(그림 앱): 슬라이드, 엑셀, 마인드맵, 다이어그램의 열기·저장·내보내기·편집',
    en: 'Documents 1: slides, sheets, mind maps, diagrams',
    rule: /^(slides|workbook|sheets|mindmap|diagram):/,
  },
  {
    id: 'D2',
    title:
      '문서 2(글 앱): 워드, 한글, HTML, 마크다운, EPUB, PDF와 PDF 도구의 열기·저장·내보내기·편집',
    en: 'Documents 2: docs, hwp, html, markdown, epub, pdf',
    rule: /^(docs|hwp|html|markdown|epub|pdf|pdf-tools|pdf-password):/,
  },
] as const
/** channels whose name matches an earlier batch's rule but whose state lives elsewhere */
const PINNED: Record<string, string> = {
  'slides:font-install-local': 'D1',
}
const APP_BATCH: Record<string, string> = {
  shell: 'W',
  slides: 'D1',
  sheets: 'D1',
  mindmap: 'D1',
  diagram: 'D1',
  'ai-provider': 'A',
}

for (const c of channels.values()) {
  const owners = c.handlers.length > 0 ? c.handlers : c.senders
  c.owner = owners[0]
  c.batch =
    PINNED[c.name] ??
    BATCHES.find((b) => b.rule.test(c.name))?.id ??
    (c.owner ? (APP_BATCH[c.owner.split('/')[0]] ?? 'D2') : undefined)
}

/**
 * An app's entry (`*-main`, `index`) registers channels of every area: it is
 * shared, every batch reads it, none edits it, and it goes with Electron in
 * the final batch. Any other module is ported by the batch most of its
 * channels belong to; a channel of another batch that it answers is written
 * by that batch on top of the ported module.
 */
const ENTRY = /-main$|\/index$/
const moduleChannels = new Map<string, Map<string, number>>()
for (const c of channels.values()) {
  if (!c.batch) continue
  for (const m of new Set([...c.handlers, ...c.senders])) {
    const counts = moduleChannels.get(m) ?? new Map<string, number>()
    counts.set(c.batch, (counts.get(c.batch) ?? 0) + 1)
    moduleChannels.set(m, counts)
  }
}
const moduleBatches = new Map<string, string>()
const sharedModules: string[] = []
for (const [m, counts] of moduleChannels) {
  if (ENTRY.test(m)) {
    sharedModules.push(m)
    continue
  }
  const top = Math.max(...counts.values())
  moduleBatches.set(m, BATCHES.find((b) => counts.get(b.id) === top)!.id)
}
sharedModules.sort()

const list = [...channels.values()].sort((a, b) => a.name.localeCompare(b.name))
const summary = {
  rendererFiles: rendererFiles.length,
  rendererSites: list.reduce((n, c) => n + c.renderer.length, 0),
  channels: list.length,
  byKind: Object.fromEntries(
    (['invoke', 'send', 'sendSync', 'event', 'port'] as const).map((k) => [
      k,
      list.filter((c) => c.kinds.includes(k)).length,
    ]),
  ),
  withoutHandler: list.filter((c) => !c.batch).map((c) => c.name),
  unresolved: unresolved.length,
  preloadElectronApis: Object.fromEntries(
    [...preloadApis].map(([f, s]) => [f, [...s].sort()]).sort(),
  ),
  batches: BATCHES.map((b) => {
    const cs = list.filter((c) => c.batch === b.id)
    const mods = [...moduleBatches].filter(([, id]) => id === b.id).map(([m]) => m)
    return {
      id: b.id,
      title: b.title,
      channels: cs.length,
      invoke: cs.filter((c) => c.kinds.includes('invoke')).length,
      send: cs.filter((c) => c.kinds.includes('send') || c.kinds.includes('sendSync')).length,
      event: cs.filter((c) => c.kinds.includes('event')).length,
      modules: mods.sort(),
    }
  }),
  sharedModules,
}

const out = join(tool, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'channels.json'), `${JSON.stringify(list, null, 2)}\n`)
writeFileSync(join(out, 'unresolved.json'), `${JSON.stringify(unresolved, null, 2)}\n`)
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const { batches, sharedModules: shared, ...head } = summary
console.log(
  JSON.stringify(
    { ...head, withoutHandler: head.withoutHandler.length, preloadElectronApis: undefined },
    null,
    2,
  ),
)
for (const b of batches) {
  console.log(`${b.id}: ${b.channels} channels, ${b.modules.length} modules`)
}

if (process.argv.includes('--markdown')) {
  console.log('\n| 묶음 | 무엇 | 채널 | invoke | send | 이벤트 | 맡는 중심 모듈 |')
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |')
  for (const b of batches) {
    console.log(
      `| ${b.id} | ${b.title} | ${b.channels} | ${b.invoke} | ${b.send} | ${b.event} | ${b.modules.length} |`,
    )
  }
  for (const b of batches) {
    console.log(`\n${b.id}: ${b.modules.map((m) => `\`${m}\``).join(', ')}`)
  }
  console.log(`\n공용 진입 모듈: ${shared.map((m) => `\`${m}\``).join(', ')}`)
}

/**
 * The channel registry of crates/shell-contract: the surfaces (one per
 * preload), the batches, and one spec per channel. The shell checks at start
 * that every spec has a handler and that a webview only reaches the channels
 * its preload reaches.
 */
if (process.argv.includes('--rust')) {
  const pascal = (id: string): string =>
    id.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase())
  const KIND: Record<RendererKind, string> = {
    invoke: 'Invoke',
    send: 'Send',
    sendSync: 'SendSync',
    event: 'Event',
    port: 'Port',
  }
  const surfaces = preloads.map(surfaceOf).sort()
  const lines = [
    '//! Generated by `npx tsx tools/shell-inventory/channels.ts --rust`: do not edit.',
    '//! Every IPC channel a renderer of the Electron build reaches, with its',
    '//! area batch and the surfaces (preloads) that reach it.',
    '',
    'use crate::ipc::ChannelKind::{self, *};',
    '',
    '/// A kind of webview, named after the preload it loads',
    '#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]',
    'pub enum Surface {',
    ...surfaces.map(
      (s) => `    /// \`${rel(preloads.find((p) => surfaceOf(p) === s)!)}\`\n    ${pascal(s)},`,
    ),
    '}',
    '',
    '/// The area batches of stage 3, in the stage 3 shell contract document under docs/seuoffice',
    '#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]',
    'pub enum Batch {',
    ...BATCHES.map((b) => `    /// ${b.en}\n    ${b.id},`),
    '}',
    '',
    '/// One channel: its Electron name, how renderers use it, who ports it, who may reach it',
    '#[derive(Debug)]',
    'pub struct ChannelSpec {',
    "    pub name: &'static str,",
    "    pub kinds: &'static [ChannelKind],",
    '    pub batch: Batch,',
    "    pub surfaces: &'static [Surface],",
    '}',
    '',
    'use Batch::*;',
    'use Surface::*;',
    '',
    'const fn spec(',
    "    name: &'static str,",
    "    kinds: &'static [ChannelKind],",
    '    batch: Batch,',
    "    surfaces: &'static [Surface],",
    ') -> ChannelSpec {',
    '    ChannelSpec { name, kinds, batch, surfaces }',
    '}',
    '',
    'pub const CHANNELS: &[ChannelSpec] = &[',
    ...list
      .filter((c) => c.batch)
      .map(
        (c) =>
          `    spec(${JSON.stringify(c.name)}, &[${c.kinds.map((k) => KIND[k]).join(', ')}], ${c.batch}, &[${[...c.surfaces].sort().map(pascal).join(', ')}]),`,
      ),
    '];',
    '',
    '/// A preload of the Electron build: the webview kind, its source, and the',
    '/// globals it exposes with `contextBridge.exposeInMainWorld`',
    '#[derive(Debug)]',
    'pub struct PreloadSpec {',
    '    pub surface: Surface,',
    "    pub source: &'static str,",
    "    pub globals: &'static [&'static str],",
    '}',
    '',
    'pub const PRELOADS: &[PreloadSpec] = &[',
    ...surfaces.map((s) => {
      const source = rel(preloads.find((p) => surfaceOf(p) === s)!)
      const names = (globals.get(s) ?? []).sort().map((g) => JSON.stringify(g))
      return `    PreloadSpec { surface: ${pascal(s)}, source: ${JSON.stringify(source)}, globals: &[${names.join(', ')}] },`
    }),
    '];',
    '',
  ]
  const target = join(root, 'crates', 'shell-contract', 'src', 'channels.rs')
  writeFileSync(target, lines.join('\n'))
  execFileSync('rustfmt', ['--edition', '2024', target])
  console.log(`wrote ${rel(target)}`)
}
