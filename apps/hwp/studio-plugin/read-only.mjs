/**
 * A studio that shows a document and cannot change it: the web build's page opened only to view
 * one (any mode but `?mode=edit`, apps/hwp/src/web/bridge.ts). The studio has no read-only mode of
 * its own; its form mode still lets form fields, form objects, object drags and plugin edits
 * through, so this is three gates the studio-read-only-* patches put in place:
 *
 * - commands (menus, toolbar, right-click, shortcuts): only the ones that read stay enabled;
 * - edit operations (typing, deleting, pasting, plugin transactions): the input handler refuses
 *   them before they run, as it refuses an edit outside a field in form mode;
 * - the engine document: every call that changes it throws, whatever path reaches it (an object
 *   drag, a form object click, IME composition), so a path the first two miss changes nothing.
 *
 * The page holding the studio asks for it with an attribute on its root element, set before the
 * studio frame exists. The desktop app never sets it, and there all three gates stay open.
 */

/** Module specifier the studio-read-only-* patches import; build-studio.mjs aliases it. */
export const READ_ONLY_MODULE = '@seuoffice/studio-read-only'

/** The attribute on the parent page's root element that asks for a read-only studio. */
export const READ_ONLY_ATTRIBUTE = 'data-studio-read-only'

/** Whether the page holding this window asked for a read-only studio. */
export function askedReadOnly(win) {
  try {
    return (
      win.parent !== win && win.parent.document.documentElement.hasAttribute(READ_ONLY_ATTRIBUTE)
    )
  } catch {
    // a parent on another origin did not ask
    return false
  }
}

/** Read once at start-up: the parent sets the attribute before the studio frame is made. */
export const STUDIO_READ_ONLY = globalThis.window !== undefined && askedReadOnly(globalThis.window)

/** Studio commands that leave the document as it is. */
const READING_COMMANDS = new Set([
  'edit:copy',
  'edit:select-all',
  'edit:find',
  'edit:find-again',
  'edit:goto',
  'file:print',
  'file:print-to-pdf',
  'file:about',
  'tool:options',
])

/**
 * Whether a read-only studio runs this command. The `view:` commands change the view (zoom,
 * marks), except the form-mode switch. The app plugins' `ext:` commands stay: the ones that read
 * (counts, marks, the app's file menu) need to run, and an edit among them stops at the next gates.
 */
export function readOnlyAllows(commandId) {
  if (READING_COMMANDS.has(commandId)) return true
  if (commandId.startsWith('view:')) return commandId !== 'view:form-mode'
  return commandId.startsWith('ext:')
}

/**
 * The engine document's calls that leave it as it is: reading, drawing, exporting, hit tests,
 * caret moves, the editor's own clipboard, undo captures, fonts, pagination and display settings,
 * and the binding's own `__` helpers. Every other call, including one a later engine adds, is
 * taken for a change.
 */
const READING_CALL =
  /^(?:__|get|render|export|hitTest|search|has|is[A-Z]|clipboard(?:Has|Is)|copy|measure|page(?:Count|Has)|navigate|moveVertical|logicalTo|textTo|fontMissing|fontSupports|ordinaryTextFont|canvasMetrics|collectCanvas|selectCanvas|capture|discard|saveSnapshot|snapshotCapacity|listCharts|findNearest|findNext|set(?:ActiveField|CaretPosition|Show|ClipEnabled|Dpi|FallbackFont|FontEnvironment|ObservedFontFallbacks|ExactFontInstance|Hangul2024Compat|AnnotateMetricFont|FileName)|set_|clear(?:ActiveField|Clipboard|ExactFontInstance|MetafileFonts|NativePuaFonts)|register|prepareNativeOtfFonts|buildFontEnvironment|(?:begin|step|flush|cancel)DeferredPagination|(?:begin|end)Batch|convertToEditable|free$|constructor$)/

/** The engine document behind a guard that throws on every call that would change it. */
export function readOnlyDocument(doc) {
  const calls = Object.getPrototypeOf(doc)
  return new Proxy(doc, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof key !== 'string' || typeof value !== 'function') return value
      if (!Object.hasOwn(calls, key) || READING_CALL.test(key)) return value
      return () => {
        throw new Error(`read-only document: ${key} would change it`)
      }
    },
  })
}
