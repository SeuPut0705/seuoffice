import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\IeumOffice', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\IeumOffice', 'IeumOffice.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'IeumOffice', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'IeumOffice', 'IeumOffice.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/IeumOffice.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/IeumOffice.app/Contents/MacOS/IeumOffice'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/ieumoffice-custom/resources'), 'linux')).toBe(
      join('/opt/ieumoffice-custom/ieumoffice'),
    )
  })
})
