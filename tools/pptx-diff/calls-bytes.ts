// Group `bytes` of comparison (f): glb-bounds.ts and chart-workbook.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_bytes.rs to
// `pptxBytes.<module>.<TypeScript name>`. Bytes cross as `args.bytes`, a list
// of numbers, and a bytes result comes back as one. No function here reads
// the text, so the runner's mutations would compare nothing: the variations of
// the .glb files are built below, truncations and byte flips drawn from
// mulberry32 with a fixed seed.
//
// Left out because JSON cannot carry them: a lone surrogate (as a key, a file
// name or a text, and as a `\uD800` escape in a .glb, whose parsed string
// would hold one), and NaN or Infinity as numbers (a series value names them
// as strings instead, see `dataOf`).
import {
  CHART_WORKBOOK_REL_TYPE,
  chartWorkbookParts,
  chartWorkbookXlsx,
  colLetter,
  storedZip,
  XLSX_CONTENT_TYPE,
  type ChartWorkbookData,
} from '../../packages/pptx-engine/src/chart-workbook'
import { glbBounds, glbJson } from '../../packages/pptx-engine/src/glb-bounds'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { mulberry32 } from '../docx-diff/synthetic'

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)]
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
]

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

interface GlbOptions {
  magic?: number
  /** The type of the first chunk. */
  chunkType?: number
  /** The length the JSON chunk declares, instead of its padded length. */
  length?: number
  /** Added to the length the JSON chunk declares. */
  lengthDelta?: number
  /** A BIN chunk after the JSON one. */
  bin?: number[]
}

/** A .glb: the header, the JSON chunk padded with spaces to four bytes, an optional BIN chunk. */
function glb(json: string | number[], options: GlbOptions = {}): number[] {
  const body = typeof json === 'string' ? utf8(json) : [...json]
  while (body.length % 4 !== 0) body.push(0x20)
  const bin = [...(options.bin ?? [])]
  while (bin.length % 4 !== 0) bin.push(0)
  const binChunk = options.bin === undefined ? [] : [...u32(bin.length), ...u32(BIN_CHUNK), ...bin]
  return [
    ...u32(options.magic ?? GLB_MAGIC),
    ...u32(2),
    ...u32(20 + body.length + binChunk.length),
    ...u32(options.length ?? body.length + (options.lengthDelta ?? 0)),
    ...u32(options.chunkType ?? JSON_CHUNK),
    ...body,
    ...binChunk,
  ]
}

/** What JSON.parse reads and what it refuses, each the JSON chunk of a .glb. */
const JSON_TEXTS: string[] = [
  '{}',
  '[]',
  '0',
  '-0',
  '1',
  '""',
  '"x"',
  'true',
  'false',
  'null',
  ' \t\r\n{"a":1} \n\r\t',
  '\uFEFF{"bom":1}',
  '{"b":1,"2":0,"1":0,"a":2,"10":3,"01":4,"4294967294":5,"4294967295":6,"-1":7}',
  '{"a":1,"b":2,"a":3}',
  '{"a":{"x":1},"b":0,"a":[2]}',
  '{"__proto__":{"x":1},"constructor":2,"toString":3,"hasOwnProperty":4,"valueOf":5}',
  '[1e400,-1e400,1e-400,-1e-400,12345678901234567890,9007199254740993,0.1,5e-324,' +
    '1.7976931348623157e308,1E2,1e+2,1e-2,-0.0,2.5e-7,123456789012345678901234567890,' +
    '0.30000000000000004,1e21,1e-7,0e5,-0e-5]',
  '["\\u00e9\\u00E9","\\ud83d\\ude00","\\/\\\\\\"\\b\\f\\n\\r\\t","\\u0000\\u001f"]',
  '["\u{1F600}\uD55C\uAE00","\u2028\u2029","\u007f",""]',
  '['.repeat(100) + ']'.repeat(100),
  '{"a":[{"b":[{"c":null}]}],"d":{"e":{"f":true}}}',
  '',
  ' ',
  '{',
  '}',
  '{"a":1,}',
  '[1,]',
  '[,1]',
  '[01]',
  '[-01]',
  '[.5]',
  '[1.]',
  '[+1]',
  '[-]',
  '[1e]',
  '[1e+]',
  '[NaN]',
  '[Infinity]',
  '[-Infinity]',
  "{'a':1}",
  '{a:1}',
  '"\\x"',
  '"\\u12"',
  '"\\u12G4"',
  '"\\U0041"',
  '"a\tb"',
  '"a\nb"',
  '{} x',
  '{}{}',
  '\u00a0{}',
  '\u000b{}',
  '\f{}',
  '\uFEFF\uFEFF{}',
  '[1,2',
  'tru',
  'nul',
  'True',
  '"unterminated',
  '[1 2]',
  '{"a" 1}',
  '{"a":1 "b":2}',
  '{1:2}',
  '/*c*/{}',
  '{"a":1}//',
]

/** JSON chunks as bytes: what TextDecoder makes of ill-formed UTF-8, a byte order mark, NULs. */
const JSON_BYTES: number[][] = [
  [...utf8('["'), 0xff, ...utf8('"]')],
  [...utf8('["'), 0xc0, 0xaf, ...utf8('"]')],
  [...utf8('["'), 0xf0, 0x9f, 0x98, ...utf8('"]')],
  [...utf8('["'), 0xed, 0xa0, 0x80, ...utf8('"]')],
  [...utf8('["a'), 0xe2, 0x82, ...utf8('b"]')],
  [...utf8('["'), 0xf4, 0x90, 0x80, 0x80, ...utf8('"]')],
  [...utf8('{"'), 0xfe, ...utf8('":1,"'), 0xff, ...utf8('":2}')],
  [...utf8('['), 0xff, ...utf8('1]')],
  [0xef, 0xbb, 0xbf, ...utf8('{"bom":1}')],
  [0xef, 0xbb, ...utf8('{}')],
  [...utf8('{"a":1}'), 0, 0, 0, 0, 0],
  [...utf8('{"a":"'), 0, ...utf8('"}')],
]

const ASSET = '"asset":{"version":"2.0"}'
const SCENE = '"scene":0,"scenes":[{"nodes":[0]}]'
const ACCESSORS = '"accessors":[{"min":[-1,-2,-3],"max":[1,2,3]},{"min":[0,0,0],"max":[4,5,6]}]'
const MESHES =
  '"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]},' +
  '{"primitives":[{"attributes":{"POSITION":1}},{"attributes":{"POSITION":0}}]}]'

/** A glTF JSON of these top-level members. */
const gltfOf = (...members: string[]): string => `{${members.join(',')}}`

/** Nodes `nodes` under the scene roots `roots`, over the two meshes and accessors above. */
const scene = (nodes: string, roots = '[0]'): string =>
  gltfOf(ASSET, `"scene":0,"scenes":[{"nodes":${roots}}]`, `"nodes":${nodes}`, MESHES, ACCESSORS)

/** One node of mesh 0 whose matrix starts with `first`. */
const matrixWith = (first: string): string =>
  scene(`[{"mesh":0,"matrix":[${first},0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]`)

/** Nodes `nodes` (one of mesh 0 unless given) under these meshes and accessors (none unless given). */
const withMeshes = (meshes: string, accessors?: string, nodes = '[{"mesh":0}]'): string =>
  gltfOf(
    SCENE,
    `"nodes":${nodes}`,
    `"meshes":${meshes}`,
    ...(accessors === undefined ? [] : [accessors]),
  )

/** One node of mesh 0, whose one primitive reads accessor 0: `accessor`. */
const withAccessor = (accessor: string): string =>
  withMeshes('[{"primitives":[{"attributes":{"POSITION":0}}]}]', `"accessors":[${accessor}]`)

/** Node 0 of mesh 0 and node 1 of mesh 1 moved 10 along x, under the scene members `members`. */
const withScene = (...members: string[]): string =>
  gltfOf(...members, '"nodes":[{"mesh":0},{"mesh":1,"translation":[10,0,0]}]', MESHES, ACCESSORS)

/** `n` nodes, each the child of the one before and moved, the last of mesh 0. */
const chain = (n: number): string =>
  scene(
    `[${Array.from({ length: n }, (_, i) =>
      i === n - 1 ? '{"mesh":0}' : `{"translation":[1,0.5,0],"children":[${i + 1}]}`,
    ).join(',')}]`,
  )

/** Every arrangement of nodes, meshes and accessors the reader has a branch for. */
const GLTF_TEXTS: string[] = [
  scene('[{"mesh":0}]'),
  scene('[{"mesh":1}]'),
  scene(
    '[{"translation":[10,0,0],"scale":[2,2,2],"children":[1]},{"mesh":0,"translation":[0,1,0]}]',
  ),
  scene('[{"mesh":0,"rotation":[0,0,0.7071067811865476,0.7071067811865476]}]'),
  scene(
    '[{"mesh":1,"rotation":[0.1,0.2,0.3,0.9273618495495703],"scale":[1.5,-2,0.25],' +
      '"translation":[-3.25,1e-7,123456.789]}]',
  ),
  scene('[{"mesh":1,"matrix":[2,0,0,0,0,3,0,0,0,0,4,0,5,6,7,1]}]'),
  scene('[{"mesh":1,"matrix":[2,0,0,0,0,3,0,0,0,0,4,0,5,6,7],"translation":[1,1,1]}]'),
  scene('[{"mesh":1,"matrix":[0,1,0,0,-1,0,0,0,0,0,1,0,0,0,0,1],"translation":[9,9,9]}]'),
  scene('[{"mesh":0,"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,7],"scale":[3,3,3]}]'),
  scene('[{"mesh":0,"matrix":null,"translation":[1,1,1]}]'),
  scene(
    '[{"translation":[1,2,3],"rotation":[0,0.3826834323650898,0,0.9238795325112867],"children":[1,2]},' +
      '{"mesh":1,"scale":[0.5,0.5,0.5]},{"mesh":0,"translation":[-4,0,0],"children":[3]},' +
      '{"mesh":1,"matrix":[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1]}]',
  ),
  chain(300),
  // what JSON.parse lets a matrix be
  scene('[{"mesh":0,"matrix":"1000010000102341"}]'),
  scene('[{"mesh":0,"matrix":"\u{1F600}00010000100001"}]'),
  scene('[{"mesh":0,"matrix":" 100\\t010\\n001 001"}]'),
  scene(
    '[{"mesh":0,"matrix":{"length":16,"0":1,"1":0,"2":0,"3":0,"4":0,"5":1,"6":0,"7":0,' +
      '"8":0,"9":0,"10":1,"11":0,"12":3,"13":2,"14":1,"15":1}}]',
  ),
  scene('[{"mesh":0,"matrix":{"length":16,"0":1,"5":1,"10":1,"15":1}}]'),
  scene('[{"mesh":0,"matrix":{"length":"16","0":1},"translation":[1,2,3]}]'),
  scene(
    '[{"mesh":0,"matrix":["2",null,false,0,[],true,[0],"0","0x0","",0,0," 5 ",[6],"7e0",[[1]]]}]',
  ),
  matrixWith('{}'),
  matrixWith('{"valueOf":2}'),
  matrixWith('{"toString":2}'),
  matrixWith('[{"toString":2}]'),
  matrixWith('[1,2]'),
  matrixWith('[null]'),
  matrixWith('"Infinity"'),
  matrixWith('"-0x10"'),
  matrixWith('1e400'),
  // translation, rotation and scale
  scene('[{"mesh":0,"translation":[1]}]'),
  scene('[{"mesh":0,"translation":[]}]'),
  scene('[{"mesh":0,"translation":"123"}]'),
  scene('[{"mesh":0,"translation":"\u{1F600}12"}]'),
  scene('[{"mesh":0,"translation":null}]'),
  scene('[{"mesh":0,"translation":5}]'),
  scene('[{"mesh":0,"translation":{"0":1}}]'),
  scene('[{"mesh":0,"translation":true}]'),
  scene('[{"mesh":0,"translation":[1,2,3,{"toString":1}]}]'),
  scene('[{"mesh":0,"translation":[{"toString":1},2,3]}]'),
  scene('[{"mesh":0,"rotation":["1",0,0,0]}]'),
  scene('[{"mesh":0,"rotation":[1,0,0,0]}]'),
  scene('[{"mesh":0,"rotation":[[1],0,0,0]}]'),
  scene('[{"mesh":0,"rotation":[true,null,false,"1"]}]'),
  scene('[{"mesh":0,"rotation":[" 1",0,0,1]}]'),
  scene('[{"mesh":0,"rotation":"0001"}]'),
  scene('[{"mesh":0,"rotation":[{},0,0,1]}]'),
  scene('[{"mesh":0,"rotation":[0,0,0,{"toString":1}]}]'),
  scene('[{"mesh":0,"rotation":[0,0,0]}]'),
  scene('[{"mesh":0,"scale":[2]}]'),
  scene('[{"mesh":0,"scale":"234"}]'),
  scene('[{"mesh":0,"scale":[0,0,0]}]'),
  scene('[{"mesh":0,"scale":[-1,1e300,1e-300]}]'),
  scene('[{"mesh":0,"scale":[1,1,{"toString":1}]}]'),
  // what a mesh index can be
  withMeshes(
    '{"null":{"primitives":[{"attributes":{"POSITION":1}}]}}',
    ACCESSORS,
    '[{"mesh":null}]',
  ),
  scene('[{"mesh":"1"}]'),
  scene('[{"mesh":1.5}]'),
  scene('[{"mesh":-0}]'),
  scene('[{"mesh":[1]}]'),
  scene('[{"mesh":2}]'),
  scene('[{"mesh":"01"}]'),
  scene('[{"mesh":{"toString":1}}]'),
  scene('[{"mesh":"constructor"}]'),
  scene('[{"mesh":"length"}]'),
  scene('[{"mesh":"__proto__"}]'),
  withMeshes(
    '{"[object Object]":{"primitives":[{"attributes":{"POSITION":1}}]}}',
    ACCESSORS,
    '[{"mesh":{}}]',
  ),
  withMeshes(
    '{"true":{"primitives":[{"attributes":{"POSITION":1}}]}}',
    ACCESSORS,
    '[{"mesh":true}]',
  ),
  withMeshes(
    '{"1,,2":{"primitives":[{"attributes":{"POSITION":1}}]}}',
    ACCESSORS,
    '[{"mesh":[1,null,[2]]}]',
  ),
  withMeshes(
    '{"constructor":{"primitives":[{"attributes":{"POSITION":1}}]},' +
      '"__proto__":{"primitives":[{"attributes":{"POSITION":0}}]}}',
    ACCESSORS,
    '[{"mesh":"constructor","children":[1]},{"mesh":"__proto__"}]',
  ),
  scene('[{"mesh":0},{"mesh":0}]', '[0,1]'),
  // meshes, primitives and attributes
  withMeshes('"abc"', ACCESSORS),
  withMeshes('null', ACCESSORS),
  withMeshes('{"0":{"primitives":[{"attributes":{"POSITION":1}}]}}', ACCESSORS),
  withMeshes('[{"primitives":"x"}]', '"accessors":{"-1":{"min":[1,1,1],"max":[2,2,2]}}'),
  withMeshes('[{"primitives":"\u{1F600}"}]', '"accessors":{"-1":{"min":[1,1,1],"max":[2,2,2]}}'),
  withMeshes('[{"primitives":5}]', ACCESSORS),
  withMeshes('[{"primitives":{}}]', ACCESSORS),
  withMeshes('[{"primitives":true}]', ACCESSORS),
  withMeshes('[{"primitives":null}]', ACCESSORS),
  withMeshes('[{"primitives":[]}]', ACCESSORS),
  withMeshes('[null]', ACCESSORS),
  withMeshes('[{"primitives":[null]}]', ACCESSORS),
  withMeshes('[{"primitives":[null]}]'),
  withMeshes('[{"primitives":[null]}]', '"accessors":null'),
  withMeshes(
    '[{"primitives":[5,{},{"attributes":null},{"attributes":{"POSITION":null}},{"attributes":[0]},"s"]}]',
    '"accessors":{"-1":{"min":[0,0,0],"max":[1,1,1]}}',
  ),
  withMeshes(
    '[{"primitives":[5,{},{"attributes":null},{"attributes":{"POSITION":null}},{"attributes":[0]},"s"]}]',
    ACCESSORS,
  ),
  withMeshes(
    '[{"primitives":[{"attributes":{"POSITION":"1"}},{"attributes":{"POSITION":[0]}}]}]',
    ACCESSORS,
  ),
  withMeshes('[{"primitives":[{"attributes":{"POSITION":{"toString":0}}}]}]', ACCESSORS),
  withMeshes('[{"primitives":[{"attributes":{"POSITION":{"toString":0}}}]}]'),
  withMeshes('[{"primitives":[{"attributes":{"POSITION":1.5}}]}]', ACCESSORS),
  withMeshes('[{"primitives":[{"attributes":{"POSITION":-0}}]}]', ACCESSORS),
  withMeshes(
    '[{"primitives":[{"attributes":{"POSITION":0}},{"attributes":{"POSITION":9}},{"attributes":{"POSITION":1}}]}]',
    ACCESSORS,
  ),
  withMeshes(
    '[{"primitives":[{"attributes":{"POSITION":0}}]}]',
    '"accessors":{"0":{"min":[1,1,1],"max":[2,2,2]}}',
  ),
  withMeshes('[{"primitives":[{"attributes":{"POSITION":0}}]}]', '"accessors":"abc"'),
  // what an accessor can be
  withAccessor('{"min":[1,2],"max":[3,4,5]}'),
  withAccessor('{"min":[1,2,3],"max":[3,4,5,6]}'),
  withAccessor('{"min":[1,2,3]}'),
  withAccessor('{"min":null,"max":[1,1,1]}'),
  withAccessor('{"min":"123","max":"789"}'),
  withAccessor('{"min":"\u{1F600}a","max":[1,1,1]}'),
  withAccessor('{"min":{"length":3,"0":1,"1":2,"2":3},"max":{"length":3,"0":4,"1":5,"2":6}}'),
  withAccessor('{"min":{"length":3},"max":[1,1,1]}'),
  withAccessor('{"min":{"length":"3","0":1,"1":2,"2":3},"max":[4,5,6]}'),
  withAccessor('{"min":["x",0,0],"max":[1,1,1]}'),
  withAccessor('{"min":[0,"x",0],"max":[1,1,1]}'),
  withAccessor('{"min":[0,0,0],"max":[1,1,"x"]}'),
  withAccessor('{"min":[null,true,"2"],"max":[[5],"6",[]]}'),
  withAccessor('{"min":[" 1 ","0x10","1e1"],"max":["","Infinity","-0"]}'),
  withAccessor('{"min":[{"toString":1},0,0],"max":[1,1,1]}'),
  withAccessor('{"min":[0,0,0],"max":[1,1,{"toString":1}]}'),
  withAccessor('{"min":[{"valueOf":1},0,0],"max":[1,1,1]}'),
  withAccessor('null'),
  withAccessor('"abc"'),
  withAccessor('[1,2,3]'),
  withAccessor('5'),
  withAccessor('{"min":[-1e400,0,0],"max":[1,1,1]}'),
  withAccessor('{"min":[0,-1e400,0],"max":[1,1e400,1]}'),
  withAccessor('{"min":[-1.7976931348623157e308,0,0],"max":[1.7976931348623157e308,1,1]}'),
  withAccessor('{"min":[1e308,0,0],"max":[1.7976931348623157e308,1,1]}'),
  withAccessor('{"min":[-0,-0,-0],"max":[0,0,0]}'),
  withAccessor('{"min":[5e-324,0.1,0.2],"max":[0.30000000000000004,1e21,-1e-7]}'),
  withAccessor('{"max":[1,1,1],"min":[0,0,0],"min":[-5,-5,-5]}'),
  // what the scene can be
  withScene(ASSET),
  withScene('"scenes":null'),
  withScene('"scenes":[null]'),
  withScene('"scenes":[5]'),
  withScene('"scenes":"abc"'),
  withScene('"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":1', '"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":null', '"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":"1"', '"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":[1]', '"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":-0', '"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":5', '"scenes":[{"nodes":[1]},{"nodes":[0]}]'),
  withScene('"scene":{"toString":1}', '"scenes":[{"nodes":[1]}]'),
  withScene('"scene":{"toString":1}'),
  withScene('"scene":{}', '"scenes":{"[object Object]":{"nodes":[1]}}'),
  withScene('"scene":"0"', '"scenes":{"0":{"nodes":[0,1]}}'),
  withScene('"scene":"constructor"', '"scenes":[{"nodes":[1]}]'),
  withScene('"scenes":[{"nodes":"0"}]'),
  withScene('"scenes":[{"nodes":"01"}]'),
  withScene('"scenes":[{"nodes":"\u{1F600}1"}]'),
  withScene('"scenes":[{"nodes":5}]'),
  withScene('"scenes":[{"nodes":{}}]'),
  withScene('"scenes":[{"nodes":true}]'),
  withScene('"scenes":[{"nodes":null}]'),
  withScene('"scenes":[{"nodes":[]}]'),
  withScene('"scenes":[{}]'),
  withScene('"scenes":[{"nodes":[0]}]', '"scenes":[{"nodes":[1]}]'),
  // what a node index can be
  withScene('"scenes":[{"nodes":["1"]}]'),
  withScene('"scenes":[{"nodes":["01"]}]'),
  withScene('"scenes":[{"nodes":[1.5]}]'),
  withScene('"scenes":[{"nodes":[-0]}]'),
  withScene('"scenes":[{"nodes":[[1]]}]'),
  withScene('"scenes":[{"nodes":[2]}]'),
  withScene('"scenes":[{"nodes":[-1]}]'),
  withScene('"scenes":[{"nodes":[null,true,{}]}]'),
  withScene('"scenes":[{"nodes":[{"toString":1}]}]'),
  withScene(
    '"scenes":[{"nodes":["constructor","toString","__proto__","hasOwnProperty","length"]}]',
  ),
  gltfOf(
    '"scenes":[{"nodes":["a","__proto__","constructor","b"]}]',
    '"nodes":{"a":{"mesh":0},"__proto__":{"mesh":1,"translation":[0,7,0]},"b":5}',
    MESHES,
    ACCESSORS,
  ),
  gltfOf(SCENE, '"nodes":"abc"', MESHES, ACCESSORS),
  gltfOf(SCENE, '"nodes":null', MESHES, ACCESSORS),
  gltfOf(SCENE, MESHES, ACCESSORS),
  // what a node can be
  scene('[null,0,false,"",{"mesh":0}]', '[0,1,2,3]'),
  scene('[null,0,false,"",{"mesh":0}]', '[0,1,2,3,4]'),
  scene('[5,"s",[],true,{"mesh":1}]', '[0,1,2,3]'),
  scene('[5,"s",[],true,{"mesh":1}]', '[0,1,2,3,4]'),
  // the order of the visit, and what `visited` holds
  scene('[{"translation":[10,0,0],"children":[1]},{"mesh":0}]', '[0,1]'),
  scene('[{"translation":[10,0,0],"children":[1]},{"mesh":0}]', '[1,0]'),
  scene('[{"translation":[10,0,0],"children":[1]},{"mesh":0}]', '[0,"1"]'),
  scene('[{"translation":[10,0,0],"children":[1]},{"mesh":0}]', '[0,0]'),
  scene(
    '[{"translation":[10,0,0],"children":[[2]]},{"translation":[0,10,0],"children":[[2]]},{"mesh":0}]',
    '[0,1]',
  ),
  scene(
    '[{"translation":[10,0,0],"children":[2]},{"translation":[0,10,0],"children":[2]},{"mesh":0}]',
    '[0,1]',
  ),
  scene(
    '[{"mesh":0,"translation":[10,0,0],"children":[1]},{"translation":[0,10,0],"children":[-0]}]',
  ),
  scene(
    '[{"mesh":0,"translation":[10,0,0],"children":[1]},{"translation":[0,10,0],"children":["0"]}]',
  ),
  scene('[{"mesh":0,"translation":[1,0,0],"children":[0,[0]]}]'),
  scene('[{"mesh":0,"translation":[1,0,0],"children":[[0],[0]]}]'),
  // 300 children that each name the node again: `visit` nests 300 deep
  scene(`[{"mesh":0,"translation":[1,0,0],"children":[${Array(300).fill('[0]').join(',')}]}]`),
  scene('[{"children":"1"},{"mesh":0,"translation":[3,3,3]}]'),
  scene('[{"mesh":0,"children":5}]'),
  scene('[{"mesh":0,"children":{}}]'),
  scene('[{"mesh":0,"children":null}]'),
  scene('[{"mesh":0,"children":[9,null,"x"]}]'),
  gltfOf(SCENE, '"nodes":[{"mesh":0}]', '"nodes":[{"mesh":1}]', MESHES, ACCESSORS),
  // a chunk that is no object
  '[{"scenes":[{"nodes":[0]}]}]',
  '"scenes"',
  '7',
]

const BASE = glb(GLTF_TEXTS[0]!)

/** The header: too short, another magic or chunk type, a declared length past the end. */
const HEADERS: number[][] = [
  [],
  [1, 2, 3, 4],
  BASE.slice(0, 19),
  BASE.slice(0, 20),
  glb(''),
  glb(GLTF_TEXTS[0]!, { magic: GLB_MAGIC + 1 }),
  glb(GLTF_TEXTS[0]!, { chunkType: BIN_CHUNK }),
  glb(GLTF_TEXTS[0]!, { chunkType: 0x6e6f736a }),
  glb('{"a":1}', { length: 7 }),
  glb('{"a":1}xyz', { length: 7 }),
  glb('{"a":1}', { length: 6 }),
  glb('{"a":1}', { length: 0 }),
  glb(GLTF_TEXTS[0]!, { lengthDelta: 1 }),
  glb(GLTF_TEXTS[0]!, { lengthDelta: -1 }),
  glb(GLTF_TEXTS[0]!, { lengthDelta: 1, bin: [1, 2, 3] }),
  glb(GLTF_TEXTS[0]!, { length: 0xffffffff }),
  glb(GLTF_TEXTS[0]!, { length: 0xffffffec }),
  glb(GLTF_TEXTS[0]!, { bin: [1, 2, 3, 4, 5] }),
  [...BASE, 0, 0, 0],
  BASE.map((byte, i) => (i === 4 ? 1 : i >= 8 && i < 12 ? 0 : byte)),
]

/** `count` truncations and byte flips of `bases`, drawn from mulberry32(`seed`). */
function variants(bases: number[][], seed: number, count: number): number[][] {
  const random = mulberry32(seed)
  const pick = (n: number): number => Math.floor(random() * n)
  return Array.from({ length: count }, () => {
    const bytes = [...bases[pick(bases.length)]!]
    const kind = pick(4)
    if (kind === 0) return bytes.slice(0, pick(bytes.length))
    for (let flips = kind === 3 ? 2 : 1; flips > 0; flips--) {
      const at = pick(bytes.length)
      bytes[at] = kind === 1 ? pick(256) : bytes[at]! ^ (1 << pick(8))
    }
    return bytes
  })
}

const GLB_INPUTS: Input[] = [
  ...HEADERS,
  ...JSON_TEXTS.map((text) => glb(text)),
  ...JSON_BYTES.map((bytes) => glb(bytes)),
  ...GLTF_TEXTS.map((text) => glb(text)),
  ...variants(
    GLTF_TEXTS.slice(0, 11).map((text) => glb(text)),
    0x676c62,
    240,
  ),
].map((bytes) => ({ args: { bytes } }))

/**
 * `args.data` as chartWorkbookParts takes it: in a series the names "NaN",
 * "Infinity" and "-Infinity" stand for those numbers, which JSON cannot carry.
 */
function dataOf(data: unknown): ChartWorkbookData {
  const { categories, series, xValues } = data as {
    categories: string[]
    series: Array<{ name: string; values: unknown[] }>
    xValues?: number[]
  }
  return {
    categories,
    series: series.map(({ name, values }) => ({
      name,
      values: values.map((value) =>
        value === 'NaN'
          ? NaN
          : value === 'Infinity'
            ? Infinity
            : value === '-Infinity'
              ? -Infinity
              : value,
      ) as Array<number | null>,
    })),
    ...(xValues === undefined ? {} : { xValues }),
  }
}

const DATA: unknown[] = [
  { categories: [], series: [] },
  {
    categories: ['Q1', 'Q2', 'Q3'],
    series: [
      { name: 'Sales', values: [1, 2.5, -3] },
      { name: 'Cost', values: [0.1, null, 1e21] },
    ],
  },
  {
    categories: ['a', '', 'a', 'Sales'],
    series: [
      { name: '', values: [1] },
      { name: 'Sales', values: [1, 2, 3, 4, 5] },
      { name: 'a', values: [] },
    ],
  },
  {
    categories: ['x', 'y'],
    series: [
      { name: 'NaN', values: ['NaN', 1] },
      { name: 'Infinity', values: ['Infinity', '-Infinity'] },
      { name: 'zero', values: [-0, 0] },
    ],
  },
  {
    categories: [
      '<&>"\'',
      '\u{1F600}',
      '\uD55C\uAE00',
      'constructor',
      '__proto__',
      'toString',
      'a\u0001b',
      'tab\tnew\nline\r',
      ' lead ',
      ']]>',
    ],
    series: [
      {
        name: '&amp;',
        values: [
          1e-7,
          0.30000000000000004,
          123456789.123,
          5e-324,
          -1e-7,
          1.7976931348623157e308,
          2 ** 53 + 2,
          1e300,
          -0.5,
          100,
        ],
      },
    ],
  },
  {
    categories: ['r1', 'r2'],
    series: Array.from({ length: 30 }, (_, j) => ({ name: `S${j}`, values: [j, -j] })),
  },
  {
    categories: ['1', '2', 'three'],
    series: [{ name: 'y', values: [10, 20, 15] }],
    xValues: [1.5, -0, 1e21],
  },
  {
    categories: ['a', 'b', 'c'],
    series: [{ name: 'y', values: [1, 2, 3] }],
    xValues: [7],
  },
  { categories: ['a', 'b'], series: [{ name: 'y', values: [1, 2] }], xValues: [] },
  { categories: ['a'], series: [], xValues: [0.1, 0.2, 1e-7] },
  { categories: [], series: [{ name: 'only the header', values: [1, 2] }] },
]

const CHART_PART = /^ppt\/charts\/chart[^/]*\.xml$/

/** Entity references only: a numeric one could name a lone surrogate, which JSON cannot carry to Rust. */
const unescapeXml = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/** The <c:v> texts of the c:pt points of a cache. */
const points = (xml = ''): string[] =>
  [...xml.matchAll(/<c:pt\b[^>]*>\s*<c:v>([^<]*)<\/c:v>/g)].map((match) => unescapeXml(match[1]!))

const childOf = (xml: string | undefined, tag: string): string | undefined =>
  xml?.match(new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`))?.[1]

/** What each chart part of a deck gives chartWorkbookXlsx: categories, series names and values. */
function chartDataOf(parts: ReadonlyMap<string, string>): Input[] {
  return [...parts]
    .filter(([path]) => CHART_PART.test(path))
    .map(([, xml]) => {
      const sers = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((match) => match[1]!)
      const data = {
        categories: points(childOf(sers[0], 'cat')),
        series: sers.map((ser) => ({
          name: points(childOf(ser, 'tx'))[0] ?? '',
          values: points(childOf(ser, 'val')).map((v) =>
            Number.isFinite(Number(v)) ? Number(v) : null,
          ),
        })),
      }
      return { args: { data } }
    })
}

const FILES: Array<Record<string, string>> = [
  {},
  { 'a.txt': '' },
  { mimetype: 'x', 'b/c.xml': '<a/>' },
  { b: '1', '1': 'one', '0': 'zero', '10': 'ten', '01': 'no index', a: '\u{1F600}' },
  { ['__proto__']: 'proto', constructor: 'c', toString: 't' },
  { '': 'an empty name', '\uD55C\uAE00.xml': '\uD55C\uAE00' },
  { 'big.xml': 'x'.repeat(65546) },
  { ['n'.repeat(65540)]: 'a name longer than its 16-bit field' },
  chartWorkbookParts(dataOf(DATA[1])),
  chartWorkbookParts(dataOf(DATA[4])),
]

export const BYTES: CallSpec[] = [
  {
    fn: 'pptxBytes.glb-bounds.glbJson',
    call: (_text, args) => glbJson(Uint8Array.from(args.bytes as number[])),
    built: GLB_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'pptxBytes.glb-bounds.glbBounds',
    call: (_text, args) => glbBounds(Uint8Array.from(args.bytes as number[])),
    built: GLB_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'pptxBytes.chart-workbook.constant',
    call: (_text, args) => {
      switch (args.name) {
        case 'CHART_WORKBOOK_REL_TYPE':
          return CHART_WORKBOOK_REL_TYPE
        case 'XLSX_CONTENT_TYPE':
          return XLSX_CONTENT_TYPE
        default:
          return undefined
      }
    },
    built: ['CHART_WORKBOOK_REL_TYPE', 'XLSX_CONTENT_TYPE', 'constructor'].map((name) => ({
      args: { name },
    })),
    mutation: 'none',
  },
  {
    fn: 'pptxBytes.chart-workbook.colLetter',
    call: (_text, args) => colLetter(args.i as number),
    built: [
      0,
      1,
      23,
      24,
      25,
      26,
      27,
      50,
      51,
      700,
      701,
      702,
      16382,
      16383,
      -1,
      -2,
      -3,
      -0.5,
      0.5,
      -1.5,
      2.999,
      1e6,
      1e15,
      2 ** 53,
      1e21,
      1e300,
      -1e300,
    ].map((i) => ({ args: { i } })),
    mutation: 'none',
  },
  {
    fn: 'pptxBytes.chart-workbook.chartWorkbookParts',
    call: (_text, args) => chartWorkbookParts(dataOf(args.data)),
    fromDocument: chartDataOf,
    built: DATA.map((data) => ({ args: { data } })),
    mutation: 'none',
  },
  {
    fn: 'pptxBytes.chart-workbook.storedZip',
    call: (_text, args) => Array.from(storedZip(args.files as Record<string, string>)),
    fromDocument: (parts) => [{ args: { files: Object.fromEntries([...parts].slice(0, 6)) } }],
    built: FILES.map((files) => ({ args: { files } })),
    mutation: 'none',
  },
  {
    fn: 'pptxBytes.chart-workbook.chartWorkbookXlsx',
    call: (_text, args) => Array.from(chartWorkbookXlsx(dataOf(args.data))),
    fromDocument: chartDataOf,
    built: DATA.map((data) => ({ args: { data } })),
    mutation: 'none',
  },
]
