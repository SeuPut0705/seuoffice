import type { zh } from './zh'

export const vi = {
  contextConfirm:
    'Yêu cầu này gần giới hạn ngữ cảnh của mô hình: khoảng {estimated} trên {limit} token ({percent}%). Vẫn gửi?',
  contextUnknown: 'Không xác nhận được kích thước ngữ cảnh của mô hình; tạm tính {limit} token.',
  toolsUnsupported:
    'Mô hình này không hỗ trợ gọi công cụ. Mô hình chỉ gợi ý văn bản và sẽ không sửa tài liệu.',
  errContextLimit:
    'Không có gì được gửi: yêu cầu gần giới hạn ngữ cảnh của mô hình. Hãy chia thành các yêu cầu nhỏ hơn và thử lại.',
} satisfies Record<keyof typeof zh, string>
