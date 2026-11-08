import type { UniverRuntime } from '../../src/renderer/univer-state'
import { inert } from './stub-installers'

/** What the mounted App built: the real Univer model (no canvas, no UI plugins). */
export const mounted: { runtime: UniverRuntime | null } = { runtime: null }

/** The in-cell editor commit App awaits before every apply; a test holds the next one to keep an apply in flight. */
export const commitGate = {
  held: null as Promise<void> | null,
  hold(): () => void {
    let release = () => {}
    this.held = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  },
}

/**
 * `createUniver` for jsdom: the real Univer core and sheets model, which the blank-workbook path and
 * the undo stack run on, without the render engine, canvas or UI plugins. Services those plugins
 * would provide resolve to an inert value so the chrome installers see something to call.
 */
export async function minimalUniverModule() {
  const { Univer, LocaleType, LogLevel } = await import('@univerjs/core')
  const { FUniver } = await import('@univerjs/core/lib/facade')
  const { UniverSheetsPlugin } = await import('@univerjs/sheets')
  const { FWorkbook } = await import('@univerjs/sheets/facade')
  // the cell editor belongs to the UI facade, which is not loaded: nothing is ever being edited
  Object.assign(FWorkbook.prototype, { isCellEditing: () => false })
  return {
    createUniver: () => {
      const univer = new Univer({
        logLevel: LogLevel.SILENT,
        locale: LocaleType.EN_US,
        locales: { [LocaleType.EN_US]: {} },
      })
      univer.registerPlugin(UniverSheetsPlugin)
      const injector = univer.__getInjector() as unknown as { get: (...args: unknown[]) => unknown }
      const real = injector.get.bind(injector)
      injector.get = (...args) => {
        try {
          return real(...args)
        } catch {
          return inert
        }
      }
      const univerAPI = FUniver.newAPI(univer) as unknown as {
        addEvent: (event: unknown, callback: unknown) => unknown
      }
      const addEvent = univerAPI.addEvent.bind(univerAPI)
      // events only the UI facade defines are undefined here
      univerAPI.addEvent = (event, callback) =>
        event ? addEvent(event, callback) : { dispose() {} }
      mounted.runtime = { univer, univerAPI } as unknown as UniverRuntime
      return mounted.runtime
    },
  }
}

export function univerStateWithGatedCommit<T extends { commitActiveCellEditor: unknown }>(
  state: T,
): T {
  const commit = state.commitActiveCellEditor as (...args: unknown[]) => Promise<boolean>
  return {
    ...state,
    commitActiveCellEditor: async (...args: unknown[]) => {
      const held = commitGate.held
      commitGate.held = null
      await held
      return commit(...args)
    },
  }
}
