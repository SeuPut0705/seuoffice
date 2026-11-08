import { chmodSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeOutput } from '../src/fs'
import { CliError } from '../src/result'
import { run, tempDir } from './helpers'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})

const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
const oldBytes = Buffer.from('Original document: do not lose this.')
const newBytes = Buffer.from(
  'Updated document: complete new content.\n\ud55c\uae00 \ubcf4\uc874\ub3c4 \ud655\uc778.',
)
const errno = (code: string) => Object.assign(new Error(`${code}: injected save failure`), { code })

beforeEach(() => {
  vi.mocked(chmodSync).mockReset().mockImplementation(actual.chmodSync)
  vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync)
  vi.mocked(writeFileSync).mockReset().mockImplementation(actual.writeFileSync)
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
})

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const dir = tempDir()
  const target = join(dir, 'document.docx')
  actual.writeFileSync(target, oldBytes)
  return { dir, target }
}

function lockRenames(code: string) {
  vi.mocked(renameSync).mockImplementation(() => {
    throw errno(code)
  })
}

describe('CLI output save failure recovery', () => {
  it('writes the complete output and removes the staging file on success', () => {
    const { dir, target } = fixture()
    writeOutput(target, newBytes)
    expect(readFileSync(target)).toEqual(newBytes)
    expect(readdirSync(dir)).toEqual(['document.docx'])
    expect(renameSync).toHaveBeenCalledTimes(1)
  })

  it('cleans an incomplete staging write without changing the original', () => {
    const { dir, target } = fixture()
    const error = errno('ENOSPC')
    vi.mocked(writeFileSync).mockImplementationOnce((path) => {
      actual.writeFileSync(path, newBytes.subarray(0, 8))
      throw error
    })
    expect(() => writeOutput(target, newBytes)).toThrow(error)
    expect(readFileSync(target)).toEqual(oldBytes)
    expect(readdirSync(dir)).toEqual(['document.docx'])
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('cleans a staging file whose permissions cannot be set', () => {
    const { dir, target } = fixture()
    const error = errno('EACCES')
    vi.mocked(chmodSync).mockImplementationOnce(() => {
      throw error
    })
    expect(() => writeOutput(target, newBytes)).toThrow(error)
    expect(readFileSync(target)).toEqual(oldBytes)
    expect(readdirSync(dir)).toEqual(['document.docx'])
  })

  it('leaves the original unchanged on a non-retryable rename failure', () => {
    const { dir, target } = fixture()
    lockRenames('EXDEV')
    expect(() => writeOutput(target, newBytes)).toThrow('EXDEV')
    expect(readFileSync(target)).toEqual(oldBytes)
    expect(readdirSync(dir)).toEqual(['document.docx'])
    expect(renameSync).toHaveBeenCalledTimes(1)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('retries a transient lock and publishes by rename without overwriting in place', () => {
    const { dir, target } = fixture()
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw errno('EBUSY')
    })
    writeOutput(target, newBytes)
    expect(readFileSync(target)).toEqual(newBytes)
    expect(readdirSync(dir)).toEqual(['document.docx'])
    expect(renameSync).toHaveBeenCalledTimes(2)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('keeps the successful fallback for %s locks', (code) => {
    const { dir, target } = fixture()
    lockRenames(code)
    writeOutput(target, newBytes)
    expect(readFileSync(target)).toEqual(newBytes)
    expect(readdirSync(dir)).toEqual(['document.docx'])
    expect(renameSync).toHaveBeenCalledTimes(5)
    expect(writeFileSync).toHaveBeenCalledTimes(2)
  })

  for (const partial of [false, true]) {
    it.each(['EACCES', 'ENOSPC', 'EIO'])(
      `keeps the complete rescue copy when fallback fails %s ${partial ? 'after truncation' : 'before writing'}`,
      (code) => {
        const { dir, target } = fixture()
        const error = errno(code)
        lockRenames('EBUSY')
        vi.mocked(writeFileSync).mockImplementation((path, bytes, options) => {
          if (path === target) {
            if (partial) actual.writeFileSync(target, newBytes.subarray(0, 7))
            throw error
          }
          actual.writeFileSync(path, bytes, options)
        })
        let thrown: unknown
        try {
          writeOutput(target, newBytes)
        } catch (err) {
          thrown = err
        }
        const rescue = readdirSync(dir).filter((name) => name !== 'document.docx')
        expect(rescue).toHaveLength(1)
        expect(rescue[0]).toMatch(/^\.document\.docx\.[a-f0-9]{12}\.tmp$/)
        // the error names the rescue copy, so the caller can find the finished edit
        expect(thrown).toBeInstanceOf(CliError)
        expect((thrown as CliError).message).toContain(error.message)
        expect((thrown as CliError).message).toContain(join(dir, rescue[0]!))
        expect((thrown as CliError).detail).toEqual({ rescue_path: join(dir, rescue[0]!) })
        expect(readFileSync(join(dir, rescue[0]!))).toEqual(newBytes)
        expect(readFileSync(target)).toEqual(partial ? newBytes.subarray(0, 7) : oldBytes)
        expect(renameSync).toHaveBeenCalledTimes(5)
      },
    )
  }

  it('keeps a readable edited DOCX when the CLI fallback fails after truncation', async () => {
    const dir = tempDir()
    const markdown = join(dir, 'source.md')
    const target = join(dir, 'source.docx')
    const ops = join(dir, 'ops.json')
    actual.writeFileSync(markdown, '# Report\n\nOld content.\n')
    expect(
      (await run(['create', '--type', 'docx', '--from', markdown, '--out', target])).code,
    ).toBe(0)
    actual.writeFileSync(ops, JSON.stringify([{ op: 'findReplace', find: 'Old', replace: 'New' }]))
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === target) throw errno('EBUSY')
      actual.renameSync(from, to)
    })
    vi.mocked(writeFileSync).mockImplementation((path, bytes, options) => {
      if (path === target) {
        actual.writeFileSync(path, 'PK')
        throw errno('ENOSPC')
      }
      actual.writeFileSync(path, bytes, options)
    })
    const failed = await run(['docs', 'apply', target, '--ops', ops, '--json'])
    expect(failed.code).toBe(3)
    expect(failed.json()).toMatchObject({ status: 'error', error: 'conversion_failed' })
    expect(readFileSync(target).toString()).toBe('PK')
    const rescue = readdirSync(dir).filter((name) =>
      /^\.source\.docx\.[a-f0-9]{12}\.tmp$/.test(name),
    )
    expect(rescue).toHaveLength(1)
    expect(failed.json().detail).toEqual({ rescue_path: join(dir, rescue[0]!) })
    const recovered = join(dir, 'recovered.docx')
    actual.writeFileSync(recovered, readFileSync(join(dir, rescue[0]!)))
    const read = await run(['docs', 'read', recovered, '--full', '--json'])
    expect(read.code).toBe(0)
    const paragraphs = read
      .json()
      .detail.items.map((item: { text?: string }) => item.text)
      .join('\n')
    expect(paragraphs).toContain('New content.')
    expect(paragraphs).not.toContain('Old content.')
  })
})
