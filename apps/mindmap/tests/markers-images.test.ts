/**
 * The pieces the look is made of that need no map on screen: which glyph a
 * marker id gets, which picture references are shown, what counts as a
 * picture, and the object URLs of the pictures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewImage } from '@genoffice/xmind-engine'
import {
  archivePictureEntry,
  PICTURE_MAX,
  pictureBox,
  PictureStore,
  pictureType,
} from '../src/renderer/map/images'
import { MARKER_HALO_CLASS, markerElement, markerGlyph } from '../src/renderer/map/markers'
import { TINY_PNG } from './helpers/fixtures'

const image = (src: string, entryName: string | null = null): ViewImage => ({
  src,
  entryName,
  width: null,
  height: null,
})

/** A reference into the archive, as the engine reads it: everything after the scheme is the entry name. */
const inArchive = (entryName: string): ViewImage => image(`xap:${entryName}`, entryName)

describe('which glyph a marker id gets', () => {
  it.each([
    ['priority-1', { family: 'priority', level: 1 }],
    ['priority-9', { family: 'priority', level: 9 }],
    ['task-start', { family: 'progress', eighths: 0 }],
    ['task-oct', { family: 'progress', eighths: 1 }],
    ['task-half', { family: 'progress', eighths: 4 }],
    ['task-3quar', { family: 'progress', eighths: 6 }],
    ['task-done', { family: 'progress', eighths: 8 }],
  ])('%s', (id, glyph) => {
    expect(markerGlyph(id)).toEqual(glyph)
  })

  it('a flag and a star take the colour their id names, as a value of this app', () => {
    const flag = markerGlyph('flag-red')
    const star = markerGlyph('star-dark-blue')
    expect(flag).toMatchObject({ family: 'flag', color: expect.stringMatching(/^#[0-9a-f]{6}$/) })
    expect(star).toMatchObject({ family: 'star', color: expect.stringMatching(/^#[0-9a-f]{6}$/) })
    expect(markerGlyph('flag-green')).not.toEqual(flag)
  })

  it.each([
    'priority-0',
    'priority-10',
    'priority-1x',
    'Priority-1',
    'task-unknown',
    'flag-chartreuse',
    'star-',
    'flag-red; background:url(x)',
    'symbol-lightning',
    'c_simbol-plus',
    '',
    '__proto__',
    'constructor',
    'toString',
  ])('an id this app does not know (%s) is the common mark', (id) => {
    expect(markerGlyph(id)).toEqual({ family: 'other' })
  })

  it('anything that is not a string is the common mark too', () => {
    for (const id of [null, undefined, 1, {}, ['priority-1']]) {
      expect(markerGlyph(id)).toEqual({ family: 'other' })
    }
  })
})

describe('a glyph as an element', () => {
  it('is an SVG drawing with its family and a name to read out, and nothing of the id in it', () => {
    const hostile = 'flag-red"><script>alert(1)</script>'
    const known = markerElement(document, 'priority-3', 'Priority 3')
    const unknown = markerElement(document, hostile, 'Marker')
    expect(known.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(known.dataset.markerFamily).toBe('priority')
    expect(known.getAttribute('aria-label')).toBe('Priority 3')
    expect(known.querySelector('text')!.textContent).toBe('3')
    expect(unknown.dataset.markerFamily).toBe('other')
    expect(unknown.querySelector('script')).toBeNull()
    expect(unknown.outerHTML).not.toContain('alert')
    expect(unknown.outerHTML).not.toContain('flag-red')
  })

  it('every family but the common mark lies on a halo that is not painted by the glyph itself', () => {
    for (const id of [
      'priority-1',
      'task-start',
      'task-half',
      'task-done',
      'flag-blue',
      'star-pink',
    ]) {
      const halos = markerElement(document, id, 'x').querySelectorAll(`.${MARKER_HALO_CLASS}`)
      expect(halos.length, id).toBeGreaterThan(0)
      for (const halo of halos) {
        // its colour comes from the map's ground through the stylesheet, never from here
        expect(halo.getAttribute('fill'), id).toBe('none')
        expect(halo.getAttribute('stroke'), id).toBe('none')
      }
    }
    expect(
      markerElement(document, 'unknown', 'x').querySelector(`.${MARKER_HALO_CLASS}`),
    ).toBeNull()
  })

  it('the common mark is drawn in the text colour of its topic', () => {
    const colours = [...markerElement(document, 'unknown', 'x').children].flatMap((part) => [
      part.getAttribute('fill'),
      part.getAttribute('stroke'),
    ])
    expect(colours.filter((colour) => colour && colour !== 'none')).toEqual([
      'currentColor',
      'currentColor',
    ])
  })
})

describe('which picture references are shown', () => {
  it('an entry under resources/ in the archive', () => {
    expect(archivePictureEntry(inArchive('resources/picture.png'))).toBe('resources/picture.png')
    expect(archivePictureEntry(inArchive('resources/a/b/c.svg'))).toBe('resources/a/b/c.svg')
    expect(archivePictureEntry(inArchive('resources/한글 이름.png'))).toBe(
      'resources/한글 이름.png',
    )
  })

  it.each([
    'http://example.com/a.png',
    'https://example.com/a.png',
    '//example.com/a.png',
    'file:///C:/Windows/win.ini',
    'C:\\Users\\someone\\a.png',
    '/etc/passwd',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/1',
    'javascript:alert(1)',
    'ftp://example.com/a.png',
    'resources/a.png',
    '',
  ])('not a reference that is no archive entry: %s', (src) => {
    // the engine gives an entry name only for the archive scheme
    expect(archivePictureEntry(image(src))).toBeNull()
  })

  it.each([
    'Thumbnails/thumbnail.png',
    'content.json',
    'resources/',
    'resources/../content.json',
    'resources/a/../../content.json',
    'resources/./a.png',
    'resources//a.png',
    'resources\\a.png',
    'resources/a\\..\\b.png',
    'resources/http://example.com/a.png',
    'resources/C:/a.png',
    '/resources/a.png',
    '../resources/a.png',
    'resources/a\u0000.png',
    'http://example.com/a.png',
    'file:///C:/a.png',
    '//example.com/resources/a.png',
  ])('not an archive entry outside resources/, or one that could leave it: %s', (entryName) => {
    expect(archivePictureEntry(inArchive(entryName))).toBeNull()
  })

  it('not for a reference of an unexpected shape', () => {
    expect(archivePictureEntry(null)).toBeNull()
    expect(archivePictureEntry(undefined)).toBeNull()
    expect(archivePictureEntry({ src: 'xap:resources/a.png' } as ViewImage)).toBeNull()
    expect(archivePictureEntry({ src: 'x', entryName: 5 } as unknown as ViewImage)).toBeNull()
  })
})

describe('what counts as a picture', () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value)

  it('the raster types, by their first bytes', () => {
    expect(pictureType(TINY_PNG)).toBe('image/png')
    expect(pictureType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(pictureType(text('GIF89a....'))).toBe('image/gif')
    expect(pictureType(text('RIFF\u0001\u0001\u0001\u0001WEBPVP8 '))).toBe('image/webp')
    expect(pictureType(text('BM......'))).toBe('image/bmp')
  })

  it('an SVG document, with or without a declaration, a doctype and comments in front', () => {
    expect(pictureType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(
      pictureType(
        text(
          '\uFEFF<?xml version="1.0"?>\n<!-- made up -->\n<!DOCTYPE svg PUBLIC "x" "y">\n<svg width="1"></svg>',
        ),
      ),
    ).toBe('image/svg+xml')
  })

  it('nothing else: a page, a script, plain text, an empty entry', () => {
    for (const value of [
      '<html><body><svg></svg></body></html>',
      '<!DOCTYPE html><svg></svg>',
      '<script>alert(1)</script>',
      'just text with <svg in it',
      '{"svg":true}',
      '',
    ]) {
      expect(pictureType(text(value)), value).toBeNull()
    }
  })
})

describe('the size a picture is drawn at', () => {
  it("is the file's own when it fits", () => {
    expect(pictureBox({ ...image('x'), width: 120.4, height: 80.6 })).toEqual({
      width: 120,
      height: 81,
    })
  })

  it('is scaled down as a whole when it does not', () => {
    const box = pictureBox({ ...image('x'), width: 3200, height: 1200 })!
    expect(box).toEqual({ width: PICTURE_MAX.width, height: 120 })
  })

  it('is left to the picture when the file gives none that can be used', () => {
    for (const size of [
      { width: null, height: null },
      { width: 100, height: null },
      { width: 0, height: 10 },
      { width: -5, height: 10 },
      { width: Number.NaN, height: 10 },
      { width: 1e9, height: 10 },
    ]) {
      expect(pictureBox({ ...image('x'), ...size })).toBeNull()
    }
  })
})

describe('the object URLs of the pictures', () => {
  afterEach(() => vi.restoreAllMocks())

  it('are made once per entry, of the type told from the bytes, and given back on destroy', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const read = vi.fn(async (name: string) => (name === 'resources/a.png' ? TINY_PNG : null))
    const store = new PictureStore(read)

    expect(store.peek('resources/a.png')).toBeUndefined()
    const [first, second] = await Promise.all([
      store.load('resources/a.png'),
      store.load('resources/a.png'),
    ])
    expect(first).toMatch(/^blob:/)
    expect(second).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0]![0] as Blob).type).toBe('image/png')
    expect(store.peek('resources/a.png')).toBe(first)

    store.destroy()
    expect(revoke).toHaveBeenCalledWith(first)
  })

  it('there is none for a missing entry, for bytes that are no picture, or when reading fails', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    const store = new PictureStore(async (name) => {
      if (name === 'resources/page.png') return new TextEncoder().encode('<html></html>')
      if (name === 'resources/broken.png') throw new Error('cannot read')
      return null
    })
    expect(await store.load('resources/missing.png')).toBeNull()
    expect(await store.load('resources/page.png')).toBeNull()
    expect(await store.load('resources/broken.png')).toBeNull()
    expect(store.peek('resources/page.png')).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('a picture that arrives after the map was closed gets no URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    let finish: (bytes: Uint8Array) => void = () => {}
    const store = new PictureStore(() => new Promise<Uint8Array>((resolve) => (finish = resolve)))
    const pending = store.load('resources/a.png')
    store.destroy()
    finish(TINY_PNG)
    expect(await pending).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})
