# 들여온 트리의 검사 기준선

- 날짜: 2026-11-08
- 커밋: `2b036c8a3a4dac13fc8a4ea68fbca700f92c3b65`(`chore: adapt the imported tree to seuoffice`, 이음오피스 `aea1414` 들여오기 직후)
- 환경: macOS arm64, Node 22.22.3(Homebrew `node@22`), npm 10.9.8, rustc·cargo 1.98.1(Homebrew)
- 방법: 깨끗한 작업 트리(`git worktree`)에서 `npm ci` 뒤 아래 명령을 차례로 돌렸다.

## Node 버전

처음에는 이 PC 기본 Node 26.5.0으로 돌렸다. `npm ci`와 검사 다섯 개는 통과했지만 `npm run test:parallel`에서 13개 작업 공간이 실패했다. 대부분 jsdom 시험에서 `localStorage`가 `undefined`였다(`Cannot read properties of undefined (reading 'getItem' | 'setItem' | 'removeItem' | 'clear')`). Node 25부터 들어온 내장 `localStorage`가 jsdom 것을 가리는 Node 버전 문제다. 그래서 상위 `.nvmrc`(22)에 맞춰 Node 22로 전부 다시 돌렸고, 아래가 그 결과다. 이 저장소의 시험은 Node 22로 돌린다.

## 결과

| 명령                             | 결과                        | 걸린 시간 |
| -------------------------------- | --------------------------- | --------- |
| `npm run check:no-genspark`      | 통과                        | 2초       |
| `npm run check:english-comments` | 통과                        | 1초       |
| `npm run format:check`           | 통과                        | 1초 미만  |
| `npm run lint`                   | 통과                        | 35초      |
| `npm run typecheck`              | 통과                        | 105초     |
| `npm run test:parallel`          | 실패(38개 작업 공간 중 5개) | 276초     |

sheets의 Rust 시험(`native:test`: 304 + 7개)과 `native:build`는 통과했다.

## 실패한 시험

| 작업 공간                | 시험 파일                             | 시험 이름                                                                                                                            | 까닭                                              |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `@genoffice/sheets`      | `tests/template-fonts-export.test.ts` | bundled fonts on the export and print page > print declares the same faces                                                           | `/usr/bin/lp`가 없음(인쇄 명령이 없는 PC)         |
| `@genoffice/slides`      | `tests/system-fonts.test.ts`          | Japanese/Korean/Traditional-Chinese font substitution (macOS system fonts) > Japanese font requests resolve to matching system faces | 이 PC 글꼴 대체가 `Hiragino Sans` 대신 `YuGothic` |
| `@genoffice/ai-provider` | `tests/subscription-locate.test.ts`   | locateSubscriptionProgram on Windows > finds a Codex that winget installed after the app started                                     | 임시 폴더 `/var` ↔ `/private/var` 경로 차이       |
| `@genoffice/ai-provider` | `tests/subscription-locate.test.ts`   | a user-configured path > that no longer exists falls back to the automatic lookup                                                    | 같은 경로 차이                                    |
| `@genoffice/ai-provider` | `tests/subscription-locate.test.ts`   | locateSubscriptionProgram elsewhere > keeps the npm launcher for the older vendor layout, which also puts its rg on PATH             | 이 PC에 설치된 프로그램을 먼저 찾음               |
| `@genoffice/shell`       | `tests/tab-shortcuts.test.ts`         | handling a tab shortcut > closes the active document tab but leaves Home to its window-close menu                                    | 단언 실패(원인 미조사)                            |
| `@genoffice/shell`       | `tests/mcp-client/local.test.ts`      | a running server > starts exactly the command the confirmation shows, without a shell, in an empty folder                            | 단언 실패(원인 미조사)                            |
| `@genoffice/shell`       | `tests/mcp-client/local.test.ts`      | a running server > gives the server the minimal system variables and its registered ones, nothing of the app                         | macOS가 넣는 `__CF_USER_TEXT_ENCODING` 환경 변수  |
| `@genoffice/markdown`    | `tests/source-splice.test.ts`         | source splice > round-trips every markdown file in the repository                                                                    | seuoffice가 만든 실패, 아래 참고                  |

`@genoffice/markdown` 한 건을 뺀 실패들은 상위 그대로의 상태이며 seuoffice가 만든 것이 아니다. 모두 이 PC 환경(macOS 글꼴·경로·인쇄 명령)에 걸린 것으로 보인다[추론].

`@genoffice/markdown`의 실패는 seuoffice가 만들었다. 이 시험은 `git ls-files -- "*.md"`로 저장소의 Markdown 파일을 읽는데, git은 한글 파일 이름(`docs/seuoffice/로드맵.md` 등)을 따옴표와 8진수로 감싸 내놓는다(`core.quotepath`). 다음 커밋 `test(markdown): read repository paths unquoted`에서 시험이 `git -c core.quotepath=off`로 경로를 읽게 고친다.

기준선을 위해 코드를 고치지 않았다.

## GitHub 상위 CI(`CI` 워크플로)

상위에서 들여온 `.github/workflows/ci.yml`을 GitHub(ubuntu, Node 22)에서 돌린 결과다. 코드 시험이 실패한 적은 없고, 실패는 모두 내려받기 장애, 시간 상한, 이력 고쳐 쓰기 때문이다.

| 실행                     | 작업   | 결과 | 까닭                                                                                                                                                  |
| ------------------------ | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 42474844121 첫 시도      | 둘 다  | 실패 | `npm ci`가 Electron을 GitHub 릴리스에서 받다 504                                                                                                      |
| 42474844121 두 번째 시도 | `e2e`  | 실패 | `Build apps`에서 draw.io(`draw.war`)를 GitHub 릴리스에서 받다 504                                                                                     |
| 42474844121 두 번째 시도 | `test` | 끊김 | 작업 시간 상한 45분. 끊기기 전까지 검사 전부와 작업 공간 28개 시험이 통과했고 실패는 0이었다. sheets `native:test`에서 끊겼다                         |
| 42478878430 첫 시도      | `e2e`  | 통과 | 앱 빌드, markdown 브라우저 시험, Electron 셸 e2e 모두 통과                                                                                            |
| 42478878430 첫 시도      | `test` | 실패 | `npm ci`가 Electron을 받다 504                                                                                                                        |
| 42478878430 두 번째 시도 | `test` | 실패 | `Check skill versions`가 `github.event.before`(force-push 전 커밋 `e6371aa`)를 찾지 못함. 이력을 고쳐 쓴 뒤 첫 푸시에서만 생기고 다음 푸시부터는 없다 |

- 상위 이음오피스의 같은 작업은 cargo 캐시가 있어 39분쯤 걸린다(이음 run 42455263595). 이 저장소는 캐시가 녹색 실행 뒤에만 저장되어 첫 실행이 더 오래 걸린다. 그래서 `test` 상한을 60분으로 올렸다(`upstream-edits.md`).
- 리눅스에서는 `@genoffice/ai-provider` 시험이 모두 통과했다. 위 표의 ai-provider 실패 세 건이 이 PC(macOS) 환경 때문이라는 추론과 맞는다.
