/**
 * `process` for preloads: a sandboxed Electron preload had one; a page of the
 * CEF shell does not. Only what the preload sources read (`process.env.X`
 * switches, the platform name).
 */
const platform = /Win/i.test(navigator.platform)
  ? 'win32'
  : /Mac/i.test(navigator.platform)
    ? 'darwin'
    : 'linux'

export const process = {
  env: {} as Record<string, string | undefined>,
  platform,
  versions: {} as Record<string, string>,
}
