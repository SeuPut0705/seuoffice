# pptx-engine

## 맡은 범위

pptx 한 파일의 모델과 저장을 맡는다. `openPptx`가 zip 전체를 메모리에 올리고, 레이아웃·마스터·테마의 상속을 풀어 슬라이드마다 요소 트리를 만든다. 요소에는 원본 XML 조각(`ByteAnchor`)이 붙어 있고, 편집 함수가 모델과 변경 표시를 바꾸면 `savePptx`/`savePptxToFile`이 바뀐 요소만 다시 써서 zip을 묶는다. 슬라이드 추가·복제·덱 간 병합, 표·차트·그림·미디어 삽입, 애니메이션, 노트와 메모, 구역, 마스터 편집, 내장 글꼴 풀기, 쓰이지 않게 된 자원 정리, 빈 덱 템플릿이 여기 있다.

## 엔진과 바인딩 (C2)

구현은 Rust(`crates/pptx-engine`)이고, 이 패키지는 WASM(`crates/office-wasm`) 위의 얇은 바인딩이다. 내보낸 이름과 타입은 그대로이고 모델은 JS 객체로 남는다.

- `src/*.ts`의 함수 본문은 `tools/docx-diff/binding/gen.ts --engine pptx`가 만든다. 손으로 고치지 않는다. 손으로 정할 것은 `tools/pptx-diff/binding/overrides.ts`, 인자 종류는 `kinds.ts`에 두고 생성기를 다시 돌린다. 생성기가 손대지 않는 것은 `engine.ts`, `engine-adopt.ts`, `engine-init.ts`, `engine-url.ts`, `src/node/**`다. `engine-type-shapes.ts`(되써지는 모델 값의 모양: 배열의 빈 자리, Map, Set)는 생성기가 쓴다.
- 엔진이 바꾸는 인자(`OpenedPptx`, `PackageArchive`, `Slide`, 요소)는 호출마다 통째로 건너가고, 엔진의 답이 부른 쪽 객체에 제자리로 되써진다(`engine-adopt.ts`). 요소는 `id`, 슬라이드는 `path`로 짝지어 같은 객체가 남는다. 아카이브는 바뀐 파트만 새 배열로 갈아 끼운다.
- 엔진은 시작해야 쓴다. `node` 조건으로 가져오면 저절로 시작하고, 페이지·워커는 `@seuoffice/pptx-engine/init`의 `initPptxEngine(url)`을 한 번 기다린다. vitest 설정은 `setupFiles`에 `packages/engine-wasm/src/node.ts`를 둔다.
- 비교의 기준인 TypeScript 엔진은 `tools/pptx-diff/reference/`에 얼려 두었다. 고치지 않는다.
- TS로 남은 것: `savePptxToFile`(엔진에 파일 시스템이 없다), `ownValue`, `setOwn`, `xmlParser`, `xmlArray`, `sfntCmapLookup`, 데이터 상수, `PackageArchive`의 `has`/`readText`/`readBytes`.

## 맡지 않는 것 (경계)

- 화면에 그리기 위한 계산(EMU→px, 텍스트 줄바꿈, 차트 도형)은 `packages/pptx-render`다. 엔진은 좌표를 EMU 그대로 둔다.
- op 이름, 인자 검증, 원자적 적용과 되돌리기, 모델에 보여 줄 op 문서로 이루어진 편집 계약은 `packages/pptx-ops`다. 엔진 함수는 저수준 변경자다. 대부분 실패를 `false`나 `null`로 알리고 사용자에게 보일 오류 문구를 만들지 않는다.
- Konva 캔버스, 선택과 끌기, 실행 취소 기록, IPC, AI 도구는 `apps/slides`다.
- 스펙에서 새 덱을 만드는 일은 `packages/pipelines`가 엔진 함수를 불러서 한다.
- 압축 폭탄 판정의 구현은 `packages/zip-gate`다.

## 항상 지켜야 하는 것

- 변경 표시가 없는 요소는 `anchor.originalXml`을 그대로 내보낸다. 변경된 슬라이드도 `bodyPrefix` + 요소들(요소 사이의 `gapAfter` 포함) + `bodySuffix`를 이어 붙일 뿐이다. 슬라이드 XML을 파싱했다가 다시 직렬화하지 않는다.
- 변경 없이 저장하면 모든 파트의 내용이 원본과 바이트 동일해야 한다. zip 자체는 매번 새로 묶으므로(XML과 rels는 DEFLATE 6단계, 나머지는 무압축 저장) 파일 전체가 아니라 파트 단위로 비교한다.
- 변경은 종류별 표시로 알린다: `dirty`(텍스트), `dirtyTransform`, `dirtyFill`, `dirtyStroke`, `dirtySrcRect`, `dirtyPPr`, 그리고 슬라이드의 `structureDirty`. 모델 필드만 바꾸고 표시를 세우지 않으면 저장에 반영되지 않는다. 반대로 표시가 선 요소에는 저장할 때 `a16:creationId`가 새겨지므로, 바뀌지 않은 요소에 표시를 세우지 않는다.
- `archive.entries`의 버퍼는 제자리에서 고치지 않고 통째로 갈아 끼운다. 되돌리기 스냅샷이 이 맵을 얕게 복사한다.
- 저장할 때 슬라이드 파트 이름을 바꾸지 않는다. 슬라이드 영속 id(`s_<n>`)가 파트 경로에서 나온다.
- `mc:AlternateContent`에 걸린 요소는 모델을 만든 가지에 패치한다. 위치·채움·선·자르기 패치는 같은 태그의 형제 가지에도 똑같이 적용하고, 텍스트 패치는 형제 가지에 적용하지 않는다. Choice 쪽 본문이 수식 같은 다른 어휘일 수 있다.
- "모델에 숨김" 표시는 실제 글자를 지우지 않는다. 표시는 런의 `a:rPr`(그림은 `nvPr`) 안 `a:extLst` 확장으로 저장하고, 파싱할 때 모델로 읽어 저장할 때 다시 쓴다.
- 문서 안에 남는 식별자는 바꾸지 않는다: 가리기 확장의 `uri`(`REDACT_EXT_URI`), 이 앱이 만든 차트를 알아보는 `descr="aislides-chart"`, 3D 모델 참조 표지 `aislides-3d:`. 가리기 기능의 이름공간 주소는 `@seuoffice/agent-core/redact-range`의 규칙을 따른다: 쓸 때는 `REDACT_NS_WRITTEN`, 읽을 때는 접두사 `go:redact`로 알아보므로 두 주소(`REDACT_NAMESPACES`) 모두 읽힌다.
- 열 때 거부하는 한도는 파트 10,000개, 파트당 512 MiB, 합계 1.5 GiB(`PPTX_ZIP_LIMITS`)다. 파트를 실제로 풀어 보는 검사가 JSZip 로드보다 먼저다.
- 예산을 넘는 입력은 버리지 않고 원본 바이트를 지닌 `passthrough`로 남긴다: 그룹 중첩 64단계, 한 슬라이드의 도형 10,000개. 그 밖의 상한은 차트 점 1,048,576개·계열 256개, chartEx 점 10,000개, 글자 크기 1pt 이상 4000pt 이하, 표 삽입 75×75다. 슬라이드 id는 256 이상 2147483647 이하에서만 낸다.
- 관계 대상은 `resolveTarget`으로만 푼다. 스킴이 붙은 대상과 디코딩할 수 없는 대상은 빈 경로가 된다.
- 자원 정리는 관계를 따라간다. 도형 하나가 그림을 안 쓰게 됐다고 파트를 지우지 않는다. 복제된 슬라이드가 같은 대상을 가리킬 수 있다. 먼저 쓰이지 않는 관계만 끊고, 그 결과 아무 데서도 닿지 않는 파트만 지운다.
- 기본 진입점의 `savePptxToFile`과 `PackageArchive.readText`는 Node에 기대고(`node:fs`, `Buffer`), 웹 앱은 별칭으로 채운다. 렌더러가 가져가는 것은 하위 경로 `./custgeom`, `./table-grid`, `./identity`, `./named-action`, `./background-promote`뿐이다. 이 파일들과 그 import 사슬에 Node 의존을 들이면 브라우저 빌드가 깨진다.
- `@seuoffice/agent-core`에서는 `redact-range` 하위 경로만 import한다. 그 패키지의 기본 진입점은 Electron에 닿는다.
- `src/vendor/`는 가져온 원본과 바이트가 같아야 한다.
- 엔진 동작은 원본(GenOffice)의 수정이 병합될 때만 바뀐다. 파일 이동, 재포맷, 이름 변경을 하지 않는다. 예외는 아래 "원본과 다른 점"에 적은 것뿐이고, 더할 때는 사람이 정한다.
- `replace`/`replaceAll`의 둘째 인자는 `$`가 없는 문자열 리터럴이거나 함수(`() => text`)여야 한다. 변수나 템플릿 문자열을 그대로 넘기면 그 안의 `$&`, `$$`, `$1`, `` $` ``, `$'`가 치환 패턴으로 풀려서, 문서나 사용자가 쓴 글자에 `$`가 있을 때 파트가 깨진다. 시험: `tests/replace-dollar-*.test.ts`.
- 문서에서 온 값(관계 id, 확장자, 요소 id, 파트 이름)은 `RegExp`에 넣지 않고 글자로 비교한다. 관계 id는 만든 쪽이 정한 이름이라 어떤 모양이든 받는다(`rId7`만이 아니다). 시험: `tests/ids-as-text.test.ts`, `tests/relationship-id-*.test.ts`.
- XML의 값은 한 번만 푼다. 푸는 함수는 `decodeXml` 하나다. 파서는 `xmlParser`(`xml-parser.ts`)로만 만들고(`new XMLParser`를 직접 쓰지 않는다), 파서가 준 값은 이미 푼 값이므로 다시 풀지 않는다. 원문 태그에서 정규식으로 읽는 속성은 `attributeOf`로 읽는다(따옴표 종류와 무관하게 읽고, 한 번 푼다). 이렇게 해야 `&amp;`, `&#38;`, `&#x26;`가 같은 값이 되고, `X&amp;#38;1`은 `X&#38;1`로 남는다. 읽은 값을 XML에 다시 쓸 때는 `escapeXmlAttr`/`escapeXmlText`를 한 번 거친다. 시험: `tests/decode-once.test.ts`.
- 남이 만든 파트를 고칠 때 요소 이름의 접두사(`p:`)를 가정하지 않는다. 파트는 같은 이름공간을 기본 이름공간(`xmlns="…"`)이나 다른 접두사로 묶을 수 있으므로, 그 파트가 루트에서 묶은 접두사(`rootPrefixOf`)로 요소를 찾고(`elementRange`, 글자 비교) 같은 접두사로 써 넣는다. 찾을 곳이 없으면 아무것도 쓰기 전에 거절한다(반쯤 쓰지 않는다). 엔진이 새로 만드는 파트는 자기 선언과 함께 `p:`로 쓴다. 시험: `tests/notes-default-namespace.test.ts`.
- 요소를 속성값으로 찾을 때(확장 `a:ext`의 `uri`, 자리표시자의 `type` 등) `uri="…"`처럼 따옴표와 철자를 박은 정규식으로 찾지 않는다. 태그를 이름으로 찾은 뒤 `attributeOf`로 읽어 글자로 비교한다. 읽는 쪽(파서)은 작은따옴표나 `=` 앞뒤 공백도 같은 값으로 읽으므로, 쓰는 쪽이 한 철자만 찾으면 사용자가 지운 표시가 남거나 같은 확장이 둘 써진다. 시험: `tests/redaction-ext-forms.test.ts`.
- 문서에서 온 값(색 이름, 스타일 id, `clrMap`이 가리키는 칸 이름 등)으로 일반 객체 표를 찾을 때는 `ownValue`(`own-value.ts`)를 거친다. `constructor`, `toString`, `__proto__` 같은 이름은 모든 객체가 물려받아서, 그대로 `TABLE[value]`로 찾으면 함수나 `Object.prototype`이 나오고 그 뒤에서 슬라이드 읽기가 터진다. 나쁜 값 하나가 슬라이드를 잃게 해서는 안 되며, 이를 막으려고 통째로 `try`로 감싸지 않는다. 시험: `tests/object-key-values-keep-slide.test.ts`.
- 문서가 정한 이름을 키로 기록할 때(가이드 이름, 글꼴 script, 파트 확장자 등)는 `record[name] = value`나 `Object.assign` 대신 `setOwn`을 쓴다. `__proto__`라는 이름은 대입하면 항목이 생기지 않고 프로토타입이 바뀌어 값이 사라진다. 문서·편집기·AI op에서 온 값으로 엔진 밖(`packages/pptx-ops`)의 표를 찾을 때도 같은 규칙이다(`Object.hasOwn`). 시험: `tests/object-key-values-own.test.ts`, `packages/pptx-ops/tests/op-values-own-keys.test.ts`.
- 파서가 준 노드는 객체라고 가정하지 않는다. 빈 요소나 글자만 든 요소(`<p:grpSpPr/>`, `<p:spPr>text</p:spPr>`)는 문자열로 나오고, 문자열에 `'a:noFill' in node`를 쓰면 TypeError가 난다. `asXmlNode`로 받거나 `typeof node === 'object'`를 먼저 본다.
- 차트의 켜고 끄는 값(CT_Boolean: `c:delete`, `c:showVal`, `c:smooth`, `c:overlay` 등)은 `chart.ts`의 `ctBoolean`으로, xsd:boolean 속성(`b`, `i`, `rtl`)은 `xsdBoolean`으로 읽는다. `"1"`과 `"true"`가 참, `"0"`과 `"false"`가 거짓이고, `val` 없이 쓴 요소는 참(스키마 기본값)이다. `=== '1'`이나 `!== '0'`으로 읽으면 다른 프로그램이 쓴 `val="true"`, `val="false"`, `<c:delete/>`가 반대로 읽힌다. 시험: `tests/chart-xsd-boolean.test.ts`.

## 이 모듈의 방식

- 의미 파싱(fast-xml-parser)과 바이트 위치 잡기(`scanSlide`)가 따로 돌고, 최상위 도형 순서로 일대일 대응한다. `spTree` 머리의 `nvGrpSpPr`/`grpSpPr`는 도형이 아니라 `bodyPrefix`에 들어간다.
- `passthrough`는 모델이 다루지 않는 요소다. 표시용 미리보기만 싣고 원본 바이트로 저장한다.
- 텍스트 패치는 두 갈래다. 모델과 XML의 런 수가 같으면 각 `a:t`만 제자리에서 고치고, 다르면 `rebuildTxBody`가 `a:txBody`를 모델에서 새로 만든다. 뒤쪽 경로에서는 모델이 싣지 않은 것이 사라진다. 런에 새 속성을 추가할 때는 파싱·모델·생성 세 곳을 함께 고쳐야 하는 이유다. 문단 속성 패치(`dirtyPPr`)도 문단 수가 어긋나면 전체 재생성으로 떨어진다.
- 저장은 세 함수가 한 묶음이다. 엔진이 zip 전체를 한 버퍼에 만들고(WASM 메모리는 32비트라 4 GiB가 끝이고 한 번 늘면 줄지 않는다), `savePptxToFile`은 그 버퍼를 파일로 흘려 쓴다. TypeScript 시절처럼 파트를 흘려 묶지는 않는다. 저장이 성공한 뒤에만 `commitSaved`를 불러 변경 표시를 비운다. 저장 도중에 들어온 편집은 스냅샷과 달라서 표시가 남고 다음 저장에 실린다.
- 파일 쓰기 스트림의 오류는 `pipeline`이 promise로 넘긴다. 실패하면 저장 스냅샷을 버린다(`forgetSnapshot`).
- 저장할 때마다 `stripStaleEmbeddedFonts`가 돈다. 내장 글꼴 서브셋은 늘릴 수 없어서, 편집으로 서브셋에 없는 글자가 들어간 face는 떼어 낸다. 그대로 두면 서브셋을 엄격히 따르는 뷰어에서 글자가 보이지 않는다. 손대지 않은 덱은 영향이 없다.
- 요소 영속 id는 요소 자신의 `p:cNvPr` 안에서만 찾는다. `a16:creationId`가 있으면 `e_<GUID 앞 8자>`, 없으면 `e_<cNvPr id>`다. 그룹 조각에는 자식의 바이트가 들어 있어서 범위를 좁히지 않으면 그룹이 자식의 GUID를 물려받는다. GUID를 새긴 뒤에도 예전 `e_<cNvPr id>` 형태는 별칭으로 계속 통한다.
- 레이아웃 관계를 잃은 손상된 슬라이드는 열기를 거부하지 않고 첫 마스터의 레이아웃으로 그린다. 가운데 제목 자리표시자가 있으면 제목 레이아웃, 아니면 첫 레이아웃이다.
- 어두운 마스터는 색 이름을 바꿔 매핑한다(`clrMap`). 색을 풀기 전에 매핑부터 세운다.

## 원본과 다른 점

원본을 받아올 때 아래 시험이 통과하는지 본다. 충돌이 나면 이 동작을 남긴다.

- **강조 색·문자 간격의 제자리 패치(결정 0094).** `TextRun.highlightEdited`·`letterSpacingEdited`가 선 런만 `patchRunProps`가 `<a:highlight>`(채움·효과 뒤, 글꼴 앞)와 `spc`를 쓰거나 지운다. 런이 없던 `a:rPr`에 강조 색을 넣는 길도 같다. `ElementFontPatch`에 `highlight`(`null`은 지움)·`letterSpacingPt`(0·`null`은 표준)가 있다. 시험: `tests/run-highlight-spacing-visibility.test.ts`.
- **도형 숨기기·이름(결정 0094).** `setElementHidden`·`setElementName`이 원본 조각의 첫 `p:cNvPr` 여는 태그에서 `hidden`·`name` 속성 하나만 바꾸고 `structureDirty`를 세운다. 숨기기 뒤의 모델은 부르는 쪽이 `materializeSlide`로 다시 읽는다. 시험: 같은 파일.
- **한글 런의 언어 표시.** `generate.ts`의 `tagHangulRun`·`tagHangulParagraphs`·`hangulLang`이 언어 없이 쓰인 한글 런에 `lang="ko-KR"`(모델에는 `eaLang`·`fontScriptHint`도)을 붙이는 단 하나의 규칙이다. 원본 #2523 뒤로 레이아웃이 한국어 표시가 있는 런만 한글을 낱말 단위로 줄바꿈하기 때문에, 글을 짓는 쪽(`packages/pipelines`의 페이지 빌더, `packages/pptx-ops`의 글자 op)과 엔진의 바꾸기(`replaceAllInDeck`, 한글 바꿀 말이 들어간 런만)·바닥글(`applyHeaderFooter`)·도형 묶음 다이어그램(`smartart.ts`)이 이것을 부른다. `addElement`와 `generateParagraphXml`은 받은 런을 그대로 쓴다. 가져오기 변환기(ODP, PDF)가 이 길로 슬라이드를 만들고, 원본에 언어가 없던 런은 표시 없이 남아야 PowerPoint와 줄바꿈이 같다. 제자리 패치(`patchRunProps`)는 모델에 새로 생긴 `lang`을 `lang`이 없는 `a:rPr`에만 쓰고, 이미 있는 값은 바꾸지 않는다. 시험: `tests/hangul-lang-tag.test.ts`.

## 테스트

- `npm run test -w @seuoffice/pptx-engine`, 또는 패키지 폴더에서 `npx vitest run`. 픽스처는 `tests/fixtures/`의 pptx 두 개(라이선스 고지 동봉)와, 테스트가 그때그때 `pptxgenjs`와 `createBlankPptx`로 만드는 덱이다. `npm run fixtures`는 필요 없다.
- OOXML 스키마 검사 테스트는 `xmllint`가 PATH에 있을 때만 돈다. 없고 `CI` 환경 변수도 없으면 경고를 찍고 건너뛴다. 건너뛴 채 통과한 결과는 스키마 적합성을 보증하지 않으므로, 생성하는 XML을 바꿨다면 CI 결과까지 확인한다.
- `corpus-edit-fuzz.test.ts`는 `CORPUS_DIRS`를 줄 때만 돌고, 단언 없이 `FUZZ_OUT`에 보고서를 쓴다.
- 열기·저장 경로를 바꾸면 "변경 없음 → 파트 바이트 동일"과 "한 요소 편집 → 나머지 바이트 그대로"를 테스트로 증명한다. 새 변경자는 자식 요소가 스키마 순서에 맞는 자리에 들어가는지도 본다.
- Windows에서 원본 코드 그대로도 실패하는 테스트는 없다.
