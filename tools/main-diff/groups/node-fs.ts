/**
 * Group `node-fs`: the table that turns an operating-system error into the
 * `code` and `message` of Node's file errors (crates/main-core/src/node_fs.rs,
 * libuv's `uv_translate_sys_error` on Windows). Each function is one raw
 * operation: the TypeScript calls Node's `fs`, the Rust the std call that
 * does the same and answers with the error Node would throw. The cases cause
 * the errors a runner can; on Windows they run natively (the main-windows job),
 * on Linux and macOS the same cases give the errno names and both sides must
 * still agree.
 *
 * Codes of the Windows table that no case can cause on a runner, and why:
 * network and socket errors (the WSA* ones, ERROR_CONNECTION_*, ERROR_NETNAME_DELETED,
 * ERROR_HOST/NETWORK_UNREACHABLE: no sockets in file calls); pipe errors
 * (ERROR_BROKEN_PIPE, ERROR_BAD_PIPE, ERROR_PIPE_*, ERROR_NO_DATA: no pipes);
 * device and media errors (ERROR_CRC, ERROR_IO_DEVICE, ERROR_GEN_FAILURE,
 * ERROR_DISK_CORRUPT, the tape ones: need failing hardware); ERROR_DISK_FULL,
 * ERROR_HANDLE_DISK_FULL, ERROR_EA_TABLE_FULL (a full disk); ERROR_NOT_ENOUGH_MEMORY
 * and ERROR_OUTOFMEMORY; ERROR_TOO_MANY_OPEN_FILES (ENFILE-scale handle
 * exhaustion would starve the runner); ERROR_NOT_SAME_DEVICE (the runner has
 * one volume to write to; a rename across volumes needs a second one);
 * ERROR_WRITE_PROTECT (read-only media); ERROR_ELEVATION_REQUIRED,
 * ERROR_PRIVILEGE_NOT_HELD (a symlink without the privilege: the runner has it);
 * ERROR_BAD_EXE_FORMAT, ERROR_MOD_NOT_FOUND (process and library loading);
 * ERROR_ENVVAR_NOT_FOUND, ERROR_INVALID_FLAGS, ERROR_INVALID_HANDLE (not from a
 * path); ERROR_NO_UNICODE_TRANSLATION (needs an unpaired surrogate in a name,
 * which JSON cannot carry); ERROR_INVALID_REPARSE_DATA, ERROR_SYMLINK_NOT_SUPPORTED,
 * ERROR_CANT_ACCESS_FILE (damaged reparse points, a file system without them,
 * a cloud placeholder); ERROR_SEM_TIMEOUT, ERROR_OPERATION_ABORTED (timeouts and
 * cancelled I/O); ERROR_NOT_SUPPORTED. (ERROR_INVALID_FUNCTION, the EISDIR of a
 * `read` on a folder, is caused by the `readFileSync` case of a folder.)
 * Producible: ENOENT, EEXIST, EISDIR, ENOTDIR, ENOTEMPTY, EPERM/EACCES,
 * EBUSY (the process's working folder cannot be removed), ENAMETOOLONG, EINVAL
 * or what `<` gives, ELOOP.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Case, FileSpec, FnSpec, Group } from '../types.ts'

const str = (a: unknown[], i: number): string => a[i] as string

/** a missing file, a folder, a read-only file, a non-empty folder... for every call */
const FILES: Record<string, FileSpec> = {
  'file.txt': 'text\n',
  'dir/inner.txt': 'x',
  empty: { dir: true },
  'ro.txt': { text: 'locked\n', mode: 0o444 },
}

const at = (name: string): string => `$DIR/${name}`

const one = (name: string, note: string): Case => ({ args: [at(name)], files: FILES, note })

// a name past every component limit (255 on NTFS and common Unix file systems)
const LONG_NAME = 'n'.repeat(300)
// a path past every total limit (PATH_MAX 4096, 32767 UTF-16 units on Windows)
const LONG_PATH = 'p/'.repeat(17000)

/** the names the cases use for a path that cannot be made on Windows */
const ANGLE = 'a<b.txt'

const readFile: FnSpec = {
  ts: (a) => readFileSync(str(a, 0), 'utf8'),
  cases: [
    one('file.txt', 'success'),
    one('missing.txt', 'ENOENT'),
    one('dir', 'EISDIR (the read fails)'),
    one('file.txt/inner', 'ENOTDIR on Unix, ENOENT on Windows'),
    one('missing/inner.txt', 'ENOENT: the folder is missing'),
    one(LONG_NAME, 'ENAMETOOLONG: a name of 300 characters'),
    one(LONG_PATH, 'ENAMETOOLONG: a path of 34000 characters'),
    one(ANGLE, 'a name with < (Windows: an invalid name)'),
  ],
}

const writeFile: FnSpec = {
  ts: (a) => writeFileSync(str(a, 0), str(a, 2), { flag: str(a, 1) }),
  cases: [
    { args: [at('new.txt'), 'wx', 'hello'], files: FILES, note: 'a new file' },
    { args: [at('file.txt'), 'wx', 'hello'], files: FILES, note: 'EEXIST' },
    { args: [at('dir'), 'wx', 'hello'], files: FILES, note: 'EEXIST on a folder' },
    { args: [at('file.txt'), 'w', 'hello'], files: FILES, note: 'overwrite' },
    { args: [at('dir'), 'w', 'hello'], files: FILES, note: 'EISDIR' },
    { args: [at('ro.txt'), 'w', 'hello'], files: FILES, note: 'EPERM on Windows, EACCES on Unix' },
    { args: [at('missing/new.txt'), 'w', 'hello'], files: FILES, note: 'ENOENT' },
    {
      args: [at('file.txt/new.txt'), 'w', 'hello'],
      files: FILES,
      note: 'ENOTDIR on Unix, ENOENT on Windows',
    },
    { args: [at(LONG_NAME), 'w', 'hello'], files: FILES, note: 'ENAMETOOLONG' },
    { args: [at(ANGLE), 'w', 'hello'], files: FILES, note: 'a name with <' },
    { args: [at(`a>b.txt`), 'wx', 'hello'], files: FILES, note: 'a name with >' },
    { args: [at(`a|b.txt`), 'w', ''], files: FILES, note: 'a name with |' },
    { args: [at(`a\u0001b.txt`), 'w', ''], files: FILES, note: 'a name with a control character' },
  ],
}

const mkdir: FnSpec = {
  ts: (a) => {
    mkdirSync(str(a, 0))
  },
  cases: [
    one('new', 'a new folder'),
    one('dir', 'EEXIST on a folder'),
    one('file.txt', 'EEXIST on a file'),
    one('missing/new', 'ENOENT'),
    one('file.txt/new', 'ENOTDIR on Unix, ENOENT on Windows'),
    one(LONG_NAME, 'ENAMETOOLONG'),
    one(`a<b`, 'a name with <'),
  ],
}

const rmdir: FnSpec = {
  ts: (a) => rmdirSync(str(a, 0)),
  cases: [
    one('empty', 'success'),
    one('dir', 'ENOTEMPTY'),
    one('missing', 'ENOENT'),
    one('file.txt', 'ENOTDIR'),
    one(LONG_NAME, 'ENAMETOOLONG'),
  ],
}

const rename: FnSpec = {
  ts: (a) => renameSync(str(a, 0), str(a, 1)),
  cases: [
    { args: [at('file.txt'), at('moved.txt')], files: FILES, note: 'success' },
    { args: [at('missing.txt'), at('moved.txt')], files: FILES, note: 'ENOENT' },
    {
      args: [at('file.txt'), at('missing/moved.txt')],
      files: FILES,
      note: 'ENOENT: the target folder is missing',
    },
    {
      args: [at('file.txt'), at('dir')],
      files: FILES,
      note: 'a file over a folder: EISDIR/EEXIST/EPERM by platform',
    },
    {
      args: [at('dir'), at('file.txt')],
      files: FILES,
      note: 'a folder over a file: ENOTDIR on Unix, EEXIST or EPERM on Windows',
    },
    {
      args: [at('empty'), at('dir')],
      files: FILES,
      note: 'a folder over a non-empty folder: ENOTEMPTY or EPERM',
    },
    { args: [at('file.txt'), at(LONG_NAME)], files: FILES, note: 'ENAMETOOLONG' },
    { args: [at('file.txt'), at(ANGLE)], files: FILES, note: 'a name with <' },
  ],
}

const unlink: FnSpec = {
  ts: (a) => unlinkSync(str(a, 0)),
  cases: [
    one('file.txt', 'success'),
    one('missing.txt', 'ENOENT'),
    one('dir', 'EPERM on Windows and macOS, EISDIR on Linux'),
    one('ro.txt', 'a read-only file: removed on Windows, a writable folder on Unix'),
    one('file.txt/inner', 'ENOTDIR on Unix, ENOENT on Windows'),
    one(LONG_NAME, 'ENAMETOOLONG'),
  ],
}

const open: FnSpec = {
  ts: (a) => {
    closeSync(openSync(str(a, 0), 'r+'))
  },
  cases: [
    one('file.txt', 'success'),
    one('missing.txt', 'ENOENT'),
    one('dir', 'EISDIR on Linux, EPERM on Windows'),
    one('ro.txt', 'EPERM on Windows, EACCES on Unix'),
    one('file.txt/inner', 'ENOTDIR on Unix, ENOENT on Windows'),
    one(LONG_NAME, 'ENAMETOOLONG'),
  ],
}

const readdir: FnSpec = {
  ts: (a) => readdirSync(str(a, 0)).sort(),
  cases: [
    one('.', 'the case folder'),
    one('dir', 'one entry'),
    one('empty', 'no entry'),
    one('missing', 'ENOENT'),
    one('file.txt', 'ENOTDIR'),
    one(LONG_NAME, 'ENAMETOOLONG'),
  ],
}

/**
 * EBUSY: the process holds its working folder open, so Windows will not remove
 * it. `[cwd, target]`: the process changes into `cwd`, removes `target`, and
 * changes back.
 */
const rmdirAsCwd: FnSpec = {
  ts: (a) => {
    const before = process.cwd()
    process.chdir(str(a, 0))
    try {
      rmdirSync(str(a, 1))
    } finally {
      process.chdir(before)
    }
  },
  cases: [
    { args: [at('held'), at('held')], files: { held: { dir: true } }, note: 'EBUSY on Windows; removed on Unix' },
    {
      args: [at('held'), at('other')],
      files: { held: { dir: true }, other: { dir: true } },
      note: 'another folder is removed while the working folder is held',
    },
    { args: [at('held'), at('missing')], files: { held: { dir: true } }, note: 'ENOENT while the working folder is held' },
  ],
}

/**
 * `[dir, end]`: `a.lnk` links to `b.lnk`, which links to `a.lnk` (`end` is
 * "loop": ELOOP, on Windows ERROR_CANT_RESOLVE_FILENAME) or to `file.txt`
 * (`end` is "file": the text); `a.lnk` is read and both links removed.
 */
const readThroughLinks: FnSpec = {
  ts: (a) => {
    const dir = str(a, 0)
    symlinkSync(`${dir}/b.lnk`, `${dir}/a.lnk`)
    symlinkSync(a[1] === 'loop' ? `${dir}/a.lnk` : `${dir}/file.txt`, `${dir}/b.lnk`)
    try {
      return readFileSync(`${dir}/a.lnk`, 'utf8')
    } finally {
      unlinkSync(`${dir}/a.lnk`)
      unlinkSync(`${dir}/b.lnk`)
    }
  },
  cases: [
    { args: ['$DIR', 'loop'], note: 'ELOOP (Windows: ERROR_CANT_RESOLVE_FILENAME)' },
    { args: ['$DIR', 'file'], files: { 'file.txt': 'through two links\n' }, note: 'a chain of two links ends at a file' },
  ],
}

export const group: Group = {
  'node-fs.readFileSync': readFile,
  'node-fs.writeFileSync': writeFile,
  'node-fs.mkdirSync': mkdir,
  'node-fs.rmdirSync': rmdir,
  'node-fs.renameSync': rename,
  'node-fs.unlinkSync': unlink,
  'node-fs.openSync': open,
  'node-fs.readdirSync': readdir,
  'node-fs.rmdirAsCwd': rmdirAsCwd,
  'node-fs.readThroughLinks': readThroughLinks,
}
