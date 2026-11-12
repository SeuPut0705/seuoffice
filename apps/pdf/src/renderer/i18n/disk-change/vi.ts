import type { zh } from './zh'

export const vi = {
  diskChanged: 'Tệp này đã bị thay đổi. Tải lại?',
  diskChangedUnsaved: 'Tệp này đã bị thay đổi. Tải lại sẽ bỏ các chỉnh sửa chưa lưu.',
  diskMissing: 'Tệp này đã bị xóa hoặc đổi tên. Nội dung trên màn hình vẫn giữ nguyên.',
  diskReload: 'Tải lại',
  diskIgnore: 'Bỏ qua',
  diskDismiss: 'OK',
  diskReloadFailed: 'Không thể tải lại tệp: {detail}',
  diskChangedNoUndo:
    'Một chương trình khác đã thay đổi hoặc xóa tệp này, nên Hoàn tác và Làm lại cho thay đổi này không được thực hiện.',
} satisfies Record<keyof typeof zh, string>
