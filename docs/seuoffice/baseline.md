# 들여온 트리의 검사 기준선

- 날짜: 2026-11-08
- 커밋: `2b036c8a3a4dac13fc8a4ea68fbca700f92c3b65`(`chore: adapt the imported tree to seuoffice`, 이음오피스 `aea1414` 들여오기 직후)
- 환경: macOS arm64, Node 22.22.3(Homebrew `node@22`), npm 10.9.8, rustc·cargo 1.98.1(Homebrew)
- 방법: 깨끗한 작업 트리(`git worktree`)에서 `npm ci` 뒤 아래 명령을 차례로 돌렸다.

## Node 버전
처음에는 이 PC 기본 Node 26.5.0으로 돌렸다. `npm ci`와 검사 다섯 개는 통과했지만 `npm run test:parallel`에서 13개 작업 공간이 실패했다. 대부분 jsdom 시험에서 `localStorage`가 `undefined`였다(`Cannot read properties of undefined (reading 'getItem' | 'setItem' | 'removeItem' | 'clear')`). Node 25부터 들어온 내장 `localStorage`가 jsdom 것을 가리는 Node 버전 문제다. 그래서 상위 `.nvmrc`(22)에 맞춰 Node 22로 전부 다시 돌렸고, 아래가 그 결과다. 이 저장소의 시험은 Node 22로 돌린다.

## 결과

| 명령 | 결과 | 걸린 시간 |
|---|---|---|
| `npm run check:no-genspark` | 통과 | 2초 |
| `npm run check:english-comments` | 통과 | 1초 |
| `npm run format:check` | 통과 | 1초 미만 |
| `npm run lint` | 통과 | 35초 |
| `npm run typecheck` | 통과 | 105초 |
| `npm run test:parallel` | 실패(38개 작업 공간 중 5개) | 276초 |

sheets의 Rust 시험(`native:test`: 304 + 7개)과 `native:build`는 통과했다.

## 실패한 시험

| 작업 공간 | 시험 파일 | 시험 이름 | 까닭 |
|---|---|---|---|
| `@genoffice/sheets` | `tests/template-fonts-export.test.ts` | bundled fonts on the export and print page > print declares the same faces | `/usr/bin/lp`가 없음(인쇄 명령이 없는 PC) |
| `@genoffice/slides` | `tests/system-fonts.test.ts` | Japanese/Korean/Traditional-Chinese font substitution (macOS system fonts) > Japanese font requests resolve to matching system faces | 이 PC 글꼴 대체가 `Hiragino Sans` 대신 `YuGothic` |
| `@genoffice/ai-provider` | `tests/subscription-locate.test.ts` | locateSubscriptionProgram on Windows > finds a Codex that winget installed after the app started | 임시 폴더 `/var` ↔ `/private/var` 경로 차이 |
| `@genoffice/ai-provider` | `tests/subscription-locate.test.ts` | a user-configured path > that no longer exists falls back to the automatic lookup | 같은 경로 차이 |
| `@genoffice/ai-provider` | `tests/subscription-locate.test.ts` | locateSubscriptionProgram elsewhere > keeps the npm launcher for the older vendor layout, which also puts its rg on PATH | 이 PC에 설치된 프로그램을 먼저 찾음 |
| `@genoffice/shell` | `tests/tab-shortcuts.test.ts` | handling a tab shortcut > closes the active document tab but leaves Home to its window-close menu | 단언 실패(원인 미조사) |
| `@genoffice/shell` | `tests/mcp-client/local.test.ts` | a running server > starts exactly the command the confirmation shows, without a shell, in an empty folder | 단언 실패(원인 미조사) |
| `@genoffice/shell` | `tests/mcp-client/local.test.ts` | a running server > gives the server the minimal system variables and its registered ones, nothing of the app | macOS가 넣는 `__CF_USER_TEXT_ENCODING` 환경 변수 |
| `@genoffice/markdown` | `tests/source-splice.test.ts` | source splice > round-trips every markdown file in the repository | seuoffice가 만든 실패, 아래 참고 |

`@genoffice/markdown` 한 건을 뺀 실패들은 상위 그대로의 상태이며 seuoffice가 만든 것이 아니다. 모두 이 PC 환경(macOS 글꼴·경로·인쇄 명령)에 걸린 것으로 보인다[추론].

`@genoffice/markdown`의 실패는 seuoffice가 만들었다. 이 시험은 `git ls-files -- "*.md"`로 저장소의 Markdown 파일을 읽는데, git은 한글 파일 이름(`docs/seuoffice/로드맵.md` 등)을 따옴표와 8진수로 감싸 내놓는다(`core.quotepath`). 다음 커밋 `test(markdown): read repository paths unquoted`에서 시험이 `git -c core.quotepath=off`로 경로를 읽게 고친다.

기준선을 위해 코드를 고치지 않았다.
