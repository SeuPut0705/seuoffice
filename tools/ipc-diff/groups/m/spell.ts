/**
 * Group `m/spell`: the docs renderer's spellcheck and context-menu channels.
 *
 * The handlers are inline in `registerDocsIpc`, which cannot be loaded on the
 * fake Electron, so their bodies are copied verbatim here from
 * apps/docs/src/main/docs-main.ts:
 *   - 1027-1040  spellIgnored / journalIgnoredWords / releaseSpellIgnores
 *   - 2859-2871  docs:spell-diag
 *   - 2880-2915  ctxMenuClaims, docs:context-menu-claim, docs:context-menu-arm,
 *                the app.whenReady() orphan scrub
 *   - 2916-2965  docs:spell-ignore-word, -add-word, -replace, -languages,
 *                -set-languages, docs:respell-kick
 * (plus userDataPath 781 and readJson 785). They call the real
 * `writeJsonAtomic`, `setContextMenuInterceptor` and `ClickClaims`.
 *
 * Faked, because they are Electron: the sender's `session`, `defaultSession`,
 * `replaceMisspelling`, `sendInputEvent`, `once`, and the clock (`hosts.m.now`,
 * as probe.rs reads it: Date.now and `new Date()` both). The clock stands
 * still, so claims never expire here; the interceptor is only called by the
 * shell's native `context-menu` event, which no channel call reaches, so
 * `docs:context-menu` is not emitted by any case.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setContextMenuInterceptor } from '../../../../packages/electron-utils/src/context-menu.ts'
import { writeJsonAtomic } from '../../../../packages/electron-utils/src/atomic-write.ts'
import { ClickClaims } from '../../../../apps/docs/src/shared/context-menu-claims.ts'
import type { Call, Case, Group } from '../../types.ts'

const call = (channel: string, args: unknown[], kind?: Call['kind']): Call => ({
  channel,
  args,
  ...(kind ? { kind } : {}),
})
const invoke = (channel: string, ...args: unknown[]): Call => call(channel, args)
const U = { $: 'u' }

const orphans = (words: unknown) => ({ 'userData/spell-ignored.json': JSON.stringify(words) })
/** a trace file over the 256 KB cap, made of numbered lines */
const bigDiag = (lines: number) => ({
  'userData/spell-diag.log': Array.from({ length: lines }, (_, i) => `old ${i} ${'x'.repeat(100)}`)
    .join('\n')
    .concat('\n'),
})

const cases: Case[] = [
  {
    note: 'ignore a word: journal written, word added, trimmed; same word from a second view',
    views: [
      { view: 1, window: 1, surface: 'Docs' },
      { view: 2, window: 2, surface: 'Docs' },
    ],
    calls: [
      invoke('docs:spell-ignore-word', '  seuoffice '),
      invoke('docs:spell-ignore-word', 'seuoffice'),
      { ...invoke('docs:spell-ignore-word', 'other'), view: 2 },
    ],
  },
  {
    note: 'ignore refuses non-strings and blanks',
    calls: [
      invoke('docs:spell-ignore-word', 12),
      invoke('docs:spell-ignore-word', '   '),
      invoke('docs:spell-ignore-word', U),
      invoke('docs:spell-ignore-word', ''),
    ],
  },
  {
    note: 'the dictionary refuses the word: the journal already has it',
    hosts: { m: { addWord: false } },
    calls: [invoke('docs:spell-ignore-word', 'nope')],
  },
  {
    note: 'add after ignore promotes the word out of the journal; add of an unknown word writes nothing',
    calls: [
      invoke('docs:spell-ignore-word', 'alpha'),
      invoke('docs:spell-ignore-word', 'beta'),
      invoke('docs:spell-add-word', ' alpha '),
      invoke('docs:spell-add-word', 'gamma'),
    ],
  },
  {
    note: 'add refuses non-strings and blanks; the dictionary answer is passed through',
    hosts: { m: { addWord: false } },
    calls: [
      invoke('docs:spell-add-word', null),
      invoke('docs:spell-add-word', '\t\n'),
      invoke('docs:spell-add-word', 'word'),
    ],
  },
  {
    note: 'replace: a word is passed untrimmed; empty and non-strings do nothing',
    calls: [
      invoke('docs:spell-replace', ' fix '),
      invoke('docs:spell-replace', ''),
      invoke('docs:spell-replace', 5),
      invoke('docs:spell-replace'),
    ],
  },
  {
    note: 'languages with the defaults and with a configured set',
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'languages as configured (macOS-like: nothing available)',
    hosts: { m: { spellLanguages: ['ko', 'en-US'], spellAvailable: [] } },
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'set languages: unavailable and non-string entries filtered, duplicates passed, read back',
    calls: [
      invoke('docs:spell-set-languages', ['ko', 'xx', 3, 'ko']),
      invoke('docs:spell-languages'),
    ],
  },
  {
    note: 'set languages: nothing valid sets nothing; non-arrays too',
    hosts: { m: { spellAvailable: ['en-US', 'ko', 'en-US'] } },
    calls: [
      invoke('docs:spell-set-languages', ['xx']),
      invoke('docs:spell-set-languages', 'ko'),
      invoke('docs:spell-set-languages'),
      invoke('docs:spell-set-languages', ['en-US']),
    ],
  },
  {
    note: 'respell kick: focus, three keystrokes, then undefined',
    views: [
      { view: 1, window: 1, surface: 'Docs' },
      { view: 2, window: 2, surface: 'Docs' },
    ],
    calls: [invoke('docs:respell-kick'), { ...invoke('docs:respell-kick'), view: 2 }],
  },
  {
    note: 'arm and claim: always answered, claims of any kind',
    calls: [
      call('docs:context-menu-arm', [], 'send'),
      call('docs:context-menu-claim', [7], 'sendSync'),
      call('docs:context-menu-claim', ['7'], 'sendSync'),
      call('docs:context-menu-claim', [-1.5], 'sendSync'),
      call('docs:context-menu-claim', [], 'sendSync'),
      call('docs:context-menu-arm', [], 'send'),
    ],
  },
  {
    note: 'diag: a line is appended with the clock; an over-long or non-string line is dropped',
    calls: [
      call('docs:spell-diag', ['toggle on'], 'send'),
      call('docs:spell-diag', ['kick'], 'send'),
      call('docs:spell-diag', ['x'.repeat(500)], 'send'),
      call('docs:spell-diag', ['x'.repeat(501)], 'send'),
      call('docs:spell-diag', [42], 'send'),
    ],
  },
  {
    note: 'diag with another clock reading',
    hosts: { m: { now: 1234567890123 } },
    calls: [call('docs:spell-diag', ['later'], 'send')],
  },
  {
    note: 'diag: a file over 256 KB restarts from its last half',
    files: bigDiag(2800),
    calls: [call('docs:spell-diag', ['after restart'], 'send')],
  },
  {
    note: 'startup: orphaned words from a crash leave the dictionary, journal rewritten empty; the next ignore journals again',
    files: orphans(['stale', 'old word']),
    calls: [invoke('docs:spell-ignore-word', 'fresh')],
  },
  {
    note: 'startup: an empty journal and a corrupt one scrub nothing',
    files: orphans([]),
    calls: [invoke('docs:spell-add-word', 'x')],
  },
  {
    note: 'startup: a journal that is not an array of strings',
    files: { 'userData/spell-ignored.json': '{"a":1}' },
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'startup: unparsable journal',
    files: { 'userData/spell-ignored.json': '[not json' },
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'startup: strings among other things',
    files: orphans(['one', 2, null, 'three']),
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'a Shell view is refused the docs channels',
    views: [{ view: 1, window: 1, surface: 'Shell' }],
    calls: [invoke('docs:spell-replace', 'x'), invoke('docs:respell-kick')],
  },
  {
    note: 'startup: a journal holding a string is iterated by characters',
    files: { 'userData/spell-ignored.json': '"ab"' },
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'startup: a journal holding null or a number is not iterable',
    files: { 'userData/spell-ignored.json': 'null' },
    calls: [invoke('docs:spell-languages')],
  },
  {
    note: 'startup: an array that starts with a non-string stops the scrub',
    files: orphans([7, 'late']),
    calls: [invoke('docs:spell-languages')],
  },
].map((c) => ({ views: [{ view: 1, window: 1, surface: 'Docs' }], ...c }))

export const group: Group = {
  batch: 'M',
  async load(cx) {
    const { electron } = cx
    const app = electron.app as { getPath(name: string): string; whenReady(): Promise<void> }
    const log = electron.log
    const config = ((cx.case.hosts ?? {}).m ?? {}) as Record<string, unknown>
    const strings = (key: string, fallback: string[]): string[] =>
      Array.isArray(config[key]) ? (config[key] as unknown[]).filter((v) => typeof v === 'string') as string[] : fallback

    // the clock of the case, as probe.rs's `now`
    const now = typeof config.now === 'number' ? config.now : 1_700_000_000_000
    const RealDate = globalThis.Date
    class FakeDate extends RealDate {
      constructor(...args: unknown[]) {
        super(...((args.length === 0 ? [now] : args) as [number]))
      }
      static override now(): number {
        return now
      }
    }
    globalThis.Date = FakeDate as DateConstructor

    // the sessions: one language list, read back by getSpellCheckerLanguages
    let languages: string[] | null = null
    const sessionOf = (id: number) => ({
      addWordToSpellCheckerDictionary: (word: string) => {
        log.push(['session.addWordToSpellCheckerDictionary', id, word])
        return typeof config.addWord === 'boolean' ? config.addWord : true
      },
      getSpellCheckerLanguages: () => languages ?? strings('spellLanguages', ['en-US']),
      get availableSpellCheckerLanguages() {
        return strings('spellAvailable', ['en-US', 'ko'])
      },
      setSpellCheckerLanguages: (next: string[]) => {
        log.push(['session.setSpellCheckerLanguages', id, next])
        languages = [...next]
      },
    })
    const session = {
      defaultSession: {
        removeWordFromSpellCheckerDictionary: (word: string) => {
          // Electron's argument conversion throws before the call is made
          if (typeof word !== 'string') throw new TypeError('Error processing argument at index 0')
          log.push(['session.removeWordFromSpellCheckerDictionary', word])
        },
      },
    }
    for (const v of cx.case.views ?? [{ view: 1 }]) {
      const wc = electron.contents(v.view)
      wc.session = sessionOf(v.view)
      wc.replaceMisspelling = (word: string) =>
        log.push(['webContents.replaceMisspelling', v.view, word])
      wc.sendInputEvent = (event: unknown) =>
        log.push(['webContents.sendInputEvent', v.view, event])
      wc.once = () => wc
    }

    const userDataPath = (...parts: string[]): string => join(app.getPath('userData'), ...parts)
    function readJson<T>(path: string, fallback: T): T {
      try {
        if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
      } catch {
        /* corrupted state file: fall back to defaults */
      }
      return fallback
    }
    // torn-down views need a document batch; none is in the probe
    const tornDownWcIds = new Set<number>()
    const ipcMain = electron.ipcMain as {
      on(ch: string, fn: (...a: any[]) => unknown): void
      handle(ch: string, fn: (...a: any[]) => unknown): void
    }

    // docs-main.ts:1027-1040
    const SPELL_IGNORED_PATH = () => userDataPath('spell-ignored.json')
    const spellIgnored = new Map<string, Set<number>>()
    const journalIgnoredWords = () =>
      writeJsonAtomic(SPELL_IGNORED_PATH(), [...spellIgnored.keys()])

    // docs-main.ts:2859-2871
    ipcMain.on('docs:spell-diag', (_event, line: unknown) => {
      if (typeof line !== 'string' || line.length > 500) return
      try {
        const path = userDataPath('spell-diag.log')
        if (existsSync(path) && statSync(path).size > 256 * 1024) {
          const tail = readFileSync(path, 'utf-8').slice(-128 * 1024)
          writeFileSync(path, tail.slice(tail.indexOf('\n') + 1))
        }
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // diagnostics must never break the app
      }
    })

    // docs-main.ts:2880-2915
    const ctxMenuClaims = new Map<number, ClickClaims>()
    ipcMain.on('docs:context-menu-claim', (event, seq: unknown) => {
      event.returnValue = true
      if (typeof seq !== 'number') return
      let claims = ctxMenuClaims.get(event.sender.id)
      if (!claims) {
        claims = new ClickClaims()
        ctxMenuClaims.set(event.sender.id, claims)
      }
      claims.claim(seq, Date.now())
    })
    ipcMain.on('docs:context-menu-arm', (event) => {
      const wc = event.sender
      setContextMenuInterceptor(app as never, wc, (contents: any, params: any) => {
        if (contents.isDestroyed() || tornDownWcIds.has(contents.id)) return Promise.resolve(false)
        const seq = ctxMenuClaims.get(contents.id)?.take(Date.now()) ?? null
        if (seq !== null) {
          const request = {
            seq,
            misspelledWord: params.misspelledWord,
            suggestions: params.dictionarySuggestions,
          }
          contents.send('docs:context-menu', request)
        }
        return Promise.resolve(seq !== null)
      })
      wc.once('destroyed', () => {
        setContextMenuInterceptor(app as never, wc, null)
        ctxMenuClaims.delete(wc.id)
      })
    })
    // Rust scrubs in `register`, before the first call: finish it before load returns.
    // The real call is `void app.whenReady().then(...)`: a throw inside only
    // ends the scrub as an unhandled rejection, which the catch stands for.
    await app
      .whenReady()
      .then(() => {
        const orphans = readJson<string[]>(SPELL_IGNORED_PATH(), [])
        for (const w of orphans) session.defaultSession.removeWordFromSpellCheckerDictionary(w)
        if (orphans.length) journalIgnoredWords()
      })
      .catch(() => {})
    // docs-main.ts:2916-2965
    ipcMain.handle('docs:spell-ignore-word', (event, word: unknown) => {
      if (typeof word !== 'string' || !word.trim()) return false
      const w = word.trim()
      let holders = spellIgnored.get(w)
      if (!holders) {
        holders = new Set()
        spellIgnored.set(w, holders)
        journalIgnoredWords()
      }
      holders.add(event.sender.id)
      return event.sender.session.addWordToSpellCheckerDictionary(w)
    })
    ipcMain.handle('docs:spell-add-word', (event, word: unknown) => {
      if (typeof word !== 'string' || !word.trim()) return false
      const w = word.trim()
      if (spellIgnored.delete(w)) journalIgnoredWords()
      return event.sender.session.addWordToSpellCheckerDictionary(w)
    })
    ipcMain.handle('docs:spell-replace', (event, word: unknown) => {
      if (typeof word === 'string' && word) event.sender.replaceMisspelling(word)
    })
    ipcMain.handle('docs:spell-languages', (event) => {
      const session = event.sender.session
      return {
        active: session.getSpellCheckerLanguages(),
        available: session.availableSpellCheckerLanguages,
      }
    })
    ipcMain.handle('docs:spell-set-languages', (event, langs: unknown) => {
      const session = event.sender.session
      const available = new Set(session.availableSpellCheckerLanguages)
      const next = Array.isArray(langs)
        ? langs.filter((l): l is string => typeof l === 'string' && available.has(l))
        : []
      if (next.length) session.setSpellCheckerLanguages(next)
      return { active: session.getSpellCheckerLanguages(), available: [...available] }
    })
    ipcMain.handle('docs:respell-kick', async (event) => {
      const wc = event.sender
      if (tornDownWcIds.has(wc.id) || wc.isDestroyed()) return
      wc.focus()
      // Blink only respells after a user activation, and only a keydown grants one
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
      wc.sendInputEvent({ type: 'char', keyCode: ' ' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
      // resolve only after the input pipeline has delivered the keystroke, so
      // the caller can scrub the space it produced
      await new Promise((r) => setTimeout(r, 120))
    })
  },
  cases,
  single: {
    'docs:context-menu-claim':
      'answers true whatever the argument; the claim only matters to the native context-menu hook, which no channel call reaches',
  },
}
