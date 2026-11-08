# html2docx

## 맡은 범위

HTML 문서를 Word 문서로 바꾼다. 실제 Chromium에 페이지를 띄워 DOM, 계산된 스타일, 실측 좌표를 읽고, 문서 의도 트리(IR)로 줄인 뒤 `docx` 라이브러리로 네이티브 OOXML을 쓴다. Word에 대응물이 없는 시각 요소만 부분 캡처한다. HTML 앱의 Word 내보내기, Docs 앱이 `w:altChunk` 안의 HTML을 펼칠 때, 명령줄 도구의 `convert … --to docx`가 같은 변환을 쓴다.

## 맡지 않는 것 (경계)

- 브라우저를 소유하지 않는다. 호출자가 `BrowserDriver`를 만들어 넘기고 닫는다. 변환기는 드라이버를 닫지 않는다.
- 기존 docx를 열거나 고치지 않는다. 결과는 언제나 새 문서라서 왕복 보존의 대상이 없다. docx의 파싱과 저장은 `packages/docx-engine`이고, 이 패키지는 그 엔진에 의존하지 않는다.
- HTML 편집기와 미리보기, 내보내기 진행 표시, IPC는 `apps/html`이다.
- PDF를 중간 형식으로 쓰지 않는다. 의미와 편집 가능성을 잃기 때문이다.

## 항상 지켜야 하는 것

- 페이지에서 돌아온 값은 신뢰하지 않는다. 추출 결과는 `normalizeIr`을 거친다. 배열이 아니거나, 항목이 객체가 아니거나, `type`이 빈 문자열이거나, `shotId`가 문자열이 아니거나, 기하 숫자가 유한수가 아니면 변환을 중단한다. `width`, `height`, `widthFrac`, `heightPx`, `px`는 음수도 거부하고 `xPx`, `yPx`만 음수를 받는다. 나눗셈이나 크기 계산에 들어가는 숫자 필드를 IR에 추가하면 이 검사에도 넣는다.
- `src/index.ts`에서 드라이버 구현을 내보내지 않는다. 앱 번들에 Playwright가, 테스트와 CLI에 Electron이 딸려 오지 않게 하려는 것이다. 호출자는 `src/drivers/electron` 또는 `src/drivers/playwright`를 경로로 직접 import한다. Electron에 닿는 파일은 `src/drivers/electron.ts` 하나로 유지한다.
- Electron 드라이버의 숨은 창은 `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`이고 preload가 없으며 새 창 열기를 거부한다. 문서의 스크립트가 그 안에서 실행되므로 이 설정을 느슨하게 하지 않는다.
- 취소(`AbortSignal`)는 단계 사이마다 확인하고, 오래 걸리는 페이지 대기는 `raceWithAbort`로 감싼다. 새 대기 지점을 넣을 때도 같다.
- 탐색은 30초에서 끊고 그 시점의 페이지로 계속한다. 외부 자원 하나가 변환 전체를 붙잡지 않는다.

## 이 모듈의 방식

- 흐름은 이렇다. A4 뷰포트(794×1123, 배율 2)로 로드 → `body`의 설계 폭이 더 넓거나 내용이 가로로 넘치면 1024px 이상으로 다시 로드 → 추출기 주입과 실행 → IR이 가리킨 요소만 캡처 → OOXML 생성. 좁은 뷰포트에서 그대로 뽑으면 없던 줄바꿈이 생기고 표의 행 높이가 부풀기 때문에 다시 로드한다.
- 원칙은 "구조 먼저, 캡처는 대안"이다. 제목·문단·목록·표·양식은 편집 가능한 Word 구조로, 그라디언트·복잡한 SVG·장식은 부분 이미지로 간다. 페이지 전체를 이미지로 만들지 않는다.
- `src/browser/core/*.js`는 모듈이 아니다. 하나의 `extractIR()` 함수 본문을 책임별로 자른 조각이고, `src/extract.ts`가 `?raw`로 읽어 정해진 순서로 이어 붙인다. 조각들이 한 스코프를 공유하므로 `import`/`export`를 쓸 수 없고, 순서를 바꾸면 깨진다. `src/browser/` 바로 아래의 파일들은 `__html2docx*` 전역을 설치하는 별도 스크립트이고 추출기보다 먼저 주입된다.
- 분류 순서가 결과를 정한다. 충실도가 높은 규칙(표, 그리드 표, 카드, 배지 등)이 일반 블록 재귀보다 앞에 있어야 한다. 뒤로 옮기면 복잡한 구성요소가 평범한 문단으로 쪼개진다.
- 표는 고정 레이아웃으로 쓰고 그리드 열 폭과 셀 폭을 둘 다 적는다. Word의 자동 맞춤이 글자 길이로 열을 다시 나누지 못하게 하려는 것이다. 같은 이유로 브라우저에서 잰 값을 그대로 써서 Word의 기본 문단 여백과 자동 조정을 누른다.
- 페이지 여백은 고정값이 아니라 `body`의 실제 여백에서 온다(`docsettings` 노드).
- 생성 계층(`src/generate/`)은 타입 없는 CommonJS에서 옮겨 온 코드라 `strict: false`다. 타입은 로직을 바꾸지 않고 파일 단위로 조인다.
- `.js?raw` import는 Vite가 풀어 준다. `tools/cli.ts`가 Vite의 SSR 로더를 거쳐 실행되는 이유다.

## 테스트

- `npm run test -w @genoffice/html2docx`, 또는 패키지 폴더에서 `npx vitest run`. 타임아웃이 길다(테스트 90초, 훅 60초).
- `tests/features.test.ts`와 `tests/pagebg-restore.test.ts`는 로컬에 설치된 Chrome을 Playwright로 띄운다. Chrome을 찾는 후보 경로가 macOS와 Linux 것뿐이라, Windows에서는 `CHROME_PATH`를 주지 않으면 `beforeAll`에서 `Chrome/Chromium not found`로 파일 전체가 실패한다. 이 두 파일은 Windows에서 변경 이전부터 실패하는 것으로 알려져 있다. Chromium을 내려받는 코드는 없다.
- 나머지 테스트 파일은 브라우저 없이 IR 검증과 생성 계층을 직접 부르며 Windows에서 통과한다.
- 추출과 분류 규칙을 바꾸면 Chrome이 있는 환경에서 `features.test.ts`에 HTML 입력과 기대하는 OOXML을 사례로 추가한다. 생성 계층만 바꾸면 브라우저 없는 테스트로 덮을 수 있다.
