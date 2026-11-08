import type { zh } from './zh'

export const vi = {
  actWebSearch: 'Tìm kiếm web',
  actWebFetch: 'Đọc trang web',
  permWebSearch: 'Tìm kiếm trên web',
  permWebFetch: 'Đọc trang web này',
  permAllowSearchSession: 'Cho phép tìm kiếm trong phiên này',
  permAllowSiteSession: 'Cho phép trang này trong phiên này',
  codexWebLabel: 'Tìm kiếm web',
  codexWebCached: 'Kết quả đã lưu',
  codexWebLive: 'Trực tiếp',
  codexWebDisabled: 'Tắt',
  codexWebNote:
    'Kết quả đã lưu lấy từ nội dung web được thu thập sẵn; Trực tiếp tìm trên web như hiện tại.',
  codexNetworkLabel: 'Truy cập internet của lệnh',
  codexNetworkOff: 'Tắt',
  codexNetworkOn: 'Bật',
  codexNetworkWarning:
    'Khi bật, các lệnh mà Codex chạy có thể truy cập internet. Với “Tin tưởng dự án này”, lệnh truy cập mà không hỏi. Chỉ dẫn ẩn trong tài liệu bạn nhận được có thể khiến dữ liệu của bạn bị gửi ra ngoài.',
  codexFolderNote: 'Hai cài đặt này được ghi nhớ riêng cho từng thư mục dự án.',
  providerCodexNoteWeb:
    'Các lệnh chạy trong không gian cách ly của Codex: chỉ có thể ghi vào thư mục dự án và không có internet trừ khi bạn bật lên.',
} satisfies Record<keyof typeof zh, string>
