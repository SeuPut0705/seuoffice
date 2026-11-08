import type { zh } from './zh'

export const zhTW = {
  ntOpen: '開啟筆記',
  ntOpenTip: '開啟與此 PDF 連結的 Markdown 筆記',
  ntInsert: '加入筆記',
  ntInsertTip: '把這段內容加到筆記末尾。請在筆記分頁中儲存',
  ntSaveFirst: '請先儲存 PDF',
  ntUnavailable: '筆記只能在 GenOffice 應用程式內開啟',
  ntFailed: '無法開啟筆記。{reason}',
  ntInserted: '已加入筆記',
} satisfies Record<keyof typeof zh, string>
