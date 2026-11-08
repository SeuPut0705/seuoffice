import type { zh } from './zh'

export const zhTW = {
  contextConfirm:
    '本次請求接近模型上下文上限：約 {estimated} / {limit} 個權杖（{percent}%）。仍要傳送嗎？',
  contextUnknown: '無法確認模型的上下文大小，暫以 {limit} 個權杖估算。',
  toolsUnsupported: '此模型不支援工具呼叫，只會提供文字建議，不會編輯文件。',
  errContextLimit: '並未傳送：內容接近模型上下文上限。請拆成更小的請求後再試一次。',
} satisfies Record<keyof typeof zh, string>
