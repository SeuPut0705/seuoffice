export const zh = {
  contextConfirm:
    '本次请求接近模型上下文上限：约 {estimated} / {limit} 个令牌（{percent}%）。仍要发送吗？',
  contextUnknown: '未能确认模型的上下文大小，按 {limit} 个令牌估算。',
  toolsUnsupported: '此模型不支持工具调用，只会给出文字建议，不会修改文档。',
  errContextLimit: '没有发送请求：内容接近模型上下文上限。请拆成更小的请求后重试。',
}
