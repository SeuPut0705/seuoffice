import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\seuoffice', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\seuoffice', 'SeuOffice.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'seuoffice', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'seuoffice', 'SeuOffice.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/seuoffice.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/seuoffice.app/Contents/MacOS/SeuOffice'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/seuoffice-custom/resources'), 'linux')).toBe(
      join('/opt/seuoffice-custom/seuoffice'),
    )
  })
})
