import type { zh } from './zh'

export const ja = {
  windowTitle: 'クイックルック',
  openInEditor: 'GenOffice で開く',
  revealInFolder: 'フォルダーに表示',
  close: '閉じる',
  prevFile: '前のファイル (↑)',
  nextFile: '次のファイル (↓)',
  shortcutHint: 'Space / Esc 閉じる · ↑↓ 切り替え · Enter 開く',
  loading: 'プレビューを読み込み中…',
  empty: 'プレビューできるテキストがありません。',
  encrypted: 'パスワードで保護された文書です。GenOffice で開いてロックを解除してください。',
  unsupported: 'このファイル形式は直接プレビューできません。',
  failed: 'ファイルのプレビューを読み込めませんでした。',
  truncated: '文書の冒頭のみを表示しています。全文は GenOffice で開いてご確認ください。',
  slideLabel: 'スライド {n}',
  sheetCount: '{n} シート',
  slideCount: '{n} スライド',
  lineCount: '{n} 行',
  charCount: '{n} 文字',
  tabThumbnail: 'プレビュー画像',
  tabContent: '本文内容',
  setQuickLookTitle: 'クイックルック（スペースキー）',
  setQuickLookHint:
    'GenOffice のファイル一覧でファイルを選びスペースキーを押すと、タブを開かずに内容をプレビューします。',
  setExplorerSpace: 'Windows エクスプローラー・デスクトップでスペースキーによるプレビューを有効にする',
  setExplorerSpaceDesc:
    'エクスプローラーやデスクトップでファイルを選択してスペースキーを押すと、クイックルックを表示します。',
  setKeepInTray: 'ウィンドウを閉じてもシステムトレイに常駐してプレビューを維持する',
  setKeepInTrayDesc:
    'メインウィンドウを閉じた後もバックグラウンドで待機し、エクスプローラーでのスペースキープレビューを即座に使えるようにします。',
  trayOpen: 'GenOffice を開く',
  trayQuit: 'GenOffice を終了',
} satisfies Record<keyof typeof zh, string>
