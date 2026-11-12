/**
 * Document-protection UI strings (Review → Protection). Every locale spreads the
 * English base and overrides it (same pattern as the certificate-sign strings).
 */
const protectStrings = {
  protect: 'Protect',
  protectHint: 'Set, change or remove the password this file is saved with',
  protectTitle: 'Document protection',
  protectSetHint:
    'The next save writes this file with a password. Readers need it to open the document.',
  protectChangeHint: 'The next save re-writes the file with this password and these limits.',
  protectPasswordLabel: 'Password to open',
  protectConfirmLabel: 'Confirm password',
  protectOwnerLabel: 'Owner password (optional)',
  protectPermsLabel: 'Once opened, readers may:',
  permPrint: 'Print',
  permModify: 'Edit content',
  permAnnotate: 'Annotate and fill forms',
  permCopy: 'Copy text and images',
  protectApply: 'Apply protection',
  protectRemove: 'Remove protection',
  protectMismatch: 'The passwords do not match',
}

const localizedProtectStrings: Record<string, Partial<typeof protectStrings>> = {
  ko: {
    protect: '보호',
    protectHint: '이 파일의 저장 비밀번호를 설정, 변경 또는 제거합니다',
    protectTitle: '문서 보호',
    protectSetHint: '다음 저장 시 이 파일에 비밀번호가 설정되며, 열려면 입력이 필요합니다.',
    protectChangeHint: '다음 저장 시 이 비밀번호와 제한으로 파일을 다시 씁니다.',
    protectPasswordLabel: '열기 비밀번호',
    protectConfirmLabel: '비밀번호 확인',
    protectOwnerLabel: '소유자 비밀번호(선택)',
    protectPermsLabel: '연 후 독자에게 허용할 작업:',
    permPrint: '인쇄',
    permModify: '내용 편집',
    permAnnotate: '주석 및 양식 작성',
    permCopy: '텍스트와 이미지 복사',
    protectApply: '보호 적용',
    protectRemove: '보호 제거',
    protectMismatch: '비밀번호가 일치하지 않습니다',
  },
}

export const protectStringsFor = (lang: string) => ({
  ...protectStrings,
  ...(localizedProtectStrings[lang as keyof typeof localizedProtectStrings] ?? {}),
})
