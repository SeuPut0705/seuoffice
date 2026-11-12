import { defineStrings } from '@genoffice/i18n'

/** Strings for the Zotero integration in the References tab. */
export const zoteroStrings = defineStrings({
  en: {
    zoteroCitation: 'Zotero Citation',
    zoteroCitationTip: 'Add a citation with Zotero; place the cursor in a citation to edit it',
    zoteroBibliography: 'Zotero Bibliography',
    zoteroBibliographyTip: 'Add or edit the bibliography with Zotero',
    zoteroRefresh: 'Refresh',
    zoteroRefreshTip: 'Refresh all Zotero citations and bibliographies',
    zoteroDocumentSettings: 'Document Settings',
    zoteroDocumentSettingsTip: 'Zotero document settings',
    zoteroDocumentPreferences: 'Document Preferences',
    zoteroRemoveCodes: 'Remove Field Codes',
    zoteroConnectionError: 'Unable to connect to Zotero. Start Zotero and keep it running.',
    zoteroOperationError: 'The Zotero operation failed.',
    zoteroNoteFieldsUnsupported:
      'This document has Zotero citations in footnotes or endnotes, which GenOffice cannot update yet. Zotero commands are turned off here so the bibliography stays intact.',
    zoteroGroup: 'Zotero',
  },
  ko: {
    zoteroCitation: 'Zotero 인용',
    zoteroCitationTip: 'Zotero로 인용을 추가합니다. 기존 인용 안에 커서를 두면 편집할 수 있습니다',
    zoteroBibliography: 'Zotero 참고 문헌',
    zoteroBibliographyTip: 'Zotero로 참고 문헌을 추가하거나 편집합니다',
    zoteroRefresh: '새로 고침',
    zoteroRefreshTip: '모든 Zotero 인용과 참고 문헌을 새로 고칩니다',
    zoteroDocumentSettings: '문서 설정',
    zoteroDocumentSettingsTip: 'Zotero 문서 설정',
    zoteroDocumentPreferences: '문서 환경설정',
    zoteroRemoveCodes: '필드 코드 제거',
    zoteroConnectionError: 'Zotero에 연결할 수 없습니다. Zotero를 실행한 상태로 유지하세요.',
    zoteroOperationError: 'Zotero 작업에 실패했습니다.',
    zoteroNoteFieldsUnsupported:
      '이 문서의 각주 또는 미주에 Zotero 인용이 있으며 GenOffice는 아직 이를 업데이트할 수 없습니다. 참고문헌을 그대로 유지하기 위해 이 문서에서는 Zotero 명령이 비활성화되었습니다.',
    zoteroGroup: 'Zotero',
  },
})
