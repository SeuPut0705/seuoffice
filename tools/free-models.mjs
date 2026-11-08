// The OpenRouter free models the app offers (`OPENROUTER_FREE_MODELS` in
// packages/ai-provider/src/free-ai.ts) set against what OpenRouter lists today.
// Shared by check-free-models.mjs (the weekly list check: no key, no free
// requests) and trial-free-models.mjs (the in-app trial: spends a key's free
// requests). Models a trial turned down live in free-models-rejected.json so
// they do not come back as candidates every week.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const FREE_AI_SOURCE = 'packages/ai-provider/src/free-ai.ts'
export const REJECTED_FILE = 'tools/free-models-rejected.json'

/** the ids in the `OPENROUTER_FREE_MODELS` array literal, in order */
export function listedFreeModels(source) {
  const block = /OPENROUTER_FREE_MODELS[^=]*=\s*\[([\s\S]*?)\]/.exec(source)
  if (!block) throw new Error(`OPENROUTER_FREE_MODELS not found in ${FREE_AI_SOURCE}`)
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

export function readListed(root) {
  return listedFreeModels(readFileSync(join(root, FREE_AI_SOURCE), 'utf8'))
}

/** `{ [id]: { date, reason } }` */
export function readRejected(root) {
  return JSON.parse(readFileSync(join(root, REJECTED_FILE), 'utf8'))
}

export async function fetchCatalog(fetchImpl = fetch) {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${OPENROUTER_MODELS_URL} answered ${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body?.data)) throw new Error(`${OPENROUTER_MODELS_URL} sent no model list`)
  return body.data
}

function isFree(model) {
  return typeof model?.id === 'string' && model.id.endsWith(':free')
}

function hasTools(model) {
  return Array.isArray(model?.supported_parameters) && model.supported_parameters.includes('tools')
}

/**
 * gone: offered models OpenRouter dropped (`unlisted`) or serves without tools
 * (`no-tools`); a user who picks one gets a failed run.
 * candidates: free models with tools that are neither offered nor turned down,
 * longest context first.
 * staleRejections: turned-down models OpenRouter no longer lists at all.
 */
export function compareFreeModels({ listed, rejected, catalog }) {
  const byId = new Map(catalog.filter((m) => typeof m?.id === 'string').map((m) => [m.id, m]))
  const gone = listed
    .filter((id) => !(byId.has(id) && hasTools(byId.get(id))))
    .map((id) => ({ id, reason: byId.has(id) ? 'no-tools' : 'unlisted' }))
  const candidates = catalog
    .filter((m) => isFree(m) && hasTools(m) && !listed.includes(m.id) && !(m.id in rejected))
    .sort((a, b) => Number(b.context_length ?? 0) - Number(a.context_length ?? 0))
    .map((m) => ({ id: m.id, context: Number(m.context_length ?? 0) }))
  const staleRejections = Object.keys(rejected).filter((id) => !byId.has(id))
  return { gone, candidates, staleRejections }
}

export function needsAction(result) {
  return result.gone.length > 0 || result.candidates.length > 0
}

const GONE_REASON = {
  unlisted: 'OpenRouter 목록에서 빠짐',
  'no-tools': '도구 호출 지원이 꺼짐',
}

/** the report the free-models workflow puts in its run summary, in Korean like the docs */
export function reportMarkdown(result) {
  const lines = []
  if (result.gone.length > 0) {
    lines.push('## 앱이 보여 주지만 지금은 쓸 수 없는 모델', '')
    lines.push(
      '사용자가 고르면 실패합니다. `packages/ai-provider/src/free-ai.ts`의 `OPENROUTER_FREE_MODELS`에서 빼고 새 버전을 냅니다.',
      '',
    )
    for (const m of result.gone) lines.push(`- \`${m.id}\`: ${GONE_REASON[m.reason]}`)
    lines.push('')
  }
  if (result.candidates.length > 0) {
    lines.push('## 시험해 볼 새 무료 모델', '')
    lines.push(
      '이름이 `:free`로 끝나고 도구 호출을 지원합니다. 앱에서 문서 편집이 되는지는 시험해야 압니다: `npm run free-models:trial` (`docs/operations.md`의 "무료 모델 점검").',
      '',
    )
    for (const m of result.candidates) {
      lines.push(`- \`${m.id}\` (기억할 수 있는 길이 ${m.context.toLocaleString('en-US')} 토큰)`)
    }
    lines.push('')
  }
  if (result.staleRejections.length > 0) {
    lines.push('## 정리할 것', '')
    lines.push(
      '시험에서 떨어진 모델 중 OpenRouter 목록에서 사라진 것입니다. `tools/free-models-rejected.json`에서 지워도 됩니다.',
      '',
    )
    for (const id of result.staleRejections) lines.push(`- \`${id}\``)
    lines.push('')
  }
  if (lines.length === 0) lines.push('바뀐 것이 없습니다.')
  return lines.join('\n').trimEnd() + '\n'
}
