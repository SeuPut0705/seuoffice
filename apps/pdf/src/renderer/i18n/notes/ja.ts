import type { zh } from './zh'

export const ja = {
  ntOpen: 'ノートを開く',
  ntOpenTip: 'この PDF に紐づく Markdown ノートを開きます',
  ntInsert: 'ノートに追加',
  ntInsertTip: 'この内容をノートの末尾に追加します。保存はノートのタブで行います',
  ntSaveFirst: '先に PDF を保存してください',
  ntUnavailable: 'ノートは GenOffice アプリ内でのみ開けます',
  ntFailed: 'ノートを開けませんでした。{reason}',
  ntInserted: 'ノートに追加しました',
} satisfies Record<keyof typeof zh, string>
