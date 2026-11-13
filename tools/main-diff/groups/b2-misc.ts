/**
 * Group `b2-misc`: packages/i18n and the small modules of packages/electron-utils
 * (user-skills-channels, mcp-tools-channels, outbound-channels, doc-attach-channels,
 * project-folder-bridge, split-pane-bridge, default-save-dir, dialog-memory,
 * author-name, font-store, github-menu, hwp-default-format, numbered-export-paths,
 * template-font-response, template-fonts-dir, abort-on-destroyed, marked-odt), the
 * `PROJECT_FOLDER_*` constants of project-store/folder-api and `templateFontFileOf`
 * of ui/template-fonts.
 *
 * A `Uint8Array` crosses as `{"$bytes": byteLength}` (both ways). A function that
 * drives a fake (a bridge, a dialog, a sender) takes a list of steps and answers
 * one entry per step; each call of the fake is one log line. The i18n functions
 * are named `i18n.<export>`; `getUiLang`/`setUiLang` are not ported (the language
 * is an argument), so `documentLocale` sets the requested locale first.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import {
  LANGS,
  createI18n,
  documentLocale,
  documentLocaleFor,
  format,
  htmlDir,
  htmlLang,
  installLang,
  isLang,
  isRtlLang,
  macShortcutsToWin,
  normalizeLang,
  platformShortcuts,
  requestedLanguage,
  setUiLang,
  productName,
  UPSTREAM_PRODUCT_NAME,
  PRODUCT_NAME,
  USER_DATA_DIR_NAME,
  DEV_USER_DATA_DIR_NAME,
  PRODUCT_REPO_OWNER,
  PRODUCT_REPO_NAME,
  PRODUCT_REPO_SLUG,
  OLD_ENV_PREFIX,
  ENV_PREFIX,
  OLD_ENV_NAMES,
  adoptOldEnv,
  OLD_HOME_DIR_NAMES,
  OLD_PROJECT_DATA_DIR_NAMES,
  OLD_CLI_COMMANDS,
  OLD_CLI_BUNDLE_FILES,
  OLD_MCP_SERVER_NAMES,
  OLD_APP_MCP_SERVER_NAMES,
  OLD_SKILL_NAMES,
  OLD_MCP_RESOURCE_SCHEMES,
  OLD_MCP_TOOL_NAMES,
  existingOrCurrent,
  type Lang,
} from '../../../packages/i18n/src/index.ts'
import {
  USER_SKILLS_BRIDGE_KEY,
  USER_SKILLS_CHANNELS,
  USER_SKILL_PREVIEW_TEXT_MAX_CHARS,
  skillIdOf,
  invokeOf,
  editorsValueOf,
  statePatchOf,
  USER_SKILL_BODY_MAX,
  saveInputOf,
  USER_SKILL_TEMPLATE_MAX_BYTES,
  cardSaveInputOf,
  USER_SKILL_PASTE_MAX_CHARS,
  importTextOf,
  USER_SKILL_BUNDLE_MAX,
  skillIdListOf,
  installRequestOf,
  skillViewsOf,
  skillsResultOf,
  USER_SKILL_HANDOFF_TEXT_MAX,
  templateOpenInputOf,
  previewInputOf,
  handoffTargetOf,
  previewEndedOf,
} from '../../../packages/electron-utils/src/user-skills-channels.ts'
import {
  MCP_TOOLS_BRIDGE_KEY,
  MCP_TOOLS_CHANNELS,
  mcpServerNameOf,
  mcpCallIdOf,
  mcpToolCallRequestOf,
} from '../../../packages/electron-utils/src/mcp-tools-channels.ts'
import {
  OUTBOUND_CHANNELS,
  MAX_CONFIRM_ADDRESSES,
  MAX_CONFIRM_ADDRESS_LENGTH,
  confirmRequestOf,
} from '../../../packages/electron-utils/src/outbound-channels.ts'
import {
  DOC_ATTACH_CHANNELS,
  DOC_ATTACH_BRIDGE_KEY,
} from '../../../packages/electron-utils/src/doc-attach-channels.ts'
import {
  PROJECT_FOLDER_NAMES,
  PROJECT_FOLDER_EVENTS,
  PROJECT_FOLDER_CHANNELS,
  PROJECT_FOLDER_LISTEN_CHANNEL,
  PROJECT_FOLDER_BRIDGE_KEY as FOLDER_API_BRIDGE_KEY,
} from '../../../packages/project-store/src/folder-api.ts'
import {
  PROJECT_FOLDER_BRIDGE_KEY,
  projectFolderBridge,
} from '../../../packages/electron-utils/src/project-folder-bridge.ts'
import {
  SPLIT_PANE_CHANNELS,
  SPLIT_PANE_BRIDGE_KEY,
  splitPaneBridge,
} from '../../../packages/electron-utils/src/split-pane-bridge.ts'
import {
  DEFAULT_SAVE_DIR_KEY,
  readDefaultSaveDirSetting,
  createDirLevels,
  isUsableSaveDir,
  resolveDefaultSaveDir,
  defaultSaveDirFallback,
  documentsDirOrFallback,
  configuredDefaultSaveDir,
  type PathProvider,
} from '../../../packages/electron-utils/src/default-save-dir.ts'
import {
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  saveAsSuggestion,
} from '../../../packages/electron-utils/src/dialog-memory.ts'
import {
  AUTHOR_NAME_KEY,
  AUTHOR_NAME_MAX,
  sanitizeAuthorName,
  readAuthorNameSetting,
  systemAuthorName,
  resolveAuthorName,
  configuredAuthorName,
} from '../../../packages/electron-utils/src/author-name.ts'
import { installLocalFontFiles } from '../../../packages/electron-utils/src/font-store.ts'
import {
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REPO_SLUG,
  GITHUB_REPO_URL,
  GITHUB_REPO_DISPLAY,
  GITHUB_ISSUES_URL,
  GITHUB_NEW_ISSUE_URL,
  GITHUB_RELEASES_URL,
  GITHUB_LATEST_RELEASE_URL,
  githubReleaseTagUrl,
} from '../../../packages/electron-utils/src/github-menu.ts'
import {
  HWP_DEFAULT_FORMAT_KEY,
  normalizeHwpDefaultFormat,
  readHwpDefaultFormat,
} from '../../../packages/electron-utils/src/hwp-default-format.ts'
import {
  markedOdtBox,
  markedOdtChoice,
  type MarkedOdtText,
} from '../../../packages/electron-utils/src/marked-odt.ts'
import { numberedExportPaths } from '../../../packages/electron-utils/src/numbered-export-paths.ts'
import { templateFontResponse } from '../../../packages/electron-utils/src/template-font-response.ts'
import {
  TEMPLATE_FONT_SCHEME,
  TEMPLATE_FONT_HOST,
  TEMPLATE_FONT_FILES,
  templateFontFileOf,
} from '../../../packages/ui/src/template-fonts.ts'
import {
  TEMPLATE_FONTS_DIR_NAME,
  TEMPLATE_FONTS_REPO_DIR,
  templateFontsDir,
} from '../../../packages/electron-utils/src/template-fonts-dir.ts'
import { abortOnDestroyed } from '../../../packages/electron-utils/src/abort-on-destroyed.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

// ---------- helpers ----------

/** One case per argument list. */
const each = (...sets: unknown[][]): Case[] => sets.map((args) => ({ args }))

/** A constant: one answer is all there is. */
const constant = (ts: () => unknown): FnSpec => ({
  ts,
  cases: [{ args: [] }],
  single: 'a constant',
})

/** `{"$bytes": n}` is a `Uint8Array` of n bytes; the rest is copied. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 1 && entries[0]![0] === '$bytes' && typeof entries[0]![1] === 'number') {
      return new Uint8Array(entries[0]![1])
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, revive(v)]))
  }
  return value
}

/** A `Uint8Array` is `{"$bytes": byteLength}`; the rest is copied. */
function flatten(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: value.byteLength }
  if (Array.isArray(value)) return value.map(flatten)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flatten(v)]))
  }
  return value
}

const bytes = (n: number): { $bytes: number } => ({ $bytes: n })

/** An object with an own `__proto__` key, as `JSON.parse` makes it. */
const parsed = (text: string): unknown => JSON.parse(text)

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---------- i18n ----------

const langCases = each(
  ['en'],
  ['ko'],
  ['EN'],
  ['fr'],
  [''],
  [null],
  [5],
  [['en']],
  [{}],
  [' en'],
  [],
)

const shortcutTexts = [
  '\u2318S',
  '\u21E7\u2318Z',
  '\u2318+Click',
  '\u2318/Ctrl+Enter',
  '\u2318/Ab',
  '\u2318/ A',
  '\u2325F4',
  '\u2318\u23CE',
  '\u232B',
  'Press \u2318 then +',
  'no symbols here',
  '\u2318F12',
  '\u2318F123',
  '\u2318\u2325\u21E7A',
  '\u2303Tab',
  '\u2318+',
  '\u2318[',
  '\u2318\\',
  '\u2318\u2190',
  '\u2318\u00B1',
  '\u2318\u2423',
  'a \u21A9 b \u2326 c',
  '\u{1F600}\u2318S',
  '',
  '\u2318',
  '\u2318\u2318C',
  '\u21E7',
  '\u2318,',
  '\u2318.',
  '\u2318\u2326',
]

const i18nGroup: Record<string, FnSpec> = {
  'i18n.LANGS': constant(() => [...LANGS]),
  'i18n.isLang': { ts: (a) => isLang(a[0]), cases: langCases },
  'i18n.normalizeLang': {
    ts: (a) => normalizeLang(a[0] as string | null | undefined),
    cases: each(
      ['ko'],
      ['KO'],
      [' ko '],
      ['ko-KR'],
      ['ko_KR'],
      ['ko-'],
      ['kor'],
      ['en'],
      [''],
      ['fr'],
      [null],
      [],
      ['\u212Ao'],
      ['\u212Ao-KR'],
      ['\u0131ko'],
      ['k\u0131'],
      ['\u00a0ko\u00a0'],
      ['ko\u0085'],
      ['KO_kr'],
    ),
  },
  'i18n.requestedLanguage': {
    ts: (a) => requestedLanguage(a[0], a[1] as string | null | undefined),
    cases: each(
      ['ja', 'de-DE'],
      ['  ', 'de-DE'],
      ['', 'de-DE'],
      [5, 'de-DE'],
      [null, 'de-DE'],
      [null, null],
      [[], 'fr'],
      [' ja ', null],
      ['ko', 'en'],
      [],
      ['\u00a0', 'fr'],
    ),
  },
  'i18n.installLang': {
    ts: (a) => installLang(a[0], a[1] as string | null | undefined),
    cases: each(
      ['ko', 'en-US'],
      [null, 'ko-KR'],
      ['ja', 'ko-KR'],
      ['', 'ko_KR'],
      [null, null],
      [5, 'ko'],
      ['en', 'ko'],
      [' KO ', 'en'],
    ),
  },
  'i18n.htmlLang': { ts: (a) => htmlLang(a[0] as Lang), cases: each(['en'], ['ko']) },
  'i18n.isRtlLang': {
    ts: (a) => isRtlLang(a[0] as string | null | undefined),
    cases: each(['ar'], ['he'], ['AR'], ['en'], [null], [''], ['ar-SA'], []),
  },
  'i18n.htmlDir': {
    ts: (a) => htmlDir(a[0] as string | null | undefined),
    cases: each(['ar'], ['he'], ['AR'], ['ko'], [null], [''], ['he-IL'], []),
  },
  'i18n.macShortcutsToWin': {
    ts: (a) => macShortcutsToWin(a[0] as string),
    cases: shortcutTexts.map((t) => ({ args: [t] })),
  },
  'i18n.platformShortcuts': {
    ts: (a) => platformShortcuts(a[0] as string),
    cases: shortcutTexts.map((t) => ({ args: [t] })),
  },
  'i18n.format': {
    ts: (a) => format(a[0] as string, a[1] as Record<string, string | number> | undefined),
    cases: each(
      ['{a} and {b}', { a: 'x', b: 2 }],
      ['{a} and {b}', { a: 'x' }],
      ['{a}', { a: null }],
      ['{a}', null],
      ['{a}', {}],
      ['{}', { a: 1 }],
      ['{a_1} {A} {1}', { a_1: 'u', A: 'v', 1: 'w' }],
      ['{\u00e9}', { é: 'x' } as unknown as Record<string, string>],
      ['{{a}}', { a: 'x' }],
      ['{a}{a}', { a: 0 }],
      ['{a}', { a: false }],
      ['{a}', { a: 1.5 }],
      ['{a}', { a: 1e21 }],
      ['{a}', { a: [1, 2] }],
      ['{toString} {hasOwnProperty}', {}],
      ['{a', { a: 1 }],
      ['\u{1F600} {a} \u{1F600}', { a: '\u{1F600}' }],
      ['{a}', parsed('{"__proto__":"p","a":"q"}')],
      ['{__proto__}', parsed('{"__proto__":"p"}')],
      ['', { a: 1 }],
      ['{ a }', { a: 1 }],
      ['{a\u0131}', { a: 1 }],
    ),
  },
  'i18n.createI18n': {
    ts: (a) =>
      createI18n({ en: a[0] as Record<string, string>, ko: a[1] as Record<string, string> })(
        a[2] as Lang,
        a[3] as string,
        (a[4] ?? undefined) as Record<string, string | number> | undefined,
      ),
    cases: each(
      [{ hi: 'Hello {name}' }, { hi: '\uc548\ub155 {name}' }, 'ko', 'hi', { name: 'x' }],
      [{ hi: 'Hello {name}' }, { hi: '\uc548\ub155 {name}' }, 'en', 'hi', { name: 'x' }],
      [{ hi: 'Hello' }, {}, 'ko', 'hi', null],
      [{ hi: 'Hello' }, {}, 'ko', 'nope', null],
      [{ hi: '' }, { hi: '' }, 'ko', 'hi', null],
      [{ hi: 'Hello' }, { hi: '' }, 'ko', 'hi', null],
      [{ save: 'Save (\u2318S)' }, { save: '\uc800\uc7a5 (\u2318S)' }, 'ko', 'save', null],
      [{ save: 'Save (\u21E7\u2318Z)' }, {}, 'en', 'save', null],
      [{ a: '{n} {m}' }, {}, 'en', 'a', { n: 1 }],
    ),
  },
  'i18n.documentLocaleFor': {
    ts: (a) => documentLocaleFor(a[0] as string | null | undefined),
    cases: each(
      ['ja-JP'],
      ['zh_CN'],
      ['zh-Hant-HK'],
      ['zh-tw'],
      ['zh-CN'],
      ['zh'],
      ['zh-Hans'],
      ['Zh_hk'],
      ['zh-mo'],
      ['zh_Hant'],
      ['de'],
      ['DE-at'],
      ['in'],
      ['in-ID'],
      ['inx'],
      ['in.'],
      ['iw'],
      ['iw_IL'],
      ['iwx'],
      [' ko '],
      [''],
      [null],
      [],
      ['ko'],
      ['kok'],
      ['it'],
      ['ita'],
      ['ms-MY'],
      ['ar'],
      ['\u212Ao'],
      ['\u0131n'],
      ['\u0130n'],
      ['en-US'],
      ['vi_VN'],
      ['th-'],
      ['\u00a0ja\u00a0'],
    ),
  },
  'i18n.documentLocale': {
    ts: (a) => {
      setUiLang('en', a[0] as string)
      return documentLocale()
    },
    cases: each(['ja'], [''], ['zh_TW'], ['ko-KR'], ['fr-CA'], ['xx'], ['en']),
  },
  'i18n.productName': {
    ts: (a) => productName(a[0] as string | null | undefined),
    cases: each(['ko'], ['en'], [''], [null], ['ko-KR'], ['x'], ['KO_kr'], []),
    single: 'SeuOffice has no localized name yet, so every language shows the product name',
  },
  'i18n.UPSTREAM_PRODUCT_NAME': constant(() => UPSTREAM_PRODUCT_NAME),
  'i18n.PRODUCT_NAME': constant(() => PRODUCT_NAME),
  'i18n.USER_DATA_DIR_NAME': constant(() => USER_DATA_DIR_NAME),
  'i18n.DEV_USER_DATA_DIR_NAME': constant(() => DEV_USER_DATA_DIR_NAME),
  'i18n.PRODUCT_REPO_OWNER': constant(() => PRODUCT_REPO_OWNER),
  'i18n.PRODUCT_REPO_NAME': constant(() => PRODUCT_REPO_NAME),
  'i18n.PRODUCT_REPO_SLUG': constant(() => PRODUCT_REPO_SLUG),
  'i18n.OLD_ENV_PREFIX': constant(() => OLD_ENV_PREFIX),
  'i18n.ENV_PREFIX': constant(() => ENV_PREFIX),
  'i18n.OLD_ENV_NAMES': constant(() => [...OLD_ENV_NAMES]),
  'i18n.adoptOldEnv': {
    ts: (a) => {
      const env = { ...(a[0] as Record<string, string>) }
      const adopted = adoptOldEnv(env)
      return { adopted, env }
    },
    cases: each(
      [{ GENOFFICE_USER_DATA: '/x' }],
      [{ GENOFFICE_USER_DATA: '/x', SEUOFFICE_USER_DATA: '/y' }],
      [{ GENOFFICE_USER_DATA: '/x', SEUOFFICE_USER_DATA: '' }],
      [{ GENOFFICE_BUILD: 'b', GENOFFICE_MCP_TOKEN: 't', GENOFFICE_APP_BIN: '' }],
      [{}],
      [{ 7: 'seven', GENOFFICE_AUTH_DIR: 'a', 2: 'two', GENOFFICE_AI_SETTINGS: 's' }],
      [
        {
          GENOFFICE_USER_DATA: '1',
          GENOFFICE_ALLOWED_ROOTS: '2',
          GENOFFICE_TRUST_PROXY_HEADERS: '3',
        },
      ],
    ),
  },
  'i18n.OLD_HOME_DIR_NAMES': constant(() => [...OLD_HOME_DIR_NAMES]),
  'i18n.OLD_PROJECT_DATA_DIR_NAMES': constant(() => [...OLD_PROJECT_DATA_DIR_NAMES]),
  'i18n.OLD_CLI_COMMANDS': constant(() => [...OLD_CLI_COMMANDS]),
  'i18n.OLD_CLI_BUNDLE_FILES': constant(() => [...OLD_CLI_BUNDLE_FILES]),
  'i18n.OLD_MCP_SERVER_NAMES': constant(() => [...OLD_MCP_SERVER_NAMES]),
  'i18n.OLD_APP_MCP_SERVER_NAMES': constant(() => [...OLD_APP_MCP_SERVER_NAMES]),
  'i18n.OLD_SKILL_NAMES': constant(() => [...OLD_SKILL_NAMES]),
  'i18n.OLD_MCP_TOOL_NAMES': constant(() => ({ ...OLD_MCP_TOOL_NAMES })),
  'i18n.OLD_MCP_RESOURCE_SCHEMES': constant(() => [...OLD_MCP_RESOURCE_SCHEMES]),
  'i18n.existingOrCurrent': {
    ts: (a, cx) => {
      const present = new Set(a[2] as string[])
      const exists = (name: string) => {
        cx.log(name)
        return present.has(name)
      }
      // a fourth argument is `inUse`, given as the names in use
      if (a[3] === undefined || a[3] === null)
        return existingOrCurrent(a[0] as string, a[1] as string[], exists)
      const used = new Set(a[3] as string[])
      return existingOrCurrent(a[0] as string, a[1] as string[], exists, (name) => {
        cx.log('inUse', name)
        return used.has(name)
      })
    },
    cases: each(
      ['new', ['old1', 'old2'], ['new', 'old1']],
      ['new', ['old1', 'old2'], ['old2', 'old1']],
      ['new', ['old1', 'old2'], ['old2']],
      ['new', ['old1', 'old2'], []],
      ['new', [], ['new']],
      ['new', [], []],
      ['', ['a'], ['a']],
      ['new', ['old1'], ['new', 'old1'], []],
      ['new', ['old1'], ['new', 'old1'], ['new']],
      ['new', ['old1'], ['new'], []],
      ['new', [], ['new'], []],
    ),
  },
}

// ---------- user-skills-channels ----------

const skillBase = { title: 'T', description: 'D', body: 'B' }
const longText = (n: number): string => 'a'.repeat(n)
const astral = '\u{1F600}'

const userSkills: Record<string, FnSpec> = {
  'user-skills-channels.USER_SKILLS_BRIDGE_KEY': constant(() => USER_SKILLS_BRIDGE_KEY),
  'user-skills-channels.USER_SKILLS_CHANNELS': constant(() => ({ ...USER_SKILLS_CHANNELS })),
  'user-skills-channels.USER_SKILL_PREVIEW_TEXT_MAX_CHARS': constant(
    () => USER_SKILL_PREVIEW_TEXT_MAX_CHARS,
  ),
  'user-skills-channels.skillIdOf': {
    ts: (a) => skillIdOf(a[0]),
    cases: each(
      ['user:name'],
      ['nocolon'],
      [''],
      [':'],
      [longText(511) + ':'],
      [longText(512)],
      [longText(511) + '::'],
      [astral.repeat(255) + ':'],
      [astral.repeat(256) + ':'],
      [5],
      [null],
      [],
      [['a:b']],
    ),
  },
  'user-skills-channels.invokeOf': {
    ts: (a) => invokeOf(a[0]),
    cases: each(['auto'], ['manual'], ['AUTO'], [''], [null], [1], [], [['auto']]),
  },
  'user-skills-channels.editorsValueOf': {
    ts: (a) => editorsValueOf(a[0]),
    cases: each(
      [],
      ['all'],
      ['ALL'],
      [['docs', 'sheets']],
      [[]],
      [null],
      [5],
      [{}],
      [Array.from({ length: 32 }, (_, i) => `e${i}`)],
      [Array.from({ length: 33 }, (_, i) => `e${i}`)],
      [[longText(32)]],
      [[longText(33)]],
      [[astral.repeat(16)]],
      [[astral.repeat(17)]],
      [['docs', 5]],
      [['docs', null]],
    ),
  },
  'user-skills-channels.statePatchOf': {
    ts: (a) => statePatchOf(a[0]),
    cases: each(
      [{ enabled: true }],
      [{ enabled: false, invoke: 'manual', editors: 'all' }],
      [{ editors: ['docs'] }],
      [{ editors: [] }],
      [{ editors: null, enabled: 'yes' }],
      [{ invoke: 'sometimes' }],
      [{}],
      [[]],
      [null],
      [],
      ['x'],
      [{ invoke: 'auto', enabled: true, editors: ['a'], extra: 1 }],
      [{ editors: Array.from({ length: 33 }, () => 'a'), enabled: true }],
    ),
  },
  'user-skills-channels.USER_SKILL_BODY_MAX': constant(() => USER_SKILL_BODY_MAX),
  'user-skills-channels.saveInputOf': {
    ts: (a) => saveInputOf(a[0]),
    cases: each(
      [skillBase],
      [{ ...skillBase, id: 'user:x', name: 'n', editors: ['docs'], turnOffSameName: true }],
      [{ ...skillBase, id: 'nocolon' }],
      [{ ...skillBase, id: null }],
      [{ ...skillBase, name: '' }],
      [{ ...skillBase, name: 5 }],
      [{ ...skillBase, name: longText(513) }],
      [{ ...skillBase, editors: 'all', turnOffSameName: false }],
      [{ ...skillBase, editors: 7 }],
      [{ ...skillBase, editors: null }],
      [{ title: 'T', description: 'D' }],
      [{ ...skillBase, title: longText(10001) }],
      [{ ...skillBase, title: longText(10000) }],
      [{ ...skillBase, description: longText(100001) }],
      [{ ...skillBase, body: longText(USER_SKILL_BODY_MAX) }],
      [{ ...skillBase, body: longText(USER_SKILL_BODY_MAX + 1) }],
      [{ ...skillBase, body: astral.repeat(1_000_000) }],
      [{ ...skillBase, body: astral.repeat(1_000_001) }],
      [null],
      [[]],
      [],
      [{ id: 'user:x', ...skillBase, name: 'n' }],
    ),
  },
  'user-skills-channels.USER_SKILL_TEMPLATE_MAX_BYTES': constant(
    () => USER_SKILL_TEMPLATE_MAX_BYTES,
  ),
  'user-skills-channels.cardSaveInputOf': {
    ts: (a) => flatten(cardSaveInputOf(revive(a[0]))),
    cases: each(
      [{ ...skillBase, name: 'n' }],
      [{ ...skillBase, name: 'n', invoke: 'manual', overwrite: true, targetId: 'user:t' }],
      [{ ...skillBase, name: 'n', invoke: 'bogus', overwrite: 'yes' }],
      [{ ...skillBase, name: 'n', template: { fileName: 'a.docx', bytes: bytes(3) } }],
      [{ ...skillBase, name: 'n', template: { fileName: 'a.docx', bytes: bytes(0) } }],
      [
        {
          ...skillBase,
          name: 'n',
          template: { fileName: 'a.docx', bytes: bytes(USER_SKILL_TEMPLATE_MAX_BYTES) },
        },
      ],
      [
        {
          ...skillBase,
          name: 'n',
          template: { fileName: 'a.docx', bytes: bytes(USER_SKILL_TEMPLATE_MAX_BYTES + 1) },
        },
      ],
      [{ ...skillBase, name: 'n', template: { fileName: '', bytes: bytes(3) } }],
      [{ ...skillBase, name: 'n', template: { fileName: longText(1025), bytes: bytes(3) } }],
      [{ ...skillBase, name: 'n', template: { fileName: 'a', bytes: [1, 2, 3] } }],
      [{ ...skillBase, name: 'n', template: { fileName: 'a' } }],
      [{ ...skillBase, name: 'n', template: 'x' }],
      [{ ...skillBase, name: 'n', template: null }],
      [{ ...skillBase, name: 'n', template: [] }],
      [{ ...skillBase, name: 'n', targetId: 'bad' }],
      [{ ...skillBase, name: 'n', targetId: null }],
      [{ ...skillBase, name: 'n', editors: ['docs'], turnOffSameName: true }],
      [{ ...skillBase, name: 'n', editors: 3 }],
      [{ ...skillBase }],
      [{ ...skillBase, name: longText(513) }],
      [{ title: 'T', name: 'n', description: 'D' }],
      [{ ...skillBase, name: 'n', description: longText(100001) }],
      [null],
      [],
    ),
  },
  'user-skills-channels.USER_SKILL_PASTE_MAX_CHARS': constant(() => USER_SKILL_PASTE_MAX_CHARS),
  'user-skills-channels.importTextOf': {
    ts: (a) => importTextOf(a[0]),
    cases: each(
      ['---\nname: x\n---'],
      [''],
      [longText(USER_SKILL_PASTE_MAX_CHARS)],
      [longText(USER_SKILL_PASTE_MAX_CHARS + 1)],
      [astral.repeat(1_000_000)],
      [astral.repeat(1_000_001)],
      [5],
      [null],
      [],
    ),
  },
  'user-skills-channels.USER_SKILL_BUNDLE_MAX': constant(() => USER_SKILL_BUNDLE_MAX),
  'user-skills-channels.skillIdListOf': {
    ts: (a) => skillIdListOf(a[0]),
    cases: each(
      [['user:a']],
      [['user:a', 'user:b', 'user:a']],
      [[]],
      [['user:a', 'bad']],
      [['user:a', 5]],
      [Array.from({ length: USER_SKILL_BUNDLE_MAX }, (_, i) => `u:${i}`)],
      [Array.from({ length: USER_SKILL_BUNDLE_MAX + 1 }, (_, i) => `u:${i}`)],
      [Array.from({ length: USER_SKILL_BUNDLE_MAX + 1 }, () => 'u:1')],
      ['user:a'],
      [null],
      [],
      [{ length: 1, 0: 'u:a' }],
    ),
  },
  'user-skills-channels.installRequestOf': {
    ts: (a) => installRequestOf(a[0]),
    cases: each(
      [{ token: 't', selected: ['a', 'b'], onCollision: { a: 'replace', b: 'skip' } }],
      [{ token: 't', selected: ['a', 5, null, 'b', longText(4097), longText(4096)] }],
      [{ token: 't', selected: [], onCollision: { a: 'overwrite', b: 'skip', c: 5 } }],
      [{ token: 't', selected: [], onCollision: { 10: 'skip', 2: 'replace', b: 'skip', 1: 'x' } }],
      [{ token: 't', selected: [], onCollision: parsed('{"__proto__":"replace","a":"skip"}') }],
      [{ token: 't', selected: [], onCollision: ['replace'] }],
      [{ token: 't', selected: [], onCollision: 'replace' }],
      [{ token: 't', selected: [], onCollision: null }],
      [{ token: '', selected: [] }],
      [{ token: longText(128), selected: [] }],
      [{ token: longText(129), selected: [] }],
      [{ token: 't', selected: 'a' }],
      [{ token: 't' }],
      [{ token: 5, selected: [] }],
      [null],
      [],
      [[]],
    ),
  },
  'user-skills-channels.skillViewsOf': {
    ts: (a) => skillViewsOf(a[0]),
    cases: each(
      [
        [
          { id: 'a', name: 'n', extra: 1 },
          { id: 'b' },
          5,
          null,
          [],
          { id: 1, name: 'x' },
          { id: '', name: '' },
        ],
      ],
      [[]],
      [{ id: 'a', name: 'n' }],
      [null],
      [],
      [[{ id: 'a', name: 'n' }, { name: 'only' }]],
    ),
  },
  'user-skills-channels.skillsResultOf': {
    ts: (a) => skillsResultOf(a[0]),
    cases: each(
      [{ ok: true, skills: [] }],
      [{ ok: false, reason: 'not-found' }],
      [{ ok: 'yes' }],
      [{}],
      [[]],
      [null],
      [5],
      [],
      [{ ok: false }],
    ),
  },
  'user-skills-channels.USER_SKILL_HANDOFF_TEXT_MAX': constant(() => USER_SKILL_HANDOFF_TEXT_MAX),
  'user-skills-channels.templateOpenInputOf': {
    ts: (a) => templateOpenInputOf(a[0]),
    cases: each(
      [{ skillId: 'u:a', text: 'go', chips: [] }],
      [
        {
          skillId: 'u:a',
          text: '',
          chips: [{ id: 'u:a', source: '', title: '' }],
          withCurrent: true,
        },
      ],
      [
        {
          skillId: 'u:a',
          text: 'go',
          chips: [{ id: 'u:a', source: 's', title: 't' }],
          withCurrent: false,
        },
      ],
      [{ skillId: 'u:a', text: 'go', chips: [{ id: 'bad', source: 's', title: 't' }] }],
      [{ skillId: 'u:a', text: 'go', chips: [{ id: 'u:a', source: longText(65), title: 't' }] }],
      [{ skillId: 'u:a', text: 'go', chips: [{ id: 'u:a', source: longText(64), title: 't' }] }],
      [{ skillId: 'u:a', text: 'go', chips: [{ id: 'u:a', source: 's' }] }],
      [{ skillId: 'u:a', text: 'go', chips: [5] }],
      [
        {
          skillId: 'u:a',
          text: 'go',
          chips: Array.from({ length: 50 }, () => ({ id: 'u:a', source: 's', title: 't' })),
        },
      ],
      [
        {
          skillId: 'u:a',
          text: 'go',
          chips: Array.from({ length: 51 }, () => ({ id: 'u:a', source: 's', title: 't' })),
        },
      ],
      [{ skillId: 'u:a', text: 'go', chips: {} }],
      [{ skillId: 'u:a', text: longText(USER_SKILL_HANDOFF_TEXT_MAX), chips: [] }],
      [{ skillId: 'u:a', text: longText(USER_SKILL_HANDOFF_TEXT_MAX + 1), chips: [] }],
      [{ skillId: 'bad', text: 'go', chips: [] }],
      [{ text: 'go', chips: [] }],
      [{ skillId: 'u:a', chips: [] }],
      [null],
      [],
    ),
  },
  'user-skills-channels.previewInputOf': {
    ts: (a) => flatten(previewInputOf(revive(a[0]))),
    cases: each(
      [
        {
          bytes: bytes(4),
          fileName: 'a.docx',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: { a: 1 },
        },
      ],
      [
        {
          bytes: bytes(0),
          fileName: 'a.docx',
          title: '',
          tabTitle: 'TT',
          text: '',
          originalRedacted: true,
          proposal: { b: [1, { c: null }] },
          draft: { d: 'x' },
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: {},
          draft: null,
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: [],
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: null,
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: 'no',
          proposal: {},
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: '',
          text: 'x',
          originalRedacted: false,
          proposal: {},
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: '',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: {},
        },
      ],
      [
        {
          bytes: bytes(USER_SKILL_TEMPLATE_MAX_BYTES + 1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: {},
        },
      ],
      [
        {
          bytes: [1],
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: {},
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: { k: 'x'.repeat(3_999_980) },
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: { k: 'x'.repeat(4_000_000) },
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: 'x',
          originalRedacted: false,
          proposal: { 2: 'b', 10: 'a', z: 1, 1: 0.5 },
          draft: { y: 1e21, n: -0 },
        },
      ],
      [
        {
          bytes: bytes(1),
          fileName: 'a',
          title: 'T',
          tabTitle: 'TT',
          text: longText(USER_SKILL_HANDOFF_TEXT_MAX + 1),
          originalRedacted: false,
          proposal: {},
        },
      ],
      [null],
      [],
    ),
  },
  'user-skills-channels.handoffTargetOf': {
    ts: (a) => handoffTargetOf(a[0]),
    cases: each(
      ['docs'],
      ['epub'],
      ['hwp'],
      ['mindmap'],
      ['Docs'],
      ['agent'],
      [''],
      [null],
      [5],
      [],
      [['docs']],
    ),
  },
  'user-skills-channels.previewEndedOf': {
    ts: (a) => previewEndedOf(a[0]),
    cases: each(
      [{ previewId: 'p', outcome: 'saved', skillId: 'u:a', title: 'T' }],
      [{ previewId: 'p', outcome: 'unsaved' }],
      [{ previewId: 'p', outcome: 'saved', skillId: 'bad', title: '' }],
      [{ previewId: 'p', outcome: 'saved', skillId: null, title: null }],
      [{ previewId: 'p', outcome: 'saved', title: longText(10001) }],
      [{ previewId: 'p', outcome: 'maybe' }],
      [{ previewId: '', outcome: 'saved' }],
      [{ previewId: longText(128), outcome: 'saved' }],
      [{ previewId: longText(129), outcome: 'saved' }],
      [{ outcome: 'saved' }],
      [{ previewId: 'p' }],
      [null],
      [],
      [[]],
    ),
  },
}

// ---------- mcp-tools-channels, outbound-channels, doc-attach-channels ----------

const mcpTools: Record<string, FnSpec> = {
  'mcp-tools-channels.MCP_TOOLS_BRIDGE_KEY': constant(() => MCP_TOOLS_BRIDGE_KEY),
  'mcp-tools-channels.MCP_TOOLS_CHANNELS': constant(() => ({ ...MCP_TOOLS_CHANNELS })),
  'mcp-tools-channels.mcpServerNameOf': {
    ts: (a) => mcpServerNameOf(a[0]),
    cases: each(
      ['srv'],
      [''],
      [longText(256)],
      [longText(257)],
      [astral.repeat(128)],
      [astral.repeat(129)],
      [5],
      [null],
      [],
    ),
  },
  'mcp-tools-channels.mcpCallIdOf': {
    ts: (a) => mcpCallIdOf(a[0]),
    cases: each(
      ['c1'],
      [''],
      [longText(200)],
      [longText(201)],
      [astral.repeat(100)],
      [astral.repeat(101)],
      [5],
      [null],
      [],
    ),
  },
  'mcp-tools-channels.mcpToolCallRequestOf': {
    ts: (a) => mcpToolCallRequestOf(a[0]),
    cases: each(
      [{ server: 's', tool: 't', input: { a: 1 }, callId: 'c' }],
      [{ server: 's', tool: 't', callId: 'c' }],
      [{ server: 's', tool: 't', input: null, callId: 'c' }],
      [{ server: 's', tool: 't', input: [], callId: 'c' }],
      [{ server: 's', tool: 't', input: 'x', callId: 'c' }],
      [{ server: '', tool: 't', callId: 'c' }],
      [{ server: 's', tool: '', callId: 'c' }],
      [{ server: 's', tool: 't', callId: '' }],
      [{ server: 's', tool: longText(257), callId: 'c' }],
      [{ server: 's', tool: longText(256), callId: longText(200), extra: 1 }],
      [{ server: 's', tool: 't', callId: longText(201) }],
      [{ tool: 't', callId: 'c' }],
      [[]],
      [null],
      ['x'],
      [],
      [{ server: 's', tool: 't', input: { 2: 'b', 10: 'a', k: 1 }, callId: 'c' }],
    ),
  },
}

const outbound: Record<string, FnSpec> = {
  'outbound-channels.OUTBOUND_CHANNELS': constant(() => ({ ...OUTBOUND_CHANNELS })),
  'outbound-channels.MAX_CONFIRM_ADDRESSES': constant(() => MAX_CONFIRM_ADDRESSES),
  'outbound-channels.MAX_CONFIRM_ADDRESS_LENGTH': constant(() => MAX_CONFIRM_ADDRESS_LENGTH),
  'outbound-channels.confirmRequestOf': {
    ts: (a) => confirmRequestOf(a[0]),
    cases: each(
      [{ tool: 'web_fetch', addresses: ['https://a.example/x'] }],
      [{ tool: 'web_fetch', addresses: ['  HTTP://a.example  ', 'https://b'] }],
      [{ tool: 'web_fetch', addresses: ['ftp://a'] }],
      [{ tool: 'web_fetch', addresses: ['https:/a'] }],
      [{ tool: 'web_fetch', addresses: ['\u00a0https://a'] }],
      [{ tool: 'web_fetch', addresses: ['\u017fttps://a'] }],
      [{ tool: 'web_fetch', addresses: ['https://' + longText(MAX_CONFIRM_ADDRESS_LENGTH - 8)] }],
      [{ tool: 'web_fetch', addresses: ['https://' + longText(MAX_CONFIRM_ADDRESS_LENGTH - 7)] }],
      [{ tool: 'web_fetch', addresses: ['https://' + astral.repeat(2000)] }],
      [{ tool: 'web_fetch', addresses: ['https://' + astral.repeat(2100)] }],
      [{ tool: 'web_fetch', addresses: Array.from({ length: 8 }, () => 'http://a') }],
      [{ tool: 'web_fetch', addresses: Array.from({ length: 9 }, () => 'http://a') }],
      [{ tool: 'web_fetch', addresses: [] }],
      [{ tool: 'web_fetch', addresses: 'https://a' }],
      [{ tool: 'web_fetch', addresses: ['https://a', 5] }],
      [{ tool: 'Web', addresses: ['https://a'] }],
      [{ tool: 'web_fetch\n', addresses: ['https://a'] }],
      [{ tool: '', addresses: ['https://a'] }],
      [{ tool: longText(64).replace(/a/g, '_'), addresses: ['https://a'] }],
      [{ tool: longText(65), addresses: ['https://a'] }],
      [{ tool: 'a-b', addresses: ['https://a'] }],
      [{ tool: 5, addresses: ['https://a'] }],
      [{ addresses: ['https://a'] }],
      [[]],
      [null],
      ['x'],
      [],
    ),
  },
}

const docAttach: Record<string, FnSpec> = {
  'doc-attach-channels.DOC_ATTACH_CHANNELS': constant(() => ({ ...DOC_ATTACH_CHANNELS })),
  'doc-attach-channels.DOC_ATTACH_BRIDGE_KEY': constant(() => DOC_ATTACH_BRIDGE_KEY),
}

// ---------- folder-api, project-folder-bridge, split-pane-bridge ----------

type Step = unknown[]

/** An `ipcRenderer` fake: every call is a log line; a listener is the number of its first sight. */
function fakeIpc(cx: TsContext, reply: (channel: string) => unknown) {
  const ids = new Map<unknown, number>()
  const id = (fn: unknown): number => {
    if (!ids.has(fn)) ids.set(fn, ids.size + 1)
    return ids.get(fn)!
  }
  return {
    invoke: (channel: string, ...rest: unknown[]) => {
      cx.log('invoke', channel, ...rest)
      return reply(channel)
    },
    on: (channel: string, fn: unknown) => cx.log('on', channel, id(fn)),
    removeListener: (channel: string, fn: unknown) => cx.log('removeListener', channel, id(fn)),
    send: (channel: string, ...rest: unknown[]) => cx.log('send', channel, ...rest),
  }
}

const eventMethods = [
  'onChatMessageAppended',
  'onOpenChat',
  'onOpenProjectScreen',
  'onProjectChanged',
]

const folderBridge: Record<string, FnSpec> = {
  'folder-api.PROJECT_FOLDER_NAMES': constant(() => ({ ...PROJECT_FOLDER_NAMES })),
  'folder-api.PROJECT_FOLDER_EVENTS': constant(() => ({ ...PROJECT_FOLDER_EVENTS })),
  'folder-api.PROJECT_FOLDER_CHANNELS': constant(() => ({ ...PROJECT_FOLDER_CHANNELS })),
  'folder-api.PROJECT_FOLDER_LISTEN_CHANNEL': constant(() => PROJECT_FOLDER_LISTEN_CHANNEL),
  'folder-api.PROJECT_FOLDER_BRIDGE_KEY': constant(() => FOLDER_API_BRIDGE_KEY),
  'project-folder-bridge.PROJECT_FOLDER_BRIDGE_KEY': constant(() => PROJECT_FOLDER_BRIDGE_KEY),
  'project-folder-bridge.projectFolderBridge': {
    ts: async (a, cx) => {
      const ipc = fakeIpc(cx, (channel) => Promise.resolve(`reply:${channel}`))
      const bridge = projectFolderBridge(ipc as never) as unknown as Record<
        string,
        (...x: unknown[]) => unknown
      >
      const unsubs: (() => void)[] = []
      const results: unknown[] = []
      for (const step of a[0] as Step[]) {
        const [op, name] = step as [string, string]
        if (op === 'request') {
          results.push(await bridge[name]!(...(step.length > 2 ? [step[2]] : [])))
        } else if (op === 'subscribe') {
          unsubs.push(bridge[name]!(() => {}) as () => void)
          results.push(unsubs.length - 1)
        } else {
          unsubs[step[1] as number]!()
          results.push(null)
        }
      }
      return results
    },
    cases: each(
      [[['request', 'listProjects']]],
      [[['request', 'createProject', { name: 'p', folder: '/x' }]]],
      [
        [
          ['request', 'setPinned', null],
          ['request', 'setPinned', 0],
          ['request', 'setPinned', false],
          ['request', 'setPinned', ''],
        ],
      ],
      [
        [
          ['request', 'openProjectScreen'],
          ['request', 'deleteChat', { id: 'c' }],
          ['request', 'listIgnoredFiles'],
        ],
      ],
      [
        [
          ['subscribe', 'onOpenChat'],
          ['unsubscribe', 0],
        ],
      ],
      [
        [
          ['subscribe', 'onOpenChat'],
          ['subscribe', 'onOpenChat'],
          ['unsubscribe', 0],
          ['unsubscribe', 0],
          ['unsubscribe', 1],
          ['unsubscribe', 1],
          ['subscribe', 'onOpenChat'],
        ],
      ],
      [
        [
          ['subscribe', 'onChatMessageAppended'],
          ['subscribe', 'onProjectChanged'],
          ['subscribe', 'onOpenProjectScreen'],
          ['subscribe', 'onOpenChat'],
          ['unsubscribe', 2],
          ['unsubscribe', 0],
          ['request', 'listChats', 'p1'],
          ['unsubscribe', 3],
          ['unsubscribe', 1],
        ],
      ],
      [eventMethods.map((m) => ['subscribe', m])],
      [
        [
          ['subscribe', 'onProjectChanged'],
          ['subscribe', 'onProjectChanged'],
          ['subscribe', 'onProjectChanged'],
          ['unsubscribe', 2],
          ['unsubscribe', 1],
          ['unsubscribe', 0],
        ],
      ],
    ),
  },
  'split-pane-bridge.SPLIT_PANE_CHANNELS': constant(() => ({ ...SPLIT_PANE_CHANNELS })),
  'split-pane-bridge.SPLIT_PANE_BRIDGE_KEY': constant(() => SPLIT_PANE_BRIDGE_KEY),
  'split-pane-bridge.splitPaneBridge': {
    ts: async (a, cx) => {
      const config = (a[1] ?? {}) as { mode?: string; value?: unknown }
      const ipc = fakeIpc(cx, () => {
        if (config.mode === 'reject') return Promise.reject(new Error('refused'))
        if (config.mode === 'undefined') return Promise.resolve(undefined)
        return Promise.resolve(config.value ?? null)
      })
      const bridge = splitPaneBridge(ipc as never)
      const unsubs: (() => void)[] = []
      const results: unknown[] = []
      for (const step of a[0] as Step[]) {
        const op = step[0]
        if (op === 'getRole') results.push(await bridge.getRole())
        else if (op === 'onRoleChanged') {
          unsubs.push(bridge.onRoleChanged(() => {}))
          results.push(unsubs.length - 1)
        } else if (op === 'unsubscribe') {
          unsubs[step[1] as number]!()
          results.push(null)
        } else if (op === 'requestFocus') {
          bridge.requestFocus()
          results.push(null)
        } else {
          bridge.reportFocus()
          results.push(null)
        }
      }
      return results
    },
    cases: [
      { args: [[['getRole']], { mode: 'value', value: 'focus' }] },
      { args: [[['getRole']], { mode: 'value', value: 'secondary' }] },
      { args: [[['getRole']], { mode: 'value', value: null }] },
      { args: [[['getRole']], { mode: 'undefined' }], note: 'the shell answered nothing' },
      { args: [[['getRole']], { mode: 'reject' }], note: 'the request failed' },
      {
        args: [[['getRole']], { mode: 'value', value: { odd: [1, 2] } }],
        note: 'passes whatever it got',
      },
      {
        args: [
          [
            ['onRoleChanged'],
            ['onRoleChanged'],
            ['unsubscribe', 1],
            ['unsubscribe', 1],
            ['unsubscribe', 0],
          ],
          { mode: 'value', value: 'focus' },
        ],
      },
      {
        args: [
          [['requestFocus'], ['reportFocus'], ['requestFocus']],
          { mode: 'value', value: null },
        ],
      },
    ],
  },
}

// ---------- default-save-dir ----------

const SAVE_DIR_STATE = Symbol.for('seuoffice.defaultSaveDir.state')

function withClock<T>(now: number, run: () => T): T {
  const real = Date.now
  Date.now = () => now
  try {
    return run()
  } finally {
    Date.now = real
  }
}

interface ScenarioStep {
  at?: number
  mkdir?: string
  chmod?: [string, number]
}

/**
 * Runs `run` once, or once per step (at `now + step.at`, after the step's
 * folder changes) against a fresh process state; `fallback` answers
 * `defaultSaveDirFallback()` instead of the values.
 */
function scenario(
  steps: ScenarioStep[] | null | undefined,
  now: number,
  run: () => unknown,
  fallback: boolean,
): unknown {
  ;(globalThis as Record<symbol, unknown>)[SAVE_DIR_STATE] = undefined
  if (!steps) {
    if (fallback) {
      try {
        withClock(now, run)
      } catch {
        /* the resolver's refusal is not what is asked */
      }
      return defaultSaveDirFallback()
    }
    return withClock(now, run)
  }
  const results: unknown[] = []
  for (const step of steps) {
    if (step.mkdir) {
      try {
        mkdirSync(step.mkdir, { recursive: true })
      } catch {
        /* as the Rust side */
      }
    }
    if (step.chmod) {
      try {
        chmodSync(step.chmod[0], step.chmod[1])
      } catch {
        /* as the Rust side */
      }
    }
    try {
      results.push(withClock(now + (step.at ?? 0), run))
    } catch (e) {
      results.push({ error: msg(e) })
    }
  }
  return fallback ? defaultSaveDirFallback() : { results, fallback: defaultSaveDirFallback() }
}

/** `{ userData, documents, home }`, each a path or `{ throws }`; `getPath` is logged. */
function fakeApp(spec: Record<string, string | { throws: string }>, cx: TsContext): PathProvider {
  return {
    getPath(name) {
      cx.log('getPath', name)
      const v = spec[name]
      if (v === undefined) return ''
      if (typeof v === 'string') return v
      throw new Error(v.throws)
    },
  }
}

const settingsText = (value: unknown): string => JSON.stringify({ defaultSaveDir: value })
const noWrite = '/dev/null/main-diff-x'

const resolveCases: Case[] = [
  { args: ['$DIR/cfg', ['$DIR/fb1']], note: 'configured folder is created and used' },
  { args: [null, ['$DIR/fb1', '$DIR/fb2']], note: 'no configured folder: first fallback' },
  { args: ['', ['$DIR/fb1']], note: 'an empty configured folder is none' },
  { args: ['$DIR/f/sub', ['$DIR/fb1']], files: { f: 'x' }, note: 'configured under a file' },
  { args: [null, '$DIR/only'], note: 'a string fallback' },
  { args: [null, ['$DIR/f/a', '$DIR/ok']], files: { f: 'x' }, note: 'first fallback blocked' },
  {
    args: [null, ['$DIR/f/a', '$DIR/g/b']],
    files: { f: 'x', g: 'y' },
    note: 'every fallback blocked',
  },
  { args: [null, []], note: 'no fallback at all' },
  { args: [null, ['$DIR/a', '$DIR/b'], [{ at: 0 }, { at: 1 }]], note: 'two calls' },
  {
    args: [
      '$DIR/ro/sub',
      ['$DIR/fb'],
      [{ at: 0 }, { at: 10000, chmod: ['$DIR/ro', 0o755] }, { at: 29999 }, { at: 30000 }],
    ],
    files: { ro: { dir: true, mode: 0o555 } },
    note: 'a failed folder is skipped for 30 s even after it is fixed, and tried again at 30 s',
  },
  {
    args: ['$DIR/ro/sub', ['$DIR/fb'], [{ at: 0 }, { at: 30000 }]],
    files: { ro: { dir: true, mode: 0o555 } },
    note: 'still failing at the retry',
  },
  {
    args: [
      null,
      ['$DIR/ro/a', '$DIR/ok'],
      [{ at: 0 }, { at: 5000, chmod: ['$DIR/ro', 0o755] }, { at: 31000 }],
    ],
    files: { ro: { dir: true, mode: 0o555 } },
    note: 'a blocked first fallback comes back after the wait',
  },
  {
    args: ['$DIR/cfg', ['$DIR/fb'], [{ at: 0 }, { at: 1, mkdir: '$DIR/other' }]],
    note: 'a usable folder stays usable',
  },
  {
    args: ['$DIR/ro', ['$DIR/fb']],
    files: { ro: { dir: true, mode: 0o555 } },
    note: 'an existing configured folder that can be read but not written is skipped',
  },
  {
    args: [null, ['$DIR/ro', '$DIR/ok']],
    files: { ro: { dir: true, mode: 0o555 } },
    note: 'an existing read-only fallback is skipped',
  },
]

const defaultSaveDir: Record<string, FnSpec> = {
  'default-save-dir.DEFAULT_SAVE_DIR_KEY': constant(() => DEFAULT_SAVE_DIR_KEY),
  'default-save-dir.readDefaultSaveDirSetting': {
    ts: (a) => readDefaultSaveDirSetting(a[0] as string),
    cases: [
      { args: ['$DIR/s.json'], files: { 's.json': settingsText('/abs/dir') } },
      { args: ['$DIR/s.json'], files: { 's.json': settingsText('rel/dir') }, note: 'relative' },
      { args: ['$DIR/s.json'], files: { 's.json': settingsText('') }, note: 'empty' },
      { args: ['$DIR/s.json'], files: { 's.json': settingsText(5) }, note: 'not a string' },
      { args: ['$DIR/s.json'], files: { 's.json': '[]' }, note: 'an array' },
      { args: ['$DIR/s.json'], files: { 's.json': 'null' }, note: 'null' },
      { args: ['$DIR/s.json'], files: { 's.json': '{"x":1}' }, note: 'key absent' },
      { args: ['$DIR/s.json'], files: { 's.json': '{oops' }, note: 'not JSON' },
      {
        args: ['$DIR/s.json'],
        files: { 's.json': '\ufeff' + settingsText('/abs/dir') },
        note: 'a BOM',
      },
      { args: ['$DIR/missing.json'], note: 'no file' },
      { args: ['$DIR/d'], files: { d: { dir: true } }, note: 'a folder' },
      { args: ['$DIR/s.json'], files: { 's.json': { hex: 'ff7b7d' } }, note: 'bad UTF-8' },
    ],
  },
  'default-save-dir.createDirLevels': {
    ts: (a) => createDirLevels(a[0] as string),
    cases: [
      { args: ['$DIR/a/b/c'] },
      { args: ['$DIR'], note: 'exists' },
      { args: ['$DIR/d'], files: { d: { dir: true } }, note: 'exists below' },
      { args: ['$DIR/f/x'], files: { f: 'x' }, note: 'a file in the way' },
      {
        args: ['$DIR/ro/x/y'],
        files: { ro: { dir: true, mode: 0o555 } },
        note: 'a read-only parent',
      },
      { args: ['$DIR/f'], files: { f: 'x' }, note: 'the folder is a file' },
      { args: ['$DIR/a/../b'], note: 'dots' },
    ],
  },
  'default-save-dir.isUsableSaveDir': {
    ts: (a) => isUsableSaveDir(a[0] as string),
    cases: [
      { args: ['$DIR'] },
      { args: ['$DIR/new/dir'], note: 'created' },
      { args: ['$DIR/f/x'], files: { f: 'x' }, note: 'under a file' },
      { args: ['$DIR/ro'], files: { ro: { dir: true, mode: 0o555 } }, note: 'read-only' },
      { args: ['$DIR/ro/x'], files: { ro: { dir: true, mode: 0o555 } }, note: 'under read-only' },
      { args: ['$DIR/f'], files: { f: 'x' }, note: 'a file' },
    ],
  },
  'default-save-dir.resolveDefaultSaveDir': {
    ts: (a, cx) =>
      scenario(
        a[2] as ScenarioStep[] | undefined,
        cx.now,
        () => resolveDefaultSaveDir(a[0] as string | null, a[1] as string | string[]),
        false,
      ),
    cases: resolveCases,
  },
  'default-save-dir.defaultSaveDirFallback': {
    ts: (a, cx) =>
      scenario(
        a[2] as ScenarioStep[] | undefined,
        cx.now,
        () => resolveDefaultSaveDir(a[0] as string | null, a[1] as string | string[]),
        true,
      ),
    cases: resolveCases,
  },
  'default-save-dir.documentsDirOrFallback': {
    ts: (a, cx) => documentsDirOrFallback(fakeApp(a[0] as Record<string, string>, cx)),
    cases: each(
      [{ userData: '/u', documents: '/d', home: '/h' }],
      [{ userData: '/u', documents: { throws: "Failed to get 'documents' path" }, home: '/h' }],
      [{ userData: '/u', documents: '', home: '/h' }],
      [{ userData: '/u', documents: { throws: 'x' }, home: { throws: 'y' } }],
      [{ userData: '/u', documents: '', home: '' }],
      [{ userData: { throws: 'no userData' }, documents: '', home: '' }],
      [{ userData: '/u' }],
    ),
  },
  'default-save-dir.configuredDefaultSaveDir': {
    ts: (a, cx) =>
      scenario(
        a[1] as ScenarioStep[] | undefined,
        cx.now,
        () => configuredDefaultSaveDir(fakeApp(a[0] as Record<string, string>, cx)),
        false,
      ),
    cases: [
      {
        args: [{ userData: '$DIR/ud', documents: '$DIR/docs', home: '$DIR/home' }],
        note: 'Documents/<product>',
      },
      {
        args: [{ userData: '$DIR/ud', documents: { throws: 'no documents' }, home: '$DIR/home' }],
        note: 'Documents cannot be reported',
      },
      {
        args: [{ userData: '$DIR/ud', documents: '', home: { throws: 'no home' } }],
        note: 'only userData is left',
      },
      {
        args: [{ userData: '$DIR/ud', documents: '$DIR/docs', home: '$DIR/home' }],
        files: { 'ud/app-settings.json': settingsText(noWrite) },
        note: 'a configured folder that cannot be created',
      },
      {
        args: [{ userData: '$DIR/ud', documents: '$DIR/docs', home: '$DIR/home' }],
        files: { 'ud/app-settings.json': settingsText('relative') },
        note: 'a relative configured folder is ignored',
      },
      {
        args: [{ userData: '$DIR/ud', documents: '$DIR/f/x', home: '$DIR/home' }],
        files: { f: 'x' },
        note: 'Documents is blocked',
      },
      {
        args: [{ userData: '$DIR/ud', documents: '$DIR/f/x', home: '$DIR/g/y' }],
        files: { f: 'x', g: 'y' },
        note: 'Documents and home are blocked: userData',
      },
      {
        args: [{ userData: { throws: 'no userData' }, documents: '$DIR/docs', home: '$DIR/home' }],
        note: 'userData cannot be reported',
      },
      {
        args: [{ userData: '$DIR/f/ud', documents: '$DIR/f/x', home: '$DIR/f/y' }],
        files: { f: 'x' },
        note: 'nothing is usable',
      },
      {
        args: [
          { userData: '$DIR/ud', documents: '$DIR/ro/d', home: '$DIR/home' },
          [{ at: 0 }, { at: 1000, chmod: ['$DIR/ro', 0o755] }, { at: 31000 }],
        ],
        files: { ro: { dir: true, mode: 0o555 } },
        note: 'Documents comes back after the wait',
      },
      {
        args: [{ userData: '$DIR/ud', documents: '$DIR/docs', home: '$DIR/home' }],
        files: { [`docs/${PRODUCT_NAME}`]: { dir: true, mode: 0o555 } },
        note: 'an existing Documents folder that cannot be written falls to home',
      },
    ],
  },
}

// ---------- dialog-memory ----------

interface DialogStep {
  parent?: boolean
  options?: Record<string, unknown>
  fallbackDir?: string | null | { fn: string | null } | { throws: string }
  result?: Record<string, unknown>
}

/** A dialog that answers each call with its step's result and logs what it was asked. */
function dialogScenario(a: unknown[], cx: TsContext, kind: 'open' | 'save'): Promise<unknown[]> {
  const steps = a[0] as DialogStep[]
  let current: DialogStep = {}
  const record = (name: string, args: unknown[]): void => {
    cx.log(name, ...args.map((x) => (x && (x as { w?: number }).w === 1 ? '<window>' : x)))
  }
  const dialog = {
    showOpenDialog: (...args: unknown[]) => {
      record('showOpenDialog', args)
      return Promise.resolve(current.result)
    },
    showSaveDialog: (...args: unknown[]) => {
      record('showSaveDialog', args)
      return Promise.resolve(current.result)
    },
  }
  return (async () => {
    const results: unknown[] = []
    for (const step of steps) {
      current = step
      const parent = step.parent ? { w: 1 } : undefined
      const fb = step.fallbackDir
      if (kind === 'open') {
        results.push(
          await showOpenDialogWithMemory(
            dialog as never,
            parent as never,
            (step.options ?? {}) as never,
            typeof fb === 'string' ? fb : undefined,
          ),
        )
      } else {
        let fallback: string | (() => string) | undefined
        if (typeof fb === 'string') fallback = fb
        else if (fb && 'fn' in fb) fallback = () => fb.fn as string
        else if (fb && 'throws' in fb) {
          const message = fb.throws
          fallback = () => {
            throw new Error(message)
          }
        }
        results.push(
          await showSaveDialogWithMemory(
            dialog as never,
            parent as never,
            (step.options ?? {}) as never,
            fallback,
          ),
        )
      }
    }
    return results
  })()
}

const picked = (path: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  canceled: false,
  filePaths: [path],
  ...extra,
})
const saved = (path: string): Record<string, unknown> => ({ canceled: false, filePath: path })
const cancelled: Record<string, unknown> = { canceled: true, filePaths: [] }

const dialogMemory: Record<string, FnSpec> = {
  'dialog-memory.showOpenDialogWithMemory': {
    ts: (a, cx) => dialogScenario(a, cx, 'open'),
    cases: each(
      [
        [
          { options: { title: 't' }, result: picked('/a/b/c.txt') },
          { options: { title: 'u' }, result: cancelled },
        ],
      ],
      [
        [
          { options: { title: 't' }, fallbackDir: '/fb', result: cancelled },
          { options: {}, result: picked('/x/y.txt') },
        ],
      ],
      [
        [
          { options: { defaultPath: '/abs/file.txt' }, result: picked('/a/b/c.txt') },
          { options: { defaultPath: '/abs/file.txt' }, result: cancelled },
        ],
      ],
      [
        [
          {
            options: { defaultPath: 'bare.txt', title: 't' },
            fallbackDir: '/fb',
            result: cancelled,
          },
        ],
      ],
      [
        [
          { options: {}, result: picked('/a/b/c.txt') },
          { options: { defaultPath: 'bare.txt', title: 't' }, result: cancelled },
          { options: { defaultPath: '' }, result: cancelled },
        ],
      ],
      [
        [
          { options: { properties: ['openDirectory'] }, result: picked('/pick/dir') },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          {
            options: { properties: ['openFile', 'multiSelections'] },
            result: picked('/pick/dir/f'),
          },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { options: { properties: 'openDirectory' }, result: picked('/pick2') },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: { canceled: true, filePaths: ['/ignored/x'] } },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: picked('') },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: { canceled: false, filePaths: [] } },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: picked('/only') },
          { options: {}, result: picked('/second/f') },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { parent: true, options: { title: 'p' }, result: picked('/w/x') },
          { parent: false, options: {}, result: cancelled },
        ],
      ],
      [[{ options: { title: 't', buttonLabel: 'b' }, fallbackDir: '/fb', result: cancelled }]],
      [[{ options: { 2: 'b', 10: 'a', title: 't' }, fallbackDir: '/fb', result: cancelled }]],
      [[{ options: {}, fallbackDir: '', result: cancelled }]],
      [
        [
          { options: {}, result: picked('/\u00e9/\u{1F600}/f.txt') },
          { options: { defaultPath: 'n.txt' }, result: cancelled },
        ],
      ],
    ),
  },
  'dialog-memory.showSaveDialogWithMemory': {
    ts: (a, cx) => dialogScenario(a, cx, 'save'),
    cases: each(
      [
        [
          { options: { title: 't' }, result: saved('/a/b/c.txt') },
          { options: {}, result: cancelled },
        ],
      ],
      [[{ options: { defaultPath: 'doc.docx' }, fallbackDir: '/fb', result: cancelled }]],
      [[{ options: { defaultPath: 'doc.docx' }, fallbackDir: { fn: '/fnfb' }, result: cancelled }]],
      [[{ options: { defaultPath: 'doc.docx' }, fallbackDir: { fn: null }, result: cancelled }]],
      [
        [
          {
            options: { defaultPath: 'doc.docx' },
            fallbackDir: { throws: 'no default folder' },
            result: cancelled,
          },
        ],
      ],
      [
        [
          {
            options: { defaultPath: '/abs/doc.docx' },
            fallbackDir: '/fb',
            result: saved('/abs/other.docx'),
          },
          { options: { defaultPath: 'x.docx' }, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, fallbackDir: '/fb', result: { canceled: true, filePath: '/no/x' } },
          { options: {}, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: { canceled: false, filePath: '' } },
          { options: { defaultPath: 'a' }, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: { canceled: false } },
          { options: { defaultPath: 'a' }, result: cancelled },
        ],
      ],
      [
        [
          { options: {}, result: saved('/one/f') },
          { options: { defaultPath: 'n' }, result: saved('/two/g') },
          { options: { defaultPath: 'm' }, result: cancelled },
        ],
      ],
      [
        [
          {
            parent: true,
            options: { defaultPath: 'p.txt' },
            fallbackDir: '/fb',
            result: cancelled,
          },
        ],
      ],
      [
        [
          {
            options: { defaultPath: 'p.txt', filters: [{ name: 'a', extensions: ['x'] }] },
            fallbackDir: '/fb',
            result: cancelled,
          },
        ],
      ],
      [[{ options: {}, fallbackDir: { fn: '' }, result: cancelled }]],
    ),
  },
  'dialog-memory.saveAsSuggestion': {
    ts: (a) => saveAsSuggestion(a[0] as string | null | undefined, a[1] as string),
    cases: each(
      ['/a/b/c.docx', 'n.docx'],
      [null, 'n.docx'],
      ['', 'n.docx'],
      ['c.docx', 'n.docx'],
      ['/a/b/', 'n.docx'],
      ['/a/b/c.docx', ''],
      ['/\u00e9/\u{1F600}/c', 'n'],
    ),
  },
}

// ---------- author-name ----------

/** Runs `run` with `os.userInfo()` answering `username`, or throwing for `null`. */
function withUser<T>(username: string | null, run: () => T): T {
  const real = os.userInfo
  ;(os as unknown as { userInfo: unknown }).userInfo = () => {
    if (username === null) throw new Error('uv_os_get_passwd returned ENOENT')
    return { username }
  }
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    ;(os as unknown as { userInfo: unknown }).userInfo = real
    syncBuiltinESMExports()
  }
}

const nameFile = (value: unknown): string => JSON.stringify({ authorName: value })

const authorName: Record<string, FnSpec> = {
  'author-name.AUTHOR_NAME_KEY': constant(() => AUTHOR_NAME_KEY),
  'author-name.AUTHOR_NAME_MAX': constant(() => AUTHOR_NAME_MAX),
  'author-name.sanitizeAuthorName': {
    ts: (a) => sanitizeAuthorName(a[0]),
    cases: each(
      ['  Ann   Lee  '],
      ['a\t\nb\r\nc'],
      ['\u00a0x\u00a0\ufeffy\u2028z'],
      ['a\u0085b'],
      ['x'.repeat(120)],
      ['x'.repeat(121)],
      ['x'.repeat(118) + astral + 'b'],
      [astral.repeat(60)],
      [astral.repeat(61)],
      ['  '],
      [''],
      [5],
      [null],
      [[]],
      [],
      ['\u00e9\u0301  ok'],
    ),
  },
  'author-name.readAuthorNameSetting': {
    ts: (a) => readAuthorNameSetting(a[0] as string),
    cases: [
      { args: ['$DIR/s.json'], files: { 's.json': nameFile('  Ann  Lee ') } },
      { args: ['$DIR/s.json'], files: { 's.json': nameFile('') } },
      { args: ['$DIR/s.json'], files: { 's.json': nameFile(5) } },
      { args: ['$DIR/s.json'], files: { 's.json': '[]' } },
      { args: ['$DIR/s.json'], files: { 's.json': 'null' } },
      { args: ['$DIR/s.json'], files: { 's.json': '{}' } },
      { args: ['$DIR/s.json'], files: { 's.json': 'nope' } },
      { args: ['$DIR/missing.json'] },
      { args: ['$DIR/d'], files: { d: { dir: true } } },
      { args: ['$DIR/s.json'], files: { 's.json': nameFile('x'.repeat(200)) } },
    ],
  },
  'author-name.systemAuthorName': {
    ts: (a) => withUser(a[0] as string | null, () => systemAuthorName()),
    cases: each(['alice'], ['  '], [null], ['a  b'], [''], ['x'.repeat(130)], ['\u00e9\u{1F600}']),
  },
  'author-name.resolveAuthorName': {
    ts: (a) => withUser(a[1] as string | null, () => resolveAuthorName(a[0] as string)),
    cases: [
      { args: ['$DIR/s.json', 'alice'], files: { 's.json': nameFile('Ann') } },
      { args: ['$DIR/s.json', 'alice'], files: { 's.json': nameFile('   ') } },
      { args: ['$DIR/s.json', null], files: { 's.json': nameFile('') } },
      { args: ['$DIR/missing.json', 'bob'] },
      { args: ['$DIR/missing.json', null] },
      { args: ['$DIR/missing.json', '  '] },
    ],
  },
  'author-name.configuredAuthorName': {
    ts: (a) =>
      withUser(a[1] as string | null, () =>
        configuredAuthorName({ getPath: () => a[0] as string }),
      ),
    cases: [
      { args: ['$DIR/ud', 'alice'], files: { 'ud/app-settings.json': nameFile('Ann') } },
      { args: ['$DIR/ud', 'alice'], files: { 'ud/app-settings.json': nameFile(7) } },
      { args: ['$DIR/ud', null] },
      { args: ['$DIR/none', 'carol'] },
    ],
  },
}

// ---------- font-store ----------

interface FontEnvSpec {
  dir: string
  families: [string, string[]][] | null
}

const sfnt = (magic: string): { hex: string } => ({ hex: magic + '00010203' })
const TTF = sfnt('00010000')
const OTF = sfnt('4f54544f')
const TTC = sfnt('74746366')
const TRUE = sfnt('74727565')

const fontStore: Record<string, FnSpec> = {
  'font-store.installLocalFontFiles': {
    ts: (a, cx) => {
      const spec = a[0] as FontEnvSpec
      const table = new Map(spec.families ?? [])
      const env = {
        dir: spec.dir,
        ...(spec.families
          ? {
              fontFileFamilies: (path: string) => {
                cx.log('fontFileFamilies', path)
                return table.get(path) ?? []
              },
            }
          : {}),
      }
      return installLocalFontFiles(env, a[1] as string[])
    },
    cases: [
      {
        args: [{ dir: '$DIR/store', families: null }, ['$DIR/in/a.ttf']],
        files: { 'in/a.ttf': TTF },
        note: 'no reader: nothing, and no folder',
      },
      {
        args: [
          { dir: '$DIR/store', families: [['$DIR/in/Foo.ttf', ['Foo Sans', 'Foo']]] },
          ['$DIR/in/Foo.ttf'],
        ],
        files: { 'in/Foo.ttf': TTF },
      },
      {
        args: [
          {
            dir: '$DIR/store',
            families: [
              ['$DIR/in/a-BoldItalic.otf', ['Fam']],
              ['$DIR/in/b-bold.ttc', ['Fam']],
              ['$DIR/in/c-Oblique.OTC', ['Fam']],
              ['$DIR/in/d-italic.ttf', ['Fam']],
              ['$DIR/in/e plain.TTF', ['Fam']],
              ['$DIR/in/f-BOLD\u00a0ITALIC.otf', ['Fam']],
            ],
          },
          [
            '$DIR/in/a-BoldItalic.otf',
            '$DIR/in/b-bold.ttc',
            '$DIR/in/c-Oblique.OTC',
            '$DIR/in/d-italic.ttf',
            '$DIR/in/e plain.TTF',
            '$DIR/in/f-BOLD\u00a0ITALIC.otf',
          ],
        ],
        files: {
          'in/a-BoldItalic.otf': OTF,
          'in/b-bold.ttc': TTC,
          'in/c-Oblique.OTC': TTC,
          'in/d-italic.ttf': TRUE,
          'in/e plain.TTF': TTF,
          'in/f-BOLD\u00a0ITALIC.otf': OTF,
        },
        note: 'style tags and extensions',
      },
      {
        args: [
          {
            dir: '$DIR/store',
            families: [
              ['$DIR/in/\u0131talic.ttf', ['Fam']],
              ['$DIR/in/\u0130talic-\u017fold.ttf', ['Fam2']],
            ],
          },
          ['$DIR/in/\u0131talic.ttf', '$DIR/in/\u0130talic-\u017fold.ttf'],
        ],
        files: { 'in/\u0131talic.ttf': TTF, 'in/\u0130talic-\u017fold.ttf': TTF },
        note: 'letters that fold only in a Unicode match',
      },
      {
        args: [
          { dir: '$DIR/store', families: [['$DIR/in/x.ttf', ['A/B:C\\D']]] },
          ['$DIR/in/x.ttf'],
        ],
        files: { 'in/x.ttf': TTF },
        note: 'a family with separators',
      },
      {
        args: [
          {
            dir: '$DIR/store',
            families: [
              ['$DIR/in/bad.ttf', ['Bad']],
              ['$DIR/in/short.ttf', ['Short']],
              ['$DIR/in/empty.ttf', ['Empty']],
            ],
          },
          [
            '$DIR/in/bad.ttf',
            '$DIR/in/short.ttf',
            '$DIR/in/empty.ttf',
            '$DIR/in/missing.ttf',
            '$DIR/in/dir.ttf',
          ],
        ],
        files: {
          'in/bad.ttf': { hex: '1234567800' },
          'in/short.ttf': { hex: '0001' },
          'in/empty.ttf': '',
          'in/dir.ttf': { dir: true },
        },
        note: 'not fonts, too short, empty, missing, a folder',
      },
      {
        args: [
          {
            dir: '$DIR/store',
            families: [
              ['$DIR/in/a.ttf', []],
              ['$DIR/in/b.ttf', ['']],
              ['$DIR/in/c.ttf', ['', 'Second']],
            ],
          },
          ['$DIR/in/a.ttf', '$DIR/in/b.ttf', '$DIR/in/c.ttf'],
        ],
        files: { 'in/a.ttf': TTF, 'in/b.ttf': TTF, 'in/c.ttf': TTF },
        note: 'no primary family',
      },
      {
        args: [
          {
            dir: '$DIR/store',
            families: [
              ['$DIR/in/a.ttf', ['Same', 'Other']],
              ['$DIR/in/b.ttf', ['Same', 'Third']],
            ],
          },
          ['$DIR/in/a.ttf', '$DIR/in/b.ttf'],
        ],
        files: { 'in/a.ttf': TTF, 'in/b.ttf': TTF },
        note: 'a family twice',
      },
      {
        args: [{ dir: '$DIR/f', families: [['$DIR/in/a.ttf', ['A']]] }, ['$DIR/in/a.ttf']],
        files: { f: 'x', 'in/a.ttf': TTF },
        note: 'the store folder is a file',
      },
      {
        args: [{ dir: '$DIR/f/store', families: [['$DIR/in/a.ttf', ['A']]] }, ['$DIR/in/a.ttf']],
        files: { f: 'x', 'in/a.ttf': TTF },
        note: 'under a file',
      },
      {
        args: [
          { dir: '$DIR/store', families: [['$DIR/in/Foo.ttf', ['Foo']]] },
          ['$DIR/in/Foo.ttf'],
        ],
        files: { 'in/Foo.ttf': TTF, 'store/Foo.ttf': { dir: true } },
        note: 'the target is a folder: skipped',
      },
      {
        args: [
          { dir: '$DIR/store', families: [['$DIR/in/Foo.ttf', ['New']]] },
          ['$DIR/in/Foo.ttf'],
        ],
        files: { 'in/Foo.ttf': TTF, 'store/New.ttf': 'old' },
        note: 'an earlier copy is replaced',
      },
      { args: [{ dir: '$DIR/store', families: [] }, []], note: 'a reader, no paths' },
    ],
  },
}

// ---------- github-menu ----------

const githubMenu: Record<string, FnSpec> = {
  'github-menu.GITHUB_REPO_OWNER': constant(() => GITHUB_REPO_OWNER),
  'github-menu.GITHUB_REPO_NAME': constant(() => GITHUB_REPO_NAME),
  'github-menu.GITHUB_REPO_SLUG': constant(() => GITHUB_REPO_SLUG),
  'github-menu.GITHUB_REPO_URL': constant(() => GITHUB_REPO_URL),
  'github-menu.GITHUB_REPO_DISPLAY': constant(() => GITHUB_REPO_DISPLAY),
  'github-menu.GITHUB_ISSUES_URL': constant(() => GITHUB_ISSUES_URL),
  'github-menu.GITHUB_NEW_ISSUE_URL': constant(() => GITHUB_NEW_ISSUE_URL),
  'github-menu.GITHUB_RELEASES_URL': constant(() => GITHUB_RELEASES_URL),
  'github-menu.GITHUB_LATEST_RELEASE_URL': constant(() => GITHUB_LATEST_RELEASE_URL),
  'github-menu.githubReleaseTagUrl': {
    ts: (a) => githubReleaseTagUrl(a[0] as string),
    cases: each(['1.2.3'], ['v1.2.3'], ['vv1'], [''], ['V1'], ['v'], ['1.2.3-beta.1'], ['v\u00e9']),
  },
}

// ---------- hwp-default-format ----------

const hwpFile = (value: unknown): string => JSON.stringify({ hwpDefaultFormat: value })

const hwpDefaultFormat: Record<string, FnSpec> = {
  'hwp-default-format.HWP_DEFAULT_FORMAT_KEY': constant(() => HWP_DEFAULT_FORMAT_KEY),
  'hwp-default-format.normalizeHwpDefaultFormat': {
    ts: (a) => normalizeHwpDefaultFormat(a[0]),
    cases: each(['hwpx'], ['hwp'], ['HWPX'], [''], [null], [5], [['hwpx']], [], [{}]),
  },
  'hwp-default-format.readHwpDefaultFormat': {
    ts: (a, cx) => readHwpDefaultFormat(fakeApp(a[0] as Record<string, string>, cx) as never),
    cases: [
      { args: [{ userData: '$DIR/ud' }], files: { 'ud/app-settings.json': hwpFile('hwpx') } },
      { args: [{ userData: '$DIR/ud' }], files: { 'ud/app-settings.json': hwpFile('hwp') } },
      { args: [{ userData: '$DIR/ud' }], files: { 'ud/app-settings.json': hwpFile('docx') } },
      { args: [{ userData: '$DIR/ud' }], files: { 'ud/app-settings.json': '[]' } },
      { args: [{ userData: '$DIR/ud' }], files: { 'ud/app-settings.json': 'null' } },
      { args: [{ userData: '$DIR/ud' }], files: { 'ud/app-settings.json': '{bad' } },
      { args: [{ userData: '$DIR/ud' }], note: 'no file' },
      { args: [{ userData: { throws: 'no userData' } }], note: 'getPath throws' },
    ],
  },
}

// ---------- numbered-export-paths ----------

const num = (x: unknown): number =>
  x === 'NaN' ? NaN : x === 'Infinity' ? Infinity : x === '-Infinity' ? -Infinity : (x as number)

const numberedPaths: Record<string, FnSpec> = {
  'numbered-export-paths.numberedExportPaths': {
    ts: (a) => numberedExportPaths(a[0] as string, num(a[1])),
    cases: each(
      ['report.png', 1],
      ['report.png', 3],
      ['report.png', 0],
      ['report.png', -1],
      ['report.png', 2.9],
      ['report.png', 1.5],
      ['report.png', 0.5],
      ['report.png', -0.5],
      ['report.png', 12],
      ['report.png', 99],
      ['report.png', 100],
      ['/dir.d/report', 2],
      ['a.b/c', 2],
      ['.hidden', 2],
      ['dir/.x', 2],
      ['x.', 2],
      ['a\\b.png', 2],
      ['a\\b', 2],
      ['a/b\\c.d.e', 2],
      ['', 2],
      ['', 1],
      ['\u00e9\u{1F600}.png', 2],
      ['\u{1F600}', 2],
      ['report.png', 'NaN'],
      ['report.png', 'Infinity'],
      ['report.png', '-Infinity'],
      ['report.png', 10000000000],
      ['report.png', 1000],
      ['r.png', 9.999],
    ),
  },
}

// ---------- template-font-response, template-fonts ----------

const FONT_BYTES = { hex: '000100004f54544f' }
const FONT_URL = (file: string): string => `${TEMPLATE_FONT_SCHEME}://${TEMPLATE_FONT_HOST}/${file}`

const templateFonts: Record<string, FnSpec> = {
  'template-font-response.templateFontResponse': {
    ts: async (a) => {
      const response = await templateFontResponse(a[0] as string, a[1] as string)
      if (!response) return null
      return {
        status: response.status,
        headers: [...response.headers.entries()],
        body: Buffer.from(await response.arrayBuffer()).toString('hex'),
      }
    },
    cases: [
      {
        args: [FONT_URL('Pretendard-Regular.otf'), '$DIR/tf'],
        files: { 'tf/Pretendard-Regular.otf': FONT_BYTES },
      },
      {
        args: [FONT_URL('BebasNeue-Regular.ttf'), '$DIR/tf'],
        files: { 'tf/BebasNeue-Regular.ttf': FONT_BYTES },
        note: 'a ttf',
      },
      {
        args: [FONT_URL('PlayfairDisplay%5Bwght%5D.ttf'), '$DIR/tf'],
        files: { 'tf/PlayfairDisplay[wght].ttf': FONT_BYTES },
        note: 'an encoded name',
      },
      {
        args: [FONT_URL('PlayfairDisplay[wght].ttf'), '$DIR/tf'],
        files: { 'tf/PlayfairDisplay[wght].ttf': '' },
        note: 'an empty file',
      },
      {
        args: [FONT_URL('Pretendard-Bold.otf'), '$DIR/tf'],
        files: { 'tf/other.otf': FONT_BYTES },
        note: 'the folder lacks it: 404',
      },
      {
        args: [FONT_URL('Pretendard-Bold.otf'), '$DIR/tf'],
        files: { 'tf/Pretendard-Bold.otf': { dir: true } },
        note: 'a folder of that name: 404',
      },
      {
        args: [FONT_URL('Unlisted.ttf'), '$DIR/tf'],
        files: { 'tf/Unlisted.ttf': FONT_BYTES },
        note: 'not listed: null',
      },
      { args: ['https://template-fonts/Pretendard-Bold.otf', '$DIR/tf'], note: 'another scheme' },
      {
        args: [FONT_URL('x/../Pretendard-Bold.otf'), '$DIR/tf'],
        files: { 'tf/Pretendard-Bold.otf': FONT_BYTES },
        note: 'dot segments',
      },
      { args: ['', '$DIR/tf'] },
      { args: [FONT_URL('Pretendard-Bold.otf'), '$DIR/missing'], note: 'no folder: 404' },
    ],
  },
  'template-fonts.TEMPLATE_FONT_SCHEME': constant(() => TEMPLATE_FONT_SCHEME),
  'template-fonts.TEMPLATE_FONT_HOST': constant(() => TEMPLATE_FONT_HOST),
  'template-fonts.TEMPLATE_FONT_FILES': constant(() => [...TEMPLATE_FONT_FILES]),
  'template-fonts.templateFontFileOf': {
    ts: (a) => templateFontFileOf(a[0] as string),
    cases: each(
      ['seuoffice-docx-media://template-fonts/Pretendard-Regular.otf'],
      ['seuoffice-docx-media://template-fonts/PlayfairDisplay%5Bwght%5D.ttf'],
      ['seuoffice-docx-media://template-fonts/PlayfairDisplay[wght].ttf'],
      ['seuoffice-docx-media://template-fonts/PlayfairDisplay%5bwght%5d.ttf'],
      ['SEUOFFICE-DOCX-MEDIA://template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://Template-Fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts:80/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts:/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts:65535/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts:65536/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts:abc/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://user:pw@template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://a@b@template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://@template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts@/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts./Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template%2Dfonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://[::1]/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://other/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts'],
      ['seuoffice-docx-media://template-fonts/'],
      ['seuoffice-docx-media://template-fonts?x=Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf?v=1'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf#frag'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf/'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf/.'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf/..'],
      ['seuoffice-docx-media://template-fonts//Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts///Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/./Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/a/../Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/a/%2e%2E/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/a/.%2e/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/../Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/%2e/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/a%2Fb/../Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/Pretendard%2DBold.otf'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf%C3%A9'],
      ['seuoffice-docx-media://template-fonts/%E0%A4%A'],
      ['seuoffice-docx-media://template-fonts/%zz'],
      ['seuoffice-docx-media://template-fonts/%'],
      ['seuoffice-docx-media://template-fonts/\u00e9'],
      ['seuoffice-docx-media://template-fonts/Pretendard\\Bold.otf'],
      ['seuoffice-docx-media:\\\\template-fonts\\Pretendard-Bold.otf'],
      ['seuoffice-docx-media:/template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media:template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media:///template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media//template-fonts/Pretendard-Bold.otf'],
      ['  seuoffice-docx-media://template-fonts/Pretendard-Bold.otf  '],
      ['\u0001seuoffice-docx-media://template-fonts/Pretendard-Bold.otf\u001f'],
      ['seuoffice-docx-media://tem\tplate-fonts/Pretendard\n-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf\r\n'],
      ['\u00a0seuoffice-docx-media://template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media://template fonts/Pretendard-Bold.otf'],
      ['https://template-fonts/Pretendard-Bold.otf'],
      ['file://template-fonts/Pretendard-Bold.otf'],
      ['/template-fonts/Pretendard-Bold.otf'],
      ['template-fonts/Pretendard-Bold.otf'],
      ['1seuoffice-docx-media://template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media+x://template-fonts/Pretendard-Bold.otf'],
      ['seuoffice-docx-media'],
      ['://template-fonts/Pretendard-Bold.otf'],
      [''],
      ['not a url'],
      ['seuoffice-docx-media://template-fonts/Unlisted.ttf'],
      ['seuoffice-docx-media://template-fonts/pretendard-bold.otf'],
      ['seuoffice-docx-media://template-fonts/' + '\u{1F600}'],
      ['seuoffice-docx-media://template-fonts/Pretendard-Bold.otf%00'],
      ['seuoffice-docx-media://template-fonts/NotoSerifKR-Regular.otf'],
      ['seuoffice-docx-media://template-fonts/NotoSerifKR-Bold.otf'],
      ['seuoffice-docx-media://template-fonts/BlackHanSans-Regular.ttf'],
      ['seuoffice-docx-media://template-fonts/DoHyeon-Regular.ttf'],
      ['seuoffice-docx-media://template-fonts/GowunDodum-Regular.ttf'],
      ['seuoffice-docx-media://template-fonts/GowunBatang-Regular.ttf'],
      ['seuoffice-docx-media://template-fonts/GowunBatang-Bold.ttf'],
      ['seuoffice-docx-media://template-fonts/BebasNeue-Regular.ttf'],
      ['seuoffice-docx-media://template-fonts/SpaceGrotesk-Bold.ttf'],
      ['seuoffice-docx-media://template-fonts/ArchivoBlack-Regular.ttf'],
    ),
  },
}

// ---------- template-fonts-dir ----------

const templateFontsDirGroup: Record<string, FnSpec> = {
  'template-fonts-dir.TEMPLATE_FONTS_DIR_NAME': constant(() => TEMPLATE_FONTS_DIR_NAME),
  'template-fonts-dir.TEMPLATE_FONTS_REPO_DIR': constant(() => TEMPLATE_FONTS_REPO_DIR),
  'template-fonts-dir.templateFontsDir': {
    ts: (a) => {
      const h = a[0] as { isPackaged: boolean; appPath: string; resourcesPath: string }
      return templateFontsDir({
        isPackaged: h.isPackaged,
        getAppPath: () => h.appPath,
        resourcesPath: h.resourcesPath,
      })
    },
    cases: each(
      [{ isPackaged: true, appPath: '$DIR/app', resourcesPath: '$DIR/res' }],
      [{ isPackaged: true, appPath: '$DIR/app', resourcesPath: '$DIR/res/' }],
      [{ isPackaged: false, appPath: '$DIR/repo/apps/shell', resourcesPath: '$DIR/res' }],
      [{ isPackaged: false, appPath: '$DIR/repo/apps/shell/', resourcesPath: '$DIR/res' }],
      [{ isPackaged: false, appPath: '$DIR/repo/apps/a/b', resourcesPath: '$DIR/res' }],
      [{ isPackaged: false, appPath: '/', resourcesPath: '/r' }],
      [{ isPackaged: true, appPath: '/', resourcesPath: '/r/\u00e9\u{1F600}' }],
    ),
  },
}

// ---------- abort-on-destroyed ----------

interface SenderSpec {
  destroyed?: boolean
  hasOn?: boolean
  onThrows?: boolean
  removeThrows?: boolean
}

const abortOnDestroyedSpec: FnSpec = {
  ts: (a, cx) => {
    const config = a[0] as SenderSpec
    const ids = new Map<unknown, number>()
    const id = (fn: unknown): number => {
      if (!ids.has(fn)) ids.set(fn, ids.size + 1)
      return ids.get(fn)!
    }
    let gone: (() => void) | undefined
    let navigation: ((...args: unknown[]) => void) | undefined
    const sender: Record<string, unknown> = {
      isDestroyed: () => {
        cx.log('isDestroyed')
        return config.destroyed === true
      },
      once: (event: string, fn: () => void) => {
        cx.log('once', event, id(fn))
        gone = fn
      },
      removeListener: (event: string, fn: unknown) => {
        cx.log('removeListener', event, id(fn))
        if (event === 'destroyed') gone = undefined
        else {
          navigation = undefined
          if (config.removeThrows) throw new Error('already gone')
        }
      },
    }
    if (config.hasOn) {
      sender.on = (event: string, fn: (...args: unknown[]) => void) => {
        cx.log('on', event, id(fn))
        if (config.onThrows) throw new Error('no such event')
        navigation = fn
      }
    }
    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => cx.log('abort'))
    const dispose = abortOnDestroyed(sender as never, controller)
    const results: unknown[] = [controller.signal.aborted]
    for (const step of a[1] as unknown[][]) {
      if (step[0] === 'destroyed') {
        const fn = gone
        gone = undefined
        fn?.()
      } else if (step[0] === 'navigate') {
        navigation?.(...step.slice(1))
      } else {
        dispose()
      }
      results.push(controller.signal.aborted)
    }
    return results
  },
  cases: [
    { args: [{ destroyed: true }, [['dispose']]], note: 'already destroyed: aborted at once' },
    { args: [{ hasOn: true }, [['destroyed'], ['dispose']]] },
    { args: [{ hasOn: true }, [['dispose'], ['destroyed']]], note: 'disposed before the event' },
    { args: [{ hasOn: true }, [['dispose'], ['dispose']]] },
    { args: [{}, [['destroyed'], ['dispose']]], note: 'a sender without the navigation event' },
    {
      args: [{}, [['navigate', {}, { isMainFrame: true }], ['dispose']]],
      note: 'no navigation listener',
    },
    {
      args: [
        { hasOn: true, onThrows: true },
        [['navigate', {}, { isMainFrame: true }], ['dispose'], ['destroyed']],
      ],
      note: 'on throws',
    },
    {
      args: [{ hasOn: true, removeThrows: true }, [['dispose'], ['dispose']]],
      note: 'removal of the navigation listener throws',
    },
    { args: [{ hasOn: true }, [['destroyed'], ['destroyed']]], note: 'once' },
    {
      args: [{ hasOn: true }, [['navigate', {}, { isMainFrame: true, isSameDocument: false }]]],
      note: 'a main-frame document load',
    },
    { args: [{ hasOn: true }, [['navigate', {}, { isMainFrame: false }]]], note: 'a subframe' },
    {
      args: [{ hasOn: true }, [['navigate', {}, { isSameDocument: true }]]],
      note: 'same document',
    },
    { args: [{ hasOn: true }, [['navigate', {}, {}]]], note: 'details with neither field' },
    {
      args: [{ hasOn: true }, [['navigate', {}, { isMainFrame: 0, isSameDocument: 1 }]]],
      note: 'not booleans',
    },
    { args: [{ hasOn: true }, [['navigate', {}, { isMainFrame: 'false' }]]], note: 'a string' },
    { args: [{ hasOn: true }, [['navigate', {}, []]]], note: 'details is an array' },
    {
      args: [{ hasOn: true }, [['navigate', {}, null, false, true]]],
      note: 'null details, legacy form, main frame',
    },
    {
      args: [{ hasOn: true }, [['navigate', {}, 'https://x/', false, true]]],
      note: 'legacy: not in place, main frame',
    },
    {
      args: [{ hasOn: true }, [['navigate', {}, 'https://x/', true, true]]],
      note: 'legacy: in place',
    },
    {
      args: [{ hasOn: true }, [['navigate', {}, 'https://x/', false, false]]],
      note: 'legacy: subframe',
    },
    { args: [{ hasOn: true }, [['navigate', {}, 'https://x/']]], note: 'legacy: flags absent' },
    {
      args: [{ hasOn: true }, [['navigate', {}, 'https://x/', 'true', 'false']]],
      note: 'legacy: strings',
    },
    {
      args: [{ hasOn: true }, [['navigate', {}, 'https://x/', false, null]]],
      note: 'legacy: null main frame',
    },
    { args: [{ hasOn: true }, [['navigate']]], note: 'no arguments at all' },
    { args: [{ hasOn: true }, [['navigate', {}, 5]]], note: 'a number as details' },
  ],
}

// ---------- marked-odt ----------

const odtText = (saveDocx?: string): MarkedOdtText => ({
  title: 'Hidden content',
  message: 'This document holds content hidden from AI.',
  detail: 'An ODT cannot keep it hidden.',
  ...(saveDocx === undefined ? {} : { saveDocx }),
  clearMarks: 'Clear the marks',
  cancel: 'Cancel',
})

const markedOdt: Record<string, FnSpec> = {
  'marked-odt.markedOdtBox': {
    ts: (a) => markedOdtBox(a[0] as MarkedOdtText),
    cases: [
      { args: [odtText('Save as Word')], note: 'Word offered: three buttons' },
      { args: [odtText()], note: 'no Word: two buttons, cancel is the second' },
      { args: [odtText('')], note: 'an empty Word label is still offered' },
      {
        args: [
          {
            title: '',
            message: '\uc228\uae40',
            detail: 'a\nb',
            saveDocx: '\u{1F600}',
            clearMarks: '',
            cancel: '',
          },
        ],
        note: 'empty and non-ASCII words',
      },
    ],
  },
  'marked-odt.markedOdtChoice': {
    ts: (a) =>
      a.length > 1 ? markedOdtChoice(num(a[0]), a[1] as boolean) : markedOdtChoice(num(a[0])),
    cases: each(
      [0],
      [1],
      [2],
      [-1],
      [-0],
      [0.5],
      [3],
      ['NaN'],
      ['Infinity'],
      [0, true],
      [1, true],
      [2, true],
      [0, false],
      [1, false],
      [2, false],
      [-1, false],
      ['NaN', false],
    ),
  },
}

export const group: Group = {
  ...i18nGroup,
  ...userSkills,
  ...mcpTools,
  ...outbound,
  ...docAttach,
  ...folderBridge,
  ...defaultSaveDir,
  ...dialogMemory,
  ...authorName,
  ...fontStore,
  ...githubMenu,
  ...hwpDefaultFormat,
  ...markedOdt,
  ...numberedPaths,
  ...templateFonts,
  ...templateFontsDirGroup,
  'abort-on-destroyed.abortOnDestroyed': abortOnDestroyedSpec,
}
