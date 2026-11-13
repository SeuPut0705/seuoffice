/**
 * Group `w/home-files-tree`: the home screen's folder panel
 * (`home:folder-list`, `-create`, `-rename`, `-delete`, `home:move-paths`).
 * They call folder-tree.ts, which `main-core` does not have on this branch
 * (it is on `feat/rust-stage2-b3b4`), so the Rust side answers through the
 * `FolderTree` host of crates/shell-ipc/w/src/home_files.rs, whose probe fake
 * panics until the module lands and the host is replaced by it. The world is
 * that of `w/home-files`.
 */
import type { Case, Group } from '../../types.ts'
import { load } from './home-files.ts'

const MTIME = 1_700_000_000_000
const file = (n: number) => ({ text: `file ${n}`, mtimeMs: MTIME + n * 1000 })
/** a folder's own modification time is set after what it holds is written */
const folder = (n: number) => ({ dir: true as const, mtimeMs: MTIME + n * 1000 })
const call = (channel: string, ...args: unknown[]) => ({ channel, args })

const settings = (extra: Record<string, unknown> = {}) => ({
  'userData/app-settings.json': JSON.stringify({
    language: 'ko',
    defaultSaveDir: '$DIR/save',
    ...extra,
  }),
})

const recent = [
  '$DIR/save/sub/a.docx',
  '$DIR/save/sub/deep/b.xlsx',
  '$DIR/save/top.md',
  '$DIR/outside/o.pdf',
  '$DIR/other/x.md',
]

/** the tree: a save folder with folders, files, junk, and a second root */
const tree = {
  ...settings({ folderRoots: ['$DIR/other'] }),
  'save/sub/a.docx': file(1),
  'save/sub/deep/b.xlsx': file(2),
  'save/sub/deep': folder(3),
  'save/sub/notes.txt': file(4),
  'save/sub/pic.png': file(5),
  'save/sub/.hidden.md': file(6),
  'save/sub/~$lock.docx': file(7),
  'save/sub': folder(8),
  'save/top.md': file(9),
  'save/node_modules/x.md': file(10),
  'save/node_modules': folder(11),
  'save/Beta 10/z.md': file(12),
  'save/Beta 10': folder(13),
  'save/Beta 2': folder(14),
  'save/alpha': folder(15),
  save: folder(16),
  'other/x.md': file(17),
  'other/inner': folder(18),
  other: folder(19),
  'outside/o.pdf': file(20),
  outside: folder(21),
  'userData/recent.json': JSON.stringify(recent),
  'userData/starred.json': JSON.stringify({
    version: 1,
    items: [{ path: '$DIR/save/sub/a.docx', group: 'g' }, { path: '$DIR/save/top.md' }],
  }),
}

const cases: Case[] = [
  {
    note: 'list: the save folder, a folder in it, and the other root',
    files: tree,
    calls: [
      call('home:folder-list', '$DIR/save'),
      call('home:folder-list', '$DIR/save/sub'),
      call('home:folder-list', '$DIR/other'),
    ],
  },
  {
    note: 'list: outside the roots, not a path, a folder that is gone',
    files: tree,
    calls: [
      call('home:folder-list', '$DIR/outside'),
      call('home:folder-list', 5),
      call('home:folder-list'),
      call('home:folder-list', null),
      call('home:folder-list', ['a', 'b']),
      call('home:folder-list', '$DIR/save/gone'),
      call('home:folder-list', '$DIR/save/sub/a.docx'),
      call('home:folder-list', '$DIR/save/../outside'),
    ],
  },
  {
    note: 'create a folder: trimmed, then the same name, bad names, outside, no parent',
    files: tree,
    calls: [
      call('home:folder-create', '$DIR/save', '  New  '),
      call('home:folder-create', '$DIR/save', 'New'),
      call('home:folder-create', '$DIR/save', 'a/b'),
      call('home:folder-create', '$DIR/save', ''),
      call('home:folder-create', '$DIR/outside', 'Nope'),
      call('home:folder-create', '$DIR/save/gone', 'Nope'),
      call('home:folder-create', '$DIR/save', 5),
      call('home:folder-create', 5, 'x'),
      call('home:folder-create', '$DIR/other', 'Inner'),
    ],
  },
  {
    note: 'rename a folder: the files under it follow in every list',
    files: tree,
    hosts: { w: { projectFiles: ['$DIR/save/sub/deep/b.xlsx'] } },
    calls: [
      call('home:folder-rename', '$DIR/save/sub', 'renamed'),
      call('home:recents'),
      call('home:starred'),
    ],
  },
  {
    note: 'rename a folder: refused and failing forms',
    files: tree,
    calls: [
      call('home:folder-rename', '$DIR/save', 'x'),
      call('home:folder-rename', '$DIR/other', 'x'),
      call('home:folder-rename', '$DIR/outside', 'x'),
      call('home:folder-rename', '$DIR/save/sub', 5),
      call('home:folder-rename', 5, 'x'),
      call('home:folder-rename', '$DIR/save/sub', 'alpha'),
      call('home:folder-rename', '$DIR/save/sub', 'sub'),
      call('home:folder-rename', '$DIR/save/sub', 'bad/name'),
      call('home:folder-rename', '$DIR/save/gone', 'x'),
      call('home:folder-rename', '$DIR/save/alpha', 'ALPHA'),
    ],
  },
  {
    note: 'delete a folder: to the trash, and what was in it leaves the lists',
    files: tree,
    calls: [
      call('home:folder-delete', '$DIR/save/sub'),
      call('home:recents'),
      call('home:starred'),
    ],
  },
  {
    note: 'delete a folder: a root, a stranger, not a path, a trash that refuses',
    files: tree,
    calls: [
      call('home:folder-delete', '$DIR/save'),
      call('home:folder-delete', '$DIR/outside'),
      call('home:folder-delete', 5),
      call('home:folder-delete'),
    ],
  },
  {
    note: 'delete a folder: the trash refuses, the lists stay',
    files: tree,
    hosts: { shared: { osShell: { trashError: 'no trash' } } },
    calls: [call('home:folder-delete', '$DIR/save/sub'), call('home:recents')],
  },
  {
    note: 'move a file and a folder into a folder: the lists follow',
    files: tree,
    hosts: { w: { projectFiles: ['$DIR/save/top.md'] } },
    calls: [
      call('home:move-paths', ['$DIR/save/top.md', '$DIR/save/sub/deep'], '$DIR/save/alpha', 'ask'),
      call('home:recents'),
    ],
  },
  {
    note: 'move: a file from outside the tree comes in, folders only from inside',
    files: tree,
    calls: [
      call(
        'home:move-paths',
        ['$DIR/outside/o.pdf', '$DIR/outside', '$DIR/save', '$DIR/save/gone'],
        '$DIR/save/alpha',
        'ask',
      ),
    ],
  },
  {
    note: 'move: the target is refused',
    files: tree,
    calls: [
      call('home:move-paths', ['$DIR/save/top.md', 5], '$DIR/outside', 'ask'),
      call('home:move-paths', ['$DIR/save/top.md'], 5, 'ask'),
      call('home:move-paths', 'x', '$DIR/save/alpha'),
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save/gone', 'ask'),
      call('home:move-paths', ['$DIR/save/sub'], '$DIR/save/sub/deep', 'ask'),
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save', 'ask'),
    ],
  },
  {
    note: 'move onto a name that exists: ask lists the conflict, skip leaves it, keepBoth renames',
    files: { ...tree, 'save/alpha/top.md': file(30), 'save/alpha': folder(31) },
    calls: [
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save/alpha', 'ask'),
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save/alpha', 'skip'),
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save/alpha', 'keepBoth'),
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save/alpha', 'nonsense'),
      call('home:recents'),
    ],
  },
  {
    note: 'move onto a name that exists: replace parks the old file, trashes it, and forgets it',
    files: {
      ...tree,
      'save/alpha/top.md': file(30),
      'save/alpha': folder(31),
      'userData/recent.json': JSON.stringify([...recent, '$DIR/save/alpha/top.md']),
    },
    hosts: { w: { nowMs: 1_800_000_000_000, projectFiles: ['$DIR/save/alpha/top.md'] } },
    calls: [
      call('home:move-paths', ['$DIR/save/top.md'], '$DIR/save/alpha', 'replace'),
      call('home:recents'),
      call('home:starred'),
    ],
  },
  {
    note: 'move: a folder replaces a folder, the trash refuses, the parked folder is removed',
    files: {
      ...tree,
      'save/alpha/sub/keep.md': file(40),
      'save/alpha/sub': folder(41),
      'save/alpha': folder(42),
    },
    hosts: { shared: { osShell: { trashError: 'no trash' } } },
    calls: [call('home:move-paths', ['$DIR/save/sub'], '$DIR/save/alpha', 'replace')],
  },
  {
    note: 'move: a presentation follows through the hooks nobody provides here',
    files: { ...tree, 'save/deck.pptx': file(50) },
    calls: [call('home:move-paths', ['$DIR/save/deck.pptx'], '$DIR/save/alpha', 'ask')],
  },
]

export const group: Group = {
  batch: 'W',
  load,
  cases,
  single: {
    'home:folder-delete':
      'answers undefined whatever the arguments: its effect is the folder and the host log after',
  },
}
