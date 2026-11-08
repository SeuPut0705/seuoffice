# odt-engine (`@genoffice/odt-engine`)

OpenDocument Text(`.odt`)를 워드 편집기가 다루는 docx로 바꾸고, 편집 결과를 원본 ODT에 고친 곳만 끼워 넣어 저장한다. 원본 ODT가 없는 문서는 ODT로 통째로 바꾼다.

## 맡은 범위

- 핵심 층(`src/core`, 진입점 `src/core/index.ts`): 나머지 층(글자, 표, 개체, 쪽, 조립)이 모두 이 위에 선다.
  - `openOdt`: zip 관문 → 패키지 읽기 → `mimetype` 검사 → 암호 검사 → 본문 위치 지도 → 스타일 표 → 생성 프로그램 판별.
  - `readOdtPackage`: 항목마다 원래 바이트(압축 푼 것), 원래 압축 방식, 원래 순서(로컬 헤더 위치 순)를 지닌다. 다시 묶을 때 이것을 쓴다.
  - `scanOdtBody`: `office:text`의 최상위 요소와 그 안의 문단·목록·구역·색인·표·행·셀·가려진 셀·글상자·그림·개체·도형·책갈피·메모·각주를 원본 문자열의 위치(`start`/`openEnd`/`closeStart`/`end`)로 기록한다.
  - `readOdtStyles`: 공용 스타일, 기본 스타일, 목록 스타일, 쪽 모양, 바탕쪽(머리글·바닥글과 왼쪽·첫쪽 변형), 두 파트의 자동 스타일을 위치와 함께 담고 상속을 풀어 준다(`resolve`).
  - 변환 뼈대(`convert.ts`, `flow.ts`, `docx-package.ts`): 양방향 변환의 문맥, 다리 지도, 처리기 등록, 본문 흐름 걷기, 다리 docx 묶기. 아래 "변환 뼈대" 절.
- 글자 층(`src/text`, 진입점 `src/text/index.ts`): 문단·제목·글자 묶음(`text:span`)·공백·탭·줄 바꿈·쪽 나누기·하이퍼링크·목록·누름틀 책갈피, 공용 스타일과 기본 스타일. 아래 "글자 층" 절.
- 표 층(`src/table`), 개체 층(`src/objects`), 쪽 층(`src/page`): 아래 각 절.
- 조립 층(`src/assemble`, 공개 진입점 `src/index.ts`): 등록 순서, 공개 API(`odtToDocx`, `saveOdt`, `docxToOdt`, `odtToText`), 다시 묶기, 메타데이터, 바뀌는 것 목록. 아래 "공개 API"와 "조립" 절.

## 맡지 않는 것 (경계)

- docx의 해석과 저장은 `packages/docx-engine`이 한다. 이 패키지는 그 엔진을 고치지 않고 공개 API만 쓴다.
- 편집 화면, 저장 창, 꺼 둔 기능의 안내는 `apps/docs`가 한다.
- 층끼리는 처리기 등록으로만 만난다. 바깥(편집기, 명령줄, MCP)은 `src/index.ts`의 공개 API만 쓴다.
- AI에 보내기 전 가리기(redaction)는 이 패키지가 하지 않는다.
- 원본(GenOffice)에서 받아오는 문서 엔진과 달리 이 패키지는 이 프로젝트가 만들었다. 고칠 때 사람에게 먼저 묻지 않아도 된다. 다만 아래 규칙과 docx 엔진을 바꾸지 않는다는 규칙은 지킨다.

## 항상 지켜야 하는 것

- 렌더러 번들에 들어가므로 `node:*`를 import하지 않는다.
- 받은 ODT에서 고치지 않은 부분은 바이트 그대로 남긴다. 고친 것이 없는 저장은 원본 바이트를 그대로 돌려준다.
- 다리 지도(`BridgeMap`)는 JSON 그대로다. 함수, 클래스 인스턴스, `Map`, 타입 배열을 넣지 않는다. 렌더러와 뒷단, 명령줄 프로세스 사이를 오간다.
- 누름틀(`text:bookmark-start text:name="NormalField…"` … `text:bookmark-end`)의 쌍과 이름은 문단이 남아 있는 한 바이트 그대로 남는다. 이름 있는 책갈피를 조용히 버리지 않는다.
- 한컴 스타일 이름과 탭 목록은 그대로 둔다. 고친 문단은 원래 자동 스타일을 복사한 새 자동 스타일을 쓰고, 원래 스타일은 건드리지 않는다.

## 이 모듈의 방식

- XML을 DOM으로 만들었다가 다시 쓰지 않는다. `XmlScanner`/`walkElements`가 원본 문자열의 위치만 돌려주고, 범위로 자른 문자열이 그 요소의 원문과 정확히 같다. 저장은 바뀐 범위만 갈아 끼운다.
- 읽기는 너그럽다. `mimetype`이 맨 앞이 아니거나 압축돼 있어도, `office:version`이 없어도, 닫히지 않은 태그가 있어도 연다. 깨진 태그는 `body.warnings`에 남기고 넘어간다.
- 거부는 `OdtOpenError`의 `code`로 구분한다: `encrypted`(manifest에 `manifest:encryption-data`), `not-odt-text`(`mimetype`이 ODT 글 문서가 아님, `.ott` 포함), `zip-rejected`(docx와 같은 한도의 압축 관문), `corrupt`.
- 파트 글자는 BOM을 지운 채가 아니라 U+FEFF로 남겨 디코드한다. 그래서 위치가 다시 인코딩한 바이트와 어긋나지 않는다.
- 접두사가 표준과 다른 문서도 뿌리 요소의 `xmlns:` 선언으로 표준 이름(`text:p`)에 맞춰 읽는다. 노드의 `name`은 표준 이름, `tag`는 파일에 쓰인 그대로다.
- 스타일 이름은 쓰인 그대로 둔다(띄어쓰기, 한글, `+`). 엔티티는 풀어서 `name`에, 원문은 `rawName`에 둔다. 한컴은 정의하지 않은 부모(`Standard`, `Frame`)를 가리키는데, 이것은 오류가 아니라 `missingParent`로 알린다.
- 자동 스타일은 다른 스타일의 부모가 되지 못한다. 부모는 공용 스타일에서만 찾고, 자동 스타일은 파트별 범위(`content`/`styles`)로 따로 찾는다. 두 파트에 같은 이름(`P1`)이 있을 수 있다.
- 한컴의 `draw:equation`은 수식이 아니라 도형(`draw:custom-shape`)의 모양 계산식이다. 노드로 잡지 않는다. 수식 개체는 `draw:object`다.
- 모든 위치(문단 글자 위치 포함)는 UTF-16 단위다. 파트 문자열의 위치는 원본 ODT의 디코드한 `content.xml`/`styles.xml` 문자열 기준이다.

## 변환 뼈대 (`src/core`)

### 전체 흐름

- 열기: ODT → `OdfToOoxmlContext` → `convertOdtStyles`(글자 층) → `convertOdtBody` → `buildBridgeDocx` → 다리 docx 바이트 + `ctx.map`(다리 지도).
- 저장: 원본 ODT + 다리 지도 + 편집된 docx → `parseDocx(편집된 docx)` → `OoxmlToOdfContext` → `rebuildOdtBody` → `updateOdtStyles`(글자 층) → `rctx.finish()` → 파트별 `TextPatch[]` → `applyTextPatches`로 원본 `content.xml`/`styles.xml` 문자열에 적용 → 다시 묶기("조립" 절).
- 다리 docx는 매번 같은 입력에서 같은 결과가 나온다. 다리 지도의 `elements[*].xml`이 다리 docx 본문 요소의 원문 그대로이므로, 저장 때 다리 docx를 다시 만들 필요가 없다.

핵심 층만으로 부르는 순서(예, 실제 순서는 "조립" 절):

```ts
const doc = await openOdt(odtBytes)
const registry = registerTextConverters(new ConversionRegistry()) // 그다음 표·개체·쪽 층의 등록 함수
const ctx = new OdfToOoxmlContext(doc, registry)
convertOdtStyles(ctx) // 반드시 본문보다 먼저: 문단이 docx 스타일 id를 찾는다
convertOdtBody(ctx)
const docxBytes = await buildBridgeDocx(ctx)
const bridge = ctx.map // JSON

// 저장
const edited = await parseDocx(editedDocx)
const rctx = new OoxmlToOdfContext(doc, bridge, edited, registry, {
  editedStylesXml: await readDocxPart(editedDocx, 'word/styles.xml'),
})
rebuildOdtBody(rctx)
updateOdtStyles(rctx)
const patches = rctx.finish() // { 'content.xml': TextPatch[], 'styles.xml': TextPatch[] }
const contentXml = applyTextPatches(doc.contentXml, patches['content.xml'])
```

### 다리 지도 (`BridgeMap`, `convert.ts`)

- `blocks: BridgeBlock[]`: 본문 흐름의 ODF 블록. `office:text`의 자식(`parent: null`)과 컨테이너(구역 등)의 자식. 원본 범위(`start`/`end`), 변환한 처리기 id(`owner`), 만든 OOXML 요소(`elements`), 자식 블록(`children`), 처리기 몫의 JSON(`data`). OOXML이 없는 블록(`owner: 'keep'`, 예: `text:sequence-decls`, 주석)은 저장 때 원래 자리에 그대로 다시 들어간다.
- `elements: BridgeElement[]`: 다리 docx 본문의 최상위 요소(`w:p`, `w:tbl` …)를 순서대로. `id`는 본문 요소 순번과 같다. `xml`은 원문 그대로, `block`은 만든 블록, `paragraph`는 문단 기록 id.
- `paragraphs: BridgeParagraph[]`: 변환한 문단 하나하나(본문, 목록, 셀, 글상자, 머리글 어디든). 원본 범위, 요소 이름(`text:p`/`text:h`), 스타일 이름, 다리 docx에서 읽히는 글자 그대로의 `text`, `markers`, 써 넣은 `w:pPr`(`pPr`, 같으면 문단 모양이 안 바뀐 것), 목록 소속(`list`), 기록한 처리기(`owner`).
- `BridgeMarker`: 문단 안의 글자 아닌 것을 글자 위치(`offset`)에 묶는다. `kind`는 `bookmark-start`/`bookmark-end`/`bookmark`(책갈피), `keep`(처리기가 없어 OOXML로 옮기지 않은 인라인 요소, 원래 자리에 다시 넣음), `text`(처리기가 없는 필드 등 글자가 있는 인라인 요소, 그 글자가 그대로면 원문을 다시 넣고 바뀌면 보통 글자로 씀), `handler`(등록한 인라인 처리기가 만든 것, `owner`·`length`). `pair`는 같은 문단 안 짝 책갈피의 순번, `field`는 한컴 누름틀(`NormalField…`), `ooxmlName`은 다리 docx에 넣은 숨은 책갈피 이름.
- `styles`: docx 문단 스타일과 ODF 공용 스타일의 대응(`paragraph[]`, 써 넣은 `w:style` 원문 포함), `docDefaults` 원문, 기본 스타일의 계열, 새 문단의 부모로 쓸 공용 스타일(`baseParagraphStyle`).
- `lists: BridgeList[]`: `w:numId` ↔ ODF 목록 스타일 이름과 그 목록 블록들.
- `ext: Record<string, JsonValue>`: 작업별 칸. 표 층은 `table`, 개체 층은 `objects`, 쪽 층은 `page`처럼 자기 이름 하나를 쓴다(`ctx.ext(key, init)`, 저장 때 `rctx.ext(key)`). 보호된 칸 좌표, 자리 표시 id 같은 공개 정보도 여기 둔다.
- `warnings`: 근사하거나 옮기지 못하고 그대로 둔 것.
- 숨은 책갈피 이름: 문단마다 `_odtp<문단 id>`(정체 표시, 편집기가 문단을 다시 만들어도 다시 써 준다), 표시 위치마다 `_odtm<문단 id>_<순번>`. `_`로 시작하므로 편집기는 숨긴다. 위치를 되살리는 데는 쓰지 않는다(엔진이 다시 만든 문단은 책갈피를 맨 앞의 빈 쌍으로 옮긴다). 위치는 기록의 `offset`으로 되살린다.

### 처리기 등록 (`ConversionRegistry`)

같은 대상에 여럿이 등록되면 나중에 등록한 것이 먼저다. 다른 작업은 이 파일들을 고치지 않고 등록만 한다.

- `addBlock(BlockConverter)`: 본문 흐름의 블록 하나를 맡는다.
  - `match(node, ctx)`로 고른다. 예: 표 층은 `node.kind === 'table'`, 그리고 글상자 안 표를 담은 문단(`text:p > draw:frame > draw:text-box > table:table`)을 글자 층보다 먼저 가져간다.
  - `toOoxml(ctx, node, env)` → `{ elements: [{ xml, kind, paragraph }], data }`. `env.blockId`의 블록은 이미 지도에 있다. 순서가 중요한 경우(안쪽에서 `convertNode`를 부르는 경우) `ctx.addElement(env.blockId, …)`로 직접 넣고 빈 `elements`를 돌려준다.
  - `toOdf(rctx, block, items, env)`: 그 블록의 요소가 "바뀌지 않은 채 빠짐없이 순서대로" 돌아오지 않았을 때만 불린다. `items`는 그 블록을 잇는 편집된 요소와 그 사이에 새로 들어온 요소(편집 순서, 지운 것은 없음). 블록의 원본 범위를 대신할 ODF를 돌려준다. 안 바뀐 요소(`item.unchanged`)는 원본 범위를 복사한다.
  - `identify?(rctx, item, candidates)`: XML이 그대로가 아니라 바로 짝을 못 찾은 편집된 요소를 자기 요소로 가져간다(`candidates`는 앞뒤로 짝을 찾은 요소 사이의, 아직 주인이 없는 이 처리기의 요소).
  - `absorbs?(rctx, block, item)`: 블록 바로 앞뒤의 새 요소가 그 블록에 속하는지(예: 목록 끝에서 친 새 항목).
- `addInline(InlineConverter)`: 문단 안 인라인 요소(`names`: `draw:frame`, `text:note`, `office:annotation`, `office:annotation-end` …). `toOoxml(ctx, el, env)` → `{ kind: 'xml', xml, text }`(문단 안 그 자리에 넣을 OOXML, `text`는 엔진이 그 XML에서 읽는 run 글자 그대로, 표시뿐이면 `''`) 또는 `{ kind: 'runs', runs }` 또는 `{ kind: 'keep' }`/`null`(기본 처리). 기록에는 `handler` 표시로 남는다.
- `addRunWriter(RunWriter)`: 편집된 문단의 원자 run(그림, 각주 번호 등)을 ODF로. `match(run)`, `toOdf(rctx, run, env)`. 그 run의 글자는 쓰지 않는다. 처리기 없는 그림·각주 run은 경고하고 버린다.
- `addInjector(ParagraphInjector)`: 편집된 문단의 글자 위치에 ODF를 끼운다(메모의 시작·끝 표시 등). `env.mapOffset(원래 위치, 'start' | 'end')`로 원래 문단의 위치를 편집된 글자 위로 옮길 수 있다.
- `addFreeWriter(FreeWriter)`: 원래 블록이 없는 새 요소(새 표, 새 그림 문단). 연속한 같은 처리기 몫을 한 번에 받는다. `env.neighbours`에 앞뒤로 원래 요소가 있으면 알려 준다.

### 기본 처리 (처리기가 없을 때)

- 블록: 구역(`text:section`)은 컨테이너(`owner: 'container'`, 자식을 흐름으로 변환하고 저장 때 원래 감싸개 안에 다시 씀). 나머지(처리기 없는 표, 차례 등)와 `other`/`opaque`는 OOXML 없이 `keep`: 화면에는 없고 저장 때 원래 자리에 바이트 그대로 남는다(`warnings`에 남김). 쪽 층이 구역을 맡을 때는 `convertContainer`/`rebuildContainer`를 감싸 쓴다.
- 인라인: `draw:*`, `office:*`, `text:note`, 변경 기록·색인 표시, `text:soft-page-break` 등은 `keep`(숨은 책갈피 하나, 저장 때 옮긴 위치에 원문 그대로). 글자가 있는 그 밖의 요소(`text:page-number` 같은 필드)는 `text`.

### 문맥

- `OdfToOoxmlContext`: `doc`, `registry`, `map`, `docx`(스타일·번호 정의·관계·추가 파트·최종 `sectPr`·이름공간을 모으는 곳, `buildBridgeDocx`가 묶음), `generate`(엔진 `generateParagraphXml`용), `part(part)`(파트 문자열·접두사·글꼴 이름표), `addBlock`/`addElement`, `reserveParagraphId`/`addParagraph`(문단을 시작할 때 id를 받고 끝날 때 기록), `allocateBookmarkId`, `addRelationship`/`addHyperlink`, `warn`, `ext`. 그림 바이트는 `docx.parts.push({ path: 'word/media/…', data })`와 `addRelationship`으로 넣는다. 쪽 층은 `docx.sectPr`을 채운다(비우면 기본 쪽 모양에서 만든다).
- `OoxmlToOdfContext`: `doc`, `map`, `edited`(편집된 docx의 `parseDocx` 결과), `registry`, `options.editedStylesXml`, `part(part)`, `patch(part, start, end, xml)`(좁은 교체, 겹치면 안 됨), `addAutomaticStyle(part, xml)`, `derivedStyle(part, key, base, build)`(같은 `key`면 같은 새 스타일을 공유), `allocateStyleName(base)`(두 파트의 기존·새 이름 어디와도 겹치지 않는 `<base>_io<n>`), `fontFace(part, family)`(없으면 `style:font-face`를 더함), `newAutomaticStyles(part)`, `warn`, `ext`, `finish()`(새 자동 스타일·글꼴 선언·빠진 이름공간 선언을 더한 파트별 패치).

### 정렬 (`alignItems`, `rebuildFlow`)

1. XML이 다리 요소와 글자 그대로 같으면 그 요소(안 바뀜).
2. 문단은 숨은 정체 책갈피 `_odtp<id>`로 찾는다(편집기는 제자리 편집한 문단에 숨은 책갈피를 다시 쓰고, Enter로 쪼갠 뒷부분에는 쓰지 않는다).
3. 처리기의 `identify`.
4. 앞뒤 짝 사이에 짝 없는 편집 요소 하나와 같은 종류의 다리 요소 하나만 남으면 둘을 잇는다.

블록 단위로 묶어 바뀌지 않았으면 원본 범위를 복사하고(사이 공백까지), 아니면 그 처리기의 `toOdf`에 넘긴다. 아무 블록에도 속하지 않는 새 요소는 `FreeWriter`로 간다.

## 글자 층 (`src/text`)

- `registerTextConverters(registry)`: 문단·제목·목록 블록(`textBlockConverter`, id `text`)과 새 문단 쓰기(`textFreeWriter`).
- `convertOdtStyles(ctx)`: 공용 문단 스타일 → docx 문단 스타일(표시 이름 그대로, `basedOn`은 부모 사슬). `Standard`가 있으면 `Normal`과 대응. 기본 스타일 → `w:docDefaults`. ODF는 부모의 탭 목록을 대체하고 OOXML은 합치므로, 탭은 docx 스타일에 넣지 않고 문단에 실제 탭 목록을 직접 넣는다. `style:default-outline-level`(한컴 "개요 n")은 docx 제목으로 바꾸지 않는다(한컴은 `text:h`를 쓰지 않는다). 편집기의 제목·하이퍼링크 명령을 위해 없으면 `Heading1…6`, `Hyperlink`를 더한다.
- `paragraphToOoxml(ctx, range, { part, owner, block, list })` → `{ xml, paragraph, model }`: 문단 하나를 `w:p`로 바꾸고 기록한다. 표 층(셀 문단), 개체 층(각주·메모 본문), 쪽 층(머리글 문단, `part: 'styles.xml'`)가 그대로 쓴다. `w:pStyle`은 자동 스타일의 부모 공용 스타일, 자동 스타일 자신의 문단 속성은 직접 `w:pPr`, run은 문단 자동 스타일의 글자 속성 위에 span·링크 스타일을 겹친 직접 `w:rPr`이다. OOXML은 엔진의 `generateParagraphXml`이 쓴다. 문단 스타일이 굵게인데 span이 보통이면 `w:b w:val="0"`을 쓴다.
- `paragraphToOdf(rctx, para, origin, { part, neighbour, follows })`: 편집된 문단(`editedParagraphFromBlock(block)`, 셀이면 `editedParagraphFromTableParagraph(tp)`)을 ODF로. `origin`은 이 문단이 잇는 원래 문단 기록(없으면 새 문단).
  - 문단 모양: `rawPPr`이 기록의 `pPr`과 같으면 안 바뀐 것. 바뀐 속성만 원래 자동 스타일의 복사본에 덮어쓴다(`editStyleXml`: 이름만 바꾸고 다른 속성·탭 목록·한컴 속성·모르는 자식은 바이트 그대로). 원래 스타일이 공용 스타일이면 그것을 부모로 한 새 자동 스타일.
  - 새 문단: 바로 앞의 원래 문단(`follows`, Enter로 쪼갠 앞부분이나 그 뒤에 친 문단, 새 문단이 이어져도 같은 것)과 docx 스타일이 같으면 그 문단의 자동 스타일에서 만든다. 모든 속성·탭 목록·한컴 속성을 복사하고 다른 것만 덮어쓰며, 바뀐 것이 없으면 그 스타일 이름을 그대로 쓴다. 구역 시작(`style:master-page-name`)은 앞 문단의 것이므로 복사본에서 뺀다. 앞에 원래 문단이 없거나 docx 스타일이 다르면 docx 스타일에 대응하는 공용 스타일(없으면 `baseParagraphStyle`)을 부모로 한 새 자동 스타일.
  - 지운 값: 고친 문단에서 원래 있던 값이 없어졌으면 편집기에서 지운 것이다(고치지 않은 문단은 원래 바이트를 쓰므로 여기 오지 않는다). 문단 속성은 복사본에서 그 속성을 빼서 공용 스타일의 값을 따르게 한다(탭 목록은 빈 목록, 앞 간격은 0). 글자 속성은 docx run이 그때 따르는 문단 스타일 사슬의 값을 쓰고, 그것도 없으면 속성을 뺀다. 색을 지우면 `fo:color`가 빠지고, 형광펜은 `transparent`, 밑줄·취소선·굵게는 끔, 크기는 문단 스타일의 크기.
  - 글자 모양: 편집된 글자마다 원래 글자를 찾아(앞뒤 공통 부분, 가운데는 LCS) 모양이 같으면 원래 span·링크 태그를 그대로 쓰고, 다르면 원래 span 스타일의 복사본에 바뀐 속성만 덮어쓴 새 스타일을 쓴다. 새 문단은 이웃 원래 문단의 끝 글자 모양을 본보기로 쓴다.
  - 누름틀·책갈피: 원래 위치를 편집된 글자 위로 옮긴다. 시작은 앞의 남은 글자 바로 뒤, 끝은 뒤의 남은 글자 바로 앞으로 가므로 쌍 안에서 친 글자는 쌍 안에 남고, 쌍 안 글자를 모두 지우면 빈 쌍이 된다. 문단을 지우면 쌍도 사라진다. 짝 없는 시작·끝, 점 책갈피, 같은 이름도 원문 그대로 옮긴 자리에 쓴다. 그림·각주 같은 원자(run writer)가 원래 `handler` 표시를 잇고 같은 자리에 책갈피가 있으면 원래 문서 순서를 지킨다(그림 다음 책갈피).
  - 문단 나누기·합치기: 고친 원래 문단과 그 뒤에 이어지는 새 문단들(Enter로 쪼갠 뒷부분)을 한 글자열로, 원래 문단과 그 바로 뒤에서 지워졌지만 글자가 절반 이상 남은 원래 문단들(Backspace로 합친 문단)을 다른 한 글자열로 보고 표시를 옮긴 뒤(`placeMarkers`), 옮긴 위치가 든 문단에 쓴다. 문단 경계에서 시작은 뒤 문단, 끝은 앞 문단으로 간다. 책갈피 쌍은 문단을 넘지 않는다: 쌍의 글자가 나뉘면 글자가 더 많이 남은 문단에 쌍을 두고 경고한다. 글자가 남지 않은 지운 문단의 표시는 문단과 함께 사라진다(일부만 남았으면 경고). 그래서 글자 층 블록은 바로 앞뒤의 새 문단을 자기 몫으로 받는다(`absorbs`).
  - 공백은 한컴처럼 `' <text:s/>'`, 맨 앞·맨 끝 공백은 `text:s`. 탭 `text:tab`, 줄 바꿈 `text:line-break`. 문단 안에 친 쪽 나누기는 문단을 나누고 뒷부분에 `fo:break-before="page"`를 준다. `fo:break-after="page"`는 다리 docx에서 문단 끝의 쪽 나누기 글자(`\f`)다.
  - 글자처럼 놓인 그림·도형(`text:anchor-type="as-char"`)은 글자 자리를 차지한다. 읽을 때 그 뒤의 공백은 앞 공백과 합쳐지지 않는다. 다만 그 공백은 뒤에 보이는 것(글자, 다른 개체)이 더 있을 때만 남는다: 그림과 공백뿐인 문단을 docx 엔진이 글자 없는 그림 블록으로 읽기 때문이다. 쓸 때 그 뒤 공백 하나는 그냥 공백이다.
  - 제목은 `text:h`와 `text:outline-level`, 원래 시작 태그의 다른 속성은 그대로.
- 목록: ODF 목록 스타일 하나 = `w:abstractNum` 하나(한국어 번호 형식 `가, 나, 다, ...` → `ganada` 등), 최상위 `text:list` 하나 = `w:num` 하나(`text:continue-list`/`text:continue-numbering`이면 이어 쓰는 목록의 것을 함께 씀). 저장 때 연속한 목록 문단을 `w:numId`별로 묶어 다시 쓰고, 원래 목록의 시작 태그(`xml:id` 포함)는 한 번만 다시 쓴다. 편집기가 새로 만든 목록은 편집된 docx의 번호 정의로 새 자동 목록 스타일을 만든다.
- `updateOdtStyles(rctx)`: 편집된 docx의 `styles.xml`에서 다리가 쓴 것과 달라진 스타일만 대응하는 ODF 공용 스타일에 바뀐 속성만 고쳐 쓴다(이름 그대로). `w:docDefaults`의 글꼴이 바뀌면 기본 스타일을 고친다(없으면 `style:default-style`을 더함).
- 하이퍼링크: `text:a` → 링크 run(`plain`이라 엔진의 Hyperlink 글자 스타일을 붙이지 않음). 저장 때 같은 주소면 원래 `text:a` 시작 태그를 그대로 쓴다.

### 알려진 한계

- docx 엔진은 `w:t` 안의 글자 `&#38;`처럼 엔티티 모양의 글자를 한 번 더 풀어 읽는다. 그런 문단을 고치면 그 글자는 `&`가 된다(말뭉치 66개 중 문단 1개).
- 표 칸의 문단(`TableParagraph`)은 숨은 책갈피를 지니지 않는다. 칸 문단과 원래 문단의 대응은 표 층이 칸 위치로 정해 `paragraphToOdf`에 `origin`으로 넘긴다.
- 문단 모양 중 다리가 옮기지 않는 것(테두리, 세로 정렬 등)은 원래 스타일의 복사본에 그대로 남지만 편집기에서 바꿀 수 없다.
- 지운 글자 속성을 문단 스타일 사슬의 값으로 되돌릴 때, 그 값을 문단 자동 스타일이나 바깥 span이 따로 정하고 있으면 그 값이 남을 수 있다(docx는 그 값을 run에 직접 썼기 때문). 한컴 문서는 span 자동 스타일이 모든 글자 속성을 지녀 해당이 드물다.

## 표 층 (`src/table`)

- `registerTableConverters(registry)`: 글자 층 다음에 등록한다(조립 순서: 글자 → 표 → 개체 → 쪽). 블록 처리기 id는 `table`, 새 표를 쓰는 `FreeWriter`도 같은 id다.
- 맡는 것: 본문의 `table:table`, 한컴이 글상자에 넣은 표를 담은 문단(`text:p > draw:frame > draw:text-box > table:table`, 글상자 안에 표 하나만 있는 틀), 셀 안의 표(맨 표와 글상자 표 모두, 몇 겹이든).
- 다른 층과의 약속: `tableFrameOf(frame)`이 null이 아닌 `draw:frame`은 표 층 몫이다. 개체 층의 인라인·블록 처리기는 이 틀을 가져가지 않는다. 가져가면 그 표가 편집기에 보이지 않고, 저장 때 틀 안의 표를 바꿔 끼우지 못한다.

### 열기 (ODF → OOXML)

- 글상자 문단: 표 말고 보이는 것이 없으면(책갈피는 괜찮다) 표만 편집기 표로 보인다. 글자가 함께 있으면 그 글자를 문단 하나(`paragraphToOoxml`, owner `table`)로, 표를 그 앞이나 뒤에 보인다. 문단 글자가 첫 틀보다 앞에 있으면 문단이 먼저다(`paragraphFirst`). 그 문단 안의 틀은 글자 층의 `keep` 표시로 남는다.
- 격자: 열 너비는 열 스타일(`style:column-width`, 없으면 `style:rel-column-width`, 그것도 없으면 표 너비를 나눔), 고정 배치(`w:tblLayout fixed`). 행 높이는 행 스타일 `style:row-height`(exact) 또는 `style:min-row-height`(atLeast). `table:table-header-rows`의 행은 `w:tblHeader`. 병합은 `w:gridSpan`과 `w:vMerge`(가려진 칸 중 세로 병합이 이어지는 첫 칸만 `w:tc`가 된다). 한컴은 가려진 칸도 열마다 요소로 쓰므로 칸의 열 번호는 행 안의 순번이다.
- 셀 모양: 테두리(`fo:border*`, 대각선), 채우기(`fo:background-color`), 세로 정렬, 안쪽 여백(`w:tcMar`). 표 수준 테두리와 기본 셀 여백은 없음/0이다. 글자처럼 놓인 틀의 표는 담은 문단의 정렬을 따른다.
- `w:tcPr`는 docx 엔진이 모델에서 다시 만들 때와 같은 꼴(`tcW`, `gridSpan`, `vMerge`, `tcBorders`, `shd`, `tcMar`, `vAlign` 순, `top` 정렬은 쓰지 않음)로 쓴다. 편집기가 표를 다시 만들어도 손대지 않은 칸의 `w:tcPr`는 같다. 저장은 이것으로 손대지 않은 칸을 가린다.
- 셀 내용: 문단(셀 안 목록의 문단 포함, 목록 번호도 보인다), 셀 안의 표, 셀 안의 글상자 표 문단. 표로 끝나는 칸과 문단이 없는 칸에는 OOXML이 요구하는 빈 `w:p`를 더하고 `synthetic`(`trailing`/`empty`)으로 적는다. 저장 때 그 빈 문단이 비어 있으면 없는 것으로 본다.
- 셀 안 표는 잠긴 칸 안에 있으면 그 칸들도 잠긴 것으로 친다.

### 다리 지도 `ext.table` (JSON)

- `TableExt = { version: 1, tables: TableRecord[], elements: { [bridge element id]: table id }, protectedCells: ProtectedCellRef[] }`.
- `TableRecord`: 원래 `table:table` 범위, `block`(다리 블록), `element`(최상위 표의 `w:tbl` 다리 요소 id, 셀 안 표는 null), `host`(셀 안 표: `{ table, row, col, index }`), `frame`(글상자 표: 문단 범위, `draw:frame` 범위, 그래픽 스타일 이름, 고정 방식), `headerRows`, `rows`(범위, 머리글 여부, 행 스타일, 높이 cm), `columns`(격자 열마다: 요소 범위, 스타일, 반복 여부, 너비 twips), `cells[row][col]`, `widthTwips`, `structureLocked`.
- 칸 주소는 (표의 다리 요소 id, 격자 행, 격자 열)이다. 행 번호는 머리글 행을 포함한 0부터, 열 번호는 칸의 첫 열.
- `CellRecord`(격자 칸마다, 기본값은 적지 않아 작다):
  - `cell`: 실제 칸. 범위(`start`/`openEnd`/`closeStart`/`end`/`selfClosing`), `tc`(`w:tr` 안 `w:tc` 순번), `style`, `units`, 병합이면 `colSpan`/`rowSpan`, 잠겼으면 `protected: true`, `synthetic`.
  - `covered`: 병합으로 가려진 칸. `start`/`end`, `anchor`(덮는 칸의 [행, 열]), `tc`(세로 병합이 이어지는 `w:tc`면 그 순번, 아니면 null).
  - `orphan`(어느 병합도 덮지 않는 가려진 칸)과 `filler`(행이 짧아 요소가 없는 자리, 범위 -1): 편집기에는 빈 칸으로 보이고, 거기 친 글자는 저장하지 않는다(경고).
- `units`: `p`(문단 기록 id와 범위), `t`(셀 안 표 id), `f`(글상자 표 문단: 범위, 글자 문단 id 또는 null, `paragraphFirst`, 표 id들). 셀 모양(테두리·채우기·정렬)은 저장하지 않고 저장 때 원래 셀 스타일에서 다시 계산한다.
- 블록 `data`: `{ kind: 'table' | 'frames', paragraph, paragraphFirst, tables }`.

### 잠긴 칸 (`protectedCells`)

- 판정: 칸의 `table:protected="true"`, 칸 스타일의 `style:cell-protect`에 `protected`가 든 값, 표의 `table:protected="true"`(모든 칸), 잠긴 칸 안에 든 표의 모든 칸.
- 목록 항목 하나: `{ table: <최상위 w:tbl의 다리 요소 id>, path: [{ row, col, index }…], row, col, tc }`. `path`는 바깥 표부터 셀 안 표로 들어가는 길(그 표의 칸 (row, col)의 `index`번째 표)이고 최상위 표면 `[]`다. `row`/`col`은 가장 안쪽 표의 격자 칸, `tc`는 그 행의 `w:tc` 순번(docx 엔진 `TableModel.rows[row][tc]`). 병합된 잠긴 칸은 왼쪽 위 칸 하나만 적는다.
- 읽기: `protectedCellsOf(map)`, `isProtectedCell(map, { table, path?, row, col | tc })`. 편집기(셀 편집 막기)와 명령줄·MCP가 이것만 읽으면 된다.
- 저장은 잠긴 칸을 절대 쓰지 않는다. 내용이나 모양이 바뀌었으면 원래 칸을 그대로 두고 경고한다. 쓰기 함수를 부르지도 않는다(새 스타일이 생기지 않게). 격자 변경이 잠긴 칸의 자리나 병합을 바꾸면(그 행·열 삭제, 병합, 나누기) 표 전체를 원래대로 두고 경고한다.

### 저장 (OOXML → ODF)

- 편집기는 바뀐 표를 두 가지로 저장한다(`apps/docs` `pmDocToSavePlan`): 칸 글자만 바뀌면 `patchTableCellTexts`(손대지 않은 칸·문단은 바이트 그대로), 구조나 모양이 바뀌면 `generateTableModelXml`(표 전체를 모델에서 다시). 둘 다 다리 요소와 XML이 달라 `identify`로 짝을 찾는다(같은 틈의 표 후보 중 칸 글자가 가장 많이 같은 것).
- 격자(행 수, 열 수, 병합)가 같으면 칸마다 비교한다.
  - 다리의 `w:tc`와 같으면 그대로. 아니면 문단마다: 다리 `w:p`와 같거나(숨은 `_odt` 책갈피 빼고) 글자가 같고 `paragraphToOdf` 결과를 다시 읽은 모양(글자별 span·링크 태그, 표시, 문단 시작 태그)이 원래와 같으면 원래 바이트, 아니면 새로 쓴 문단.
  - 바뀐 칸만 그 범위를 갈아 끼운다. 행·표 태그, 다른 칸, 틀은 바이트 그대로다.
  - 칸 문단 대응: 글자가 같은 공통 앞·뒤, 그 사이는 순서대로. 문단 수가 다르면(칸 안 Enter·Backspace) 글자 층과 같은 규칙으로 `placeMarkers`가 누름틀·책갈피를 글자를 따라 옮긴다(쌍은 글자가 더 많이 남은 문단에, 경고). 새 문단은 앞의 원래 문단 바로 뒤(목록 안이면 같은 목록 항목 안)에 넣고 그 문단 스타일을 따른다. 지운 문단은 범위째 지운다.
  - 칸 모양: `w:tcPr`(너비·병합 제외)가 다르면 엔진 모델의 채우기·세로 정렬·테두리를 원래 스타일에서 다시 계산한 값과 비교해, 바뀐 속성만 원래 셀 스타일의 복사본(`<이름>_io<n>`)에 덮어쓴다. 한 변의 테두리가 바뀌면 `fo:border`를 네 변 속성으로 풀어 쓴다.
  - 열 너비가 바뀌면 그 열의 스타일 복사본과 표 스타일 너비(원래 `style:width` + 변화량), 틀 너비를 고친다.
- 격자가 바뀌면 표를 원래 조각으로 다시 짠다.
  - 짝짓기: 행 수가 같으면 그대로, 다르면 행의 칸 글자 서명으로 LCS를 잡고 그 사이는 순서대로 짝짓는다(`mapSequence`). 열도 짝지은 행들로 같은 방법.
  - 원래 행과 짝지어졌고 칸이 모두 그대로면 행 바이트 그대로. 짝지은 칸은 바뀌지 않았으면 바이트 그대로, 병합 크기만 바뀌었으면 시작 태그의 `table:number-*-spanned`만 고친다.
  - 새 행은 이웃 행(위, 없으면 아래)의 행 시작 태그(행 스타일)와 같은 열 칸의 시작 태그(칸 스타일), 새 열은 이웃 열의 열 요소(너비가 다르면 그 열 스타일의 복사본)와 칸 시작 태그를 쓴다. 새 칸에는 `table:protected`를 옮기지 않는다. 새 칸 문단은 본뜬 칸의 첫 문단 스타일을 따른다.
  - 칸 합치기: 왼쪽 위 칸이 주인이고, 덮인 원래 칸들의 문단은 그 뒤에 붙어 원래 스타일과 표시를 지닌 채 쓰인다. 나누기: 새 칸은 나뉜 칸의 태그를 본뜬다. 가려진 칸은 원래 가려진 요소가 있으면 그것, 없으면 `<table:covered-table-cell/>`.
  - 머리글 행은 맨 앞의 연속한 머리글 행만 `table:table-header-rows`(원래 시작 태그)에 넣는다.
  - 표 시작 태그와 첫 열 앞의 내용은 원래 그대로다. 행 사이의 다른 요소(쪽 나눔 표시 등)는 다시 짤 때 빠진다.
- 틀 크기: 한컴 틀의 그래픽 스타일 `fo:min-height`는 표 행 최소 높이의 합과 같다(말뭉치 1,819개 틀에서 중앙값 차이 0). 그래서 새 높이 = 원래 `fo:min-height` + (새 행 높이 합 − 원래 행 높이 합)이다. 행 높이는 행 스타일 값, 새 행은 본뜬 이웃 행의 값. 너비도 열 너비 합의 변화만큼. 원래 그래픽 스타일의 복사본을 만들어 `draw:style-name`을 바꾸고, 틀 태그에 `svg:height`/`svg:width`/`fo:min-*`가 있으면 그것도 고친다. 틀의 나머지(문단, 위치, `draw:text-box`)는 바이트 그대로다.
- 틀 문단: 표가 바뀌면 원래 문단 안의 틀 범위만 갈아 끼운다. 혼합 문단의 글자가 바뀌면 글자 층이 쓴 문단(틀은 `keep` 표시로 원문 그대로 들어 있다)에서 원래 틀을 새 틀로 바꾼다. 표를 지우면 틀을 지우고, 순수 틀 문단의 표가 모두 지워지면 문단도 지운다.
- 구조 잠금(`structureLocked`): 반복 행(`table:number-rows-repeated`), 반복 칸, 행 묶음·열 묶음이 있는 표는 칸 글자만 고칠 수 있다. 격자 변경은 경고하고 원래대로 둔다. 한컴 파일에는 없다.
- 새 표(원래 없음): 본문 수준 `table:table`과 새 자동 스타일(표 너비·정렬, 열 너비, 행 높이, 칸 테두리·채우기·세로 정렬·안쪽 여백). 칸 테두리가 없으면 표 수준 테두리, 그것도 없으면 0.5pt 검은 실선. 칸 문단은 새 문단 규칙(`paragraphToOdf`, origin 없음)을 따른다.

### 알려진 한계

- docx 엔진의 `generateTableModelXml`은 칸 문단의 `w:pStyle`을 쓰지 않는다. 그래서 스타일 id가 없는 칸 문단은 "스타일이 바뀌지 않음"으로 본다. 편집기에서 표 구조를 바꾼 저장에서는 칸 문단의 스타일 변경이 전해지지 않는다.
- 행 높이 편집은 쓰지 않는다(새 행은 이웃 행 높이).
- 혼합 글상자 문단의 글자는 표의 앞이나 뒤 한 곳에만 보인다. 그 글자 문단만 지우는 편집은 무시하고 글자를 남긴다(경고). 한 틀 문단의 표들 사이에 친 새 내용은 그 문단 뒤에 쓴다(경고).
- 목록 항목 안의 글상자 표 문단(말뭉치 2개)은 글자 층이 문단으로 바꾸므로 표로 보이지 않는다(바이트 그대로 남는다).
- 머리글·바닥글(styles.xml)의 표는 맡지 않는다.
- 합쳐진 다른 칸의 셀 안 표는 원래 바이트가 아니라 새 표로 쓴다.
- 글자가 있는 인라인 처리기(각주 번호)가 든 칸 문단은 모양 비교를 하지 않아, 표를 다시 만든 저장에서 글자 층이 다시 쓴다. 글자가 없는 처리기(그림, 자리 표시)는 다시 읽으면 `keep` 표시가 되므로 원래 바이트와 비교해 같으면 원래 문단을 쓴다.
- `ext.table`은 격자 칸마다 기록하므로 큰 문서에서 크다(말뭉치에서 가장 큰 content.xml 12.8MB 문서에 5.7MB).

### 테스트

- `tests/table-bridge.test.ts`(세 가지 배치, 병합·너비·높이·모양, 잠긴 칸 목록과 JSON 왕복, 편집 없는 왕복과 다시 만든 표의 왕복), `table-edit.test.ts`(칸 하나, 칸 안 누름틀, 칸 안 나누기, 잠긴 칸, 셀 안 표, 혼합 틀 문단, 칸 채우기, 새 표), `table-structure.test.ts`(행·열 추가·삭제, 합치기·나누기, 틀 크기, 잠긴 칸이 있는 구조 변경), `table-cells.test.ts`(칸 안 목록, 구역 안 표, 빈 칸).
- `tests/helpers/table-editor.ts`: 편집기의 두 저장 방식(`patchCells` = `patchTableCellTexts`, `regenerate` = `generateTableModelXml`)과 등록 순서(`tableRegistry`). `table-fixtures.ts`: 한컴 모양의 표 문서.
- `tests/table-corpus.test.ts`(`ODT_CORPUS`): 모든 표 변환, 편집 없는 저장이 원본과 같음, 첫 표를 편집기가 그대로 다시 만들어도 쓰는 것이 없음, 첫 표의 칸 하나를 고치면 그 칸만 바뀜.

## 개체 층 (`src/objects`)

그림, 이음오피스가 고칠 수 없는 개체(수식, 도형, 글상자 속 글, 차례, 차트, 변경 기록), 각주·미주, 기존 메모를 맡는다. 진입점은 `src/objects/index.ts`.

- `registerObjectConverters(registry)`: 글자 층(그리고 표 층) 다음에 등록한다. 인라인 처리기(`draw:frame`과 도형·묶음 등 `DRAW_OBJECT_NAMES`, `text:note`, `office:annotation`, `office:annotation-end`, 변경 기록 표시), run 쓰기(그림·각주 번호), 끼우기(메모 시작·끝, 엔진이 읽지 못한 그림), 블록 처리기(`objects`: 차례·색인, 흐름에 바로 놓인 글상자·도형, 변경 기록 범위가 든 문단), 새 요소 쓰기(그림만 든 문단)를 한 번에 등록한다. 나중에 등록한 것이 먼저이므로 남의 몫은 `null`로 사양한다: 표를 담은 글상자(`draw:text-box > table:table`)는 표 층에 남긴다.

### 다리 docx에서의 이름

- 그림은 `wp:docPr` 이름으로 정체를 지닌다. 편집기는 크기 바꾸기·그림 바꾸기에서 이 이름을 그대로 둔다.
  - `odt-pic:<id>`: 고칠 수 있는 그림(`draw:frame` 안에 화면에 보일 수 있는 `draw:image` 하나).
  - `odt-keep:<id>:<kind>`: 고칠 수 없는 개체 하나를 대신하는 잠긴 자리 표시 그림. `<kind>`는 `equation`, `shape`, `textbox`, `toc`, `chart`, `revision`, `object` 중 하나(`OBJECT_KINDS`). 편집기는 이 종류로 "수식(한컴에서 보임)" 같은 이름표를 그린다(`parseKeepName`).
- 자리 표시 그림의 내용: 파일에 대신 쓸 그림이 있으면 그것(수식·차트의 `ObjectReplacements/…` 같은 같은 틀 안의 `draw:image`, 묶음·도형은 거의 전체를 덮는 안쪽 그림)을 쓰고, 없으면 언어와 무관한 옅은 회색 그림(`NEUTRAL_PLACEHOLDER_PNG`)을 쓴다. 대신 쓸 그림은 엔진이 변환 없이 보이는 형식(PNG, JPEG, GIF, BMP, SVG)만 쓴다. 크기는 개체의 크기(`svg:width`/`svg:height`, 없으면 글상자의 최소 크기나 안쪽 요소들을 합친 상자)다.
- `text:anchor-type="as-char"`는 `wp:inline`, 그 밖은 그래픽 스타일의 위치·감싸기를 옮긴 `wp:anchor`다.
- 각주·미주는 `word/footnotes.xml`·`word/endnotes.xml`로 간다. 본문 문단은 글자 층(`paragraphToOoxml`, owner `objects`)이 만들고, 본문 안의 개체는 바꾸지 않고 둔다. 번호 run의 글자는 엔진이 본문 순서로 매기는 번호와 같다.
- 메모는 진짜 docx 메모(`word/comments.xml`, 글자만)다. 메모가 달린 글자는 보통 글자로 고칠 수 있다. 끝이 없는 메모는 참조만 둔다.

### 다리 지도 `ext.objects` (`ObjectsExt`, JSON)

```ts
{
  version: 1,
  placeholders: [{ id, kind, name /* odt-keep:<id>:<kind> */, part, start, end,
    paragraph /* 인라인 개체가 든 문단 기록, 블록이면 null */, block, element /* 블록 자리 표시 */,
    widthEmu, heightEmu, preview, entries /* 개체가 가리키는 패키지 항목 */, finalText /* 변경 기록: 모든 변경을 반영한 글자 */ }],
  pictures: [{ id, name /* odt-pic:<id> */, part, start, end, openEnd, imageStart, imageOpenEnd,
    href, entry, rId, widthEmu, heightEmu, anchored, xEmu, yEmu, paragraph, entries }],
  comments: [{ id /* docx w:id */, name, start, end, endStart, endEnd, paragraph, offset,
    endParagraph, endOffset, ranged, text }],
  notes: [{ id /* docx w:id */, kind /* footnote | endnote */, start, end, bodyStart, bodyEnd,
    citation, bodyFirst, paragraph, paragraphs, text /* 엔진이 읽는 NoteInfo.text */, editable }],
}
```

편집기와 명령줄은 `placeholders`(순서대로, 종류 포함)를 읽는다.

### 저장

호출 순서(조립 층이 부른다):

```ts
prepareObjectWriteBack(rctx) // rebuildOdtBody 전
rebuildOdtBody(rctx)
updateOdtStyles(rctx)
const patches = rctx.finish()
const contentXml = applyTextPatches(doc.contentXml, patches['content.xml'])
const stylesXml = applyTextPatches(doc.stylesXml ?? '', patches['styles.xml'])
const changes = objectPackageChanges(rctx, { contentXml, stylesXml }) // 패치 적용 후
// 다시 묶기: changes.remove 항목을 빼고, changes.add 항목({ path, data, mediaType })을 더하고,
// META-INF/manifest.xml = patchManifestXml(원래 manifest, changes)
```

- 자리 표시: 남아 있으면 원래 바이트 그대로(크기·자르기 변경은 무시), 사라졌으면 개체를 지운다. 블록 자리 표시는 `identify`로 짝을 찾고 원래 범위를 그대로 쓴다.
- 그림: 원래 틀을 그대로 쓰고, 크기가 바뀌면 `svg:width`/`svg:height`(떠 있는 그림은 옮긴 `svg:x`/`svg:y`)만 고친다. 그림을 바꾸면(`a:blip`의 관계가 달라지고 바이트가 다르면) 틀은 두고 `draw:image`의 `xlink:href`만 새 항목으로 바꾼다. 새 그림은 새 그래픽 자동 스타일(`fr_io<n>`)을 쓴 새 `draw:frame`이다. 새 항목 이름은 `Pictures/io_<n>.<확장자>`이고 기존·새 항목과 겹치지 않으며 같은 바이트는 한 항목을 함께 쓴다.
- 그림만 든 문단은 편집기에서 그림 블록이 되어 숨은 정체 책갈피로 짝을 찾지 못한다. 바뀐 그림 블록은 새 요소 쓰기가 그림 이름으로 원래 문단을 찾아, 그 문단에 그 그림만 있었으면 문단의 나머지를 바이트 그대로 두고 그림만 다시 쓰고, 아니면 원래 문단을 origin으로 글자 층에 넘긴다.
- 패키지 항목: 그림·개체가 가리키던 항목(`entries`) 가운데 최종 `content.xml`·`styles.xml`의 어떤 `*:href`도 가리키지 않는 것만 지운다(`Object 1/` 같은 폴더는 그 안의 항목까지). 새 항목은 최종 XML이 가리키는 것만 더한다.
- 각주·미주: 번호 run이 `text:note`를 쓴다. 글자가 그대로면 원래 바이트, 바뀌었으면 본문만 문단 단위로 다시 쓴다(바뀌지 않은 문단은 원래 바이트, 바뀐 문단은 원래 문단을 origin으로 `paragraphToOdf`, 글자마다 그 글자가 이어받은 원래 글자의 모양). 편집기에서 각주만 고치면 문단 XML은 그대로이므로 `prepareObjectWriteBack`이 그 문단의 다리 요소 XML을 잠시 바꿔 다시 쓰게 하고, `objectPackageChanges`가 되돌린다. 새 번호 run은 같은 종류의 기존 각주 모양(문단 스타일·글자 모양·인용 형식 `1)`·본문과 인용의 순서)을 따른 새 `text:note`, 지운 번호 run은 각주를 지운다.
- 메모: 원래 `office:annotation`·`office:annotation-end` 바이트를 옮긴 자리에 다시 쓴다. 한 문단 안의 범위는 편집기가 메모로 표시한 run을 따라가고, 문단을 넘는 범위와 끝 없는 메모는 원래 위치를 `env.mapOffset`으로 옮긴다. 한 문단 안 범위의 글자를 모두 지웠거나 편집기가 메모를 지웠으면 메모를 지운다. 새 메모·답글·메모 내용 변경은 저장하지 않고 경고한다.
- 엔진이 읽지 못한 그림(캔버스가 없는 곳의 WMF/EMF 등)은 고친 문단의 run에서 빠진다. 편집된 XML에 그 그림 이름이 남아 있고 어떤 run도 그것을 지니지 않으면 원래 위치에 원래 바이트로 다시 쓴다.

### 알려진 한계

- 머리글·바닥글(`styles.xml`)의 그림과 각주·메모 본문 안의 개체는 OOXML로 옮기지 않고(숨은 책갈피, 원문 그대로) 둔다. 머리글 그림은 머리글 파트의 관계가 필요하다.
- 변경 기록 범위는 그 범위만이 아니라 범위가 든 최상위 문단 전체를 잠근다(`revision`). 목록·표 칸 안의 변경 기록 표시는 숨은 표시로 남고 글자는 고칠 수 있다.
- 표 칸 문단의 각주만 고치면 칸 문단 XML이 그대로다. `prepareObjectWriteBack`이 그 문단이 든 블록의 표 요소를 바뀐 것으로 표시하고, 표 층이 칸 문단마다 `paragraphNeedsRewrite(rctx, 문단 id)`를 보고 그 칸(셀 안 표 포함)을 다시 쓴다.
- 문단을 넘는 메모에서 시작이 든 문단을 지우고 끝이 든 문단을 손대지 않으면 끝 표시가 홀로 남는다.
- 새 각주 앞뒤의 기존 각주 인용 글자(`2)`)는 다시 매기지 않는다(한컴·LibreOffice가 열 때 다시 매긴다).
- 그림 문단의 정렬을 그림 도구로 바꾸면 그 문단은 글자 층으로 다시 쓰인다.

## 쪽 층 (`src/page`)

쪽 모양(`style:page-layout`), 바탕쪽(`style:master-page`, 머리글·바닥글과 첫쪽·왼쪽 변형), 구역을 docx의 구역과 머리글·바닥글 파트로 옮기고, 편집 결과를 `styles.xml`의 쪽 모양·바탕쪽과 구역을 시작하는 문단의 스타일에 되돌려 쓴다.

### 조립 층이 부르는 순서

```ts
const registry = registerPageConverters(registerTextConverters(new ConversionRegistry())) // 그다음 표·개체 층의 등록 함수
// 열기
convertOdtStyles(ctx)
convertOdtBody(ctx)
convertOdtPage(ctx) // 본문 다음, buildBridgeDocx 앞: 다리 요소에 구역 나눔을 넣고 ctx.docx.sectPr를 채운다
const docxBytes = await buildBridgeDocx(ctx)

// 저장
const items = await preparePageWriteBack(rctx) // rebuildOdtBody 앞: 쪽 모양·바탕쪽 패치를 넣고 본문 항목을 돌려준다
rebuildOdtBody(rctx, items)
updateOdtStyles(rctx)
const patches = rctx.finish()
```

- `registerPageConverters`는 `registerTextConverters` 다음에 부른다. 그때 등록된 글자 층 블록 처리기를 감싼 처리기(같은 id `text`)를 더하고, 머리글의 쪽 번호 필드 처리기(인라인, run writer)를 더한다. 감싼 처리기는 글자 층이 받을 노드만 받는다. 먼저 등록된 다른 처리기(표, 개체)가 받는 노드는 건드리지 않는다.
- `preparePageWriteBack`은 비동기다(편집된 docx의 머리글 파트를 읽는다). 저장 한 번에 한 번, 이 저장용 다리 지도 사본으로 부른다. 지도의 다리 요소에서 넣었던 구역 나눔을 걷어 낸다(몇 번 불러도 같다).

### 열기 (ODF → OOXML)

- 쪽 흐름(run): 문단(또는 표) 스타일의 `style:master-page-name`이 바뀌는 곳마다 새 쪽 흐름이 시작한다. 첫 흐름은 그런 문단이 없으면 `Standard`(없으면 첫 바탕쪽)를 쓴다. 요소가 없는 블록(그대로 두는 표 등)이 바탕쪽을 바꾸면 다음 요소부터다.
- docx 구역: 쪽 흐름마다 하나, 그리고 `text:section`의 앞뒤에서 이어지는 구역(`w:type continuous`, 그 구역 스타일의 단 수). 마지막이 아닌 구역은 마지막 문단의 `w:pPr`에 `w:sectPr`를 넣는다(문단이 하나도 없는 구역은 다음 구역에 합친다). 마지막 구역은 `ctx.docx.sectPr`. 구역 나눔을 지닌 문단 뒤의 요소(쪽 흐름을 끝내는 글상자 표 등)는 docx에서 다음 구역에 보이므로 지도에도 다음 구역 몫으로 적는다(저장 때 구역 대응이 어긋나지 않게).
- 위치 계산: ODF는 머리글을 쪽 여백 안에 둔다. 한컴도 `fo:margin-top`을 위쪽 여백으로, 머리글 스타일의 `svg:height`를 머리말 길이로 읽고, 바탕쪽에 머리글이 없어도 그 길이를 비워 둔다(한컴 판독 결과 36개로 확인). 그래서 `w:header = fo:margin-top`, `w:top = fo:margin-top + 머리글 높이(svg:height, 없으면 fo:min-height) + 머리글 간격(fo:margin-bottom)`. 아래쪽도 같다(바닥글 간격은 `fo:margin-top`).
- 쪽 번호: 쪽 모양의 `style:num-format` → `w:pgNumType w:fmt`, 흐름을 시작하는 문단 스타일의 `style:page-number`(숫자) → `w:start`.
- 단: 쪽 모양의 `style:columns`, 구역 스타일의 `style:columns` → `w:cols`. 보여 주기만 한다.
- 머리글·바닥글: 쪽 흐름마다 자기 파트를 따로 받는다(같은 바탕쪽을 쓰는 흐름도 사본). 그래야 한 흐름만 고친 것을 저장 때 알아본다. 문단은 글자 층 `paragraphToOoxml(..., { part: 'styles.xml', owner: 'page' })`, 표 같은 다른 자식은 다리 docx에 넣지 않는다(저장 때 제자리에 바이트 그대로). 칸 채우기:
  - `header-first`/`footer-first`가 있으면 `w:titlePg`. 첫 쪽 머리글이 없으면 그 칸에 보통 머리글 사본(`fallback`, ODF도 그렇게 보인다).
  - 어느 바탕쪽이든 `header-left`/`footer-left`가 있으면 `w:evenAndOddHeaders`(settings.xml을 만든다). 왼쪽 머리글이 없는 바탕쪽의 짝수 쪽 칸에는 보통 머리글 사본.
  - 앞 흐름에 머리글이 있었는데 이 흐름의 바탕쪽에는 없으면 빈 파트(`empty`): Word가 앞 구역의 것을 물려받지 않게 한다.
- 머리글의 `text:page-number`/`text:page-count`는 Word 필드(PAGE/NUMPAGES)로 보여 준다(편집기에서는 쪽 번호 표시 문자). 본문의 같은 필드는 글자 층 기본 처리 그대로다.

### 저장 (OOXML → ODF)

1. 걷어 내기: 다리 요소와 편집된 요소의 문단 속 `w:sectPr`를 걷어 내, 글자 층은 구역 나눔 없는 문단으로 비교한다. 글자 없는 구역 나눔 문단(엔진의 passthrough)은 문단으로 되돌리고, 편집기가 새로 넣은 빈 구역 나눔 문단은 ODF에 쓰지 않는다.
2. 구역 대응: 편집된 구역이 다리 구역의 첫 요소(앞 요소가 모두 지워졌으면 첫 남은 요소)로 시작하면 그 구역을 잇는다. 아니면 편집기에서 넣은 나눔이다. 아무도 잇지 않은 다리 쪽 흐름은 나눔이 지워진 것이다. `text:section` 경계의 이어지는 구역은 앞 흐름에 합친다.
3. 바뀐 것: 편집된 구역의 `w:sectPr`가 온 다리 구역(그 구역을 끝내는 문단, 새 나눔은 그것을 넣은 구역)과 비교한다. 나눔이 지워져 합친 구역은 뒤 구역의 `w:sectPr`를 지니므로, 그것과 같으면 앞 흐름의 바탕쪽을 그대로 따른다. 바뀐 값만 쓴다: 용지 크기·방향·여백(위 계산을 거꾸로: 머리글 간격은 두고 `w:header`를 여백으로, 나머지를 머리글 높이로), 쪽 번호 모양(`style:num-format`), 머리글·바닥글 영역, 첫쪽(`w:titlePg`)과 짝수 쪽(`w:evenAndOddHeaders`) 켜고 끄기. 단은 쓰지 않는다. 길이는 cm 소수 셋째 자리, 0.1mm로 딱 떨어지면 그 값(21cm는 `21.000cm`).
4. 바탕쪽 나누기: 같은 바탕쪽을 쓰는 흐름이 같은 상태를 원하면 바탕쪽을 그대로 고친다. 다르면 바뀌지 않은 흐름(없으면 첫 흐름, 시작 문단을 바꿀 수 없는 흐름이 있으면 그 흐름)이 원래 바탕쪽을 갖고, 나머지는 같은 상태끼리 사본(`<이름>_io<n>`, 원래 바탕쪽 바로 뒤)을 받는다. 새 나눔은 언제나 그 자리 바탕쪽의 사본. 쪽 모양은 그것을 쓰는 모든 바탕쪽이 같은 변경을 원할 때만 그대로 고치고(바뀌지 않은 채 쓰는 바탕쪽이 없으면 한 변경이 원본을 갖는다), 아니면 사본(자동 스타일 끝)을 만든다.
5. 흐름 시작 문단: 사본을 가리키게 하거나(바탕쪽 이름), 지운 나눔을 따르게 하거나(`style:master-page-name` 빼기), 쪽 시작 번호(`style:page-number`)를 쓸 때:
   - 그 자동 스타일을 그 문단 하나만 쓰고 이미 바탕쪽을 바꾸는 스타일이며 문단이 그대로면 스타일을 제자리에서 고친다(한컴의 `…_MS<n>_…` 스타일이 그렇다). 본문은 바이트 그대로다.
   - 아니면(새 나눔, 여러 문단이 함께 쓰는 스타일, 고친 문단) 감싼 처리기가 그 문단을 쓸 때 스타일을 복사한 새 자동 스타일로 바꾼다. 바뀌지 않은 문단은 원문을 쓰고 시작 태그의 스타일 이름만 바꾼다.
   - 시작이 문단이 아닌 곳(표 앞의 새 나눔), 목록 안 문단, 다른 처리기가 맡은 문단의 새 시작은 쓰지 못하고 경고를 남긴다.
6. 머리글·바닥글 영역: 편집된 파트가 다리 파트와 바이트가 같으면 그대로다. 다르면 다리 파트를 엔진으로 다시 읽은 문단(편집된 docx의 styles.xml로)과 문단마다 비교해, 같은 문단은 원래 ODF 바이트, 다른 문단은 원래 문단을 바탕으로 `paragraphToOdf(..., { part: 'styles.xml' })`, 새 문단은 앞 원래 문단을 본보기로 쓴다. 표 등 다른 자식은 제자리에 바이트 그대로. 쪽 번호 필드는 원래 요소(같은 순번)를 다시 쓰고, 새로 넣은 것은 `text:page-number`. 다른 구역의 파트를 물려받은 구역(앞과 같게)은 그 영역 내용을 그대로 복사한다.

### 다리 지도 `ext.page` (`PageExt`, JSON)

```ts
{
  version: 1,
  defaultMaster: string | null,     // 첫 흐름이 바탕쪽을 밝히지 않을 때 쓰는 바탕쪽
  evenAndOdd: boolean,              // 다리 docx의 w:evenAndOddHeaders
  runs: Array<{                     // 쪽 흐름(바탕쪽 하나가 이어지는 쪽들), 문서 순서
    master: string | null, layout: string | null,
    startParagraph: number | null,  // 바탕쪽을 바꾸는 문단 기록 id (암묵적 첫 흐름은 null)
    startBlock: number | null, startStyle: string | null,
    startFamily: 'paragraph' | 'table' | null,
    hidden: boolean,                // 자기 docx 구역이 없음(문단 없는 흐름)
    slots: Partial<Record<'header' | 'header-left' | 'header-first' | 'footer' | 'footer-left' | 'footer-first', string>>, // rId
  }>,
  sections: Array<{                 // 다리 docx 구역, 문서 순서
    run: number, region: number | null /* text:section 블록 */, continuous: boolean,
    first: number | null, last: number | null,  // 다리 요소 id
    carrier: number | null,         // w:sectPr를 지닌 문단 요소 (마지막 구역은 null)
    sectPr: string,                 // 써 넣은 w:sectPr 원문
  }>,
  parts: Record<rId, {
    rId, path, kind: 'header' | 'footer', master: string,
    region: 영역 이름 | null, fill: 'content' | 'fallback' | 'empty',
    paragraphs: number[],           // 영역 문단의 기록 id, 순서대로
    xml: string,                    // 써 넣은 파트 원문
  }>,
}
```

### 알려진 한계

- 머리글 안의 표·글상자는 다리 docx에 넣지 않는다(편집기에는 보이지 않고, 저장 때 그대로 남는다).
- 편집기에서 새로 친 머리글 글자는 서식 없는 run으로 오므로 원래 span 스타일의 글자 속성을 지운 복사본을 쓴다(문단 스타일의 글꼴을 따른다).
- 이어지는 구역 나눔(`continuous`)을 새로 넣으면 ODF에는 쪽 나눔으로 쓴다(경고). `text:section` 경계를 지우거나 옮기는 것은 쓰지 않는다.
- 바탕쪽의 `style:next-style-name`이 자기 자신이면 사본도 자기 자신을 가리킨다. 다른 바탕쪽을 가리키는 사슬(첫 쪽 → 보통 쪽)은 따로 복제하지 않는다.
- 한컴은 HWP→ODT에서 쪽 번호 위치(`pgnp`)를 잃으므로, 한컴 ODT의 머리글에는 쪽 번호 필드가 거의 없다(말뭉치 66개 중 1개).

### 테스트

- `tests/page-forward.test.ts`(구역·위치·머리글 칸·단·쪽 번호, 위치 왕복, 편집 없는 저장), `tests/page-edit.test.ts`(여백·용지·방향, 공유 바탕쪽 복제, 같은 변경은 제자리, 쪽 번호, 단은 쓰지 않음), `tests/page-headers.test.ts`(머리글 글자, 공유 바탕쪽의 한 흐름만 고친 머리글, 첫쪽·짝수 쪽 켜고 끄기, 쪽 번호 필드), `tests/page-breaks.test.ts`(나눔 추가·삭제, 시작 문단 삭제, 암묵적 첫 흐름의 쪽 번호).
- 도우미: `tests/helpers/page-bridge.ts`(조립 순서로 열기·되돌려 쓰기, 편집기처럼 구역 `w:sectPr` 고치기), `tests/helpers/page-fixtures.ts`(쪽 흐름 셋: `Standard`, `MP2`, `Standard`).
- `ODT_CORPUS`가 있으면 `tests/page-corpus.test.ts`가 모든 파일을 변환하고, 편집 없는 저장이 같은지, 마지막 구역 여백 편집이 그 쪽 모양만 바꾸는지, 마지막 구역 머리글 편집이 그 바탕쪽(과 새 자동 스타일)만 바꾸는지 본다. 말뭉치 66개: 쪽 흐름 82, docx 구역 82, 여러 흐름이 함께 쓰는 바탕쪽 0, 머리글·바닥글 파트 22.

## 공개 API (`src/index.ts`)

바깥(편집기, 명령줄, MCP)은 이것만 쓴다. 층 내부의 함수는 공개 API가 아니다.

```ts
odtToDocx(odtBytes: Uint8Array): Promise<{ docxBytes: Uint8Array; bridge: BridgeMap; report: ConversionReport }>
saveOdt(input: { originalOdt: Uint8Array; bridge: BridgeMap; editedDocx: Uint8Array }): Promise<Uint8Array>
docxToOdt(docxBytes: Uint8Array, options?: { renderedObjects?: Record<string, RenderedObject> | ReadonlyMap<string, RenderedObject> }): Promise<{ odtBytes: Uint8Array; report: ConversionReport }>
odtToText(odtBytes: Uint8Array): Promise<string>

interface RenderedObject { png: Uint8Array; widthEmu: number; heightEmu: number }
type ConversionReport = ReportItem[]
interface ReportItem { kind: 'converted' | 'dropped'; feature: ReportFeature; count: number }
type ReportFeature = 'toc' | 'chart' | 'equation' | 'shape' | 'textbox' | 'columns' | 'citation' | 'cross_reference'
  | 'page_color' | 'mirror_margins' | 'theme' | 'comment' | 'revision' | 'ink' | 'watermark' | 'password'
  | 'protection' | 'form_field' | 'object'
```

- 여는 오류는 `OdtOpenError`(`code`: `encrypted` | `not-odt-text` | `zip-rejected` | `corrupt`)와 그 하위 `OdtEncryptedError`, `OdtNotTextError`다. `isOdtOpenError(err, 'encrypted')`로 가려 "암호를 푼 뒤 열어 달라"고 안내한다. `odtToDocx`, `saveOdt`(원본을 다시 연다), `odtToText`가 같은 오류를 던진다. `docxToOdt`는 docx가 아니면 docx 엔진의 오류를 그대로 던진다.
- `bridge`는 JSON이다(IPC로 오간다). `saveOdt`는 받은 지도를 바꾸지 않는다.
- 그 밖의 공개: `ODT_MIMETYPE`, `REPORT_FEATURES`, 잠긴 칸 읽기(`protectedCellsOf`, `isProtectedCell`), 자리 표시 읽기(`parseKeepName`, `OBJECT_KINDS`, `ObjectsExt`).

## 조립 (`src/assemble`)

### 등록 순서 (`registry.ts`)

`odtRegistry()` = 글자 → 표 → 개체 → 쪽. 나중 것이 먼저 고르므로 표·개체가 자기 노드를 글자 층보다 먼저 가져간다. 쪽 층의 장식(같은 id `text`)은 글자 처리기가 받을 노드만 받는다(앞에 등록된 표·개체가 맞으면 사양한다). `docxToOdt`는 여기에 이름표 run 쓰기(`labelRunWriter`)만 더한다.

### 열기 (`odtToDocx`, `odt.ts`)

`openOdt` → `convertOdtStyles` → `convertOdtBody` → `convertOdtPage` → 사람 정보(`docProps/core.xml`) 더하기 → `buildBridgeDocx`. 다리 docx의 `core.xml`은 `dc:creator` = `meta:initial-creator`, `cp:lastModifiedBy` = `dc:creator`이고, 그 값은 `ext.assemble.core`에 남는다. meta.xml에 사람 이름이 없으면 `core.xml`을 넣지 않는다.

### 저장 (`saveOdt`, `odt.ts`)

1. 원본을 다시 열고(`openOdt`), 다리 지도를 JSON으로 깊이 복사한다(쪽·개체 층의 앞 단계가 지도를 고친다).
2. `prepareObjectWriteBack` → `preparePageWriteBack`(편집된 항목을 돌려준다) → `rebuildOdtBody(rctx, items)` → `updateOdtStyles` → `rctx.finish()` → `applyTextPatches`(content.xml, styles.xml) → `objectPackageChanges` → `patchManifestXml`.
3. meta.xml: 편집된 docx의 `w:removePersonalInformation`이 켜졌거나, 다리가 보인 `dc:creator`/`cp:lastModifiedBy`가 편집된 `core.xml`에서 비었으면 `meta:initial-creator`, `dc:creator`, `meta:printed-by` 요소를 지운다. 아니면 바이트 그대로다(`dc:date` 등도 고치지 않는다).
4. 바뀐 파트도, 더하거나 지울 항목도 없으면 받은 바이트를 그대로(같은 객체) 돌려준다.
5. 다시 묶기(`repackOdt`, `zip.ts`): `mimetype`을 맨 앞에 압축 없이(원래 압축돼 있었으면 풀어서), 나머지는 원래 순서로. 손대지 않은 항목은 원래 압축 데이터·방식·CRC를 그대로 복사하므로 푼 바이트가 같다. 바뀐 파트는 deflate, 지운 항목(폴더면 그 안까지)은 빼고, 새 항목은 끝에 더한다. 원본의 스키마 오류는 고치지 않는다.

- zip 쓰기는 자체 구현이다(CRC-32, `CompressionStream('deflate-raw')`, zip-gate의 `streamBytes`). `node:*`도, `Blob.stream`도 쓰지 않는다.

### docx → 새 ODT (`docxToOdt`, `export/`)

원본 ODT가 없는 경로(새 문서의 ODT 저장, 다른 이름으로 저장, 마크다운·HTML 내보내기, 명령줄 변환). 받은 ODT 저장과 같은 쓰기 함수를 쓴다.

1. docx를 `parseDocx`로 읽고, 본문 요소마다 쓰기 함수가 받을 항목으로 고친다(`export/blocks.ts`):
   - 변경 기록: 지운 글자·블록은 빼고 넣은 글자는 남긴다(최종 글자). 메모는 쓰지 않는다.
   - 글자 스타일(`w:rStyle`)의 모양을 run에 접어 넣는다(ODF 쪽에 대응하는 글자 스타일을 만들지 않는다).
   - 차트·수식·도형·글상자는 그림 run이 된다. 순서: `renderedObjects`의 그림 → 파일 안 대체 그림(`mc:Fallback`의 `a:blip`/`v:imagedata`, OLE 미리보기) → 종류 이름("Chart", "Equation", "Shape", "Text box")을 적은 이름표 상자(`draw:frame` + `draw:text-box`, 회색 테두리). 셋 다 `converted`로 센다. 가로줄 그림(`rule`)은 얇은 회색 그림이다.
   - `renderedObjects` 열쇠: `"<docxIndex>:<n>"` = 그 본문 요소(`Block.docxIndex`) 안 n번째(0부터, 문서 순서, 표 칸 포함) 변환 개체. `"<docxIndex>"`만 쓰면 첫 개체다.
   - 그림은 패키지에서 관계(`r:embed`/`r:id`)로 원래 바이트를 읽는다(메타파일도 그대로). 없으면 엔진의 data URL. 다리 docx의 이름(`odt-pic:`, `odt-keep:`)은 지운다(새 문서에서는 모두 새 그림). 받은 ODT를 연 다리 docx를 새 ODT로 저장할 때 잠긴 개체 자리 표시는 그 그림이 되고 종류별로 `converted`로 센다.
   - 필드로 잠긴 문단: 차례 줄은 보통 글자(제목 + 탭 + 쪽 번호, 오른쪽 점선 탭), 다른 필드 결과도 보통 글자. 엔진이 읽지 못한 잠긴 문단은 XML에서 글자 run과 개체를 다시 꺼내 만든다. 문단의 `w:sectPr`는 걷어 낸다.
   - 쪽 나누기(`w:br w:type="page"`, 엔진에서는 run 글자 `\f`): 문단을 나누고 뒷부분이 `fo:break-before="page"`로 새 쪽을 시작한다(한컴은 `fo:break-after`를 따르지 않는다). 나누기만 있는 문단은 빈 문단을 남기지 않고 다음 요소가 새 쪽을 시작한다. 다음 요소가 표 같은 문단 아닌 것이면 그 앞에 쪽을 시작하는 빈 문단을 둔다. 나뉜 목록 항목의 뒷부분은 번호 없는 문단이다. 문서 끝의 나누기는 새 쪽을 시작하는 빈 문단 하나가 된다(Word가 보이는 마지막 빈 쪽).
   - 표 행 높이의 바닥(`export/rows.ts`): 높이가 없거나 "최소" 높이가 더 낮은 행에 Word가 그 행을 그리는 높이보다 크지 않은 최소 높이(`style:min-row-height`)를 준다. 칸마다 위아래 여백 + 문단마다 (앞 간격 + 한 줄 + 뒤 간격), 한 줄은 글자 크기 × 글꼴의 한 줄 비율(Windows의 winAscent+winDescent: Calibri 1.2207, 맑은 고딕 1.3301 등, 목록에 없는 글꼴은 1) × 줄 간격이다. 표 스타일의 문단 간격·글자 크기는 더 작은 쪽을 쓴다. 병합된 칸·세로쓰기 칸은 세지 않고, "고정" 높이는 그대로다. 한컴은 ODT 칸의 마지막 문단 뒤 간격과 마지막 줄의 줄 간격 몫을 빼고 그려서, 높이 없는 행이 글자 높이만큼으로 줄어든다(12pt 한 줄 = 12pt 행). 한컴이 쓴 ODT도 모든 행에 최소 높이를 적는다.
2. 뼈대 ODT를 만든다(`export/styles.ts`): `w:docDefaults` → `style:default-style`(크기가 없으면 Word 기본 10pt, 라틴 글꼴이 없으면 Times New Roman, 언어), docx 문단 스타일마다 공용 문단 스타일, 쪽 묶음마다 쪽 모양과 바탕쪽. `office:version="1.3"`, 매니페스트 `manifest:version="1.3"`.
   - 공용 문단 스타일은 모양 전체를 적는다: 문서 기본값(왼쪽 정렬, 줄 간격, 앞뒤 간격, 글꼴, 크기) 위에 엔진이 상속을 푼 값(`StyleInfo.display`). 한컴은 `style:default-style`의 줄 간격·정렬을 쓰지 않고(정렬은 양쪽으로 본다) 스타일에 적힌 값만 쓰기 때문이다. 기본 스타일은 `Standard`.
   - 개요 스타일(`text:outline-style`)은 번호 없음으로 적는다. 한컴은 이것을 보지 않고 모든 `text:h`에 "1.", "1.1." 번호를 붙이므로, 제목은 `text:h`가 아니라 `style:default-outline-level`을 지닌 스타일의 `text:p`로 쓴다(한컴이 자기 "개요 n" 문단을 쓰는 방식, `export/headings.ts`). 공용 제목 스타일(`Heading1` …)에 그 수준을 적고, 제목 문단의 자동 스타일에도 적는다. 보통 문단과 함께 쓰는 자동 스타일이나 수준이 다른 경우는 사본(`<이름>_L<수준>`)을 만든다. LibreOffice는 스타일의 수준으로 제목을 알아보고, `odtToDocx`도 `Heading1…`이라는 이름으로 docx 제목으로 읽는다.
   - 쪽 묶음: docx의 쪽 구역마다 바탕쪽 하나(`Standard`, `MP2` …, 모양이 같아도 따로)를 써서 한컴에서도 구역이 구역으로 남는다. 이어지는 구역 나눔(`continuous`, `nextColumn`)은 앞 묶음에 합치고, 단이 다르면 그 구역을 `text:section`(구역 스타일 `style:section-properties`의 `style:columns`)으로 감싼다. 이때 쪽 모양은 한 단이다. 쪽 전체가 여러 단이면 쪽 모양(`style:page-layout-properties`)에 `style:columns`를 쓴다. 단은 언제나 `style:column` 자식(`style:rel-width="1000*"`, 단 사이 간격의 반씩 `fo:start-indent`/`fo:end-indent`)을 함께 쓴다: 자식 없는 `style:columns fo:column-count="2"`는 한컴을 멈추게 한다("원격 프로시저를 호출하지 못했습니다"). 한 단이면 `style:columns`를 쓰지 않는다. 너비가 다른 단(`w:col` 너비)만 `columns`로 보고한다(같은 너비로 바뀜).
   - 위치: 쪽 층의 계산을 거꾸로 한다. 머리글이 있으면 `fo:margin-top = w:header`, 머리글 높이(`svg:height`) = `w:top − w:header`, 간격 0. 없으면 `fo:margin-top = w:top`. 아래도 같다. 제본 여백은 왼쪽(또는 위) 여백에 더한다. `mirrorMargins`는 `style:page-usage="mirrored"`.
   - 머리글 칸: 기본 `style:header`, `w:titlePg`면 `style:header-first`, `w:evenAndOddHeaders`면 `style:header-left`(없는 쪽은 빈 칸). Word처럼 앞 구역의 머리글을 물려받는다.
3. 뼈대를 받은 ODT처럼 열고(`openOdt`), 빈 다리 지도에 docx 스타일 id ↔ ODF 공용 스타일 대응만 넣는다. 본문은 쪽 묶음마다 `rebuildFlow`(모든 항목이 새 요소라 새 요소 쓰기 함수가 쓴다: 문단·목록·표·그림·각주)로 쓰고, 두 번째 묶음부터는 첫 요소의 스타일 사본에 `style:master-page-name`(쪽 번호 시작이 있으면 `style:page-number`)을 준다(표면 표 스타일 사본). 머리글·바닥글은 쪽 층의 `regionInnerXml`로 채운다.
4. `finish` → 패치 적용 → `objectPackageChanges`(새 그림 항목) → 매니페스트를 새로 써서 묶는다(`mimetype` 맨 앞·무압축).

### `odtToText` (`text.ts`)

문단·제목을 문서 순서로 한 줄씩, 표는 행마다 한 줄(칸은 탭, 칸 안 문단과 셀 안 표는 공백으로 이어 붙임), 글상자 안 표는 그것을 담은 문단 뒤에, 각주·미주는 본문 자리에 인용 글자만 두고 끝에 `인용 본문`으로 모은다. 지운 변경 기록, 메모, 색인 틀 글자, 그림의 이진 데이터는 뺀다. 여는 오류 외에는 던지지 않는다.

### 바뀌는 것 (`report.ts`)

- ODT → docx(`odtToDocx`): 잠긴 개체 자리 표시를 종류별로(`toc`, `chart`, `equation`, `shape`, `textbox`, 그 밖은 `object`) `converted`, 변경 기록 범위(`text:changed-region` 수와 잠긴 범위 중 큰 쪽) `revision` `converted`, 누름틀(시작·점 책갈피 수) `form_field` `converted`, 잠긴 칸과 보호된 구역 `protection` `dropped`.
- docx → ODT(`docxToOdt`): 차례 수(`toc`), 개체 종류별(`chart`/`equation`/`shape`/`textbox`), 너비가 다른 단(`columns`), 인용·참고 문헌 필드(`citation`), 상호 참조·캡션 필드(`cross_reference`, 차례의 `PAGEREF _Toc`는 빼고), 테마가 답하지 못하는 테마 참조(`theme`)는 `converted`. 거울 여백은 `style:page-usage="mirrored"`로 그대로 남으므로 보고하지 않는다(`mirror_margins`는 목록에만 남는다).
- 테마(`export/theme.ts`): 엔진이 읽으면서 테마 글꼴(`w:asciiTheme` 등, 비어 있는 동아시아·복합 문자 칸 포함)과 테마 색(`w:themeColor`/`w:themeFill`, 밝기·어둡기 포함)을 실제 값으로 풀고, 편집기와 ODT가 같은 값을 쓴다. 보이는 것이 같고 테마와의 연결만 없어지므로 보고하지 않는다. 테마 부분이 있다는 것만으로도 보고하지 않는다. 내보내는 내용(본문, 머리글·바닥글, 그것들이 쓰는 스타일과 그 부모, 문서 기본값)의 테마 참조 가운데 테마가 답하지 못하는 것만 하나씩 센다: 테마 부분이 없거나 읽히지 않는데 글꼴 테마를 가리킴, 가리킨 라틴 글꼴 칸이 비어 있음, 테마에 없는 색 칸을 가리킴(`dk1`/`lt1`은 엔진의 기본값이 있어 빼고). 이때 엔진과 ODT는 Word가 곁에 저장해 둔 값(`w:val`, 글꼴 이름)을 쓰는데, Word라면 테마의 값으로 바꿔 보였을 것이다. 쪽 색(`page_color`), 메모(`comment`), 변경 기록(`revision`, 표시 수), 잉크(`ink`), 워터마크(`watermark`), 암호 해시(`password`), 편집 제한·읽기 전용 권장(`protection`)은 `dropped`.
- 개수가 0인 항목은 넣지 않는다. 순서는 `REPORT_FEATURES` 순서다.

### 알려진 한계

- 새 ODT의 머리글·바닥글: 표와 그림은 넣지 않는다(문단만). 머리글 문단은 docx 스타일 이름을 잃고 엔진이 푼 문단 모양으로 쓴다.
- 새 ODT의 각주 본문은 글자만 옮긴다(각주 스타일·글자 모양 없음, 기본 문단 스타일).
- 문단 스타일이 굵게인데 run이 굵게를 끈 경우(`w:b w:val="0"`)처럼, 스타일 값을 run에서 끄는 모양은 새 ODT에 옮기지 않는다.
- 글상자 안 글, 수식의 내용은 그림이나 이름표가 되어 글자로 남지 않는다(편집기가 그린 그림을 주면 보이는 모양은 남는다).
- `docGrid`(줄 격자), 쪽 테두리, 줄 번호, 세로쓰기는 옮기지 않는다. 짝수/홀수 쪽에서 시작하는 구역은 보통 쪽 나눔이다.
- 표 스타일(`w:tblStyle`)의 문단 간격(`TableGrid`의 뒤 간격 0, 줄 간격 1)은 칸 문단의 ODF 모양에 넣지 않는다(행 높이 바닥은 더 작은 쪽을 쓴다). 말뭉치에는 그런 표가 없다.
- 한컴에서 본 모양(2026-10-15, 한글 2024, docx 27개): 쪽 수는 이음오피스 화면(편집기 쪽 나누기, `apps/docs/tests/pagination-parity.test.ts`, Word와 25/25 같음)과 23개가 같다. 다른 4개(01, 12, 13, 16)는 Calibri 라틴 글이 대부분인 문서로, 한컴이 ODF 비율 줄 간격을 글꼴에 따라 늘려 읽는다(`fo:line-height="115%"` → Calibri 183%, SimSun 150%). docx의 값(`w:line="276"` → 115%)을 그대로 적은 것이고, 한컴이 같은 docx를 직접 읽어도 쪽 수가 같이 늘어난다(01 5쪽, 12 4쪽, 13 10쪽, 16 3쪽, 우리 것은 5·4·11·3). 같은 글의 글꼴·크기·굵기·정렬·앞뒤 간격·들여쓰기는 docx를 한컴이 읽은 것과 757개 문단에서 모두 같다(Word 기본값을 쓰는 docDefaults 없는 시험 파일 2개는 한컴이 docx를 자기 기본값으로 읽어 다르다). 각주는 한컴에서 자동 번호 조판 부호(`atno`)가 더 보이고, 한 단 구역은 단 정의 조판 부호(`cold`)가 첫 구역에만 있다(구역 수 `secd`와 용지는 같다).
- 떠 있는(anchored) 개체의 이름표·그림은 글자처럼(as-char) 놓는다. 떠 있는 그림은 objects 층 규칙대로 문단 기준 위치로 옮긴다.

## 테스트

- `npm run test -w @genoffice/odt-engine`. 실제 정부 파일은 저장소에 넣지 않고, 한컴 ODT의 특징을 흉내 낸 합성 파일로 시험한다.
- 합성 파일 생성기는 `tests/helpers/`에 있다. 모든 층의 테스트가 함께 쓴다.
  - `build-odt.ts`: `buildOdt(options)`/`buildOdtPackage(options)`. 기본값이 한컴과 같다(항목 이름순이라 `mimetype`이 맨 앞이 아니고 압축됨, `office:version` 없음, 문단마다 자동 스타일과 탭 목록, 머리글·바닥글이 있는 바탕쪽 둘). `body`, `extraContentAutomaticStyles`, `extraCommonStyles`, `masterStyles`, `pictures`, `extraEntries`, `overrideParts`, `encrypted`, `mimetype`, `generator`로 무엇이든 바꿔 넣는다.
  - `hancom-fragments.ts`: 한컴 모양의 조각(`hPara`, `hTable`, `hCell`, `hFramedTable`, `hFieldBookmark`, `hFootnote`, `hAnnotation`, `hImageFrame`, `hFormulaObject`, `hCustomShape` 등). 조각은 쓴 문자열을 그대로 돌려주므로 테스트가 "범위로 자른 원문 = 조각"을 바로 비교할 수 있다.
  - `hancom-sample.ts`: 위 특징을 모두 담은 문서 하나(글상자 안의 표, 본문 표, 셀 안의 표, 병합·가려진 셀, 잠긴 셀, 누름틀 책갈피, 그림, 각주, 메모, 수식 개체, 도형, 목록, 구역, 차례, 같은 바탕쪽을 쓰는 여러 구역).
  - `bridge.ts`: `odtToBridge`(열기, 지도는 JSON 왕복), `editorSave`(편집기처럼 `rawPPr`을 다시 쓰거나 합쳐 `saveDocx`로 저장; `keep`/`edit`/`insert`/`xml`), `editOnly`, `replaceText`, `writeBack`(편집된 docx를 원본 ODT 문자열에 되돌려 씀). 다른 층의 왕복 시험도 이것을 쓴다.
  - `text-fixtures.ts`: 글자 층 시험 문서(누름틀, 제목, 링크, 목록, 쪽 나누기, 공백, 필드·각주, 지우기용 강한 글자 모양).
- 실제 파일 점검은 저장소 밖에서만 한다: `ODT_CORPUS=<폴더> npm run test -w @genoffice/odt-engine`. 변수가 없으면 `tests/core-corpus.test.ts`, `tests/text-corpus.test.ts`는 건너뛴다. 글자 층 점검은 모든 문단(셀·글상자·머리글 포함)을 변환해 다리 docx에서 같은 글자로 읽히는지, 편집 없이 되돌려 쓰면(`rawPPr` 지름길 없이 모든 속성을 비교해도) 같은 글자이고 새 스타일이 없는지, 편집 없는 저장이 원본과 같은지, 문단 하나를 고치면 그 문단만 바뀌는지 본다.
- 조립 층 시험:
  - `tests/assemble-api.test.ts`: 공개 API로 편집 없는 저장 = 원본 바이트, 문단·칸·그림·머리글 하나씩 고치면 그 파트의 그 요소만 바뀜(다른 항목의 푼 바이트 같음, `mimetype` 맨 앞·무압축, 원래 순서), meta.xml은 개인 정보 제거 때만, 암호 ODT는 `OdtEncryptedError`, ODT→docx 보고, `odtToText`(글상자 표, 셀 안 표, 각주).
  - `tests/assemble-integration.test.ts`: 층 사이 고침(구역 안 표의 `identify`, 칸 안 각주, as-char 그림 뒤 공백, 칸 안 그림, 글상자 표로 끝나는 쪽 흐름).
  - `tests/assemble-export.test.ts`: `docxToOdt` 패키지 표준, 다시 읽은 내용(문단·글자·표 격자·그림·각주·쪽·머리글·기본 글꼴/크기/줄 간격)이 원본 docx와 같음, 제목·목록·링크·글자 모양, 구역별 바탕쪽(모양이 같아도 따로), 머리글 위치 계산, 이어지는 구역의 단(`text:section`)과 쪽 전체 단, 한컴이 다르게 읽는 것(제목을 `text:p`로, 문단 속 쪽 나누기, 표 행 높이 바닥, 공용 스타일의 모양 전체), 다리 docx 이름의 그림, 대체 그림·이름표·편집기 그림, 보고(테마는 테마가 답하지 못하는 참조만, 거울 여백은 보고하지 않음).
  - 도우미: `tests/helpers/api.ts`(공개 API 왕복, 패키지 비교), `build-docx.ts`/`docx-fixtures.ts`(합성 docx, 모든 기능을 담은 `kitchenSink`), `docx-signature.ts`(docx를 비교할 수 있는 값으로).
- 층 사이 시험: `ODT_FULL_REGISTRY=1 npm run test -w @genoffice/odt-engine`이면 모든 층의 시험이 조립 등록 순서와 조립 저장 순서(`tests/helpers/full.ts`)로 돈다. 일부러 일부 층만 등록해야 뜻이 있는 시험 4개는 이때 건너뛴다.
- `ODT_CORPUS`가 있으면 `tests/assemble-corpus.test.ts`가 공개 API로 66개를 모두 열고, 편집 없는 저장이 원본 바이트와 같은지, 문단 하나·칸 하나·여백 하나 편집이 그 파트의 그 요소(새 자동 스타일 빼고)만 바꾸는지 보고, 가장 큰 파일의 열기·저장 시간을 찍는다. `tests/assemble-export-corpus.test.ts`는 `<ODT_CORPUS>/docx`의 docx를 `docxToOdt`로 바꿔 `<ODT_CORPUS>/out-docx2odt`(저장소 밖)에 쓰고, 다시 읽어 내용이 같은지 본다. 받은 ODT 66개를 연 다리 docx도 `docxToOdt`로 새 ODT를 만들어 같은지 본다(편집기에서 연 ODT를 다른 이름으로 ODT 저장하는 경우). 말뭉치 점검은 `out-`으로 시작하는 폴더를 건너뛴다.
- 말뭉치 결과(2026-10-15): 66/66 열림, 편집 없는 저장 66/66 바이트 같음, 문단 편집 54개·칸 편집 57개·여백 편집 65개 파일 모두 해당 요소만 바뀜(나머지는 고를 요소가 없음). docx 27개와 받은 ODT 66개의 다리 docx 모두 새 ODT로 바꿔 다시 읽은 내용 같음. ODF 검사기(odfvalidator 0.13, ODF 1.3): docx→ODT 결과 93개 모두 오류 0(목록 시작 값 0을 쓰던 것을 고친 뒤). 받은 ODT 13개를 고쳐 저장하면 오류가 원본보다 늘지 않음(다시 묶기로 패키지 오류가 2개에서 3개 줄어듦). 시간: 가장 큰 파일(6.7MB) 열기 약 0.4초에서 1초, 편집 없는 저장 약 0.5초, content.xml이 가장 큰 파일(12.5MB) 열기 약 1.4초에서 2초, 편집 없는 저장 약 3초.
