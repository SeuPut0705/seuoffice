# packages/ai-search (`@genoffice/ai-search`)

AI가 쓰는 부가 도구(웹 검색, 이미지 검색, 이미지 생성, 미디어 분석)와, 그 요청이 무료·키·구독 중 어느 경로에서 시작할지 정하는 라우팅을 담는다. 에디터의 메인 프로세스와 명령줄(`packages/cli`)이 같은 코드를 쓴다.

## 맡은 범위

- 검색: `webSearch`·`imageSearch`와 백엔드별 구현(`src/index.ts`), 설정 파일을 읽어 옵션으로 바꾸는 `webSearchTool`·`imageSearchTool`·`searchOptionsFromSettings`(`src/search-tools.ts`), 키 없는 Parallel 검색(`src/parallel-mcp.ts`).
- 웹 페이지 읽기: `readUrlTool`·`readUrlModelText`(`src/read-url.ts`)과 HTML→글 변환 `htmlToText`(`src/html-text.ts`). 주소는 `fetchWithSsrfGuard`로 받고 10MB·30초·50,000자 상한과 나눠 읽기(offset)를 두며, 설정의 `readUrl.githubToken`은 비공개 GitHub 파일을 읽을 때만 읽는다.
- 이미지 생성과 미디어 분석: `generateImageTool`·`analyzeMediaTool`(`src/media-tools.ts`), 채팅 제공자에게 이미지를 보여 주는 분석(`src/chat-analysis.ts`).
- 이미지 생성·미디어 분석 호출의 취소: 진행 중인 호출을 창(webContents id)별로 기억해 두고, 창이 사라지거나 그 창의 AI 실행이 중단되면 끊는 `withMediaCallSignal`·`abortMediaCalls`(`src/media-call-abort.ts`).
- 경로 결정: `resolveImageRoute`·`resolveImageAnalysisRoute`·`resolveVideoAnalysisRoute`·`headlessSubscriptionBlocked`(`src/tool-routing.ts`)와 같은 함수로 만든 가용성 보고 `aiToolCapabilities`(`src/tool-capabilities.ts`).
- 자동 호출 경로의 구독 요청 차례와 사용량 기록: `runHeadlessSubscriptionCall`·`headlessSubscriptionUsage`(`src/headless-ledger.ts`). 명령줄의 PDF 작업(`pdf ai-read`, `pdf translate`)도 모델 호출마다 이 차례를 거친다.
- Codex 이미지 생성기가 스스로 등록하는 자리 `registerCodexImageGenerator`(`src/codex-image-generator.ts`)와, 그 자리에 들어가는 CLI 생성기 `createCodexImageCliGenerator`(`src/codex-image-cli.ts`, 결정 0076): `codex exec` 한 번으로 내장 `image_gen`을 쓰고, 임시 폴더에 쓰인 이미지 파일을 읽어 돌려준다. 로그인 파일은 읽지 않는다(CLI가 스스로 인증한다).

## 맡지 않는 것 (경계)

- 제공자 선택 규칙, 구독 프로그램의 시작·종료, 연결 상태 확인은 `packages/ai-provider`의 범위다. 이 모듈은 호출자가 넘긴 `statuses`를 읽기만 하고, 상태를 직접 확인하거나 벤더 프로그램을 띄우지 않는다.
- Codex로 이미지를 "만드는 방법"은 원래 이 모듈의 범위가 아니었지만, 결정 0076으로 CLI 생성기(`codex-image-cli.ts`)를 여기 두었다. 채팅 세션과 분리된 `codex exec` 한 번이며, 채팅의 도구 통제 규칙은 그대로다. 앱이 시작할 때 `apps/docs`의 메인이 등록하고 가용성을 켠다. 무료 요금제에는 이미지 도구가 없으므로 첫 실패에서 그 실행 동안 경로를 숨긴다(요금제 이름으로 미리 추측하지 않는다).
- 받은 이미지를 문서에 넣는 일, 도구를 모델에게 노출할지 정하는 일은 각 에디터(`apps/*/src/renderer/ai`)의 범위다.
- 명령의 인자·출력 형식·종료 코드는 `packages/cli`의 범위다. 이 모듈의 도구는 `{ url | text | error, errorCode, resetsAt }` 객체를 돌려줄 뿐이다.
- Electron을 import하지 않는다. 이 코드는 Electron 없이 도는 명령줄 번들에도 들어가므로 `@genoffice/electron-utils`는 패키지 루트가 아니라 `generated-images`·`remote-image`·`safe-remote-url` 하위 경로로만 import한다(루트는 Electron에 묶인 모듈을 다시 내보낸다).

## 항상 지켜야 하는 것

- 검색은 구독을 쓰지 않고, 기본 경로는 키가 없는 경로다(무료 Parallel 검색 다음 DuckDuckGo). 키 제공자는 사용자가 설정에서 고른 것만 쓴다. 환경 변수의 키(`SERPER_API_KEY` 등)는 사용자가 "고른" 제공자의 저장된 키를 대신할 뿐 어느 제공자를 쓸지는 바꾸지 못한다. Parallel에 저장된 키가 없으면 그것이 곧 무료 경로이므로 `PARALLEL_API_KEY`가 있어도 유료로 바뀌지 않는다(`selectedSearchKey`).
- 요청은 화면 경로(`path: 'screen'`, 사람이 에디터에서 요청)와 자동 호출 경로(`path: 'headless'`, 명령줄과 MCP) 중 하나로 들어온다. 자동 호출 경로는 사용자가 설정에서 켰을 때(`headlessSubscriptionEnabled`)만 구독 로그인을 쓰고, 꺼져 있으면 `ready`인 구독이 없는 것처럼 라우팅한다(`routingStatuses`). 켜져 있다는 것은 스위치(`headlessSubscriptionEnabled`)와 함께 지금 판의 경고에 동의한 기록(`headlessSubscriptionConsentVersion` ≥ 2)이 있다는 뜻이다(`headlessSubscriptionOn`). 시간당 한도가 있던 예전 경고에 동의한 스위치는 꺼진 것으로 읽는다. `dataDir`가 없는 자동 호출도 구독을 쓰지 않는다. 잠금 파일을 둘 곳이 없으면 프로세스들 사이의 차례를 지킬 수 없기 때문이다.
- 자동 호출 경로의 구독 요청은 한 번에 하나다. 시간당 한도는 없다(결정 0011, 0004를 대체). 명령 하나가 프로세스 하나이므로 차례는 `dataDir`의 잠금 파일(`headless-subscription.lock`)로 프로세스를 넘어 지킨다. 차례의 단위는 요청 하나다. 긴 PDF 작업도 요청마다 잠금을 놓으므로 다른 호출자와 번갈아 처리된다. 30분(`HEADLESS_QUEUE_TIMEOUT_MS`) 넘게 차례를 기다린 요청은 `timeout`으로 끝난다.
- 장부(`headless-subscription-ledger.json`)는 최근 한 시간의 요청 시작 시각만 정보로 남긴다(`capabilities`의 `automatic_calls.used`). 장부는 요청을 막지 않는다. 손상됐거나 읽을 수 없는 장부는 빈 것으로 치고, 시각을 기록하지 못해도 요청은 돈다. `headless-limit`은 더는 내지 않는다. 오류 종류 이름만 예전 호출자를 위해 남아 있다.
- 사용자가 동의한 종량제 로그인은 구독이 아니다. 요청마다 돈이 드는 키와 같은 취급이라 자동 호출 스위치로 꺼지지도, 장부에 세지도 않고, 이미지 생성에는 쓰지 않는다. 가용성 보고에서는 `route: 'key'`에 `metered: true`로 나간다.
- 이미지 분석이 채팅 제공자로 갈 때는 채팅과 똑같이 `selectAiProvider`로 고른다. 돈이 드는 것을 사용자 대신 고르지 않기 위해서다. 연결된 것이 없으면 다른 것으로 넘어가지 않고 `unavailable`로 답한다.
- 보고와 실행은 같은 함수를 묻는다. `aiToolCapabilities`가 "된다"고 한 경로가 실제 도구가 시작하는 경로여야 하므로, 경로 규칙은 `tool-routing.ts`에만 두고 도구나 보고 쪽에 따로 분기를 만들지 않는다. 보고는 장부를 보지 않는다. 사용량(`used`)은 명령줄이 따로 읽어 붙인다.
- 도구는 throw하지 않는다. 실패는 `error`와 `errorCode`(`'unavailable'` 또는 `AiRunErrorKind`)로 돌려준다. 문장은 영어이며 도구(모델)가 읽는 용도다. 화면은 `errorCode`로 번역한다.
- 모델이 준 주소와 경로는 믿지 않는다. 원격 미디어는 `fetchWithSsrfGuard`와 크기 상한을 거치고, 로컬 경로는 `mediaRoots`(열린 문서의 폴더와 첨부 임시 폴더) 안에 있는지 양쪽을 realpath로 풀어 확인한다. `file://` 주소는 `readGeneratedImage`가 이 앱이 만든 이미지일 때만 읽는다.

## 이 모듈의 방식

- 호출자가 자기 신원을 넘긴다. 에디터 메인은 `{ path: 'screen', statuses: sharedSubscriptionStatuses() }`, 명령줄과 MCP는 `{ path: 'headless', statuses, dataDir }`다. `dataDir`는 `ai-settings.json`이 있는 폴더로, 앱과 모든 명령줄 프로세스가 같은 곳을 써야 차례가 하나로 지켜진다. 컨텍스트를 안 넘기면 "구독이 연결되지 않은 화면 경로"로 취급되어 키와 무료 경로만 쓴다.
- `statuses`는 상태 서비스의 값이어야 한다. 날것의 감지 결과에는 `meteredAccepted`가 반영되지 않아 동의한 종량제 로그인이 연결로 읽히지 않는다.
- 도구는 호출 때마다 설정 파일을 새로 읽고(`readAiSettingsFile`) 안에서 `normalizeAiSettings`를 거친다. 사라진 제공자 id가 저장돼 있어도 기본값으로 읽힌다.
- 이미지 경로는 요청이 시작할 때 한 번 정하고 도중에 바꾸지 않는다(`resolveImageRoute`). Codex 경로는 `codexImageGenerationAvailable()`이 참이고 생성기가 등록됐을 때만 후보다(`codexImageRouteOffered`). `@genoffice/ai-provider`가 이 패키지를 import하면 순환이 되므로 생성기는 "등록"하는 구조다.
- 키 제공자가 준 이미지 바이트는 로컬 생성 이미지 저장소(`storeGeneratedImage`)에 두고 `file://` 주소로 돌려준다. 에디터의 삽입 경로가 그 주소를 받는다.
- 이미지 분석은 사용자가 고른 키 분석 제공자가 채워져 있으면 그쪽으로, 아니면 채팅이 도는 제공자(`chat`)로 간다. `chat` 분석은 비전이 없는 모델, 요청당 20MB를 넘는 이미지(`CHAT_ANALYSIS_MAX_BYTES`)를 거절하고 300초(`CHAT_ANALYSIS_TIMEOUT_MS`)에 끊는다. 영상·음성 분석은 영상을 읽는 키 제공자가 있을 때만 된다.
- 잠금은 죽은 프로세스를 견딘다. 보유자가 잠금 파일의 수정 시각을 주기적으로 갱신하고, 프로세스가 사라졌거나 갱신이 멈춘 잠금은 넘겨받는다. 장부 쓰기는 임시 파일을 rename하는 방식만 쓴다.
- HTML→글 변환은 `parse5`를 쓴다(이 패키지의 의존성). 페이지 캐시는 프로세스 메모리에만 3분·8개까지 두고, 최종 주소와 요청 주소로 찾는다.

## 테스트

- 실행: `npm run test -w @genoffice/ai-search`(또는 이 폴더에서 `npx vitest run`), `npm run typecheck -w @genoffice/ai-search`.
- 테스트는 네트워크와 벤더 프로그램에 닿지 않는다. `@genoffice/ai-provider`의 `generateImageWithProvider`·`analyzeMediaWithProvider`·`streamForProvider`를 `vi.mock`으로 바꾸고, 상태는 `tests/routing-helpers.ts`의 `status()`로 만든다. 구독 경로를 타는 테스트에서 `streamForProvider`를 바꾸지 않으면 실제 프로그램이 뜬다.
- 설정 파일 픽스처에는 `providers` 블록을 항상 넣는다(`writeSettings`). 그 블록이 없는 파일은 제공자 도입 이전 파일로 읽혀 모든 구역이 기본값으로 초기화된다.
- 바꾸면 반드시 테스트하는 것: 화면·자동 호출 × 스위치 켬·끔 × 구독 `ready`·종량 허용·미연결 조합에서 경로와 보고가 같은 답인지, 환경 변수 키가 선택을 바꾸지 못하는지(`tests/search-free-route.test.ts`), 21번째 이후 요청도 거절되지 않는지, 손상된 장부와 쓸 수 없는 장부가 요청을 막지 않는지, 예전 판의 동의가 꺼짐으로 읽히는지, 죽은 프로세스의 잠금, 동시에 들어온 두 요청이 차례로 도는지.
- `tests/codex-image-absent.test.ts`는 "패키지 진입점만으로는 Codex 이미지 생성기가 등록되지 않는다"를 고정한다. 앱의 등록은 `apps/docs`가 하며, 그 등록을 바꾸면 이 테스트와 가용성 판단을 함께 본다.
- `tests/codex-image-cli.test.ts`는 가짜 CLI로 `codex exec` 명령 모양(이미지 도구, `workspace-write`, `--skip-git-repo-check`, 크기·품질), 파일 회수(다른 이름 포함), 요금제 실패 문장과 그 뒤의 경로 숨김, 임시 폴더 정리를 확인한다. 실제 유료 계정 호출은 하지 않는다.
- Windows에서 `tests/media-local-path.test.ts`의 `documentMediaRoots` 한 건은 변경과 무관하게 실패한다(기대값이 `/work`인데 Windows의 `dirname`은 `\work`를 돌려준다).
