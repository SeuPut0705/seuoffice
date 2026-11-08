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

/** Point Node built-ins and electron at the browser shims */
export function seuofficeWebAliases(): Alias[] {
  return [
    ...Object.entries(NODE_SHIMS).map(([id, stem]) => ({
      find: new RegExp(`^(node:)?${escape(id)}$`),
      replacement: shim(stem),
    })),
    { find: /^node:buffer$/, replacement: 'buffer' },
    { find: /^electron$/, replacement: shim('electron') },
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

/** Worker entry modules get the Node globals the page entry imports itself */
function workerGlobals(): Plugin {
  return {
    name: 'seuoffice:worker-globals',
    transform(code, id) {
      if (!id.includes('?worker_file')) return null
      return { code: `import '@seuoffice/web-platform/globals'\n${code}`, map: null }
    },
  }
}

export function seuofficeWebPlugins(): Plugin[] {
  return [assetSuffixCompat(), workerGlobals()]
}
