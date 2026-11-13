/**
 * `WinExplorerQuickLookHook` for the quick-look group: no helper program runs.
 * Once the hook is enabled it reports what the case's script lists, in order
 * (`hosts.w.quickLook.script`), and waits for each report to finish: the
 * extraction reads a file and the exit animation takes 155 ms, so a pause
 * longer than both follows each one. The Rust fake (`quick_look/probe.rs`)
 * plays the same script and waits for its workers instead.
 */
import { quickLookBox } from './quick-look-box.ts'

interface Handlers {
  onSpace(filePath: string): void
  onNavigate(filePath: string): void
  onEscape(): void
}

const PAUSE_MS = 220
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class WinExplorerQuickLookHook {
  constructor(private readonly handlers: Handlers) {}

  setEnabled(enabled: boolean): void {
    const box = quickLookBox()
    box.log.push(['WinExplorerQuickLookHook.setEnabled', enabled])
    if (!enabled || box.started) return
    box.started = true
    box.played = this.play()
  }

  stop(): void {}

  private async play(): Promise<void> {
    const box = quickLookBox()
    for (const op of box.script) {
      if (op.op === 'space') this.handlers.onSpace(op.path ?? '')
      else if (op.op === 'navigate') this.handlers.onNavigate(op.path ?? '')
      else if (op.op === 'escape') this.handlers.onEscape()
      else box.notify()
      await sleep(PAUSE_MS)
    }
  }
}
