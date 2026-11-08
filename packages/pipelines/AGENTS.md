# pipelines

## 맡은 범위

AI가 슬라이드를 만들 때 거치는 결정적 단계들을 모아 둔다. 페이지 스펙(JSON)의 검증과 pptx 빌드(`parsePageSpec`, `buildPagePptx`), 여러 페이지 합치기(`parseDeckSpec`, `buildDeckPptx`), 개요 검증(`parseOutline`), 개요·스타일 시트와의 교차 점검(`stage-check.ts`), 기하 점검(`layout-audit.ts`, `auditDeck`), 에이전트용 안내문(`SLIDES_GUIDES`), 내장 디자인 템플릿 12개(`slides/templates/`)와 그 검사기(`slides/template-check.ts`)다. Slides 앱의 메인·렌더러와 명령줄 도구(`packages/cli`)가 같은 구현을 쓴다. 지금 들어 있는 것은 슬라이드용뿐이다.

## 맡지 않는 것 (경계)

- 모델을 부르지 않는다. 프롬프트 조립과 스트리밍도 하지 않는다. 입력은 이미 받아 온 모델 출력 문자열이다. 그 일은 `packages/agent-core`, `packages/ai-provider`와 `apps/slides`의 AI 코드가 한다.
- 네트워크, 이미지 디코딩, 글꼴 메트릭을 직접 다루지 않고 `BuildPageDeps`(`fetchImage`, `imageDims`, `fontMetrics`)로 주입받는다.
- pptx 읽기와 쓰기는 `packages/pptx-engine`, 레이아웃 계산은 `packages/pptx-render`가 한다. 이미 있는 덱을 고치는 op는 `packages/pptx-ops`다.
- 도구 등록과 IPC는 `apps/slides`다.

## 항상 지켜야 하는 것

- 모델 출력은 신뢰하지 않는 입력이다. `JSON.parse` 전에 길이를 본다. 덱 스펙은 2,000,000자(로컬 이미지를 허용하는 호출은 64,000,000자), 개요는 512,000자다. 그 밖의 상한은 페이지 60장, 페이지당 요소 48개·이미지 8개, 런 하나의 글자 4,000자, 페이지당 이미지 검색어 8개다.
- 스펙의 잘못된 요소는 페이지를 실패시키지 않고 버리면서 경고로 알린다. 남는 요소가 하나도 없을 때만 오류를 돌려준다. 오류와 경고 문구는 모델에 되돌려 고치게 하는 데 쓰이므로, 무엇이 왜 버려졌는지 요소 번호와 함께 적는다.
- 이미지 주소는 기본적으로 http(s)만 받는다. 로컬 경로와 `data:` URL은 `localImages`를 켠 호출자(명령줄 도구)에서만 허용한다. 앱 경로에서는 이 옵션을 켜지 않는다.
- 스펙 값은 유효한 OOXML이 되는 범위로 좁힌다. 모르는 도형 이름은 `rect`로 바꾸고, 색은 `#RGB`, `#RRGGBB`, `#RRGGBBAA`만 통과시키고, 글자 크기는 6pt 이상 160pt 이하, 선 두께는 0.25pt 이상 24pt 이하로 자른다.
- `layout-audit.ts`는 `@genoffice/pptx-render`에서 타입만 import한다. 렌더러가 `@genoffice/pipelines/slides/layout-audit` 하위 경로로 이 파일만 가져가기 때문이다. `slides` 진입점은 Node 전용인 `pptx-engine`을 끌고 오므로 렌더러에서 import하지 않는다.
- Electron을 import하지 않는다.
- 디자인 템플릿 폴더(`slides/templates/`, 하위 경로 `@genoffice/pipelines/slides/templates`)는 렌더러가 가져가는 곳이다. 자료와 찾기 함수(`listSlideTemplates`, `findSlideTemplate`)만 두고, 실행 시점에 다른 패키지나 폴더 밖 파일을 불러오지 않는다. 형은 `import type`으로만 가져온다. `tests/slide-templates.test.ts`가 import 그래프를 따라가고, `pptx-engine`·`pptx-render`를 막은 채 불러 본다.
- 템플릿 검사기 `validateSlideTemplate`(`slides/template-check.ts`)는 `pptx-engine`으로 견본 표지를 빌드하므로 Node 전용 `slides` 진입점에서만 내보낸다. 모델도 네트워크도 부르지 않는다.
- 새 템플릿은 검사기의 문제가 0건이어야 한다. id는 `^[a-z0-9-]+$`이고 겹치지 않는다. 이름은 원본의 영어 이름 그대로다. 설명과 스타일 글은 영어이고, 스타일 글은 2,400자 이하다. 색은 모두 `#RRGGBB`로 적고 `palette`에 있어야 한다. 글꼴은 앱에 든 10개(`SLIDE_TEMPLATE_FONTS`)만 쓴다. 페이지 스펙이 그리지 못하는 효과(gradient, glow, blur, texture, shadow, rotate, animation)는 스타일 글에 적지 않는다. 견본 표지는 한국어·영어 두 장이고 구성이 같다. 그림 요소가 없고, 페이지 스펙 검증과 기하 점검을 통과하고, 글자색에 투명도가 없다. 한국어 표지에는 한글이, 영어 표지에는 한글이 없어야 하고, 템플릿 이름이나 견본 문구를 보이지 않는다. `source`는 원본 저장소, 40자 커밋, 템플릿 폴더다.
- 보이는 순서는 `slides/templates/catalog.ts`의 배열 순서다. 템플릿을 더하면 import 하나와 배열 항목 하나를 넣고, `tests/slide-templates.test.ts`의 목록과 저장소 루트의 `NOTICE`(출처, 글꼴)를 함께 고친다. 새 글꼴이 필요하면 `packages/ui/template-fonts`에 먼저 넣는다(`apps/slides/tests/template-fonts-catalog.test.ts`가 앱에 든 글꼴만 쓰는지 본다).

## 이 모듈의 방식

- 스펙 좌표는 1280×720 px 캔버스 기준이고 배열 순서가 곧 z 순서다. 배경색은 전체를 덮는 사각형으로 넣고, `promoteSlideBackground`가 그것을 슬라이드 배경으로 올린다.
- 텍스트 상자의 안쪽 여백은 0으로 쓴다. PowerPoint의 기본 여백을 두면 스펙이 정한 자리에서 글자가 밀린다.
- 빌드한 뒤 저장한 바이트를 다시 열어 실제 레이아웃 엔진으로 재고, 내용보다 낮은 텍스트 상자만 키운다. 줄이지 않고, 도형 안 글자 상자는 손대지 않는다. 가운데·아래 맞춤 상자는 글자가 제자리에 남도록 위로 옮긴다. 모델이 글자 수 어림으로 상자 크기를 잡아 큰 CJK 제목이 자주 넘치기 때문에 있는 단계다. `fontMetrics`가 없으면 건너뛴다.
- 이미지는 왜곡 없이 가운데를 기준으로 잘라 넣는다(`coverCropFractions`). 종횡비 차가 1% 미만이면 자르지 않고, 보이는 면적이 절반 미만이면 경고를 남긴다. 내려받지 못한 이미지는 빌드를 실패시키지 않고 `imageFailures`에 모은다.
- 덱은 페이지마다 한 장짜리 pptx를 만든 뒤 `mergeSlideFromPptx`로 순서대로 합친다. 앱이 생성된 페이지를 덱에 넣는 방식과 같다.
- 기하 점검은 모델도 화면 캡처도 쓰지 않는다. 캔버스 밖으로 나감, 내용 요소끼리 겹침, 글자 넘침, 그림 찌그러짐을 계산으로만 찾고, 한 페이지에 최대 12건을 낸다. 결과 문구는 도구 반환값 끝에 붙어 모델이 읽는다. `auditDeck`이 내는 id는 op가 받는 영속 id(`e_*`, `s_*`)다. 메트릭 없이 돌리면 넘침 수치는 근사값이다.
- 안내문(`slides/guides/*.md`)은 `?raw`로 번들에 들어간다. Vite가 아닌 번들러에는 같은 로더가 필요하다.

## 테스트

- `npm run test -w @genoffice/pipelines`, 또는 패키지 폴더에서 `npx vitest run`. 픽스처 파일은 없고, 테스트가 스펙 객체와 렌더 노드를 코드로 만든다.
- vitest 별칭이 `pptx-engine`과 `pptx-render`를 소스 경로로 묶는다. 두 패키지의 새 하위 경로를 import하면 `vitest.config.ts`에 별칭을 추가하고, 더 구체적인 경로를 앞에 둔다.
- 한도나 버림 규칙을 바꾸면 경계값 사례를, 점검 규칙을 바꾸면 걸리는 사례와 통과하는 사례를 함께 넣는다.
- Windows에서 원본 코드 그대로도 실패하는 테스트는 없다.
