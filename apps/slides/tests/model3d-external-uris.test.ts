/**
 * A 3D model arrives inside a deck someone else made. glTF lets it name its buffers and images
 * by address, so opening the deck must not read a local file or call a host on its behalf: the
 * model is drawn from what the file itself carries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mesh, MeshStandardMaterial, Object3D } from 'three'
import { NO_ROTATION } from '@seuoffice/pptx-engine/model3d'
import { loadModel, type ModelView } from '../src/renderer/model3d/scene'

const drawn = vi.hoisted((): { scene: Object3D | null } => ({ scene: null }))

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>()
  // jsdom has no WebGL: the stand-in keeps the scene it is asked to draw
  class WebGLRenderer {
    setPixelRatio(): void {}
    setSize(): void {}
    render(scene: Object3D): void {
      drawn.scene = scene
    }
    dispose(): void {}
  }
  return { ...three, WebGLRenderer }
})

/** One triangle, 2 wide and 1 high */
const TRIANGLE = new Uint8Array(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer)
const TRIANGLE_DATA_URI = `data:application/octet-stream;base64,${Buffer.from(TRIANGLE).toString('base64')}`

/** A glTF scene of the triangle; `buffer` and `image` are the addresses it names (no `buffer`: the binary chunk) */
function gltfJson(uris: { buffer?: string; image?: string }): Record<string, unknown> {
  const textured = uris.image !== undefined
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, ...(textured ? { material: 0 } : {}) }] },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [2, 1, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: TRIANGLE.length }],
    buffers: [
      { byteLength: TRIANGLE.length, ...(uris.buffer !== undefined ? { uri: uris.buffer } : {}) },
    ],
    ...(textured
      ? {
          materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
          textures: [{ source: 0 }],
          images: [{ uri: uris.image }],
        }
      : {}),
  }
}

// copied into a new array: under jsdom TextEncoder's buffer is not an `ArrayBuffer` of the loader's realm
const encode = (json: Record<string, unknown>): Uint8Array =>
  new Uint8Array(new TextEncoder().encode(JSON.stringify(json)))

const gltf = (uris: { buffer?: string; image?: string }): Uint8Array => encode(gltfJson(uris))

/** The binary container PowerPoint stores: a JSON chunk, then the buffer itself */
function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const padded = (bytes: Uint8Array, fill: number) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill)
    out.set(bytes)
    return out
  }
  const jsonChunk = padded(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binChunk = padded(bin, 0)
  const out = new Uint8Array(12 + 8 + jsonChunk.length + 8 + binChunk.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // "glTF"
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, jsonChunk.length, true)
  view.setUint32(16, 0x4e4f534a, true) // "JSON"
  out.set(jsonChunk, 20)
  const binAt = 20 + jsonChunk.length
  view.setUint32(binAt, binChunk.length, true)
  view.setUint32(binAt + 4, 0x004e4942, true) // "BIN"
  out.set(binChunk, binAt + 8)
  return out
}

/**
 * Every address the loader asks for outside the file, by the three ways a page can ask:
 * fetch (three.js reads buffers with it, and images where the browser has createImageBitmap,
 * as the app's Chromium does), an image element's `src` (images elsewhere, jsdom included) and
 * XMLHttpRequest. Nothing outside the file answers.
 */
function recordRequests(): string[] {
  const urls: string[] = []
  const realFetch = globalThis.fetch
  // Node's Request refuses an address without a scheme; a page resolves it against its own
  vi.stubGlobal(
    'Request',
    class extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, document.baseURI) : input, init)
      }
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>((input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (/^data:/i.test(url)) return realFetch(input, init)
      urls.push(url)
      return Promise.reject(new TypeError('unreachable'))
    }),
  )
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement,
    url: string,
  ) {
    urls.push(url)
    queueMicrotask(() => this.dispatchEvent(new Event('error')))
  })
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation((_method: string, url) => {
    urls.push(String(url))
  })
  return urls
}

/** The meshes of the scene the view draws */
function drawnMeshes(view: ModelView): Mesh[] {
  drawn.scene = null
  view.draw(200, 100, NO_ROTATION)
  const meshes: Mesh[] = []
  ;(drawn.scene as Object3D | null)?.traverse((node) => {
    if ((node as Mesh).isMesh) meshes.push(node as Mesh)
  })
  return meshes
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const OUTSIDE = [
  'file:///etc/hosts',
  '//host/share/x.bin',
  'http://host.example/x.bin',
  '../../secret.bin',
]

describe('a 3D model that names addresses outside its file', () => {
  it.each(OUTSIDE)('is not shown when its buffer is %s, and nothing is asked for', async (uri) => {
    const requests = recordRequests()
    await expect(loadModel(gltf({ buffer: uri }))).rejects.toThrow()
    expect(requests).toEqual([])
  })

  describe.each([
    ['an image element', false],
    ['createImageBitmap, as in the app', true],
  ])('with images read through %s', (_label, bitmaps) => {
    it.each(OUTSIDE)('is drawn without the image at %s, and nothing is asked for', async (uri) => {
      if (bitmaps) vi.stubGlobal('createImageBitmap', vi.fn())
      const requests = recordRequests()
      const view = await loadModel(gltf({ buffer: TRIANGLE_DATA_URI, image: uri }))
      const meshes = drawnMeshes(view)
      expect(requests).toEqual([])
      expect(meshes).toHaveLength(1)
      expect((meshes[0]!.material as MeshStandardMaterial).map).toBeNull()
    })
  })

  it('asks for neither when a buffer and an image are both outside', async () => {
    const requests = recordRequests()
    await expect(
      loadModel(gltf({ buffer: 'file:///etc/hosts', image: '//host/share/x.bin' })),
    ).rejects.toThrow()
    expect(requests).toEqual([])
  })
})

describe('a 3D model that carries everything itself', () => {
  it.each([
    ['a data: buffer', () => gltf({ buffer: TRIANGLE_DATA_URI })],
    ['the binary chunk of a .glb', () => glb(gltfJson({}), TRIANGLE)],
  ])('is drawn with its mesh from %s', async (_label, bytes) => {
    const requests = recordRequests()
    const view = await loadModel(bytes())
    const meshes = drawnMeshes(view)
    expect(meshes).toHaveLength(1)
    expect(meshes[0]!.geometry.getAttribute('position').count).toBe(3)
    expect(view.frontAspect).toBe(2)
    expect(requests).toEqual([])
  })
})

describe('a 3D model packed for a decoder the app does not carry', () => {
  const self = gltfJson({ buffer: TRIANGLE_DATA_URI })
  const packed = (extension: string, parts: Record<string, unknown>) =>
    encode({ ...self, extensionsUsed: [extension], extensionsRequired: [extension], ...parts })

  it.each([
    [
      'Draco geometry',
      /DRACOLoader/,
      packed('KHR_draco_mesh_compression', {
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0 },
                extensions: {
                  KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } },
                },
              },
            ],
          },
        ],
      }),
    ],
    [
      'meshopt buffers',
      /MeshoptDecoder/,
      packed('EXT_meshopt_compression', {
        bufferViews: [
          {
            buffer: 0,
            byteLength: TRIANGLE.length,
            extensions: {
              EXT_meshopt_compression: {
                buffer: 0,
                byteLength: TRIANGLE.length,
                byteStride: 12,
                count: 3,
                mode: 'ATTRIBUTES',
              },
            },
          },
        ],
      }),
    ],
    [
      'Basis textures',
      /KTX2Loader/,
      packed('KHR_texture_basisu', {
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
        images: [{ uri: 'data:image/ktx2;base64,AAAA' }],
      }),
    ],
  ])('is not shown when it needs %s, and no decoder is fetched', async (_label, missing, bytes) => {
    const requests = recordRequests()
    // the loader names the decoder it was not given: the refusal is for that, not a broken file
    await expect(loadModel(bytes)).rejects.toThrow(missing)
    expect(requests).toEqual([])
  })
})
