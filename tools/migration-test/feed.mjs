// A local update feed for the migration test (docs/seuoffice/3단계-넘어가기-시험.md).
// The installed app is pointed at it instead of GitHub, so an update from any
// Electron build to any candidate build (an Electron release, or a CEF build
// that is not released) runs through the app's own updater, unchanged.
//
//   node feed.mjs make  --file <installer.exe | app.zip> --version <v> --out <dir>
//   node feed.mjs serve --dir <dir> --port <port>
//   node feed.mjs point --resources <installed app's resources dir> --url <feed url>
//
// make: copies the file (and its .blockmap, when one is beside it) and writes
// the channel files electron-updater reads (latest.yml and stable.yml for an
// .exe, latest-mac.yml and stable-mac.yml for a .zip), so a build of either
// channel finds it.
// serve: answers a single byte range with 206, so a block-map download takes
// only the changed blocks; each line of its log is one request, a range with
// its bytes.
// point: rewrites resources/app-update.yml to the generic provider at <url>,
// keeping the other keys (the channel, the cache folder name). On macOS the
// bundle must be signed again afterwards (the scripts do it).

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { basename, join, normalize } from 'node:path'
import { parseArgs } from 'node:util'

const [command, ...rest] = process.argv.slice(2)
const { values } = parseArgs({
  args: rest,
  options: {
    file: { type: 'string' },
    version: { type: 'string' },
    out: { type: 'string' },
    dir: { type: 'string' },
    port: { type: 'string', default: '8765' },
    resources: { type: 'string' },
    url: { type: 'string' },
  },
})

function need(name) {
  if (!values[name]) throw new Error(`--${name} is required for ${command}`)
  return values[name]
}

if (command === 'make') {
  const file = need('file')
  const out = need('out')
  const name = basename(file)
  copyFileSync(file, join(out, name))
  if (existsSync(`${file}.blockmap`))
    copyFileSync(`${file}.blockmap`, join(out, `${name}.blockmap`))
  const bytes = readFileSync(file)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const yml = [
    `version: ${need('version')}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
  const suffix = name.endsWith('.zip') ? '-mac' : ''
  for (const channel of ['latest', 'stable']) {
    writeFileSync(join(out, `${channel}${suffix}.yml`), yml)
  }
  console.log(yml)
} else if (command === 'serve') {
  const dir = need('dir')
  const port = Number(values.port)
  createServer((req, res) => {
    const path = normalize(join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
    let size
    try {
      if (!path.startsWith(normalize(dir))) throw new Error('outside')
      size = statSync(path).size
    } catch {
      res.writeHead(404).end()
      console.log('404', req.url)
      return
    }
    // one range only: several (electron-updater's generic provider asks for
    // up to 1000 at once) get the whole file, which makes it download fully
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (range && Number(range[2]) < size && Number(range[1]) <= Number(range[2])) {
      const [start, end] = [Number(range[1]), Number(range[2])]
      console.log(req.method, req.url, 'range', start, end, 'bytes', end - start + 1)
      res.writeHead(206, {
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
      })
      if (req.method === 'HEAD') res.end()
      else createReadStream(path, { start, end }).pipe(res)
      return
    }
    console.log(req.method, req.url, 'bytes', size)
    res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' })
    if (req.method === 'HEAD') res.end()
    else createReadStream(path).pipe(res)
  }).listen(port, '127.0.0.1', () => console.log(`feed ${dir} on http://127.0.0.1:${port}/`))
} else if (command === 'point') {
  const path = join(need('resources'), 'app-update.yml')
  const replaced = new Set([
    'provider',
    'owner',
    'repo',
    'url',
    'releaseType',
    'private',
    'vPrefixedTagName',
  ])
  const kept = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !replaced.has(line.split(':')[0].trim()))
  const yml = ['provider: generic', `url: ${need('url')}`, ...kept, ''].join('\n')
  writeFileSync(path, yml)
  console.log(yml)
} else {
  console.error('usage: node feed.mjs make|serve|point ...')
  process.exit(2)
}
