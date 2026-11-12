import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateLog, createUpdateSteps } from '../src/main/update-log'

/** The update record in the data folder (src/main/update-log.ts). */

let dir = ''
const fixedNow = () => new Date('2026-10-26T01:02:03.000Z')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ieum-update-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('update record', () => {
  it('writes one timestamped line per message', () => {
    const file = join(dir, 'update-log.txt')
    const log = createUpdateLog(file, 64 * 1024, fixedNow)
    log.info('Checking for update')
    log.warn({ code: 'X' })
    log.error(new Error('first\nsecond'))
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('2026-10-26T01:02:03.000Z info Checking for update')
    expect(lines[1]).toBe('2026-10-26T01:02:03.000Z warn {"code":"X"}')
    expect(lines[2]).toMatch(/^2026-10-26T01:02:03\.000Z error Error: first \| second/)
  })

  it('cuts an overlong entry instead of letting it empty the file', () => {
    const file = join(dir, 'update-log.txt')
    const log = createUpdateLog(file, 6000, fixedNow)
    log.info('x'.repeat(10_000))
    const content = readFileSync(file, 'utf8')
    expect(content.length).toBeGreaterThan(4000)
    expect(content.length).toBeLessThanOrEqual(6000)
  })

  it('stays under its size by dropping the older half', () => {
    const file = join(dir, 'update-log.txt')
    const log = createUpdateLog(file, 2000, fixedNow)
    for (let i = 0; i < 200; i++) log.info(`line ${i}`)
    expect(statSync(file).size).toBeLessThanOrEqual(2000)
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('line 199')
    expect(content).not.toContain('line 0\n')
    // only whole lines are kept
    expect(content.startsWith('2026-')).toBe(true)
  })

  it('never throws when the file cannot be written', () => {
    const log = createUpdateLog(join(dir, 'missing', 'update-log.txt'))
    expect(() => log.info('x')).not.toThrow()
  })
})

describe('update steps', () => {
  it('writes each step as a phase line, the end of a span with its milliseconds', () => {
    const lines: string[] = []
    let clock = 1000
    const step = createUpdateSteps(
      (line) => lines.push(line),
      () => clock,
    )
    step('download-start', { version: '0.2.0' })
    clock += 21_873.4
    step('download-end', { version: '0.2.0', bytes: 232_783_832, transferred: null })
    step('quit-requested')
    expect(lines).toEqual([
      'phase download-start version=0.2.0',
      'phase download-end ms=21873 version=0.2.0 bytes=232783832',
      'phase quit-requested',
    ])
  })

  it('leaves the milliseconds out of an end whose start it did not see, or saw already ended', () => {
    const lines: string[] = []
    const step = createUpdateSteps(
      (line) => lines.push(line),
      () => 5,
    )
    step('verify-end')
    step('unpack-start')
    step('unpack-end')
    step('unpack-end')
    expect(lines).toEqual([
      'phase verify-end',
      'phase unpack-start',
      'phase unpack-end ms=0',
      'phase unpack-end',
    ])
  })

  it('keeps every value one word, so a line splits on spaces', () => {
    const lines: string[] = []
    createUpdateSteps((line) => lines.push(line))('check-end', { found: 'net error\nagain' })
    expect(lines).toEqual(['phase check-end found=net_error_again'])
  })

  it('lands in the record as timestamped lines', () => {
    const file = join(dir, 'update-log.txt')
    const log = createUpdateLog(file, 64 * 1024, fixedNow)
    createUpdateSteps((line) => log.info(line))('installer-start', { version: '0.2.0' })
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-10-26T01:02:03.000Z info phase installer-start version=0.2.0\n',
    )
  })
})
