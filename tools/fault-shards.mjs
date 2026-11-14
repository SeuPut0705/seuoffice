/**
 * Splits fault probes over runners by what each one costs, not by its index.
 *
 * Every fault runner (tools/docx-diff/faults.py, tools/pptx-diff/faults.mjs,
 * tools/odt-diff/faults.mjs) keeps the seconds each fault took in its report.
 * A cost file beside it, `fault-costs.json`, holds those seconds by fault id;
 * `planShards` packs the faults longest first, each into the runner with the
 * least work so far, so the slowest runner ends about when the others do.
 * A fault the cost file does not know counts as the median of those it does.
 *
 *   node tools/fault-shards.mjs plan <fault-costs.json> <count> [id ...]
 *       prints the plan for the ids (all of the cost file when none are given)
 *   node tools/fault-shards.mjs pick <fault-costs.json> <index>/<count> < ids
 *       reads and prints a JSON array of fault ids, preserving every string
 *   node tools/fault-shards.mjs refresh <fault-costs.json> <report.json> ...
 *       writes the seconds of every fault the reports measured into the file
 *
 * The plan depends only on the ids and the cost file, so every runner of a
 * matrix computes the same one and each fault lands in exactly one shard.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** @returns {Record<string, number>} seconds by fault id */
export function readCosts(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

/**
 * The faults of `ids` in `count` shards: longest first into the lightest
 * shard, ties to the lower shard; within a shard the faults keep the order of
 * `ids`. Equal inputs give an equal plan on every runner.
 * @param {string[]} ids
 * @param {Record<string, number>} costs
 * @param {number} count
 * @returns {{ shards: string[][], loads: number[] }}
 */
export function planShards(ids, costs, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count ${count}`)
  if (new Set(ids).size !== ids.length) throw new Error('a fault id repeats')
  const known = ids.map((id) => costs[id]).filter((s) => typeof s === 'number')
  const sorted = [...known].sort((a, b) => a - b)
  const fallback = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1
  const cost = (id) => (typeof costs[id] === 'number' ? costs[id] : fallback)
  const loads = Array.from({ length: count }, () => 0)
  const shardOf = new Map()
  const byCost = ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => cost(b.id) - cost(a.id) || a.index - b.index)
  for (const { id } of byCost) {
    const lightest = loads.indexOf(Math.min(...loads))
    shardOf.set(id, lightest)
    loads[lightest] += cost(id)
  }
  const shards = Array.from({ length: count }, (_, i) => ids.filter((id) => shardOf.get(id) === i))
  return { shards, loads }
}

/** `INDEX/COUNT` as two integers, INDEX below COUNT */
export function parseShard(text) {
  const [index, count] = String(text).split('/').map(Number)
  if (!(Number.isInteger(index) && Number.isInteger(count) && index >= 0 && index < count))
    throw new Error(`a shard is INDEX/COUNT, not ${text}`)
  return { index, count }
}

/**
 * The cost file with the measured seconds of `reports` written in. A report
 * is an array of entries with an `id` and `seconds` (report.json of the slides
 * and odt runners, faults.json of the docx one) or an object holding that
 * array as `results` (summary.json of the fileparse runner). Faults no report
 * measured keep their old cost.
 */
export function refreshCosts(costs, reports) {
  const next = { ...costs }
  for (const report of reports)
    for (const { id, seconds } of Array.isArray(report) ? report : (report.results ?? []))
      if (typeof id === 'string' && typeof seconds === 'number') next[id] = Math.round(seconds)
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}

function main([command, costsPath, ...rest]) {
  const costs = readCosts(costsPath)
  if (command === 'plan') {
    const [count, ...ids] = rest
    const { shards, loads } = planShards(
      ids.length > 0 ? ids : Object.keys(costs),
      costs,
      Number(count),
    )
    shards.forEach((shard, i) =>
      console.log(`${i}/${count} ~${Math.round(loads[i] / 60)} min  ${shard.join(' ')}`),
    )
  } else if (command === 'pick') {
    const { index, count } = parseShard(rest[0])
    const ids = JSON.parse(readFileSync(0, 'utf8'))
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw new Error('fault ids must be a JSON array of strings')
    console.log(JSON.stringify(planShards(ids, costs, count).shards[index]))
  } else if (command === 'refresh') {
    const reports = rest.map((path) => JSON.parse(readFileSync(path, 'utf8')))
    writeFileSync(costsPath, JSON.stringify(refreshCosts(costs, reports), null, 2) + '\n')
  } else {
    console.error('usage: node tools/fault-shards.mjs plan|pick|refresh <fault-costs.json> ...')
    process.exit(2)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
