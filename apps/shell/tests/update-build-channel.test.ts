import { describe, expect, it } from 'vitest'
import { buildChannelFromAppUpdateYml } from '../src/main/update-build-channel'

describe('the update channel a packaged build carries', () => {
  // what electron-builder 26 writes into resources/app-update.yml
  const appUpdateYml = (channel: string): string =>
    `owner: seuput-inc\nrepo: seuoffice\nprovider: github\nchannel: ${channel}\nupdaterCacheDirName: seuoffice-updater\n`

  it('reads the channel the build was packaged with', () => {
    expect(buildChannelFromAppUpdateYml(appUpdateYml('latest'))).toBe('latest')
    expect(buildChannelFromAppUpdateYml(appUpdateYml('stable'))).toBe('stable')
    expect(buildChannelFromAppUpdateYml(appUpdateYml("'latest'"))).toBe('latest')
  })

  it('keeps an install on the checked releases unless the file says latest', () => {
    for (const text of ['', appUpdateYml('beta'), appUpdateYml('latest-extra'), 'channel:\n']) {
      expect(buildChannelFromAppUpdateYml(text), JSON.stringify(text)).toBe('stable')
    }
  })
})
