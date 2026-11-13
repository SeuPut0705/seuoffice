# seuoffice 작업 규칙

seuoffice는 웹과 PC(Windows, Mac)에서 문서를 보고 고치고 AI로 편집하는 오피스다. 이음오피스(IeumOffice, Apache-2.0, GenOffice의 한국어 포크)에서 갈라져 나왔고, 2026-11-12부터 상위를 따라가지 않는 독립 프로젝트다(결정 0024). 엔진을 Rust로 옮기는 중이다(결정 0025, 0026). 스풋(GitHub SeuPut0705)의 개인 자산이고, 저장소 전체를 공개한다(결정 0007). <FSL_FIRST_VERSION>부터 라이선스는 FSL-1.1-ALv2(`LICENSE`)이고, 그 전 판과 GenOffice·이음오피스에서 온 부분은 Apache-2.0(`LICENSE-APACHE`)이다(결정 0031, 초안).

## 먼저 읽을 것

- `docs/seuoffice/로드맵.md`: 단계와 지금 위치
- `docs/seuoffice/decisions/index.md`: seuoffice 결정 기록
- `docs/seuoffice/web-gaps.md`: 웹에서 데스크톱과 다르게 동작하는 브리지 메서드
- `docs/seuoffice/baseline.md`: 들여올 때 이미 실패하던 검사
- `docs/archive/`: 이음오피스 시절의 기록. 남은 TypeScript 코드가 왜 그렇게 생겼는지 볼 때 읽는다. 고치지 않는다.
- 고치려는 모듈의 `apps/*/AGENTS.md`, `packages/*/AGENTS.md`, 그리고 `docs/standards.md`, `docs/engineering-notes.md`. 이음오피스 규칙이며 이 파일과 부딪히지 않는 한 그대로 따른다.

## 경계

1. 유유헬스케어 저장소(`yuyuhealthcare/yuyu-mos`)의 코드·설정·데이터를 이 저장소에 넣지 않는다. 유유 실데이터와 고객 원본 문서도 넣지 않는다. 시험 자료는 모의 문서나 출처와 권리가 확인된 문서만 쓴다.
2. GenOffice `ee/`(GenOffice Enterprise License)는 가져오지 않는다. 추적 파일에 `ee/`가 생기면 `seuoffice` CI가 실패한다.
3. 저장소 공개 전환, `main` force-push·이력 재작성, 저장소 삭제는 스풋 확인 뒤에만 한다.
4. 비밀값(API 키, 서명 인증서, 토큰)을 커밋하지 않는다.
5. 라이선스 고지를 지우거나 고쳐 쓰지 않는다: `LICENSE`, `NOTICE`, 제3자 고지, `vendor/`와 내장 스킬 폴더의 라이선스 파일, `docs/seuoffice/upstream-edits.md`(`NOTICE`가 가리키는 변경 고지, 2026-11-12에 닫음). 원본 코드를 Rust로 옮겨 적은 것도 파생물이라 고지는 그대로 둔다(결정 0024). 새 제3자 코드나 자료를 들이면 `NOTICE`에 출처와 라이선스를 더한다.

## 원본과의 관계

- 이음오피스와 GenOffice를 따라가지 않는다(결정 0024). 원격 `ieum`, `genoffice`는 지웠고, 상위에서 코드를 받아오지 않는다. 이전에 받은 파일도 우리 파일이라 필요한 만큼 고친다.
- `docs/seuoffice/upstream-edits.md`에는 더 적지 않는다.
- 내부 이름은 `@seuoffice/*` 패키지, `SEUOFFICE_*` 환경 변수, `seuoffice` 명령, `~/.seuoffice`다(결정 0024). 사용자 컴퓨터에 이미 있는 옛 이름(`~/.ieumoffice`, `GENOFFICE_*` 환경 변수, `ieumoffice` 명령, 저장 문서의 옛 XML 네임스페이스와 표지)은 계속 읽는다. 그 호환 코드는 `old-names*` 파일에 모여 있고, 지우려면 결정으로 남긴다. 다른 가지에서 main을 받은 뒤에는 `node tools/rename-internal/codemod.mjs --apply && npm install && npm run format`으로 이름을 맞춘다. 설치된 앱의 정체(앱 이름, userData 폴더, 키체인 항목, ProgId, 업데이트 피드)는 결정 0013·0019 그대로다.
- 엑셀 엔진(`apps/sheets/native/*`)의 웹 분기는 `#[cfg(target_os = "wasi")]`로만 두고 데스크톱 동작은 바꾸지 않는다.

## 커밋

- 영어 Conventional Commits: `type(scope): summary`. type은 feat, fix, test, docs, chore, refactor, perf, ci, build. scope는 앱·패키지 이름(`docs`, `sheets`, `slides`, `pdf`, `hwp`, `web`, `embed`, `web-platform`).
- 한 커밋에 한 가지 변경. 커밋마다 빌드와 타입검사가 통과해야 한다.
- 결함 수정은 재현 시험을 먼저 쓰고, 고치기 전에 그 시험이 실패하는 것을 확인한다.
- 작은 변경은 `main`에 바로 올린다. 여러 커밋짜리 일은 `feat/*`·`fix/*` 가지에서 하고 `--no-ff`로 합친다. `git stash`는 쓰지 않는다(작업 트리 여럿이 하나를 공유한다).
- 푸시한 뒤 CI(`CI`, `seuoffice`)가 통과하는 것까지가 한 단위다.
- 판은 모아서 낸다(결정 0027). main 푸시로는 판이 나오지 않는다. 판을 시작하는 것은 메인 세션이고, 다른 세션은 판을 내거나 안정 판으로 올리지 않는다. 절차는 `docs/seuoffice/판-내기.md`.

## 시험

- 상위 모듈 시험은 작업 공간별로 돌린다: `npm run test -w @seuoffice/<이름>`. 전부는 `npm run test:parallel`.
- 웹 층: `npm run build -w @seuoffice/web` 뒤 `npm run test -w @seuoffice/web`(Playwright, 다섯 형식을 웹에서 열어 화면을 확인). 웹 층이나 웹 층이 import하는 상위 코드를 고치면 반드시 돌린다.
- xlsx 엔진(`apps/sheets/native/*`)을 고치면 `npm run native:test -w @seuoffice/sheets`와 웹 시험을 둘 다 돌린다.
- 합치기 전 검사: `npm run check:english-comments`, `npm run format:check`, `npm run lint`, `npm run typecheck`, 고친 작업 공간 시험, 웹 층을 건드렸으면 웹 시험.
- `docs/seuoffice/baseline.md`에 없는 실패는 고친 사람이 해결한다. 원래 실패인지는 손대지 않은 상위 커밋에서 같은 시험을 돌려 확인한다.
- 시험은 동작(경계, 오류, 형식 왕복, 상태 전이)을 확인한다. 문구·배선·구현을 베끼는 시험은 쓰지 않는다.

## 문서

- `docs/seuoffice/`와 이 파일은 한국어로 쓴다. 코드 주석은 영어로 쓴다. `check:english-comments`가 문서와 주석의 한자를 막으니 한자를 쓰지 않는다.
- 결정은 `docs/seuoffice/decisions/NNNN-제목.md`(맥락, 결정, 버린 대안, 결과)로 남기고 `index.md`에 한 줄 더한다. 이음오피스의 기록은 `docs/archive/ieum/`에 닫아 두었고 고치지 않는다.
- 단계 일을 끝내면 같은 커밋에서 `docs/seuoffice/로드맵.md` 상태를 고친다. 웹 브리지가 데스크톱과 다르게 동작하는 메서드를 만들면 `web-gaps.md`에 적는다.
- 이 파일을 고치면 `CLAUDE.md`도 같은 내용으로 고친다.
