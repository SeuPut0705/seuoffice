import type { zh } from './zh'

export const zhTW = {
  actWebSearch: '網頁搜尋',
  actWebFetch: '讀取網頁',
  permWebSearch: '在網路上搜尋',
  permWebFetch: '讀取此網頁',
  permAllowSearchSession: '本次工作階段允許搜尋',
  permAllowSiteSession: '本次工作階段允許此網站',
  codexWebLabel: '網頁搜尋',
  codexWebCached: '已儲存的結果',
  codexWebLive: '即時',
  codexWebDisabled: '關閉',
  codexWebNote: '「已儲存的結果」從預先收集的網頁內容中查找；「即時」搜尋當下的網頁。',
  codexNetworkLabel: '指令的網際網路存取',
  codexNetworkOff: '關閉',
  codexNetworkOn: '開啟',
  codexNetworkWarning:
    '開啟後，Codex 執行的指令可以連上網際網路。在「信任此專案」中，指令會不經詢問直接連線。收到的文件中隱藏的指示可能會讓它把資料傳送出去。',
  codexFolderNote: '這兩項設定會依專案資料夾分別記住。',
  providerCodexNoteWeb:
    '指令在 Codex 的隔離空間中執行：只能寫入專案資料夾，除非你開啟，否則無法連上網際網路。',
} satisfies Record<keyof typeof zh, string>
