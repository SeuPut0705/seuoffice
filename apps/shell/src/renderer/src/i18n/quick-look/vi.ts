import type { zh } from './zh'

export const vi = {
  windowTitle: 'Xem nhanh',
  openInEditor: 'Mở trong GenOffice',
  revealInFolder: 'Hiển thị trong thư mục',
  close: 'Đóng',
  prevFile: 'Tệp trước (↑)',
  nextFile: 'Tệp tiếp theo (↓)',
  shortcutHint: 'Space / Esc đóng · ↑↓ chuyển tệp · Enter mở',
  loading: 'Đang tải bản xem trước…',
  empty: 'Tài liệu này không có văn bản có thể xem trước.',
  encrypted: 'Tài liệu được bảo vệ bằng mật khẩu. Mở trong GenOffice để mở khóa.',
  unsupported: 'Định dạng tệp này không thể xem trước trực tiếp.',
  failed: 'Không thể đọc bản xem trước của tệp.',
  truncated: 'Đang hiển thị phần đầu tài liệu. Mở trong GenOffice để xem toàn bộ.',
  slideLabel: 'Trang chiếu {n}',
  sheetCount: '{n} trang tính',
  slideCount: '{n} trang chiếu',
  lineCount: '{n} dòng',
  charCount: '{n} ký tự',
  tabThumbnail: 'Ảnh xem trước',
  tabContent: 'Nội dung tài liệu',
  setQuickLookTitle: 'Xem nhanh (Phím cách)',
  setQuickLookHint:
    'Nhấn Phím cách trên bất kỳ tệp nào trong danh sách GenOffice để xem trước nội dung mà không cần mở thẻ.',
  setExplorerSpace: 'Xem trước tệp bằng Phím cách trong Windows File Explorer & Màn hình nền',
  setExplorerSpaceDesc:
    'Nhấn Phím cách trên tệp đang chọn trong File Explorer hoặc Màn hình nền để bật cửa sổ Xem nhanh.',
  setKeepInTray: 'Giữ chạy dưới khay hệ thống khi đóng cửa sổ',
  setKeepInTrayDesc:
    'Giữ GenOffice sẵn sàng chạy nền để tính năng xem nhanh bằng Phím cách trong File Explorer luôn hoạt động.',
  trayOpen: 'Mở GenOffice',
  trayQuit: 'Thoát GenOffice',
} satisfies Record<keyof typeof zh, string>
