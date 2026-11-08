# packages/i18n (`@genoffice/i18n`)

모든 앱과 패키지가 쓰는 i18n의 핵심이다. 지원 언어 목록, 사전의 타입 규칙, 번역 함수, 그리고 제품 이름을 정의하는 단 하나의 자리를 담는다. React·Electron·다른 workspace 패키지에 의존하지 않는다.

## 맡은 범위

- 언어: `Lang`·`LANGS`(21개), 로캘 문자열을 지원 언어로 옮기는 `normalizeLang`, `<html lang>` 값 `htmlLang`, 오른쪽에서 왼쪽으로 쓰는 언어 판정 `isRtlLang`·`htmlDir`(`src/index.ts`).
- 사전 규칙과 번역기: `LangDicts`, `defineStrings`, `createI18n`, 자리 표시 채우기 `format`.
- 단축키 표기 변환: 사전에 Mac 표기로 적힌 단축키를 Windows/Linux에서 `Ctrl+…` 형태로 바꾸는 `macShortcutsToWin`·`platformShortcuts`.
- 메인 프로세스용 현재 언어 보관소: `getUiLang`·`setUiLang`·`onUiLangChange`.
- 제품 정체성(`src/product.ts`): `PRODUCT_NAME`, `productName(lang)`, `brandText`, `UPSTREAM_PRODUCT_NAME`·`UPSTREAM_NAME_LITERAL`, userData 폴더 이름 `USER_DATA_DIR_NAME`·`DEV_USER_DATA_DIR_NAME`, 저장소 좌표 `PRODUCT_REPO_OWNER`·`PRODUCT_REPO_NAME`·`PRODUCT_REPO_SLUG`.
- 글꼴 선택기가 쓰는 한중일 글꼴 이름 목록(`src/font-names.ts`). 화면 문구가 아니라 OS가 보고하는 글꼴 가족 이름이라는 기능 데이터다.

## 맡지 않는 것 (경계)

- 실제 사전은 이 모듈의 범위가 아니다. 문자열은 각 앱의 `src/renderer/i18n/`와 메인 프로세스의 인라인 사전, `packages/ui`의 공용 문자열에 있다. 여기에 화면 문구를 추가하지 않는다.
- React 훅(`useI18n`)과 언어 전환 UI는 각 앱의 `src/renderer/i18n/locale.tsx`의 범위다.
- 앱 안 도움말 본문(언어별 Markdown)과 그 구조 검사는 `apps/shell`과 `tools/check-help-langs.mjs`의 범위다.
- 저장소 주소에서 만든 URL(이슈, 릴리스)은 `packages/electron-utils`의 `github-menu.ts`가, PC에 등록하는 명령·MCP·스킬 이름은 `packages/cli`의 `names.ts`가, 설치 프로그램의 식별자는 `apps/shell/electron-builder.cjs`가 정한다. 이 모듈은 그것들이 가져다 쓰는 원천 값만 준다.

## 항상 지켜야 하는 것

- 의존성을 추가하지 않는다. 렌더러, 메인 프로세스, Electron 없이 도는 명령줄 번들이 모두 이 패키지를 import한다. Node 전용 API나 DOM API를 모듈 최상위에서 쓰면 어느 한쪽이 깨진다(`IS_MAC` 판정이 `navigator`와 `process`를 둘 다 조심스럽게 읽는 이유다).
- 모든 언어가 모든 키를 가져야 한다. `zh` 사전이 키 집합을 정의하고 나머지 20개 언어는 `Record<keyof D, string>`으로 같은 키를 강제받는다. 빠진 번역은 실행 중의 대체가 아니라 타입 오류여야 한다. `createI18n`의 `en` → `zh` → 키 이름 순 대체는 오래된 사전 조각이 예외를 던지지 않게 하는 안전망일 뿐, 번역을 생략해도 된다는 뜻이 아니다.
- 제품 이름은 출력 시점에 치환한다. 사전·도움말·소스는 제품을 원본 표기 `GenOffice`로 적고(원본의 수정을 계속 병합하기 위해서다), `createI18n`이 모든 번역 문자열에, `brandText`가 그 밖의 사용자에게 보이는 글에 제품 이름을 넣는다. 사전의 `GenOffice`를 일괄로 바꾸지 않는다.
- 원본 이름 자체를 찍어야 하는 곳("GenOffice를 기반으로 합니다" 고지)은 `{{GenOffice}}`(`UPSTREAM_NAME_LITERAL`)로 쓴다. 이 고지는 지우거나 제품 이름으로 바뀌게 두지 않는다.
- `brandText`가 바꾸지 않는 것을 유지한다. 더 긴 식별자 안의 이름(`GenOfficeFormField`), 소문자 `genoffice`(패키지 이름, 환경 변수, 스킴)는 손대지 않는다. 파일·폴더 이름 안의 이름(`GenOffice.exe`, `Documents/GenOffice`)은 언어와 무관하게 `PRODUCT_NAME`이 된다. 한국어 UI에서도 폴더 이름은 `IeumOffice`이고 화면 이름만 `이음오피스`다.
- 치환은 템플릿에만 한다. `createI18n`은 단축키 변환 → 제품 이름 치환 → 자리 표시 채우기 순으로 처리한다. 매개변수 값은 맨 마지막에 들어가므로 치환되지 않는다(사용자 파일 이름이 실제로 `GenOffice`일 수 있다). 이 순서를 바꾸지 않는다.
- `PRODUCT_NAME`은 PC에 등록되는 이름의 원천이다. 설치 프로그램의 제품 이름, userData 폴더, 기본 저장 폴더가 여기서 나오고 UI 언어와 무관하게 같아야 한다. 이 값을 바꾸면 기존 사용자의 설정 폴더가 달라진다. 언어별 표시 이름은 `LOCALIZED_PRODUCT_NAMES`에만 추가한다.
- 원본 앱의 폴더를 물려받지 않는다. userData 이름은 설치본 `IeumOffice`, 개발 실행 `IeumOffice-Dev`이며 둘 다 이 제품의 것이다. 원본이 쓰던 폴더 이름으로 되돌리거나 그것을 찾아 읽는 코드를 넣지 않는다.
- `LANGS` 선언의 모양을 유지한다. `tools/check-help-langs.mjs`가 이 파일을 import하지 않고 글자로 읽어 `export const LANGS`의 `= [` 와 `]` 사이에서 언어 코드를 뽑는다. 배열을 다른 식으로 조립하면 그 검사가 실패한다.

## 이 모듈의 방식

- 큰 사전은 언어별 조각으로 나눈다. `i18n/strings-<영역>.ts`는 `i18n/<영역>/<lang>.ts`를 모으는 얇은 집계 파일이고, 조각 끝의 `satisfies Record<keyof typeof zh, string>`이 빠진 키와 남는 키를 둘 다 타입 오류로 만든다. 키를 추가할 때는 `zh.ts`와 나머지 20개 조각에 함께 넣는다. 집계 파일을 언어 전체가 든 한 객체로 되돌리지 않는다.
- 단축키는 사전에 Mac 표기(`⌘S`, `⇧⌘Z`)로 적는다. macOS가 아니면 `createI18n`이 `Ctrl+S` 형태로 바꾼다. 사전에 `Ctrl+S`를 직접 쓰면 macOS에서 틀린 표기가 나온다. 변환은 템플릿에만 적용되어 매개변수로 넣은 글리프는 그대로 남는다.
- `useI18n()`이 돌려주는 `t`는 참조가 고정되지 않는다. 훅의 의존성 배열에 넣지 않고, 키를 저장해 두었다가 렌더링할 때 번역한다.
- 메인 프로세스의 현재 언어는 프로세스에 하나다. shell과 에디터들의 메인 코드가 한 번들에서 돌기 때문에 모듈 변수 하나로 충분하다. 렌더러는 이 보관소를 읽지 않고 IPC로 언어를 받는다. 초기값은 `zh`이므로 앱이 시작할 때 `setUiLang(normalizeLang(...))`을 불러야 한다.
- `normalizeLang`은 번체 중국어 변형(`zh-TW`, `zh-HK`, `zh-Hant`)을 일반 `zh` 접두사보다 먼저 가려내고, 옛 코드 `in`·`iw`를 `id`·`he`로 읽고, 모르는 값은 `en`으로 보낸다. 언어 코드 뒤에는 `-`나 `_` 경계가 있어야 한다.
- 언어를 추가하는 일은 이 파일만의 변경이 아니다. `Lang`, `LANGS`, `HTML_LANGS`(여기까지는 타입이 강제한다)에 더해 저장소의 모든 사전 조각, 메인 프로세스의 인라인 사전, 도움말의 모든 항목 파일이 그 언어를 가져야 한다.

## 테스트

- 실행: `npm run test -w @genoffice/i18n`(또는 이 폴더에서 `npx vitest run`), `npm run typecheck -w @genoffice/i18n`. Windows에서 전부 통과한다.
- 사전의 키 누락은 테스트가 아니라 타입 검사가 잡는다. 사전을 고쳤으면 그 사전이 속한 workspace의 `typecheck`를 돌린다.
- 바꾸면 반드시 테스트하는 것: `brandText`의 경계(식별자 안, 파일 이름 안, `{{GenOffice}}`, 한 문장에 여러 번 나올 때, 한국어와 그 밖의 언어), 매개변수 값이 치환되지 않는지, 대체 경로로 나온 글에도 제품 이름이 들어가는지, `normalizeLang`의 경계(`zh-Hant`, `in-ID`, 빈 값).
- `platformShortcuts`는 모듈을 불러올 때의 플랫폼으로 고정된다. 변환 규칙은 순수 함수 `macShortcutsToWin`으로 테스트한다.
- 설치 설정, `package.json`, HTML 제목, 파일 연결 ProgId가 이 모듈의 상수와 어긋나지 않는지는 `apps/shell/tests/product-identity.test.ts`가 본다. `PRODUCT_NAME`이나 저장소 좌표를 바꾸면 그 테스트도 함께 돌린다.
