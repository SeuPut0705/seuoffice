# 웹 차이 목록

웹 브리지가 데스크톱과 다르게 동작하는 메서드를 적는다. 기본값을 돌려주거나 `WebUnsupportedError`로 거절하는 것이 모두 여기에 들어간다.

| 앱  | 브리지 메서드                                                                        | 웹 동작                                                               | 데스크톱 동작                                   | 언제 메울지                 |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| pdf | `getTheme`                                                                           | 늘 `'system'`                                                         | 사용자가 고른 테마                              | 2단계(호스트가 테마를 넘김) |
| pdf | `getAiPanelPrefs`, `getAiSettings`                                                   | 기본값(`DEFAULT_AI_PANEL_PREFS`, `defaultAiSettings()`)               | 사용자 설정 파일                                | 3단계                       |
| pdf | `getAutoSaveDefault`                                                                 | 자동 저장 끔                                                          | 셸 설정                                         | 2단계                       |
| pdf | `getUsername`                                                                        | 빈 문자열(메모 작성자 없음)                                           | OS 사용자 이름                                  | 2단계(호스트 사용자 이름)   |
| pdf | `listEditFonts`, `listStaticFormFills`, `listDigitalSignatures`                      | 빈 목록                                                               | 시스템 글꼴, 파일 옆 기록, 서명 검사            | 2단계                       |
| pdf | `isUntitledCopy`, `recoveryState`, `reportUnprotectable`, `imageGenerationAvailable` | `false` / 복구 없음 / `null` / `false`                                | 셸 상태                                         | 2·3단계                     |
| pdf | `setDirty`, `on*`(메뉴·셸 요청, 설정 변경 알림)                                      | 아무 일도 하지 않음                                                   | 셸 창과 메뉴 연결                               | 2단계                       |
| pdf | `structure`, `store`, `subscription`, `noteOpen`                                     | 없음(`undefined`, 기능 꺼짐)                                          | 문서 구조 분석, 번역 저장소, 구독 연결, 노트 앱 | 3단계                       |
| pdf | `decryptPdf`                                                                         | `WebUnsupportedError('pdf.decrypt')`(암호 PDF는 앱의 암호 안내까지만) | 암호 해제                                       | 2단계                       |
| pdf | `save`                                                                               | `WebUnsupportedError('pdf.save')`                                     | 파일 저장                                       | 2단계                       |
