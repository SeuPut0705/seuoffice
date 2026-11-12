import type { Lang } from '@genoffice/i18n'

/** "Attach from documents" in every editor's AI panel */
export interface DocAttachStrings {
  label: string
  busy: string
}

export const DOC_ATTACH_STRINGS: Record<Lang, DocAttachStrings> = {
  en: {
    label: 'Attach from GenOffice documents',
    busy: 'The document list window is already open',
  },
  ko: {
    label: 'GenOffice 문서에서 첨부',
    busy: '목록 창이 이미 열려 있습니다',
  },
}
