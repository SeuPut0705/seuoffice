# seuoffice 작업 규칙

seuoffice는 웹과 PC(Windows)에서 문서를 보고 고치고 AI로 편집하는 오피스다. 이음오피스(IeumOffice, Apache-2.0, GenOffice의 한국어 포크)를 통째로 포크해 웹에서도 돌게 개조한다. 스풋(GitHub SeuPut0705)의 개인 자산이고, 저장소 전체를 Apache-2.0으로 공개한다(결정 0007).

## 먼저 읽을 것

- `docs/seuoffice/로드맵.md`: 단계와 지금 위치
- `docs/seuoffice/decisions/index.md`: seuoffice 결정 기록
- `docs/seuoffice/upstream-edits.md`: 상위(이음오피스) 파일을 고친 목록
- `docs/seuoffice/web-gaps.md`: 웹에서 데스크톱과 다르게 동작하는 브리지 메서드
- `docs/seuoffice/baseline.md`: 들여올 때 이미 실패하던 검사
- 고치려는 모듈의 `apps/*/AGENTS.md`, `packages/*/AGENTS.md`, 그리고 `docs/standards.md`, `docs/engineering-notes.md`. 이음오피스 규칙이며 이 파일과 부딪히지 않는 한 그대로 따른다.

## 경계

1. 유유헬스케어 저장소(`yuyuhealthcare/yuyu-mos`)의 코드·설정·데이터를 이 저장소에 넣지 않는다. 유유 실데이터와 고객 원본 문서도 넣지 않는다. 시험 자료는 모의 문서나 출처와 권리가 확인된 문서만 쓴다.
2. GenOffice `ee/`(GenOffice Enterprise License)는 가져오지 않는다. 추적 파일에 `ee/`가 생기면 `seuoffice` CI가 실패한다.
3. 저장소 공개 전환, `main` force-push·이력 재작성, 저장소 삭제는 스풋 확인 뒤에만 한다.
4. 비밀값(API 키, 서명 인증서, 토큰)을 커밋하지 않는다.

## 상위 따라가기

- 원격 `ieum` = https://github.com/pblsketch/ieumoffice (바탕, merge로 따라감), 원격 `genoffice` = GenOffice 원본(보통 이음을 거쳐 받는다).
- 내부 이름(`@genoffice/*` 패키지, `GENOFFICE_*` 환경 변수, `genoffice` 명령, `~/.genoffice`)은 바꾸지 않는다(결정 0002). 사용자에게 보이는 이름과 새로 만드는 부품만 seuoffice / `@seuoffice/*`로 한다.
- 새 코드는 새 파일에 둔다: `packages/web-platform/`, `packages/embed/`, `packages/collab/`, `apps/web/`, `apps/*/vite.web.config.ts`, `apps/*/src/web/`, `apps/sheets/native/xlsx-wasm/`, `formal/`, `docs/seuoffice/`, `.github/workflows/seuoffice.yml`.
- 상위 파일을 고쳐야 하면 가장 작게 고치고, 같은 커밋에서 `docs/seuoffice/upstream-edits.md`에 파일·까닭을 한 줄 적는다. Rust 엔진은 `#[cfg(target_os = "wasi")]` 분기로만 고치고 데스크톱 동작은 바꾸지 않는다.
- 이음 따라잡기: `git fetch ieum` → 가지 `sync/ieum-YYYYMMDD`에서 `git merge ieum/main` → 충돌 처리 → 아래 "합치기 전 검사" → `main`에 `--no-ff`로 합친다.
  - 루트 `AGENTS.md`·`CLAUDE.md`·`README.md`는 우리 것을 두고, 상위 규칙 변경 중 해당되는 것만 옮긴다.
  - `package-lock.json`은 상위 것을 받은 뒤 `npm install`로 다시 만든다.
  - 나머지는 `upstream-edits.md` 목록과 대조해 우리 편집을 다시 적용한다.

## 커밋

- 영어 Conventional Commits: `type(scope): summary`. type은 feat, fix, test, docs, chore, refactor, perf, ci, build. scope는 앱·패키지 이름(`docs`, `sheets`, `slides`, `pdf`, `hwp`, `web`, `embed`, `web-platform`).
- 한 커밋에 한 가지 변경. 커밋마다 빌드와 타입검사가 통과해야 한다.
- 결함 수정은 재현 시험을 먼저 쓰고, 고치기 전에 그 시험이 실패하는 것을 확인한다.
- 작은 변경은 `main`에 바로 올린다. 여러 커밋짜리 일은 `feat/*`·`fix/*` 가지에서 하고 `--no-ff`로 합친다. `git stash`는 쓰지 않는다(작업 트리 여럿이 하나를 공유한다).
- 푸시한 뒤 CI(`CI`, `seuoffice`)가 통과하는 것까지가 한 단위다.
- 판은 모아서 낸다(결정 0027). main 푸시로는 판이 나오지 않는다. 판을 시작하는 것은 메인 세션이고, 다른 세션은 판을 내거나 안정 판으로 올리지 않는다. 절차는 `docs/seuoffice/판-내기.md`.

## 시험

- 상위 모듈 시험은 작업 공간별로 돌린다: `npm run test -w @genoffice/<이름>`. 전부는 `npm run test:parallel`.
- 웹 층: `npm run build -w @seuoffice/web` 뒤 `npm run test -w @seuoffice/web`(Playwright, 다섯 형식을 웹에서 열어 화면을 확인). 웹 층이나 웹 층이 import하는 상위 코드를 고치면 반드시 돌린다.
- xlsx 엔진(`apps/sheets/native/*`)을 고치면 `npm run native:test -w @genoffice/sheets`와 웹 시험을 둘 다 돌린다.
- 합치기 전 검사: `npm run check:english-comments`, `npm run format:check`, `npm run lint`, `npm run typecheck`, 고친 작업 공간 시험, 웹 층을 건드렸으면 웹 시험.
- `docs/seuoffice/baseline.md`에 없는 실패는 고친 사람이 해결한다. 원래 실패인지는 손대지 않은 상위 커밋에서 같은 시험을 돌려 확인한다.
- 시험은 동작(경계, 오류, 형식 왕복, 상태 전이)을 확인한다. 문구·배선·구현을 베끼는 시험은 쓰지 않는다.

## 문서

- `docs/seuoffice/`와 이 파일은 한국어로 쓴다. 코드 주석은 영어로 쓴다. `check:english-comments`가 문서와 주석의 한자를 막으니 한자를 쓰지 않는다.
- 결정은 `docs/seuoffice/decisions/NNNN-제목.md`(맥락, 결정, 버린 대안, 결과)로 남기고 `index.md`에 한 줄 더한다. 이음오피스의 기록은 `docs/archive/ieum/`에 닫아 두었고 고치지 않는다.
- 단계 일을 끝내면 같은 커밋에서 `docs/seuoffice/로드맵.md` 상태를 고친다. 웹 브리지가 데스크톱과 다르게 동작하는 메서드를 만들면 `web-gaps.md`에 적는다.
- 이 파일을 고치면 `CLAUDE.md`도 같은 내용으로 고친다.
