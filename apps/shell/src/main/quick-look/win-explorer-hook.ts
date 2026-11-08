import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'

export interface ExplorerQuickLookEvents {
  onSpace: (filePath: string) => void
  onNavigate: (filePath: string) => void
  onEscape: () => void
}

interface HelperMessage {
  type?: 'ready' | 'space' | 'nav' | 'escape' | 'error'
  path?: string
  message?: string
}

function findCscExe(): string | null {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function resolveHelperBinary(): string | null {
  if (process.platform !== 'win32') return null

  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'quicklook', 'win-quicklook.exe') : '',
    resolve(import.meta.dirname, 'win-quicklook.exe'),
    resolve(import.meta.dirname, '../../src/main/quick-look/win-quicklook.exe'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Fallback for unpacked dev runs when build-win.mjs has not run yet.
  const csCandidates = [
    resolve(import.meta.dirname, 'win-quicklook.cs'),
    resolve(import.meta.dirname, '../../src/main/quick-look/win-quicklook.cs'),
  ]
  const csPath = csCandidates.find((c) => existsSync(c))
  const csc = findCscExe()
  if (!csPath || !csc) return null

  try {
    const outDir = join(app.getPath('userData'), 'quicklook')
    mkdirSync(outDir, { recursive: true })
    const outExe = join(outDir, 'win-quicklook.exe')
    if (!existsSync(outExe)) {
      execFileSync(
        csc,
        [
          '/nologo',
          '/optimize+',
          '/target:exe',
          '/r:System.dll',
          '/r:System.Core.dll',
          '/r:System.Windows.Forms.dll',
          '/r:Microsoft.CSharp.dll',
          `/out:${outExe}`,
          csPath,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
    }
    return existsSync(outExe) ? outExe : null
  } catch {
    return null
  }
}

export class WinExplorerQuickLookHook {
  private child: ChildProcess | null = null
  private enabled = false
  private readonly handlers: ExplorerQuickLookEvents

  constructor(handlers: ExplorerQuickLookEvents) {
    this.handlers = handlers
  }

  setEnabled(enabled: boolean): void {
    if (process.platform !== 'win32') return
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (enabled) {
      this.start()
    } else {
      this.stop()
    }
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed
  }

  private start(): void {
    if (this.child) return
    const exePath = resolveHelperBinary()
    if (!exePath) return

    try {
      const child = spawn(exePath, [], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
      this.child = child

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout })
        rl.on('line', (line) => {
          const trimmed = line.trim()
          if (!trimmed.startsWith('{')) return
          try {
            const msg = JSON.parse(trimmed) as HelperMessage
            if (msg.type === 'space' && typeof msg.path === 'string' && msg.path) {
              this.handlers.onSpace(msg.path)
            } else if (msg.type === 'nav' && typeof msg.path === 'string' && msg.path) {
              this.handlers.onNavigate(msg.path)
            } else if (msg.type === 'escape') {
              this.handlers.onEscape()
            }
          } catch {
            // Ignore malformed stdout lines.
          }
        })
      }

      child.on('exit', () => {
        if (this.child === child) {
          this.child = null
        }
      })
      child.on('error', () => {
        if (this.child === child) {
          this.child = null
        }
      })
    } catch {
      this.child = null
    }
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      // Ignore closed pipe.
    }
    try {
      if (!child.killed) {
        child.kill()
      }
    } catch {
      // Ignore already exited child.
    }
  }
}
