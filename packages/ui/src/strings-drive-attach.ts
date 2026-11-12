import type { Lang } from '@genoffice/i18n'

/** "Attach from Drive" in every editor's AI panel (decisions 0033, 0085) */
export interface DriveAttachStrings {
  label: string
  /** {n}: files left out (a format no editor reads, or past 20) */
  skipped: string
  /** {n}: files Drive did not hand over */
  failed: string
  disconnected: string
  /** Google's picker is already open in the browser */
  busy: string
  /** the model-training item in Settings is not confirmed yet (decision 0085) */
  training: string
  /** the AI in use is a free connection, which is never given Drive files */
  freeAi: string
  /** Google's picker did not run */
  pickFailed: string
}

export const DRIVE_ATTACH_STRINGS: Record<Lang, DriveAttachStrings> = {
  en: {
    label: 'Attach from Google Drive',
    skipped: 'Not attached: {n} (a format that cannot be read, or past 20 files)',
    failed: 'Could not get from Drive: {n}',
    disconnected: 'Google Drive is disconnected',
    training: 'First confirm model training under Settings → Integrations → Google Drive',
    freeAi:
      'Drive files are not given to a free AI connection, which may train on them. Choose another AI first',
    pickFailed: 'Google’s window could not be opened. Try again',
    busy: 'Google’s window is already open in your browser',
  },
  ko: {
    label: 'Google 드라이브에서 첨부',
    skipped: '{n}개는 첨부하지 않았습니다(읽을 수 없는 형식이거나 20개를 넘음)',
    failed: '{n}개는 드라이브에서 받지 못했습니다',
    disconnected: 'Google 드라이브 연결이 끊겼습니다',
    training: '설정 → 연동 → Google 드라이브에서 모델 학습 항목을 먼저 확인하세요',
    freeAi:
      '무료 AI 연결은 받은 내용을 학습에 쓸 수 있어 드라이브 파일을 보내지 않습니다. 다른 AI를 먼저 고르세요',
    pickFailed: 'Google 창을 열지 못했습니다. 다시 시도하세요',
    busy: '브라우저에 Google 창이 이미 열려 있습니다',
  },
}
