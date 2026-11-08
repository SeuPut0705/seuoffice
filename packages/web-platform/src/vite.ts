import { fileURLToPath } from 'node:url'
import type { Alias, Plugin } from 'vite'

const shim = (stem: string): string => fileURLToPath(new URL(`./shims/${stem}.ts`, import.meta.url))

/** Node built-in → shim file stem */
const NODE_SHIMS: Record<string, string> = {
  zlib: 'zlib',
  crypto: 'crypto',
  path: 'path',
  fs: 'fs',
  'fs/promises': 'fs-promises',
  os: 'os',
  child_process: 'child-process',
  worker_threads: 'worker-threads',
  readline: 'readline',
  net: 'net',
  'stream/promises': 'stream-promises',
  url: 'url',
}

const escape = (text: string): string => text.replace(/[/]/g, '\\/')

/** Point Node built-ins and electron at the browser shims, and the template fonts at the web folder */
export function seuofficeWebAliases(): Alias[] {
  return [
    ...Object.entries(NODE_SHIMS).map(([id, stem]) => ({
      find: new RegExp(`^(node:)?${escape(id)}$`),
      replacement: shim(stem),
    })),
    { find: /^node:buffer$/, replacement: 'buffer' },
    { find: /^electron$/, replacement: shim('electron') },
    {
      find: /^@genoffice\/ui\/template-fonts$/,
      replacement: fileURLToPath(new URL('./template-fonts.ts', import.meta.url)),
    },
  ]
}

/** electron-vite's `?asset` import is a plain asset URL in a web build */
function assetSuffixCompat(): Plugin {
  return {
    name: 'seuoffice:asset-suffix-compat',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith('?asset')) return null
      return this.resolve(`${source.slice(0, -'?asset'.length)}?url`, importer, { skipSelf: true })
    },
  }
}
/** Worker bundle entries get the Node globals that the page entry imports itself */
function workerEntryGlobals(): Plugin {
  return {
    name: 'seuoffice:worker-entry-globals',
    transform(code, id) {
      if (!this.getModuleInfo(id)?.isEntry) return null
      return { code: `import '@seuoffice/web-platform/globals'\n${code}`, map: null }
    },
  }
}

export function seuofficeWebPlugins(): Plugin[] {
  return [assetSuffixCompat()]
}

/** `worker` options for an app's web config: workers are bundled separately and need their own plugins */
export function seuofficeWebWorker(): { format: 'es'; plugins: () => Plugin[] } {
  return { format: 'es', plugins: () => [assetSuffixCompat(), workerEntryGlobals()] }
}
