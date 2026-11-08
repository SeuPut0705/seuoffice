# font-metrics

## 맡은 범위

PC에 설치된 글꼴 파일에서 수치를 읽는다. 세로 메트릭(`familyVerticalMetrics`), 글자별 전진 폭(`advanceWidths`), 글꼴 찾기(`findSystemFont`, `findFontCovering`, `isFamilyInstalled`)가 전부다. Docs 메인 프로세스가 `docs:font-metrics` IPC로 렌더러에 세로 메트릭을 내주고, PDF 앱 메인 프로세스가 텍스트 편집 때 넣을 글꼴을 찾고, `packages/pdf2docx`가 출력 글꼴의 폭을 미리 재는 데 쓴다.

## 맡지 않는 것 (경계)

- 줄바꿈과 줄 높이를 계산하지 않는다. win 메트릭과 typo 메트릭 중 무엇을 쓸지도 정하지 않고 둘 다 돌려준다. 정하는 것은 받는 쪽이다.
- 커닝(kern/GPOS)과 셰이핑(아랍 문자 연결 등)을 다루지 않는다. 전진 폭은 커닝 없는 줄 폭의 상한으로만 쓴다.
- 슬라이드 텍스트 측정은 `packages/pptx-render`가 주입받은 글꼴 객체로 따로 한다. 문서에 내장된 글꼴은 각 엔진(`packages/docx-engine`, `packages/pptx-engine`)이 다룬다.

## 항상 지켜야 하는 것

- `node:fs`로 파일을 직접 읽으므로 메인 프로세스나 Node에서만 쓴다. 렌더러 번들에 넣지 않는다. Electron에는 의존하지 않고, 캐시 폴더는 호출자가 `configureMetricsCache(dir)`로 넘긴다.
- 패밀리 이름은 정규화(NFKC, 소문자, 공백·`-`·`_` 제거)한 뒤 정확히 같을 때만 맞는 것으로 본다. 비슷한 이름으로 넘어가지 않는다. 못 찾으면 `null`을 돌려주고 호출자가 자기 대체 경로를 탄다. 틀린 글꼴의 수치는 없는 것보다 나쁘다.
- 후보 글꼴 파일을 통째로 읽지 않는다. 필요한 테이블만 읽고 길이 상한을 둔다. head·hhea·OS/2는 512바이트, name과 cmap은 1 MiB(`findFontCovering`의 cmap은 4 MiB), hmtx는 512 KiB다. 통째로 읽는 것은 최종으로 고른 face 하나뿐이다. CJK 글꼴 모음 파일은 100MB를 넘는다.
- 글꼴 파일은 신뢰하지 않는 입력이다. 테이블이 64개를 넘는 face와 face가 64개를 넘는 모음 파일은 건너뛰고, 파일이 스스로 선언한 길이는 읽기 전에 버퍼 길이와 대조한다. `glyphOf`는 try/catch 밖에서 돌기 때문에 범위를 벗어난 읽기가 곧 호출자의 예외가 된다.
- 매핑이 없는 글자의 폭은 추정하지 않고 `NaN`으로 돌려준다. 합계가 `NaN`이면 그 측정을 쓸 수 없다는 뜻이다.

## 이 모듈의 방식

- 첫 호출 때 시스템 글꼴 폴더를 두 단계 깊이까지 훑어 PostScript 이름과 패밀리 이름의 색인을 만들고, 프로세스가 끝날 때까지 다시 훑지 않는다. 실행 중에 설치한 글꼴은 다시 시작하기 전까지 보이지 않는다. Windows에서 보는 곳은 `C:\Windows\Fonts`와 사용자 폴더의 `AppData/Local/Microsoft/Windows/Fonts` 둘이고 경로가 코드에 고정돼 있다.
- 앱이 직접 싣고 다니는 글꼴(디자인 템플릿 글꼴 폴더)은 시스템 폴더에 없으므로 호출자가 `configureExtraFontDirs([dir])`로 폴더를 알려 준다. 그 폴더는 한 단계만, 시스템 폴더 다음에 훑는다. 그 폴더를 보는 것은 세로 메트릭 `familyVerticalMetrics`(워드 편집기)와 글꼴 목록의 패밀리 정보 `familyInfoFor`(워드·엑셀·파워포인트 편집기) 둘뿐이다. `findSystemFont`, `findFontCovering`, `isFamilyInstalled`, `advanceWidths`는 언제나 시스템 폴더만 본다. shell 안에서는 여러 편집기가 한 프로세스를 나눠 쓰므로, 이렇게 나누지 않으면 PDF 편집기까지 템플릿 글꼴을 찾게 된다. 부르면 색인과 패밀리 정보 스캔, 못 찾은 패밀리 기억이 처음부터 다시 만들어진다. 부르지 않으면 예전처럼 시스템 폴더만 본다. Docs 메인 프로세스가 `templateFontsDir`로 부른다.
- 세로 메트릭은 `font-vertical-metrics.json`에 글꼴 경로·수정 시각·크기와 함께 남긴다. 파싱 결과가 `null`인 것(테이블이 없는 글꼴)은 저장하지만, 읽다가 난 예외는 저장하지 않고 다음 호출에서 다시 시도한다. Windows의 글꼴 파일 잠금처럼 일시적일 수 있기 때문이다. 설치되지 않은 패밀리는 프로세스 안에서만 기억한다.
- 스타일은 토큰 점수(`styleScore`)로 고른다. `demibold`를 `bold`보다 먼저 떼고, `oblique`는 `italic`으로 접고, 원하는 토큰이 없으면 Regular 계열을 앞세운다. 부분 문자열 비교로 바꾸면 Semibold가 Bold 요청에 같이 걸린다.
- `findFontCovering`은 색상 이모지 글꼴(`sbix`, `COLR`, `CBDT`, `CBLC` 테이블)을 뺀다. 화면에는 보이지만 PDF 텍스트 개체로 내장할 수 없다.

## 테스트

- `npm run test -w @genoffice/font-metrics`, 또는 패키지 폴더에서 `npx vitest run`.
- 실제 설치 글꼴을 쓰는 단언은 macOS에 Helvetica가 있을 때만 실행되고, 그 밖의 환경에서는 일찍 반환한다. Windows에서 통과했다고 실제 글꼴 경로가 검증된 것은 아니다.
- 어느 플랫폼에서나 도는 것은 합성 글꼴 테스트다. 임시 폴더에 최소 sfnt 파일을 쓰고 `getFontIndex().byFamily`에 직접 꽂아 넣는다. 파서의 경계 검사를 바꾸면 이 방식으로 잘린 테이블 사례를 추가한다.
- Windows에서 원본 코드 그대로도 실패하는 테스트는 없다.
