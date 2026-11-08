import type { zh } from './zh'

export const ja = {
  actWebSearch: 'ウェブ検索',
  actWebFetch: 'ウェブページの読み取り',
  permWebSearch: 'ウェブで検索',
  permWebFetch: 'このウェブページを読み取る',
  permAllowSearchSession: 'このセッション中は検索を許可',
  permAllowSiteSession: 'このセッション中はこのサイトを許可',
  codexWebLabel: 'ウェブ検索',
  codexWebCached: '保存済みの結果',
  codexWebLive: 'リアルタイム',
  codexWebDisabled: 'オフ',
  codexWebNote:
    '保存済みの結果は事前に集められたウェブの情報から探します。リアルタイムは今のウェブを検索します。',
  codexNetworkLabel: 'コマンドのインターネット接続',
  codexNetworkOff: 'オフ',
  codexNetworkOn: 'オン',
  codexNetworkWarning:
    'オンにすると、Codex が実行するコマンドがインターネットに接続できます。「このプロジェクトを信頼する」では確認なしで接続します。受け取った文書に隠された指示が、データを外部に送らせるおそれがあります。',
  codexFolderNote: 'この 2 つの設定はプロジェクトフォルダーごとに記憶されます。',
  providerCodexNoteWeb:
    'コマンドは Codex の隔離された環境で実行されます。書き込めるのはプロジェクトフォルダーだけで、オンにしない限りインターネットには接続できません。',
} satisfies Record<keyof typeof zh, string>
