import type { zh } from './zh'

export const ja = {
  noticeText:
    'スキルは 設定 → スキル でオン・オフするようになりました。Claude と Codex のスキルフォルダーのスキルはオフの状態で始まります。',
  noticeOpenSettings: '設定を開く',
  noticeClose: '閉じる',
  nextSession: '変更したスキルは次のセッションから反映されます',
  templateLabel: 'テンプレートとして一緒に保存する文書',
  templateNone: 'テンプレートなし',
  templateFromTab: 'タブで開いています',
  templateFromProject: 'プロジェクトフォルダー',
  templateUnsaved:
    'このタブには保存していない変更があります。保存済みのファイルがテンプレートになります。',
  templateChecking: '伏せた内容があるか確認しています…',
  templateUnknown:
    'この形式は伏せた内容があるかここでは確認できないため、そのまま保存できません。空のテンプレートを作って保存してください。',
  templateTooLarge: 'この文書は大きすぎてテンプレートとして保存できません',
  installTitle: 'AI がこのスキルのインストールを提案しています',
  installHint:
    'プレビューで内容を確認してから、インストールするか決めてください。インストールしたスキルは次のセッションから使えます。',
  installOpen: 'プレビューを開く',
  installDismiss: '閉じる',
  installDismissed: 'インストールしませんでした',
  installCancel: 'キャンセル',
  actProposeSkill: 'スキルの提案',
} satisfies Record<keyof typeof zh, string>
