# 업데이트 상세 내역 표시 계획

상태: **구현됨**(2026-10-19, 실제 릴리스 확인 남음). "정한 것"은 결정 기록 [0044](../tracking/decisions/0044-update-notes-in-the-window.md)에 옮겼다. 단계별 세부는 구현하면서 이 문서를 고친다.

## 1. 무엇을 하려는가

업데이트 창은 지금 "새 버전이 있습니다"와 버전 번호만 보여 준다. 무엇이 바뀌었는지는 앱 밖 GitHub 릴리스 페이지에 가야 안다. 이 계획은 **업데이트를 시작하기 전에 바뀐 점을 앱 안에서 읽게** 한다.

데이터는 새로 만들지 않는다. `electron-updater`가 업데이트를 확인할 때 릴리스 본문을 이미 받아 온다. 앱이 그 값을 쓰지 않을 뿐이다. 새 네트워크 요청도, 새 서버도 없다.

**정한 것**

1. 건너뛴 버전의 본문도 함께 보여 준다(`autoUpdater.fullChangelog = true`).
2. 내용이 있으면 일반 문구("이 업데이트에는 성능 개선과 버그 수정이 포함되어 있습니다…")는 숨긴다.
3. 창 크기는 읽기 좋은 쪽으로 정한다(5절).
4. 릴리스 본문을 쓰는 절차에 윤문 단계를 넣는다(7절).

## 2. 확인한 것 (2026-10-19)

- 업데이트 확인은 `releases.atom` → `releases/latest` → `latest.yml` 순서로 요청한다. **첫 요청의 응답에 릴리스 본문이 HTML로 들어 있다.** 실제 v0.12.1 본문으로 확인했다: `<p>`, `<h2>설치</h2>`, `<ul>`, `<ol>`, `<strong>`, `<code>`, `<a href>`.
- `fullChangelog = true`면 같은 응답 하나로 "지금 쓰는 버전 이후"의 본문 전부를 받는다. 새 버전부터 역순의 `{version, note}` 목록이다. 꺼져 있으면 최신 버전 하나만 온다.
- 본문이 없는 릴리스는 `"No content."`가 온다. 빈 본문은 걸러 낸다.
- 피드에 실리는 릴리스 수에는 상한이 있다(약 10개). 여러 버전을 건너뛴 사용자는 있는 것까지만 본다.
- `parse5`는 이미 워크스페이스에 있다(뒷단 코드가 쓴다). 셸 의존성에 한 줄 보태면 된다.

## 3. 데이터 흐름

```
GitHub Releases (releases.atom — 기존 확인 요청에 이미 들어 있음)
        │  info.releaseNotes: string | [{version, note}] | null
        ▼
updater.ts ── normalizeReleaseNotes() ──▶ UpdateUiState.releaseNotes
        │        update-notes.ts: HTML → 블록, 상한 적용 (순수 함수)
        ▼
update-window.ts (창 크기 결정) ──▶ update.html / update.ts (블록을 그림)
```

`apps/shell/src/shared/update-api.ts`에 더할 타입:

```ts
interface UpdateNoteRun {
  text: string
  strong?: boolean
  code?: boolean
}
type UpdateNoteBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: UpdateNoteRun[] }
  | { kind: 'paragraph'; runs: UpdateNoteRun[] }
  | { kind: 'list'; ordered: boolean; items: UpdateNoteRun[][] }
interface UpdateNoteSection {
  version: string | null
  blocks: UpdateNoteBlock[]
}
interface UpdateReleaseNotes {
  sections: UpdateNoteSection[]
  truncated: boolean
}
// UpdateUiState에 추가: releaseNotes: UpdateReleaseNotes | null
```

변환은 `apps/shell/src/main/update-notes.ts`가 맡는다. Electron을 가져오지 않는 순수 모듈이라 node 환경에서 테스트한다(`settings-ai.ts`와 같은 방식).

## 4. 변환 규칙

| GitHub 본문(HTML)         | 블록                                       |
| ------------------------- | ------------------------------------------ |
| `h1`~`h3`                 | heading                                    |
| `p`, `blockquote`         | paragraph                                  |
| `ul` / `ol` + `li`        | list (중첩 목록은 부모 항목 글자에 평탄화) |
| `br`                      | 문단 안 줄바꿈                             |
| `strong`                  | run의 굵게 표시                            |
| `code`, `pre`             | run의 고정폭 표시(여러 줄 허용)            |
| `a`                       | 글자만 남김(href 버림)                     |
| `em`, 그 밖의 모르는 태그 | 글자는 남김                                |
| `script`, `style`, `img`  | 버림                                       |

- 상한: 원문 256KB, 결과 48,000자, 섹션 12개. 넘으면 `truncated: true`.
- 빈 본문, `"No content."`, `null`은 `releaseNotes: null`. 창은 지금과 같아진다.
- 문자열(현재)과 배열(4절 1번을 켠 뒤) 둘 다 처리한다.

## 5. 화면 설계

### 크기와 가독성

| 상태      | 창               | 내용                                     |
| --------- | ---------------- | ---------------------------------------- |
| 내용 없음 | 400×430 (그대로) | 지금과 같다                              |
| 내용 있음 | 400×600 (목표)   | 히어로와 버튼은 그대로, 사이에 내용 상자 |

- 600의 근거: 상자 200px이면 13px 글자로 아홉 줄 남짓이 한눈에 들어온다. "새로 들어간 것"의 첫 목록을 스크롤 없이 읽히는 높이다. 768px 화면에도 여유가 남는다. 구현 때 재어 보고 ±20px 안에서 고친다.
- 너비는 400 그대로. 내용 폭 344px에 13px 글자는 한 줄이 26자 남짓이라 한글 읽기에 무리가 없다. 키우면 진행률·버튼까지 달라 보여서 그대로 둔다.
- 상자: 최대 200px, 길면 스크롤. 글자 왼쪽 정렬, 13px, 줄 간격 1.7, 선택 가능. 짧은 본문은 상자가 내용만큼 줄어든다.
- 스크롤 상자는 드래그 영역에서 뺀다(`-webkit-app-region: no-drag`). `role="region"`, `aria-label`, `dir="auto"`(본문이 오른쪽→왼쪽 언어로 쓰였을 때 대비).
- 버전이 여럿이면 섹션마다 `v0.12.0` 머리글. 하나면 생략한다(히어로의 버전 칩과 겹침).
- 일반 문구(desc)는 내용이 없을 때만 쓴다. 실패·수동 안내 문구는 내용이 있어도 그대로 보여 준다.

### 상태별 표시

| phase       | 일반 문구       | 진행률 | 내용 상자 | 바닥 링크              |
| ----------- | --------------- | ------ | --------- | ---------------------- |
| available   | 내용 없을 때만  | –      | 표시      | 표시                   |
| downloading | 내용 없을 때만  | 표시   | 표시      | 표시                   |
| downloaded  | 내용 없을 때만  | –      | 표시      | 표시                   |
| error       | 실패 문구(항상) | –      | 표시      | 표시                   |
| manual      | 수동 안내(항상) | –      | 표시      | 숨김(버튼과 같은 대상) |

### 조립

- 원격 글은 **HTML로 화면에 들어가지 않는다.** 블록을 `createElement`/`textContent`로만 조립한다. `innerHTML`을 쓰지 않는다.
- 굵게·고정폭만 살리고, 링크 주소·그림·스크립트·스타일은 버린다.
- 바닥 링크 "GitHub에서 전체 보기"는 기존 `onOpenDownload`(저장소 상수 URL)를 그대로 쓴다.
- 색은 update.html의 기존 관례대로 `:root`의 변수 정의 줄로만 넣는다(`check:theme-colors`).

## 6. 문구 (21개 언어 추가 — `tUpd` 표에 3키)

| 키                  | ko                   | en                               |
| ------------------- | -------------------- | -------------------------------- |
| `updNotesLabel`     | 업데이트 내용        | What's new                       |
| `updNotesOnGitHub`  | GitHub에서 전체 보기 | View full notes on GitHub        |
| `updNotesTruncated` | 일부만 표시했습니다. | Only part of the notes is shown. |

한국어·영어는 직접 쓰고, 나머지 19개는 기존 방식대로 번역으로 채운다. "일부만 표시했습니다"는 상자 안 마지막 줄에 둔다.

## 7. 릴리스 본문 쓰는 규약

본문이 이제 앱에도 나온다. `docs/releasing.ko.md`의 6번 3번 항목을 이렇게 바꾼다.

> 3. **제목**: 알아보기 쉬운 이름(예: `v0.11.1`). **설명**: 바뀐 점. 설명은 웹 페이지와 **앱의 업데이트 창** 모두에 그대로 나옵니다(앱은 본문을 번역하지 않습니다). 본문은 이렇게 씁니다.
>    1. **첫 문단** — 한두 줄 요약. 창에서 가장 먼저 보입니다.
>    2. `## 새로 들어간 것`, `## 고친 것` — 목록.
>    3. `## 설치` 같은 수동 설치 안내 — 본문 맨 아래. 앱에서는 스크롤을 내려야 보입니다.
>
> 본문 초안을 다 쓴 뒤 **humanize-korean 스킬로 윤문**합니다. 이 글은 사용자가 앱에서 그대로 읽는 글이므로, AI 티와 번역투를 걷어내고 사람이 쓴 문장으로 다듬습니다.

7번 끝에 한 줄 보탠다: "새 버전이 있으면 업데이트 창에 바뀐 점이 나옵니다. 길면 스크롤하고, 'GitHub에서 전체 보기'로 릴리스 페이지를 열 수 있습니다."

지금 v0.12.1 본문은 "설치"가 위에 있지만 첫 문단이 요약이고 나머지 구조도 좋아서 그대로도 무리 없이 나온다. 다음 릴리스부터 설치 안내만 아래로 내린다.

## 8. 절대 지킬 선 (보안·개인정보)

1. 원격 글은 HTML로 화면에 들어가지 않는다. 조립은 `createElement`/`textContent`만.
2. 그림·스크립트·스타일·링크 주소는 버린다. **클릭 가능한 링크 없음** — 바닥의 "GitHub에서 전체 보기"만.
3. 새 네트워크 요청 없음(기존 피드 요청에 얹힘), 새 IPC 없음, 새 외부 열기 경로 없음.
4. 본문은 어디에도 저장·전송되지 않는다(창 상태에만 살고 끝). `PRIVACY.md`는 그대로다.
5. 상한 3종(원문·결과·섹션)으로 창 상태의 크기를 제한한다.

## 9. 버린 대안

| 대안                            | 버린 이유                                                     |
| ------------------------------- | ------------------------------------------------------------- |
| GitHub API로 Markdown 원문 받기 | 새 네트워크 경로 + 익명 호출 제한(시간당 60회)                |
| renderer에서 DOMParser          | 원격 HTML을 렌더러로 넘기게 됨, node 환경 테스트 불가         |
| 본문에서 "설치" 섹션 잘라내기   | 제목 규약에 의존 — 릴리스마다 흔들림. 문서 규약으로 푼다(7절) |
| 접었다 펴는 토글                | 기본 표시보다 발견성이 낮음                                   |
| 본문을 plain text 한 덩어리로   | 굵게·목록이 뭉개져 읽기 나쁨. 구조를 살리는 비용이 작음       |

## 10. 구현 목록

| 파일                                                                | 일                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/shell/src/main/update-notes.ts`                               | **신규** — HTML → 블록 변환 + 상한                                          |
| `apps/shell/src/shared/update-api.ts`                               | 블록 타입, `releaseNotes` 필드, 문구 3키                                    |
| `apps/shell/src/main/updater.ts`                                    | `fullChangelog = true`, `info.releaseNotes` 수집, 가짜 업데이트에 예시 본문 |
| `apps/shell/src/main/update-window.ts`                              | 내용 유무로 창 높이 결정                                                    |
| `apps/shell/src/renderer/update.html`, `src/renderer/src/update.ts` | 레이아웃·CSS·블록 렌더                                                      |
| `apps/shell/package.json`(+lock)                                    | `parse5` 의존성                                                             |
| `apps/shell/tests/update-notes.test.ts`                             | **신규** — 실물 v0.12.1 본문 픽스처 포함                                    |
| `apps/shell/tests/updater.test.ts`                                  | FakeGitHub에 본문 주입, 상태까지 오는지, `fullChangelog` 확인               |
| `apps/shell/tests/update-window.test.ts`                            | 상태 픽스처에 새 필드 반영                                                  |
| `docs/releasing.ko.md`                                              | 7절의 규약 반영                                                             |
| `apps/shell/AGENTS.md`                                              | `update-notes.ts`와 규칙 한 줄, 구조 그림에 이 문서 추가                    |

## 11. 테스트와 확인

- `update-notes.test.ts`: v0.12.1 본문 픽스처(문단·목록·굵게·고정폭·링크), 엔티티 복원(`&quot;`), `script`/`style` 제거, 모르는 태그의 글자 보존, 빈 입력·`"No content."`·`null`, 배열 입력(버전 머리글 순서), 상한 3종, `img` 제거.
- `updater.test.ts`: `fullChangelog = true`가 설정되는지, `info.releaseNotes`가 정규화되어 상태에 실리는지(문자열·배열·없음), GitHub provider 실코드 경로(FakeGitHub 본문 주입)까지.
- `update-window.test.ts`: 창 높이 규칙(내용 유무)과 픽스처 갱신.
- 개발 확인: `GENOFFICE_FAKE_UPDATE=9.9.9`로 띄워 레이아웃과 스크롤을 본다.
- 실물 확인: `releasing.ko.md` 8번(베타 프리릴리스) 절차로 업데이트 창을 한 번 끝까지 본다.
- 검사: `npm run test -w @genoffice/shell`, `typecheck`, `check:theme-colors`, `check:english-comments`, `licenses`.
