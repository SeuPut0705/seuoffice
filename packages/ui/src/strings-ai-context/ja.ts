import type { zh } from './zh'

export const ja = {
  contextConfirm:
    'このリクエストはモデルのコンテキスト上限に近づいています。約 {estimated} / {limit} トークン（{percent}%）。このまま送信しますか？',
  contextUnknown:
    'モデルのコンテキストサイズを確認できませんでした。{limit} トークンとして扱います。',
  toolsUnsupported:
    'このモデルはツール呼び出しに対応していません。文章での提案だけを行い、文書は編集しません。',
  errContextLimit:
    '送信しませんでした。内容がモデルのコンテキスト上限に近づいています。より小さなリクエストに分けて、もう一度お試しください。',
} satisfies Record<keyof typeof zh, string>
