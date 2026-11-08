/**
 * Regenerates every file derived from the IeumOffice brand sources in
 * apps/shell/build/brand/:
 *
 *   app-icon.svg        -> app / installer icons (png, ico, icns, Linux size
 *                          set) and the in-app app-icon.png copies
 *   app-icon-small.svg  -> the same icon redrawn bolder for slots of 32 px and
 *                          below (optional: without it app-icon.svg is used)
 *   logo-lockup.svg     -> the shell sidebar logo (copied verbatim)
 *
 * To rebrand, replace those SVGs and run:
 *   node tools/gen-brand-assets.mjs
 *
 * Optional: `--preview <file.png>` also writes a contact sheet (icon at
 * 16/32/48/256 px on light and dark backgrounds, the lockup and the AI mark)
 * for a quick visual check. The sheet is not part of the repo.
 *
 * The SVG is rasterized with the system Chrome (or Edge) through
 * playwright-core, the same approach as tools/gen-file-association-icons.mjs.
 * The ICO and ICNS containers are written by hand, so the script runs on any
 * host OS and needs no dependency beyond the root devDependencies.
 *
 * Not generated here: packages/ui/src/AiMark.tsx is a hand-written React
 * component that mirrors apps/shell/build/brand/ai-mark.svg.
 */

/* global Image, document -- used inside page.evaluate callbacks, which run in the browser */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'apps/shell/build/brand')
const ICON_SVG = join(brandDir, 'app-icon.svg')
const ICON_SMALL_SVG = join(brandDir, 'app-icon-small.svg')
// Largest canvas (px) that is drawn from the small optical size.
const SMALL_ICON_MAX_PX = 32
const LOCKUP_SVG = join(brandDir, 'logo-lockup.svg')
const AI_MARK_SVG = join(brandDir, 'ai-mark.svg')

// Full-bleed 1024 px icon: electron-builder's Windows/Linux fallback and the
// image the renderers show in onboarding / update / about surfaces.
const FULL_BLEED_PNG_TARGETS = [
  'apps/shell/build/icon.png',
  'apps/docs/build/icon.png',
  'apps/shell/src/renderer/src/assets/app-icon.png',
  'apps/docs/src/renderer/assets/app-icon.png',
  'apps/sheets/src/renderer/assets/app-icon.png',
  'apps/slides/src/renderer/assets/app-icon.png',
]
const MAC_PNG_TARGETS = ['apps/shell/build/icon-mac.png', 'apps/docs/build/icon-mac.png']
const ICO_TARGETS = ['apps/shell/build/icon.ico', 'apps/docs/build/icon.ico']
const ICNS_TARGETS = ['apps/shell/build/icon.icns', 'apps/docs/build/icon.icns']
// freedesktop hicolor size set (electron-builder linux.icon points at this dir).
const LINUX_ICON_DIR = 'apps/shell/build/icons'
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]
const LOCKUP_TARGET = 'apps/shell/src/renderer/src/assets/genoffice-logo.svg'

const WIN_SIZES = [16, 24, 32, 48, 64, 128, 256]

// macOS icons carry the standard app-icon grid margin (824/1024 content) so
// they sit at the same optical size as neighboring icons in the Dock/Finder.
// Windows and Linux icons are conventionally full-bleed.
const MAC_CONTENT_RATIO = 824 / 1024
// ICNS entries in the order iconutil writes them: [OSType, canvas px, format].
// The two smallest slots must be packed ARGB; the rest are embedded PNGs.
const ICNS_ENTRIES = [
  ['ic12', 64, 'png'],
  ['ic07', 128, 'png'],
  ['ic13', 256, 'png'],
  ['ic08', 256, 'png'],
  ['ic04', 16, 'argb'],
  ['ic14', 512, 'png'],
  ['ic09', 512, 'png'],
  ['ic05', 32, 'argb'],
  ['ic10', 1024, 'png'],
  ['ic11', 32, 'png'],
]

/** ICO container with PNG-compressed entries (supported since Vista). */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o) // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2) // palette
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/**
 * ICNS run-length coding for one 8-bit channel: a control byte below 128
 * copies the next (n + 1) literal bytes, a control byte of 128 or more repeats
 * the next byte (n - 125) times (runs of 3..130).
 */
function packIcnsChannel(channel) {
  const out = []
  const runLength = (from) => {
    let n = 1
    while (from + n < channel.length && n < 130 && channel[from + n] === channel[from]) n++
    return n
  }
  let i = 0
  while (i < channel.length) {
    const run = runLength(i)
    if (run >= 3) {
      out.push(run + 125, channel[i])
      i += run
      continue
    }
    const start = i
    while (i < channel.length && i - start < 128 && runLength(i) < 3) i++
    out.push(i - start - 1, ...channel.subarray(start, i))
  }
  return Buffer.from(out)
}

/** `ARGB` ICNS payload from straight-alpha RGBA pixels (planar A, R, G, B). */
function buildIcnsArgb(rgba) {
  const pixels = rgba.length / 4
  const planes = [3, 0, 1, 2].map((channelOffset) => {
    const plane = Buffer.alloc(pixels)
    for (let p = 0; p < pixels; p++) plane[p] = rgba[p * 4 + channelOffset]
    return packIcnsChannel(plane)
  })
  return Buffer.concat([Buffer.from('ARGB', 'latin1'), ...planes])
}

function buildIcns(chunks) {
  const parts = chunks.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'latin1')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'latin1')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

/** Prefer an installed Chrome, then Edge, then a Playwright-managed Chromium. */
async function launchBrowser() {
  const failures = []
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ ...options, headless: true })
    } catch (error) {
      failures.push(`${options.channel ?? 'bundled chromium'}: ${String(error).split('\n')[0]}`)
    }
  }
  throw new Error(`No Chromium-based browser could be launched:\n  ${failures.join('\n  ')}`)
}

function svgDataUrl(file) {
  return `data:image/svg+xml;base64,${readFileSync(file).toString('base64')}`
}

/**
 * Draws the SVG centered on a transparent square canvas and returns both the
 * PNG encoding and the raw straight-alpha RGBA pixels (for packed ICNS slots).
 * The browser rasterizes the vector at the target size, so small icons are
 * rendered natively instead of being downsampled from a large bitmap.
 */
async function rasterize(page, dataUrl, canvasSize, contentSize) {
  const result = await page.evaluate(
    async ({ dataUrl, canvasSize, contentSize }) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvasSize
      canvas.height = canvasSize
      const context = canvas.getContext('2d')
      const inset = (canvasSize - contentSize) / 2
      context.drawImage(image, inset, inset, contentSize, contentSize)
      const { data } = context.getImageData(0, 0, canvasSize, canvasSize)
      let binary = ''
      for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i])
      return { png: canvas.toDataURL('image/png').split(',')[1], rgba: btoa(binary) }
    },
    { dataUrl, canvasSize, contentSize },
  )
  return { png: Buffer.from(result.png, 'base64'), rgba: Buffer.from(result.rgba, 'base64') }
}

function write(relativePath, data) {
  const target = join(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data)
  console.log(`wrote ${relativePath}`)
}

/** Contact sheet for eyeballing the result; never written into the repo by default. */
async function writePreview(page, outFile) {
  const icon = (size) =>
    `data:image/png;base64,${readFileSync(join(root, LINUX_ICON_DIR, `${size}x${size}.png`)).toString('base64')}`
  const lockup = svgDataUrl(LOCKUP_SVG)
  const aiMark = readFileSync(AI_MARK_SVG, 'utf8').replace(/^[\s\S]*?(?=<svg)/, '')
  const row = (background, color, invert) =>
    `<div style="background:${background};color:${color};padding:28px;display:flex;align-items:flex-end;gap:28px">` +
    [256, 48, 32, 16]
      .map((size) => `<img src="${icon(size)}" width="${size}" height="${size}">`)
      .join('') +
    `<img src="${lockup}" height="56" style="margin-left:24px;filter:invert(${invert})">` +
    [30, 26, 22, 18, 14]
      .map((size) => aiMark.replace('width="24" height="24"', `width="${size}" height="${size}"`))
      .join('') +
    '</div>'
  await page.setViewportSize({ width: 1100, height: 640 })
  await page.setContent(
    `<body style="margin:0">${row('#f3f3f3', '#1f1f1f', 0)}${row('#1e1e1e', '#e8e8e8', 1)}</body>`,
  )
  writeFileSync(outFile, await page.screenshot({ fullPage: true }))
  console.log(`wrote preview ${outFile}`)
}

const previewFlag = process.argv.indexOf('--preview')
const previewFile = previewFlag === -1 ? null : process.argv[previewFlag + 1]
if (previewFlag !== -1 && !previewFile) throw new Error('--preview needs an output file path')

const browser = await launchBrowser()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const icon = svgDataUrl(ICON_SVG)
  const smallIcon = existsSync(ICON_SMALL_SVG) ? svgDataUrl(ICON_SMALL_SVG) : icon
  const iconFor = (size) => (size <= SMALL_ICON_MAX_PX ? smallIcon : icon)

  const fullBleed = new Map()
  for (const size of new Set([...WIN_SIZES, ...LINUX_SIZES])) {
    fullBleed.set(size, await rasterize(page, iconFor(size), size, size))
  }
  const mac = new Map()
  for (const size of new Set(ICNS_ENTRIES.map(([, size]) => size))) {
    const contentSize = Math.round(size * MAC_CONTENT_RATIO)
    mac.set(size, await rasterize(page, iconFor(size), size, contentSize))
  }

  for (const target of FULL_BLEED_PNG_TARGETS) write(target, fullBleed.get(1024).png)
  for (const size of LINUX_SIZES) {
    write(`${LINUX_ICON_DIR}/${size}x${size}.png`, fullBleed.get(size).png)
  }
  const ico = buildIco(WIN_SIZES.map((size) => ({ size, png: fullBleed.get(size).png })))
  for (const target of ICO_TARGETS) write(target, ico)

  for (const target of MAC_PNG_TARGETS) write(target, mac.get(1024).png)
  const icns = buildIcns(
    ICNS_ENTRIES.map(([type, size, format]) => ({
      type,
      data: format === 'argb' ? buildIcnsArgb(mac.get(size).rgba) : mac.get(size).png,
    })),
  )
  for (const target of ICNS_TARGETS) write(target, icns)

  copyFileSync(LOCKUP_SVG, join(root, LOCKUP_TARGET))
  console.log(`wrote ${LOCKUP_TARGET}`)

  if (previewFile) await writePreview(page, resolve(previewFile))
} finally {
  await browser.close()
}
