import type { zh } from './zh'

export const vi = {
  ntOpen: 'Mở ghi chú',
  ntOpenTip: 'Mở ghi chú Markdown gắn với PDF này',
  ntInsert: 'Thêm vào ghi chú',
  ntInsertTip: 'Thêm nội dung này vào cuối ghi chú. Lưu trong thẻ ghi chú',
  ntSaveFirst: 'Hãy lưu PDF trước',
  ntUnavailable: 'Ghi chú chỉ mở được trong ứng dụng GenOffice',
  ntFailed: 'Không mở được ghi chú. {reason}',
  ntInserted: 'Đã thêm vào ghi chú',
} satisfies Record<keyof typeof zh, string>
