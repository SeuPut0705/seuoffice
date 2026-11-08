import type { zh } from './zh'

export const zhTW = {
  windowTitle: '快速預覽',
  openInEditor: '在 GenOffice 中開啟',
  revealInFolder: '在資料夾中顯示',
  close: '關閉',
  prevFile: '上一個檔案 (↑)',
  nextFile: '下一個檔案 (↓)',
  shortcutHint: 'Space / Esc 關閉 · ↑↓ 切換檔案 · Enter 開啟',
  loading: '正在載入預覽…',
  empty: '此文件沒有可預覽的內文。',
  encrypted: '此文件受密碼保護。請在 GenOffice 中開啟以解鎖。',
  unsupported: '此檔案格式暫不支援直接預覽。',
  failed: '無法讀取檔案預覽。',
  truncated: '僅顯示文件前段內容。請在 GenOffice 中開啟以檢視完整內容。',
  slideLabel: '投影片 {n}',
  sheetCount: '{n} 個工作表',
  slideCount: '{n} 張投影片',
  lineCount: '{n} 行',
  charCount: '{n} 字',
  tabThumbnail: '縮圖預覽',
  tabContent: '內文內容',
  setQuickLookTitle: '快速預覽（空白鍵）',
  setQuickLookHint:
    '在 GenOffice 檔案清單中選取檔案後按空白鍵，無需開啟分頁即可快速預覽內容。',
  setExplorerSpace: '在 Windows 檔案總管與桌面按空白鍵預覽檔案',
  setExplorerSpaceDesc:
    '在檔案總管或桌面上選取檔案並按空白鍵時彈出快速預覽視窗。',
  setKeepInTray: '關閉視窗時保留在系統匣以維持檔案總管預覽',
  setKeepInTrayDesc:
    '關閉主視窗後仍在背景待命，以便隨時在檔案總管中使用空白鍵快速預覽。',
  trayOpen: '開啟 GenOffice',
  trayQuit: '結束 GenOffice',
} satisfies Record<keyof typeof zh, string>
