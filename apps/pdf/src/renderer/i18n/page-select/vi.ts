import type { zh } from './zh'

export const vi = {
  pageSelDelete: 'Xóa {n} trang',
  pageSelExtract: 'Trích xuất {n} trang',
  pageCut: 'Cắt',
  pageCopy: 'Sao chép',
  pagePaste: 'Dán',
  pagesCopied: 'Đã sao chép {n} trang',
  pagesCut: 'Đã cắt {n} trang',
  pagesPasted: 'Đã dán {n} trang',
  pageClipEmpty:
    'Chưa có trang nào được sao chép. Hãy chọn trang trong hình thu nhỏ, sao chép rồi dán.',
  pageClipProtected: 'Không thể sao chép hoặc dán trang trong PDF được bảo vệ bằng mật khẩu.',
} satisfies Record<keyof typeof zh, string>
