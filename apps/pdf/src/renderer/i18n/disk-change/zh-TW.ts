import type { zh } from './zh'

export const zhTW = {
  diskChanged: '此檔案已被變更。要重新載入嗎？',
  diskChangedUnsaved: '此檔案已被變更。重新載入會捨棄尚未儲存的編輯。',
  diskMissing: '此檔案已被刪除或重新命名。畫面上的內容仍會保留。',
  diskReload: '重新載入',
  diskIgnore: '忽略',
  diskDismiss: '確定',
  diskReloadFailed: '無法重新載入檔案：{detail}',
  diskChangedNoUndo: '此檔案已被其他程式變更或刪除，因此未執行此變更的復原或重做。',
  pageOpNoUndoConfirm:
    '此檔案（{size}）超過了可為復原保留的大小（{limit}），因此此頁面操作無法復原。是否繼續？',
  undoNoRedoConfirm:
    '目前的檔案（{size}）超過了可為重做保留的大小（{limit}），因此此次復原無法重做。是否繼續？',
} satisfies Record<keyof typeof zh, string>
