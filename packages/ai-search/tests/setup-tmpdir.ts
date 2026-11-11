import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/**
 * Vitest setup file, loaded after tools/test-home.ts: moves this suite's temp
 * dir into a folder of its own in the real temp dir.
 *
 * media-local-path.test.ts needs a writable folder that is under neither the
 * working tree nor os.tmpdir(), and uses the home folder for it. The throwaway
 * home the runner provides lives in the real temp dir, so with the temp dir
 * left alone that folder would be inside os.tmpdir() and the test would no
 * longer notice a temp-dir allowlist coming back. With the temp dir moved, the
 * home sits beside it, as a real home does.
 */
const tmp = mkdtempSync(join(tmpdir(), 'seuoffice-test-tmp-'))

// os.tmpdir() reads TMPDIR on POSIX, TEMP then TMP on Windows
process.env.TMPDIR = tmp
process.env.TEMP = tmp
process.env.TMP = tmp

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
