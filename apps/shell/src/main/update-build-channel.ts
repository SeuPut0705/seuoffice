import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * seuoffice update channels, fixed when the app is packaged
 * (SEUOFFICE_UPDATE_CHANNEL in electron-builder.cjs), never chosen by the user.
 * - 'latest': every published release, pre-releases included; feed latest.yml.
 * - 'stable': only the release GitHub marks Latest, which the owner promotes
 *   after checking it; feed stable.yml, whose installer is the stable build
 *   again, so an install never leaves its channel by updating.
 */
export type BuildUpdateChannel = 'latest' | 'stable'

/**
 * The channel electron-builder wrote into app-update.yml. Anything but an
 * explicit `channel: latest` reads as stable, so a damaged or foreign file
 * keeps an install on the checked releases.
 */
export function buildChannelFromAppUpdateYml(text: string): BuildUpdateChannel {
  const channel = /^channel:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m.exec(text)?.[1]
  return channel === 'latest' ? 'latest' : 'stable'
}

/** The packaged app's channel (resources/app-update.yml, as electron-updater reads it). */
export function packagedUpdateChannel(): BuildUpdateChannel {
  try {
    return buildChannelFromAppUpdateYml(
      readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'),
    )
  } catch {
    return 'stable'
  }
}
