import type { zh } from './zh'

export const zhTW = {
  noticeText:
    '技能現在在 設定 → 技能 中開啟和關閉。Claude 和 Codex 技能資料夾中的技能開始時為關閉狀態。',
  noticeOpenSettings: '開啟設定',
  noticeClose: '關閉',
  nextSession: '變更的技能將從下一個工作階段起生效',
  templateLabel: '一併儲存為範本的文件',
  templateNone: '不使用範本',
  templateFromTab: '已在分頁中開啟',
  templateFromProject: '專案資料夾',
  templateUnsaved: '此分頁有尚未儲存的變更。範本將使用已儲存的檔案。',
  templateChecking: '正在檢查是否有隱藏的內容…',
  templateUnknown:
    '無法在此確認這種格式是否有隱藏的內容，因此不能照原樣儲存。請製作空白範本後儲存。',
  templateTooLarge: '此文件太大，無法儲存為範本',
  installTitle: 'AI 建議安裝這個技能',
  installHint: '請在預覽中確認內容後再決定是否安裝。安裝的技能將從下一個工作階段起使用。',
  installOpen: '開啟預覽',
  installDismiss: '關閉',
  installDismissed: '未安裝',
  installCancel: '取消',
  actProposeSkill: '建議技能',
} satisfies Record<keyof typeof zh, string>
