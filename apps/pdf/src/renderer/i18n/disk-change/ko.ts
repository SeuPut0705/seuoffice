import type { en } from './en'

export const ko = {
  diskChanged: '이 파일이 바뀌었습니다. 다시 불러올까요?',
  diskChangedUnsaved: '이 파일이 바뀌었습니다. 다시 불러오면 저장하지 않은 편집이 사라집니다.',
  diskMissing: '이 파일이 지워졌거나 이름이 바뀌었습니다. 화면의 내용은 그대로 남아 있습니다.',
  diskReload: '다시 불러오기',
  diskIgnore: '무시',
  diskDismiss: '확인',
  diskReloadFailed: '파일을 다시 불러오지 못했습니다: {detail}',
  diskChangedNoUndo:
    '다른 프로그램이 이 파일을 바꾸거나 지워서, 이 변경의 실행 취소와 다시 실행을 하지 않았습니다.',
  pageOpNoUndoConfirm:
    '이 파일({size})은 실행 취소를 위해 보관할 수 있는 크기({limit})보다 커서, 이 페이지 작업은 되돌릴 수 없습니다. 계속하시겠습니까?',
  undoNoRedoConfirm:
    '지금 파일({size})은 다시 실행을 위해 보관할 수 있는 크기({limit})보다 커서, 이 실행 취소는 다시 실행할 수 없습니다. 계속하시겠습니까?',
} satisfies Record<keyof typeof en, string>
