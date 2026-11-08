import type { zh } from './zh'

export const vi = {
  noticeText:
    'Kỹ năng giờ được bật và tắt trong Cài đặt → Kỹ năng. Các kỹ năng trong thư mục kỹ năng của Claude và Codex lúc đầu ở trạng thái tắt.',
  noticeOpenSettings: 'Mở Cài đặt',
  noticeClose: 'Đóng',
  nextSession: 'Kỹ năng đã thay đổi được áp dụng từ phiên tiếp theo',
  templateLabel: 'Tài liệu được lưu làm mẫu',
  templateNone: 'Không dùng mẫu',
  templateFromTab: 'Đang mở trong thẻ',
  templateFromProject: 'Thư mục dự án',
  templateUnsaved: 'Thẻ này có thay đổi chưa lưu. Tệp đã lưu sẽ trở thành mẫu.',
  templateChecking: 'Đang kiểm tra nội dung bị ẩn…',
  templateUnknown:
    'Với định dạng này, ứng dụng không thể kiểm tra tại đây xem có nội dung bị ẩn hay không, nên không thể lưu nguyên trạng. Hãy tạo mẫu trống rồi lưu.',
  templateTooLarge: 'Tài liệu này quá lớn để lưu làm mẫu',
  installTitle: 'AI đề xuất cài đặt kỹ năng này',
  installHint:
    'Mở bản xem trước để xem nội dung, rồi quyết định có cài đặt hay không. Kỹ năng đã cài sẽ dùng được từ phiên tiếp theo.',
  installOpen: 'Mở bản xem trước',
  installDismiss: 'Đóng',
  installDismissed: 'Chưa cài đặt',
  installCancel: 'Hủy',
  actProposeSkill: 'Đề xuất kỹ năng',
} satisfies Record<keyof typeof zh, string>
