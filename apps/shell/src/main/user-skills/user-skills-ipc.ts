/**
 * The skills channels of the shell's main process. Any window may list
 * skills, read them for the AI (checked again here), save a skill card and
 * ask for the settings page; changing, importing, exporting and removing
 * skills is for the settings screen only. Previewed imports and found updates
 * wait under a token until installed or dropped; a window that goes away
 * drops its own.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain, shell, webContents } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { GitHubSkillUpdateCheck, SkillImport } from '@genoffice/ai-provider'
import {
  USER_SKILLS_CHANNELS as C,
  cardSaveInputOf,
  installRequestOf,
  saveInputOf,
  skillIdOf,
  statePatchOf,
  type UserSkillImportPreview,
  type UserSkillUpdateCheck,
  type UserSkillsFail,
  type UserSkillsResult,
} from '@genoffice/electron-utils/user-skills-channels'
import { failureOf, importPreviewOf, type UserSkillsService } from './user-skills-service'

export interface UserSkillsIpcDeps {
  service: UserSkillsService
  /**
   * whether a window may make this management call: the settings screen any of
   * them, the agent window only its install preview (spec 6.4)
   */
  canManage(sender: WebContents, channel: string): boolean
  /** bring the main window forward with the settings open on the skills page */
  openSettings(): void
  /** the agent window's one-time notice is due (spec 6.5) */
  agentNoticeDue(): boolean
  markAgentNoticeSeen(): void
}

const notAllowed: UserSkillsFail = { ok: false, reason: 'not-allowed' }
const invalid: UserSkillsFail = { ok: false, reason: 'invalid' }

interface Pending<T> {
  value: T
  owner: number
}

type ChangedCheck = Extract<GitHubSkillUpdateCheck, { status: 'changed' }>

export interface UserSkillsIpc {
  /** tell every window the list changed */
  broadcastChanged(): void
}

export function registerUserSkillsIpc(deps: UserSkillsIpcDeps): UserSkillsIpc {
  const { service } = deps
  const imports = new Map<string, Pending<SkillImport>>()
  const updates = new Map<string, Pending<{ id: string; check: ChangedCheck }>>()
  /** the GitHub import or update check running for a window */
  const running = new Map<number, AbortController>()
  const watched = new Set<number>()

  const broadcastChanged = () => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(C.changed)
    }
  }

  /** Drop everything a window left waiting when it goes away */
  const watch = (sender: WebContents) => {
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    const owner = sender.id
    sender.once('destroyed', () => {
      watched.delete(owner)
      running.get(owner)?.abort()
      running.delete(owner)
      for (const [token, entry] of imports) {
        if (entry.owner !== owner) continue
        imports.delete(token)
        void service.dispose(entry.value)
      }
      for (const [token, entry] of updates) {
        if (entry.owner !== owner) continue
        updates.delete(token)
        void service.dispose(entry.value.check.update)
      }
    })
  }

  const parentOf = (event: IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(event.sender) ?? undefined

  /** A management channel: the settings screen only */
  const manage = (
    channel: string,
    run: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!deps.canManage(event.sender, channel)) return notAllowed
      try {
        return await run(event, ...args)
      } catch (error) {
        return failureOf(error)
      }
    })
  }

  /** Run a change and tell every window when it worked */
  const changing = async <T extends { ok: boolean }>(work: Promise<T> | T): Promise<T> => {
    const done = await work
    if (done.ok) broadcastChanged()
    return done
  }

  const keepImport = (
    event: IpcMainInvokeEvent,
    imported: SkillImport,
  ): UserSkillsResult<{ preview: UserSkillImportPreview }> => {
    watch(event.sender)
    const token = randomUUID()
    imports.set(token, { value: imported, owner: event.sender.id })
    return { ok: true, preview: importPreviewOf(imported, token) }
  }

  // ---- any window ----

  ipcMain.handle(C.list, async () => {
    try {
      return await service.list()
    } catch {
      return []
    }
  })

  ipcMain.handle(C.read, async (_event, id: unknown) => {
    const skillId = skillIdOf(id)
    return skillId ? service.read(skillId).catch(failureOf) : invalid
  })

  ipcMain.handle(C.suggestName, async (_event, title: unknown) =>
    service.suggestName(typeof title === 'string' ? title.slice(0, 10_000) : '').catch(() => ''),
  )

  ipcMain.handle(C.checkName, async (_event, name: unknown, forId: unknown) => {
    if (typeof name !== 'string') return { ok: false, problem: 'empty' }
    return service
      .checkName(name, skillIdOf(forId))
      .catch(() => ({ ok: false, problem: 'empty' as const }))
  })

  ipcMain.handle(C.saveFromCard, async (_event, raw: unknown) => {
    const input = cardSaveInputOf(raw)
    if (!input) return invalid
    return changing(service.saveFromCard(input).catch(failureOf))
  })

  ipcMain.handle(C.aiRead, async (_event, id: unknown) => {
    const skillId = skillIdOf(id)
    return skillId ? service.aiRead(skillId).catch(failureOf) : invalid
  })

  ipcMain.handle(C.aiReadFile, async (_event, id: unknown, rel: unknown) => {
    const skillId = skillIdOf(id)
    if (!skillId || typeof rel !== 'string' || rel.length > 4096) return invalid
    return service.aiReadFile(skillId, rel).catch(failureOf)
  })

  ipcMain.handle(C.openSettings, () => {
    deps.openSettings()
  })

  ipcMain.handle(C.agentNotice, () => {
    try {
      return deps.agentNoticeDue()
    } catch {
      return false
    }
  })

  ipcMain.handle(C.agentNoticeSeen, () => {
    try {
      deps.markAgentNoticeSeen()
    } catch {
      // an unwritable settings file shows the notice once more next time
    }
  })

  // ---- the settings screen ----

  manage(C.setState, (_event, id: unknown, patch: unknown) => {
    const skillId = skillIdOf(id)
    const change = statePatchOf(patch)
    if (!skillId || !change) return invalid
    return changing(service.setState(skillId, change))
  })

  manage(C.hideBuiltin, (_event, id: unknown) => {
    const skillId = skillIdOf(id)
    return skillId ? changing(service.hideBuiltin(skillId)) : invalid
  })

  manage(C.unhideBuiltins, (_event, names: unknown) => {
    if (names !== undefined && !Array.isArray(names)) return invalid
    const list = Array.isArray(names)
      ? names.filter((name): name is string => typeof name === 'string')
      : undefined
    return changing(service.unhideBuiltins(list))
  })

  manage(C.remove, (_event, id: unknown) => {
    const skillId = skillIdOf(id)
    return skillId ? changing(service.remove(skillId)) : invalid
  })

  manage(C.copyToMine, (_event, id: unknown, overwrite: unknown) => {
    const skillId = skillIdOf(id)
    return skillId ? changing(service.copyToMine(skillId, overwrite === true)) : invalid
  })

  manage(C.save, (_event, raw: unknown) => {
    const input = saveInputOf(raw)
    return input ? changing(service.save(input)) : invalid
  })

  manage(C.importFolder, async (event) => {
    const parent = parentOf(event)
    const options = { properties: ['openDirectory' as const] }
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const folder = picked.filePaths[0]
    if (picked.canceled || !folder) return { ok: false, reason: 'cancelled' } as UserSkillsFail
    return keepImport(event, await service.prepareFolder(folder))
  })

  manage(C.importZip, async (event) => {
    const parent = parentOf(event)
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    }
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return { ok: false, reason: 'cancelled' } as UserSkillsFail
    return keepImport(event, await service.prepareZip(file))
  })

  manage(C.importGitHub, async (event, address: unknown) => {
    if (typeof address !== 'string' || address.length > 2048) return invalid
    const owner = event.sender.id
    if (running.has(owner)) return { ok: false, reason: 'busy' } as UserSkillsFail
    watch(event.sender)
    const controller = new AbortController()
    running.set(owner, controller)
    try {
      const imported = await service.prepareGitHub(address, controller.signal)
      if (controller.signal.aborted || event.sender.isDestroyed()) {
        await service.dispose(imported)
        return { ok: false, reason: 'cancelled' } as UserSkillsFail
      }
      return keepImport(event, imported)
    } finally {
      if (running.get(owner) === controller) running.delete(owner)
    }
  })

  manage(C.cancelImport, async (event, token: unknown) => {
    if (token === undefined || token === null) {
      running.get(event.sender.id)?.abort()
      return { ok: true }
    }
    if (typeof token !== 'string') return invalid
    const entry = imports.get(token)
    if (entry && entry.owner === event.sender.id) {
      imports.delete(token)
      await service.dispose(entry.value)
    }
    return { ok: true }
  })

  manage(C.install, async (event, raw: unknown) => {
    const request = installRequestOf(raw)
    if (!request) return invalid
    const entry = imports.get(request.token)
    if (!entry || entry.owner !== event.sender.id) {
      return { ok: false, reason: 'not-found' } as UserSkillsFail
    }
    const done = await service.install(entry.value, request)
    // a name choice still missing keeps the preview open for the person to answer
    if (done.ok || done.reason !== 'needs-choice') {
      imports.delete(request.token)
      await service.dispose(entry.value)
    }
    if (done.ok) broadcastChanged()
    return done
  })

  manage(C.checkUpdate, async (event, id: unknown): Promise<UserSkillUpdateCheck> => {
    const skillId = skillIdOf(id)
    if (!skillId) return invalid
    const owner = event.sender.id
    if (running.has(owner)) return { ok: false, reason: 'busy' }
    watch(event.sender)
    const controller = new AbortController()
    running.set(owner, controller)
    try {
      const answer = await service.checkUpdate(skillId, controller.signal)
      if (!answer.ok) return answer
      const check = answer.check
      if (check.status === 'up-to-date') {
        return { ok: true, status: 'up-to-date', locallyEdited: check.locallyEdited }
      }
      if (controller.signal.aborted || event.sender.isDestroyed()) {
        await service.dispose(check.update)
        return { ok: false, reason: 'cancelled' }
      }
      const token = randomUUID()
      updates.set(token, { value: { id: skillId, check }, owner })
      const preview = importPreviewOf(check.update, token)
      return {
        ok: true,
        status: 'changed',
        token,
        locallyEdited: check.locallyEdited,
        changedFiles: check.changedFiles,
        candidate: preview.candidates[0]!,
      }
    } finally {
      if (running.get(owner) === controller) running.delete(owner)
    }
  })

  manage(C.applyUpdate, async (event, token: unknown) => {
    if (typeof token !== 'string') return invalid
    const entry = updates.get(token)
    if (!entry || entry.owner !== event.sender.id) {
      return { ok: false, reason: 'not-found' } as UserSkillsFail
    }
    updates.delete(token)
    return changing(service.applyUpdate(entry.value.id, entry.value.check))
  })

  manage(C.cancelUpdate, async (event, token: unknown) => {
    if (typeof token !== 'string') return invalid
    const entry = updates.get(token)
    if (entry && entry.owner === event.sender.id) {
      updates.delete(token)
      await service.dispose(entry.value.check.update)
    }
    return { ok: true }
  })

  manage(C.exportInfo, (_event, id: unknown) => {
    const skillId = skillIdOf(id)
    return skillId ? service.exportInfo(skillId) : invalid
  })

  manage(C.exportZip, async (event, id: unknown) => {
    const skillId = skillIdOf(id)
    if (!skillId) return invalid
    const info = await service.exportInfo(skillId)
    if (!info.ok) return info
    const parent = parentOf(event)
    const options = {
      defaultPath: info.fileName,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    }
    const picked = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) {
      return { ok: false, reason: 'cancelled' } as UserSkillsFail
    }
    return service.exportTo(skillId, picked.filePath)
  })

  manage(C.openFolder, async (_event, id: unknown) => {
    const skillId = skillIdOf(id)
    if (!skillId) return invalid
    const folder = await service.folderOf(skillId)
    if (!folder.ok) return folder
    const error = await shell.openPath(folder.dir)
    return error ? ({ ok: false, reason: 'failed' } as UserSkillsFail) : { ok: true }
  })

  return { broadcastChanged }
}
