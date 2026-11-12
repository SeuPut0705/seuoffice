# packages/i18n (`@seuoffice/i18n`)

모든 앱과 패키지가 쓰는 i18n의 핵심이다. 지원 언어 목록, 사전의 타입 규칙, 번역 함수, 그리고 제품 이름을 정의하는 단 하나의 자리를 담는다. React·Electron·다른 workspace 패키지에 의존하지 않는다.

## 맡은 범위

- 언어: `Lang`·`LANGS`(영어·한국어), 로캘 문자열을 지원 언어로 옮기는 `normalizeLang`, `<html lang>` 값 `htmlLang`, 오른쪽에서 왼쪽으로 쓰는 언어 판정 `isRtlLang`·`htmlDir`(`src/index.ts`).
- 사전 규칙과 번역기: `LangDicts`, `defineStrings`, `createI18n`, 자리 표시 채우기 `format`.
- 단축키 표기 변환: 사전에 Mac 표기로 적힌 단축키를 Windows/Linux에서 `Ctrl+…` 형태로 바꾸는 `macShortcutsToWin`·`platformShortcuts`.
- 메인 프로세스용 현재 언어 보관소: `getUiLang`·`setUiLang`·`onUiLangChange`.
- 제품 정체성(`src/product.ts`): `PRODUCT_NAME`, `productName(lang)`, 원작 이름 `UPSTREAM_PRODUCT_NAME`, userData 폴더 이름 `USER_DATA_DIR_NAME`·`DEV_USER_DATA_DIR_NAME`, 저장소 좌표 `PRODUCT_REPO_OWNER`·`PRODUCT_REPO_NAME`·`PRODUCT_REPO_SLUG`.
- 옛 이름 목록(`src/old-names.ts`): 이 제품이 우리 이름을 갖기 전에 사용자 컴퓨터에 남긴 이름(환경 변수, 홈 폴더, 프로젝트 폴더, 명령, MCP 서버, 스킬)과, 그것을 계속 받아 주는 `adoptOldEnv`·`existingOrCurrent`. 옛 이름을 글자로 적는 곳은 이름이 `old-names`로 시작하는 파일뿐이다(결정 0024).
- 옛 환경 변수 넘겨받기(`src/old-names-env.ts`, 내보내는 경로 `@seuoffice/i18n/old-names-env`): 불러오면 `process.env`에서 `OLD_ENV_NAMES`의 변수를 넘겨받는다. 이 모듈만 부작용이 있고 `src/index.ts`는 없다.
- 글꼴 선택기가 쓰는 한중일 글꼴 이름 목록(`src/font-names.ts`). 화면 문구가 아니라 OS가 보고하는 글꼴 가족 이름이라는 기능 데이터다.

## 맡지 않는 것 (경계)

- 실제 사전은 이 모듈의 범위가 아니다. 문자열은 각 앱의 `src/renderer/i18n/`와 메인 프로세스의 인라인 사전, `packages/ui`의 공용 문자열에 있다. 여기에 화면 문구를 추가하지 않는다.
- React 훅(`useI18n`)과 언어 전환 UI는 각 앱의 `src/renderer/i18n/locale.tsx`의 범위다.
- 앱 안 도움말 본문(언어별 Markdown)과 그 구조 검사는 `apps/shell`과 `tools/check-help-langs.mjs`의 범위다.
- 저장소 주소에서 만든 URL(이슈, 릴리스)은 `packages/electron-utils`의 `github-menu.ts`가, PC에 등록하는 명령·MCP·스킬 이름은 `packages/cli`의 `names.ts`가, 설치 프로그램의 식별자는 `apps/shell/electron-builder.cjs`가 정한다. 이 모듈은 그것들이 가져다 쓰는 원천 값만 준다.

## 항상 지켜야 하는 것

- 의존성을 추가하지 않는다. 렌더러, 메인 프로세스, Electron 없이 도는 명령줄 번들이 모두 이 패키지를 import한다. Node 전용 API나 DOM API를 모듈 최상위에서 쓰면 어느 한쪽이 깨진다(`IS_MAC` 판정이 `navigator`와 `process`를 둘 다 조심스럽게 읽는 이유다).
- 모든 언어가 모든 키를 가져야 한다. `en` 사전이 키 집합을 정의하고 `ko`는 `Record<keyof D, string>`으로 같은 키를 강제받는다. 빠진 번역은 실행 중의 대체가 아니라 타입 오류여야 한다. `createI18n`의 `en` → 키 이름 순 대체는 오래된 사전 조각이 예외를 던지지 않게 하는 안전망일 뿐, 번역을 생략해도 된다는 뜻이 아니다.
- 제품 이름은 사전·도움말·지시문에 `SeuOffice`라고 직접 적는다. 출력할 때 이름을 바꿔 끼우는 장치(`brandText`)는 없앴다(결정 0024). 언어별 표시 이름이 생기면 `LOCALIZED_PRODUCT_NAMES`와 `productName(lang)`으로 다룬다.
- 원작 이름을 찍어야 하는 곳은 "GenOffice를 기반으로 합니다" 고지(셸의 `setBasedOn`) 한 줄뿐이다. 사전에는 `{upstream}` 자리 표시로 적고, 부르는 쪽이 `UPSTREAM_PRODUCT_NAME`을 매개변수로 넘긴다. 이 고지는 지우거나 제품 이름으로 바뀌게 두지 않는다(Apache-2.0 고지와 한 짝이다).
- `createI18n`은 단축키 변환 → 자리 표시 채우기 순으로 처리한다. 매개변수 값은 맨 마지막에 들어가 바뀌지 않는다(사용자 파일 이름이 실제로 `GenOffice`일 수 있다).
- 환경 변수는 `SEUOFFICE_*`다. 옛 접두사에서 넘겨받는 것은 사람에게 설정하라고 알려 준 변수(`OLD_ENV_NAMES` 열두 개: 도움말, 에이전트 스킬, 명령 도움말·README·오류 문구, 개인정보·보안 문서, `docs/contracts.md`에 나온 것)뿐이고, 새 이름이 이미 있으면 그것이 이긴다. 빌드·개발·시험용 변수는 이름만 바꿨다. 프로세스 진입 파일(셸과 각 편집기의 main, 워커·유틸리티 프로세스, 명령줄)은 `@seuoffice/i18n/old-names-env`를 맨 첫 import로 둔다. `tests/env-entry-points.old-names.test.ts`가 빌드 설정에서 진입 파일을 찾아 그 줄이 없으면 실패한다.
- `PRODUCT_NAME`은 PC에 등록되는 이름의 원천이다. 설치 프로그램의 제품 이름, userData 폴더, 기본 저장 폴더가 여기서 나오고 UI 언어와 무관하게 같아야 한다. 이 값을 바꾸면 기존 사용자의 설정 폴더가 달라진다. 언어별 표시 이름은 `LOCALIZED_PRODUCT_NAMES`에만 추가한다.
- 원본 앱의 폴더를 물려받지 않는다. userData 이름은 설치본 `seuoffice`, 개발 실행 `seuoffice-Dev`이며 둘 다 이 제품의 것이다. 원본이 쓰던 폴더 이름으로 되돌리거나 그것을 찾아 읽는 코드를 넣지 않는다. `old-names.ts`에 있는 것은 이 제품 자신이 예전에 쓰던 이름이다.
- `LANGS` 선언의 모양을 유지한다. `tools/check-help-langs.mjs`가 이 파일을 import하지 않고 글자로 읽어 `export const LANGS`의 `= [` 와 `]` 사이에서 언어 코드를 뽑는다. 배열을 다른 식으로 조립하면 그 검사가 실패한다.

## 이 모듈의 방식

- 큰 사전은 언어별 조각으로 나눈다. `i18n/strings-<영역>.ts`는 `i18n/<영역>/<lang>.ts`를 모으는 얇은 집계 파일이고, 조각 끝의 `satisfies Record<keyof typeof en, string>`이 빠진 키와 남는 키를 둘 다 타입 오류로 만든다. 키를 추가할 때는 `en.ts`와 `ko.ts`에 함께 넣는다. 집계 파일을 언어 전체가 든 한 객체로 되돌리지 않는다.
- 단축키는 사전에 Mac 표기(`⌘S`, `⇧⌘Z`)로 적는다. macOS가 아니면 `createI18n`이 `Ctrl+S` 형태로 바꾼다. 사전에 `Ctrl+S`를 직접 쓰면 macOS에서 틀린 표기가 나온다. 변환은 템플릿에만 적용되어 매개변수로 넣은 글리프는 그대로 남는다.
- `useI18n()`이 돌려주는 `t`는 참조가 고정되지 않는다. 훅의 의존성 배열에 넣지 않고, 키를 저장해 두었다가 렌더링할 때 번역한다.
- 메인 프로세스의 현재 언어는 프로세스에 하나다. shell과 에디터들의 메인 코드가 한 번들에서 돌기 때문에 모듈 변수 하나로 충분하다. 렌더러는 이 보관소를 읽지 않고 IPC로 언어를 받는다. 초기값은 `en`이므로 앱이 시작할 때 `setUiLang(normalizeLang(...))`을 불러야 한다.
- `normalizeLang`은 바깥에서 온 언어 값이 `Lang`이 되는 단 하나의 자리다. 저장된 선택, 시스템 로캘, 환경 변수, 웹 호스트의 `?lang=`이 모두 이 함수를 거친다. 한국어(`ko`, `ko-KR`, `ko_KR`)는 `ko`, 그 밖의 값과 빈 값은 모두 `en`이다. 언어 코드 뒤에는 `-`나 `_` 경계가 있어야 한다. 설치본이 보일 언어는 `installLang`이 정한다: 저장된 선택이 있으면 그것을(UI 언어가 아니면 영어), 없으면 시스템 로캘을 따른다.
- 언어를 추가하는 일은 이 파일만의 변경이 아니다. `Lang`, `LANGS`, `HTML_LANGS`(여기까지는 타입이 강제한다)에 더해 저장소의 모든 사전 조각, 메인 프로세스의 인라인 사전, 도움말의 모든 항목 파일이 그 언어를 가져야 한다.

## 테스트

- 실행: `npm run test -w @seuoffice/i18n`(또는 이 폴더에서 `npx vitest run`), `npm run typecheck -w @seuoffice/i18n`. Windows에서 전부 통과한다.
- 사전의 키 누락은 테스트가 아니라 타입 검사가 잡는다. 사전을 고쳤으면 그 사전이 속한 workspace의 `typecheck`를 돌린다.
- 바꾸면 반드시 테스트하는 것: 고지 문자열이 매개변수로 원작 이름을 받는지, 매개변수 값이 바뀌지 않는지, 대체 경로(`en`), `adoptOldEnv`의 대상과 우선순위(목록의 변수만, 새 이름이 이긴다, 빈 값도 설정된 것이다), `existingOrCurrent`의 순서(새 이름이 있으면 새 이름), `normalizeLang`의 경계(`ko-KR`, UI 언어가 아닌 값, 빈 값), `installLang`(저장된 `ja`, 저장값 없는 첫 실행).
- `platformShortcuts`는 모듈을 불러올 때의 플랫폼으로 고정된다. 변환 규칙은 순수 함수 `macShortcutsToWin`으로 테스트한다.
- 설치 설정, `package.json`, HTML 제목, 파일 연결 ProgId가 이 모듈의 상수와 어긋나지 않는지는 `apps/shell/tests/product-identity.test.ts`가 본다. `PRODUCT_NAME`이나 저장소 좌표를 바꾸면 그 테스트도 함께 돌린다.
