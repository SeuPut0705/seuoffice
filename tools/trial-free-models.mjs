// Trial of OpenRouter free models before they go into OPENROUTER_FREE_MODELS.
// Spends the free daily requests of the OpenRouter key the installed app holds
// (%APPDATA%/IeumOffice/ai-settings.json); the key is never printed. Needs a
// build (`npm run build:all`).
//
//   node tools/trial-free-models.mjs              the candidates check-free-models finds
//   node tools/trial-free-models.mjs <id> ...     these models
//   node tools/trial-free-models.mjs --listed     the models the app offers now
//
// Each model first gets one short request with one tool (1 free request); one
// that answers with the tool call in time then runs e2e/free-models.trial.spec.ts
// in the built app: two Word edits, about 12 free requests. Models that fail
// (other than with --listed) are recorded in free-models-rejected.json, so the
// weekly check stops offering them; the change is there to review in git.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  REJECTED_FILE,
  compareFreeModels,
  fetchCatalog,
  readListed,
  readRejected,
} from './free-models.mjs'

const PROBE_COST = 1
const APP_COST = 12
const PROBE_TIMEOUT_MS = 30_000

const args = process.argv.slice(2)
const listedMode = args.includes('--listed')
const named = args.filter((a) => !a.startsWith('--'))
const unknown = args.find((a) => a.startsWith('--') && a !== '--listed')
if (unknown) {
  console.error(`알 수 없는 옵션: ${unknown}`)
  process.exit(2)
}

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
if (!existsSync(join(root, 'apps/shell/out/main/index.js'))) {
  console.error('빌드된 앱이 없습니다. 먼저 `npm run build:all`을 실행하세요.')
  process.exit(2)
}

function storedKey() {
  const path = join(process.env.APPDATA ?? '', 'IeumOffice', 'ai-settings.json')
  try {
    const key = JSON.parse(readFileSync(path, 'utf8'))?.providers?.openrouter?.apiKey
    if (typeof key === 'string' && key.trim()) return key.trim()
  } catch {
    // fall through to the message below
  }
  console.error(
    '설치된 앱에 OpenRouter 키가 없습니다. 앱의 설정 → AI → 무료로 쓰기에서 먼저 연결하세요.',
  )
  process.exit(2)
}

const key = storedKey()

async function freeRemaining() {
  const r = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await r.json()
  return body?.data?.free_model_daily_requests?.remaining ?? 0
}

const PROBE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'insert_paragraph',
      description: 'Insert a paragraph at the end of the open Word document.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
]

/** one short request with one tool: does the model call it, and in time */
async function probe(model) {
  const t0 = Date.now()
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        tools: PROBE_TOOLS,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: "You edit the user's document only through the provided tools.",
          },
          {
            role: 'user',
            content: '문서 끝에 "오늘 회의는 3시에 시작합니다."라는 문단을 넣어 줘.',
          },
        ],
      }),
    })
    const seconds = Math.round((Date.now() - t0) / 100) / 10
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      return { ok: false, reason: `짧은 확인 ${r.status}: ${body?.error?.message ?? ''}`.trim() }
    }
    const call = body?.choices?.[0]?.message?.tool_calls?.[0]
    if (call?.function?.name !== 'insert_paragraph') {
      return { ok: false, reason: '짧은 확인에서 도구를 부르지 않음' }
    }
    return { ok: true, seconds }
  } catch {
    return { ok: false, reason: `짧은 확인이 ${PROBE_TIMEOUT_MS / 1000}초 안에 끝나지 않음` }
  }
}

/** the in-app trial; the spec prints one `TRIAL {json}` line whatever happens */
function appTrial(model) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      '-c',
      'e2e/playwright.config.ts',
      'free-models.trial',
      '--reporter=line',
    ],
    {
      cwd: root,
      env: { ...process.env, TRIAL_MODEL: model },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  const line = /^TRIAL (.*)$/m.exec(`${result.stdout}\n${result.stderr}`)
  if (!line) return { pass: false, failure: '앱 시험이 결과를 남기지 않음' }
  return JSON.parse(line[1])
}

function appFailure(report) {
  if (report.failure) return report.failure
  for (const label of ['A', 'B']) {
    const step = report[label]
    if (!step) continue
    if (step.errors?.length) return `요청 ${label}: ${step.errors[0]}`
    if (!step.ok) return `요청 ${label}의 결과가 맞지 않음`
  }
  return '알 수 없음'
}

function printTable(rows) {
  console.log('\n| 모델 | 결과 | 비고 |\n| --- | --- | --- |')
  for (const row of rows) {
    const mark = row.pass === true ? '통과' : row.pass === false ? '탈락' : '건너뜀'
    const note = row.note.replace(/\|/g, '/')
    console.log('| `' + row.model + '` | ' + mark + ' | ' + note + ' |')
  }
}

// Runs to the end instead of process.exit(): on Windows exiting while a fetch's
// handles close aborts Node.
async function main() {
  let models = listedMode ? readListed(root) : named
  if (models.length === 0) {
    const result = compareFreeModels({
      listed: readListed(root),
      rejected: readRejected(root),
      catalog: await fetchCatalog(),
    })
    models = result.candidates.map((c) => c.id)
  }
  if (models.length === 0) {
    console.log('시험할 후보가 없습니다.')
    return
  }

  let budget = await freeRemaining()
  console.log(`시험할 모델 ${models.length}개, 오늘 남은 무료 요청 ${budget}번`)

  const rows = []
  for (const model of models) {
    if (budget < PROBE_COST + APP_COST) {
      rows.push({ model, pass: null, note: `남은 무료 요청이 모자라 건너뜀 (${budget}번)` })
      continue
    }
    console.log(`- ${model}: 짧은 확인`)
    const p = await probe(model)
    budget -= PROBE_COST
    if (!p.ok) {
      rows.push({ model, pass: false, note: p.reason })
      continue
    }
    console.log(`- ${model}: 앱 시험`)
    const report = appTrial(model)
    budget -= APP_COST
    rows.push(
      report.pass
        ? {
            model,
            pass: true,
            note: `짧은 확인 ${p.seconds}초, 문단 넣기 ${report.A.seconds}초, 제목·요약 ${report.B.seconds}초`,
          }
        : { model, pass: false, note: appFailure(report) },
    )
  }
  printTable(rows)

  const offered = readListed(root)
  const passed = rows.filter((r) => r.pass === true && !offered.includes(r.model))
  const failed = rows.filter((r) => r.pass === false)
  if (listedMode) {
    if (failed.length > 0) {
      console.log(
        '\n앱이 보여 주는 모델이 떨어졌습니다. OPENROUTER_FREE_MODELS에서 빼는 것을 검토하세요.',
      )
    }
    return
  }
  if (passed.length > 0) {
    console.log(
      '\n통과한 모델은 packages/ai-provider/src/free-ai.ts의 OPENROUTER_FREE_MODELS에 더합니다:',
    )
    for (const row of passed) console.log(`  '${row.model}',`)
  }
  if (failed.length > 0) {
    const today = new Date().toISOString().slice(0, 10)
    const rejected = readRejected(root)
    for (const row of failed) rejected[row.model] = { date: today, reason: row.note }
    writeFileSync(join(root, REJECTED_FILE), JSON.stringify(rejected, null, 2) + '\n')
    console.log(`\n떨어진 모델 ${failed.length}개를 ${REJECTED_FILE}에 적었습니다.`)
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
})
