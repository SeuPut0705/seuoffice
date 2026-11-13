# docx-engine

## 맡은 범위

docx 한 파일의 읽기와 쓰기 전부를 맡는다.

- `parseDocx`: 본문 파트의 최상위 요소를 블록 트리로 바꾸고, 블록마다 원본 XML 조각과 순번(`originalXml`, `docxIndex`)을 붙인다.
- `generate.ts`: 편집된 블록을 OOXML 조각으로 만든다.
- `saveDocx`: 바뀐 블록만 원본 XML에 끼워 넣고 zip을 다시 묶는다.
- 그 밖에 빈 문서 템플릿, 구역·머리글·각주·메모·워터마크·차트·스타일·번호 매기기 수정, 보호 암호 해시, 수식 변환(`./math`), EMF/WMF 변환(`./metafile`), 큰 문서의 그림을 디스크에 남겨 두는 지연 미디어(`./lazy-media`, `./zip-splice`)를 가진다.

## 맡지 않는 것 (경계)

- 편집기(Tiptap), 쪽 나눔과 화면 그리기, 어느 블록이 고쳐졌는지의 추적, 원본 파일 보관, IPC는 `apps/docs`다. 엔진은 "어느 블록이 원본 그대로이고 어느 블록이 새로 만들어졌는가"(`SaveBlock[]`)를 받아 바이트를 돌려줄 뿐이다.
- AI 도구 정의와 실행은 `apps/docs`와 `packages/agent-core`다. 엔진은 AI를 모른다.
- HTML→docx는 `packages/html2docx`, PDF→docx는 `packages/pdf2docx`다. 후자는 이 엔진의 `buildBlankDocx` → `parseDocx` → `saveDocx`를 호출한다. `w:altChunk` 안의 HTML을 펼칠 변환기는 엔진이 갖지 않고 호스트가 `setAltChunkHtmlConverter`로 넣어 준다.
- 압축 폭탄 판정의 구현은 `packages/zip-gate`에 있고, 여기서는 다시 내보내기만 한다.
- 첨부용 평문 추출은 `packages/file-parse`가 `parseDocx` 결과를 납작하게 만들어 쓴다.

## 항상 지켜야 하는 것

- 바뀐 것이 없으면 `saveDocx`는 `originalBytes`를 그대로 돌려준다. 다시 압축하지 않는다. 이 판정은 `isUnchanged`에 옵션을 하나씩 나열한 조건이므로, `SaveOptions`에 필드를 추가하면 이 조건에도 추가한다. 빠뜨리면 그 옵션만 바꾼 저장이 원본 바이트를 돌려주며 변경이 조용히 사라진다.
- 건드리지 않은 블록은 원본 본문 XML의 부분 문자열을 그대로 복사한다. XML 전체를 파싱했다가 다시 직렬화하지 않는다. 그렇게 하면 속성 순서, 자기 닫힘 표기, 엔티티 표기가 바뀐다. 위치는 `scanBody`가 문자 범위로 잡는다.
- 본문 밖의 zip 항목은 내용을 바꾸지 않고 옮긴다. 다만 변경이 있는 저장은 zip을 새로 만들어 DEFLATE 6단계로 묶으므로 파일 전체 바이트는 달라진다. 충실도는 항목별 내용으로 비교한다.
- 새로 만든 블록은 문서에 이미 있는 스타일만 참조한다(`headingStyleIds`, `listParagraphStyleId`). 없는 스타일 id를 지어내지 않는다.
- 엔진이 손대지 않은 바이트를 일부러 바꾸는 경우는 다음 경우뿐이고, 늘리지 않는다.
  - ISO Strict 이름공간과 비표준 접두사를 불러올 때 과도기(transitional) 표기로 정규화한다. 저장 결과도 과도기형이 된다.
  - 과도기형 문서도 단위가 붙은 값(`12pt` 등)을 속성의 기본 단위로 바꾸고, 중복된 `w:pStyle`·`w:rStyle`은 마지막 것만 남긴다. 단위 값의 정규화는 해당 파트의 태그 표기도 다시 쓸 수 있다. 이 결과는 변경이 있는 저장에만 쓰며, 편집 없는 저장은 원본 바이트를 돌려준다.
  - 변경이 있는 저장은 본문·머리글·꼬리말·각주·미주·용어집의 짝 잃은 이동 범위 표식을 지운다(`cleanStoryMoveRanges`). 짝이 맞는 표식은 남긴다. 표식만으로는 편집 없는 저장을 다시 쓰지 않는다. 수락·거절이 고아 표식만 찾았으면 호출자가 `dropOrphanMoveRanges: true`로 정리를 요청하며, 지울 표식도 없으면 원본 바이트를 돌려준다.
  - 변경이 있는 저장은 내용이 없는 zip 폴더 항목을 옮기지 않는다. 파일 항목은 남기며, 편집 없는 저장은 폴더 항목을 포함한 원본 바이트를 돌려준다.
  - 최종 본문에서 닿지 않게 된 자원을 정리한다(`cleanupDocxOwnedResources`).
  - 필드의 begin/separate/end 짝을 맞춘다(`balanceFieldChars`). 짝이 어긋난 필드는 Word가 손상 파일로 본다.
  - 개인 정보 제거 플래그가 켜진 문서에서 작성자·조직 메타데이터를 지운다. 이 경우에는 편집이 없어도 원본 바이트를 그대로 돌려주지 않는다.
- 자원 정리는 좁게 한다. 문서 루트에서는 그림·차트·다이어그램·하이퍼링크·OLE 관계만 끊고, 머리글처럼 살아남은 다른 파트가 가리키는 대상은 남기며, 모르는 종류나 사용자 정의 파트는 지우지 않는다.
- 새 id는 기존 것과 겹치지 않게 낸다. 관계 id는 따옴표 종류와 `=` 주변 공백에 상관없이 읽은 최대값 다음부터, `wp:docPr` id는 9000번대에서 문서에 이미 있는 값을 피해, 책갈피 id는 문서 최대값 위에서 낸다. 이미 있는 id를 "없다"고 읽으면 중복 id가 생기고 Word가 복구를 묻는다.
- 문서 안에 남는 이름은 바꾸지 않는다: 새 그림 파트 `word/media/aidocs<N>.<확장자>`, 잉크 그림의 `wp:docPr` 이름 접두 `aidocs-ink`와 파트 `word/media/aidocsink<N>.png`. 다시 열었을 때 자기가 만든 것을 알아보는 열쇠이고, 원본 프로그램과 주고받는 문서에 이미 들어 있다.
- 지연 미디어의 URL 스킴 `seuoffice-docx-media`는 실행 중에만 쓰이는 이름이라 파일에 남지 않는다. 자리표시자 머리말(`lazy-media.ts`의 `MAGIC`)은 길이를 바꾸지 않는다. 자리표시자가 든 zip은 렌더러에 건네는 사본이고, 사용자 파일로 쓰기 전에는 반드시 `materializeDocx`로 원본 바이트를 되돌린다. 다만 그림을 되돌리지 못한 복구 사본은 자리표시자를 지닌 채 앱 데이터에 남으므로, 예전 버전이 쓴 머리말(`src/old-names.ts`의 `OLD_LAZY_MEDIA_MAGICS`)도 읽는다.
- 열 때 거부하는 한도는 파트 10,000개, 파트당 512 MiB, 합계 1.5 GiB(`DOCX_ZIP_LIMITS`)이고 zip64와 암호화 항목도 거부한다. `loadDocxZip`은 파트를 실제로 풀어 보는 검사를 JSZip 로드보다 먼저 돌린다. 이 순서를 바꾸지 않는다.
- 그 밖의 방어 상한: 표 중첩 8단계 초과는 1×1 표로 납작하게 만든다. `altChunk` 64 MiB, gzip 메타파일 해제 64 MiB, TIFF 1억 5천만 픽셀·한 변 16,384, 차트 캐시 점 1,048,576개·계열 256개, 지연 미디어 경로 512자(`..` 마디 거부). 보호 암호의 `spinCount`는 1,000,000으로 자른다.
- 깨진 XML이 문서 전체를 실패시키면 안 된다. 파싱하지 못한 문단은 원본 바이트를 지닌 `passthrough` 블록이 되고, 읽히지 않는 `styles.xml`은 빈 스타일 표로 내려간다.
- Electron과 UI에 의존하지 않는다. 기본 진입점은 Docs 렌더러 번들에 들어가므로 `node:*`를 import하지 않는다. Node 전용 코드는 `./zip-splice` 하위 경로에만 두고, `zip-load.ts`가 `zip-splice`를 import하게 만들지 않는다(테스트가 막고 있다).
- `src/vendor/`는 가져온 원본과 바이트가 같아야 한다. 포매터 대상에서도 빠져 있다.
- 엔진 동작은 이 저장소에서 사람이 정해 고친다. 원본(GenOffice)과 달라진 것과 그것을 지키는 시험은 "원본과 다른 점" 절에 적는다(결정 0092). 원본 커밋을 옮겨 올 때 충돌이 나면 그 절의 동작을 남긴다. 파일 이동, 재포맷, 이름 변경을 하지 않고 `@seuoffice/*` 이름을 그대로 둔다.

## 이 모듈의 방식

- 여는 길은 `loadDocxZip` 하나다. 여기서 Info-ZIP 유니코드 경로 필드(0x7075)를 무력화하고, 압축 폭탄 검사를 하고, Strict 정규화를 한다. Word는 헤더의 파일 이름으로 파트를 찾는데 JSZip은 저 필드를 따르므로, 충돌하는 필드가 본문 파트를 다른 항목으로 가릴 수 있다. 정규화를 이 한 곳에서만 하는 이유는 파싱의 위치값과 저장의 끼워 넣기가 같은 텍스트를 봐야 하기 때문이다.
- 본문 파트가 `word/document.xml`이 아닌 문서가 있다. 경로를 고정하지 말고 `resolveMainDocumentPath`로 찾는다.
- `passthrough`는 엔진이 이해하지 못했거나 편집을 지원하지 않는 요소다. 표시용 미리보기만 붙이고 저장할 때 원본 조각을 그대로 내보낸다. 내용은 못 고쳐도 통째로 옮길 수는 있다.
- `SaveBlock`의 갈래는 `original`(원본 복사), `generated`(모델에서 생성), `xml`(편집기가 만든 완결 조각), `image`/`images`(새 그림), `chart`(새 차트)다. 숨은 뒤쪽 요소(마지막 `w:sectPr`)는 엔진이 알아서 붙인다.
- 본문의 주석·CDATA·처리 명령은 "불투명 영역"으로 따로 보존한다. 단, `w:t` 같은 텍스트 요소 안의 CDATA는 이미 런 텍스트로 읽혔으므로 넣지 않는다. 넣으면 저장할 때 글자가 두 번 나온다.
- 메모와 각주처럼 평문으로 편집하는 항목은 `patchParagraphTexts`가 바뀐 문단의 `w:t`만 고친다. 문단 수가 달라지거나 바뀐 문단에 기댈 `w:t`가 없으면 `null`을 돌려주고, 호출부가 항목 전체를 다시 만든다.
- 같은 바이트의 새 그림은 미디어 파트 하나를 공유한다. 그래서 그림 순번과 `docPr` 순번을 따로 센다.
- "전체 목록" 옵션(`comments`, `footnotes`, `endnotes`, `sources`, `inks`)은 값을 주면 해당 파트를 목록에서 다시 만들고, `undefined`면 바이트를 유지한다. `inks: []`는 이 앱이 넣은 잉크를 전부 지운다는 뜻이다.
- `settings.xml`의 자식은 스키마 순서(`SETTINGS_CHILD_ORDER`)에 맞는 자리에 끼운다. 순서가 틀리면 Word가 복구를 제안한다.

## 엔진 시작 (wasm 바인딩)

구현 모듈은 Rust 엔진(`crates/office-wasm`)을 `@seuoffice/engine-wasm`으로 부르는 얇은 함수다. 호출은 동기이고 엔진은 프로세스(또는 워커)마다 한 번 시작한다.

- `node` 조건으로 이 패키지를 import하면 `src/node/*.ts`가 `@seuoffice/engine-wasm/node`를 먼저 불러 엔진을 동기로 시작한다. wasm은 `SEUOFFICE_WASM`이 가리키는 파일, 없으면 `crates/target/wasm32-wasip1/release/office_wasm.wasm`이다. 그 파일이 없으면 시작하지 않고(번들이 import만 하는 경우를 죽이지 않으려는 것), 엔진을 부르는 순간 "call initEngine or initEngineSync first"로 알린다.
- 별칭으로 소스 경로를 직접 가리키는 곳(vitest 설정, electron-vite 설정)은 `node` 조건을 거치지 않는다. 시험은 `setupFiles`에 `packages/engine-wasm/src/node.ts`를 넣고, 앱의 Electron main·워커 스레드는 `engine-init.ts`(`?asset`으로 번들에 담은 wasm)에서 `initDocxEngineSync`를, 렌더러·웹·웹 워커는 `await initDocxEngine(engineUrl)`(`./engine-url`의 `?url`)을 가장 먼저 import하는 모듈에서 부른다. CSP에 `'wasm-unsafe-eval'`이 있어야 한다.
- 명령줄은 번들이 CommonJS 한 파일이라 `packages/cli/src/engine-init.ts`가 `engineWasmPath()`(`Resources/wasm/office_wasm.wasm`)로 시작한다.
- 이 패키지의 모듈은 스스로 엔진을 시작하지 않는다(`src/engine.ts`는 시작됐는지만 본다). 인자와 답을 오가게 하는 코덱(`engineInvokeRaw`, `revive`, 오류 이름 복원 `engineErrorOf`)은 `@seuoffice/engine-wasm`의 것이고, 이 패키지는 `Run.wrap` 경계 규칙만 더한다. `metafile.ts`, `tiff.ts`, `xml-utils.ts`와 `vendor/`는 엔진 없는 TypeScript로 남는다.
- 경계에서 TypeScript와 다르게 보일 수 있는 값은 다음처럼 건넌다(`packages/engine-wasm/src/invoke.ts`, `crates/office-wasm`).
  - 64 KiB(UTF-16 단위)를 넘는 글자 인자는 JSON 머리 밖의 blob(`{"$text": n}`)으로 가고, 엔진은 그 blob을 복사하지 않고 읽는다(`invoke::Args`).
  - 짝 잃은 대리 문자는 UTF-8로 쓸 수 없어 U+FFFD로 바뀐다. 한 단위가 한 단위로 바뀌므로 UTF-16 위치는 그대로다. TypeScript 엔진은 메모리에서는 반쪽을 그대로 들고 있었고, 파일로 쓸 때는 어차피 U+FFFD가 됐다.
  - 답 안의 NaN·무한대는 `{"$num": "NaN" | "Infinity" | "-Infinity"}`로 와서 `revive`가 숫자로 되돌린다(`jscompat::writing_for_host`). 엔진 안에서 `JSON.stringify`를 옮긴 곳은 TypeScript처럼 `null`을 쓴다.
  - 인자는 JSON으로 1024단계까지 중첩될 수 있다(배열·객체 하나가 한 단계). 더 깊으면 엔진이 아무것도 재귀하기 전에 `RangeError: Maximum call stack size exceeded`로 거절한다. wasm 스택(8 MiB, `crates/office-wasm/build.rs`)이 넘치면 그 인스턴스는 다시 쓸 수 없기 때문이다.
  - 모델의 문자열 열거형에 없는 값(`w:lineRule="aut"` 같은 문서의 오타)은 TypeScript처럼 쓰인 그대로 들고 다시 쓴다(생성된 열거형의 `Unlisted`). 게이트의 엄격한 읽기만 그런 값을 거절한다.
- 바인딩 이전의 TypeScript 구현은 `tools/docx-diff/reference/`에 얼려 두었고 게이트는 그것과 비교한다. 거기는 고치지 않는다.

## 원본과 다른 점 (결정 0092)

결정 0092의 네 수정(머리글·꼬리말의 `SECTIONPAGES`, 직접 만든 스타일의 목차 줄, 쪽 기준 도형의 감싸기, 대체 글꼴)은 원본 #2364로 원본에 들어갔다. 그 시험(`tests/hf-section-pages.test.ts`, `tests/field-display.test.ts`, `tests/page-anchored-wrap.test.ts`, `tests/wrap-topbottom-band.test.ts`)은 원본의 것으로 남는다.

아래는 2026-11-12에 이 저장소에서 고친 것이고 원본에는 없다. Rust 엔진과 함수 단위로 비교하다가 찾았다(결정 0025).

- **표를 문서 값으로 읽을 때 자기 키만 본다.** 평범한 객체로 둔 표를 문서에서 온 값으로 읽으면 `constructor`, `toString`, `__proto__` 같은 상속 이름이 "찾은 값"으로 나왔다. 글머리 기호의 `w:lvlText`가 `constructor`면 표식이 함수가 됐고, 표 칸 글자가 정확히 그 낱말이면 함수의 소스가 저장됐고, 미리 정한 색 이름이 그 낱말이면 예외가 났다. 이런 조회는 모두 `src/own-value.ts`의 `ownValue`나 `Object.hasOwn`을 거친다. 새 표를 문서 값으로 읽을 때도 그렇게 한다. 시험: `tests/inherited-key-lookups.test.ts`, `tests/inherited-key-lookups-sweep.test.ts`, `tests/latex-inherited-names.test.ts`.
- **문서가 `__proto__`라고 이름 붙인 항목을 잃지 않는다.** 그 이름으로 대입하면 값이 버려지거나 기록의 프로토타입이 바뀐다. 사용자 지정 속성, 메일 머지 열, 머리글·꼬리말 관계 id, 차트 파트 경로, 테마 글꼴 표, VML 속성은 `setOwn`으로 넣는다. 이 기록을 다른 객체로 옮길 때는 spread나 `Object.entries`를 쓴다(`Object.assign`과 `target[k] = v`는 대상의 프로토타입을 바꾼다). 시험: `tests/proto-named-keys.test.ts`.
- **LaTeX에서 BMP 밖 글자 하나가 인자 하나다.** 읽기가 UTF-16 단위로 움직여 `x^😀`나 `x_𝒜`가 반쪽 대리 문자 둘이 됐다. 시험: `tests/latex-astral-characters.test.ts`.
- **대리 범위의 문자 참조(`&#xD800;`)는 U+FFFD로 읽는다.** 문서 속성의 값과 이름, 내용 컨트롤의 `w:tag`, 체크 상자 글리프에서 반쪽 대리 문자가 나왔다. 붙어 있는 두 참조가 한 글자를 이루면 합친다. 입력에 이미 있던 반쪽도 U+FFFD가 된다. 본문 글자(`parse-xml-text.ts`, `generate.ts`)는 전부터 그런 참조를 쓰인 그대로 두고, `resource-cleanup.ts`는 값을 안에서 비교에만 써서 그대로 뒀다. 시험: `tests/char-ref-surrogates.test.ts`.
- **짝 잃은 이동 범위 표식만으로 무편집 저장을 다시 쓰지 않는다.** 원본 #2557은 고아 표식이 있으면 빠른 반환을 막았지만, 이 저장소는 원본 바이트 반환을 유지한다. 명시적인 수락·거절은 `dropOrphanMoveRanges`로 정리를 요청한다. 시험: `tests/move-range-cleanup.test.ts`, `tests/transitional-normalize-unedited-save.test.ts`.
- **서식 변경을 거절하면 기록이 `w:pPr`의 첫 자식이어도 옛 서식이 돌아온다.** 같은 자리에서 시작하는 두 편집 가운데 길이 0인 끼워 넣기가 "다른 편집에 덮인 것"으로 버려져, 추적을 켜고 가운데 맞춤을 지운 문단을 거절해도 맞춤이 돌아오지 않았다. 같은 패스에서 문단 표식 `w:rPr`이 통째로 지워질 때도 같았다. `applyEdits`의 순서는 "같은 시작에서는 끼워 넣기가 먼저(계획 순서대로), 그다음 가장 긴 바꾸기"이고, 바뀌는 구간의 안쪽에 있는 편집만 버린다. 시험: `tests/revision-edit-order.test.ts`.
- **수정 기록의 속성은 작은따옴표로 쓰여도 읽는다.** 머리글·꼬리말·각주 같은 파트의 `w:author`, `w:id`, `w:date`를 `이름="값"` 꼴로만 읽어, 다른 프로그램이 `이름='값'`이나 `이름 = "값"`으로 쓴 변경은 작성자·id·날짜로 골라 수락·거절할 수 없었다. `attrOf`는 태그의 속성을 앞에서부터 차례로 읽으므로 다른 속성의 값 안에 든 비슷한 글자를 속성으로 보지 않는다. 시험: `tests/revision-attr-quotes.test.ts`.
- **수정 기록의 `before` 거르개는 시간대 표시가 없는 날짜를 UTC로 읽는다.** `Date.parse`는 그런 날짜를 컴퓨터의 현지 시각으로 읽어, 같은 파일의 같은 요청이 서울과 로스앤젤레스에서 다른 변경을 골랐다. 파트의 `w:date`와 거르개의 `before` 둘 다 그렇게 읽고, `Z`나 `+09:00`이 붙은 값은 뜻이 그대로다. UTC로 읽는 것은 ISO 날짜-시각 꼴(`2024-01-01T10:00`, 사이가 빈칸인 `2024-01-01 10:00:00`도)뿐이고, `Mon, 01 Jan 2024 10:00:00 GMT`처럼 다른 꼴은 `Date.parse`가 읽는 대로 둔다(전에는 `T`가 든 문자열이면 모두 끝에 `Z`를 붙여 이런 값이 날짜가 아니게 되었다). 날짜가 아닌 `w:date`는 어떤 시각보다도 앞이 아니다(`revisionDateBefore`). 전에는 비교가 거짓이 되어 모든 `before`에 걸렸다. 날짜가 아니거나 문자열이 아닌 `before`는 `applyTrackedChangesXml`이 파트를 건드리기 전에 자기 오류로 거절한다(전에는 빈 문자열이 모든 변경을 골랐고, 숫자는 `TypeError`로 터졌다). 규칙은 `revisionDateMs` 한 곳에 있고, 편집기가 본문 변경을 고르는 거르개(`apps/docs`의 `revision-ops.ts`)도 이것으로 읽는다. 시험: `tests/revision-date-zone.test.ts`, `apps/docs/tests/revision-date-zone.test.ts`.
- **문서에 없는 스타일을 가리키는 문단은 글자도 기본 문단 스타일로 읽는다.** `w:pStyle`이 없는 스타일이면 문단 속성은 기본 문단 스타일로 내려갔지만 런은 내려가지 않아, 글자가 Normal의 크기·기울임 대신 내장 10pt로 보였다. `resolveRunProps`도 `resolveParagraphProps`와 같은 대체를 한다. 시험: `tests/missing-paragraph-style.test.ts`.
- **떠 있는 개체의 감싸기는 자기 감싸기 요소로만 정한다.** `noWrap`을 조각 전체에서 `<wp:wrapNone`을 찾아 정해서, 사각 감싸기인 글상자 안에 "텍스트 앞" 그림이 들어 있으면 바깥 글상자까지 글자 위에 놓였다. `drawingAnchorMeta`는 `a:graphic` 앞의 자기 요소만 본다. 시험: `tests/nested-drawing-wrap.test.ts`.
- **altChunk의 레거시 문자셋은 어느 호스트에서나 Encoding Standard로 푼다.** 호스트의 `TextDecoder`로 풀어서 같은 HTML·MHT 조각이 렌더러(Chromium)와 CLI(Node)에서 다르게 나왔다. euc-kr `8C 63`이 Chromium에서는 "똠", Node에서는 U+008C와 "c"였고, big5·shift_jis·euc-jp·koi8-u·windows-874·windows-1253·windows-1255도 달랐으며 Node는 iso-8859-16과 x-user-defined를 아예 몰랐다. `decodeWithCharset`은 `@exodus/bytes`(MIT, 1.15.1 고정)의 JavaScript 디코더를 쓰고, 다중 바이트 표(약 150 KB)는 그 문자셋을 처음 만날 때 동적 import로 읽는다. 표의 출처는 이 패키지가 담은 WHATWG 색인이다. big5 `88 62`, `88 64`, `88 A3`, `88 A5` 네 쌍은 표준대로 두 글자(U+00CA·U+00EA에 U+0304 또는 U+030C)로 풀며, Chromium 156은 여기서 U+0093과 짝 잃은 대리 문자를 낸다. 그래서 `decodeHtmlBytes`와 `decodeMhtToHtml`은 비동기다. 시험: `tests/alt-chunk-legacy-charset.test.ts`. 다국어 바이트 표(`@exodus/bytes/encoding.js`)는 동적 import로 불러오고, 푸는 것도 그 모듈이 내보낸 `TextDecoder`로 한다: CommonJS로 도는 경우(진입점이 CommonJS인 tsx 스크립트)에는 `require`와 `import()`가 패키지 인스턴스를 둘 만들어, 정적으로 부른 가벼운 모듈의 디코더에는 표가 등록되지 않았다(`tests/alt-chunk-charset-commonjs.test.ts`). 표를 불러오지 못하면 그 조각은 호스트의 `TextDecoder`로 풀고 경고를 한 번만 남긴다. 몇 글자가 다를 수 있어도 windows-1252로 깨진 글보다 낫다(`tests/alt-chunk-charset-tables-missing.test.ts`).
- **VML의 분수 값은 퍼센트로 쓰여도 읽는다.** `<v:fill opacity="50%"/>`가 버려져 반투명 도형과 워터마크가 불투명하게 그려졌다(`.5`와 `32768f`는 읽혔다). `vmlFraction`이 세 표기를 모두 읽으므로 같은 함수를 쓰는 `arcsize`, `gain`, `blacklevel`도 퍼센트를 받는다. 시험: `tests/vml-percent-fraction.test.ts`.
- **저장이 읽는 여는 태그는 따옴표 안의 `>`에서 끊지 않는다.** XML은 속성 값 안에 `>`를 허락하는데, 문서·머리글·설정의 루트와 `w:pgSz`·`w:pgMar`를 `<이름[^>]*>`로 읽어 그 값 안에서 끊었다. 그래서 루트에 `xmlns:x="urn:x>y"` 같은 속성이 있으면 표를 품은 머리글을 다시 쓰거나 워터마크만 바꾼 머리글, 쪽 색을 넣은 본문, 숨김 표시를 단 본문이 well-formed가 아니었고, 그림 워터마크는 쪽 크기를 못 읽어 다른 크기로 들어갔고, 개인 정보 제거는 `dc:creator` 같은 작성자 요소를 비우다가 여는 태그를 잘라 core.xml을 깨뜨렸다. 이런 읽기는 `src/xml-tag.ts`의 `findStartTag` 하나를 거친다(`patch.ts`의 `clearQualifiedElements`까지, `hf-root.ts`). 시작과 끝을 함께 맞춰 요소 전체를 지우거나 옮기는 정규식(`<w:comment\s[^>]*>[\s\S]*?</w:comment>` 꼴)과 값에 `>`가 올 수 없는 속성만 가진 태그(`w:sectPr`, 머리글 참조, 번호 매기기, 설정 켬·끔 표시)는 그대로 둔다. 시험: `tests/quoted-gt-start-tags.test.ts`.
- **정수 속성에 NaN·무한대·지수 표기를 쓰지 않는다.** 그림·글상자·도형·잉크의 크기, 위치, 회전, 쌓임 순서, 여백, id를 숫자에서 바로 글자로 바꿔 `cx="NaN"`, `<wp:posOffset>Infinity</wp:posOffset>`, `id="1e+21"`, `id="2.5"`가 저장될 수 있었다. 그런 파트는 스키마에 어긋난다. 숫자는 `src/xml-number.ts`(`xmlInt`, `xmlId`, `xmlDecimal`) 한 곳에서 글자가 된다. 기존 XML을 고치는 함수(`applyImageWrap`, `applyImageZOrder`, `applyShapeZOrderAt`, `swapAnchorWrap`, `patchTextboxHeights`, `patchTextboxSizes`, `patchShapeStyles`, `patchDrawingExtent`, `resizeInlinePictureXml`, `resizeAnchoredPictureXml`)는 쓸 수 없는 값이면 그 속성의 원래 값을 두고 나머지 일은 한다. 필수 속성 `relativeHeight`를 새로 써야 할 때는 기본값 251658240을 쓴다. 새로 만드는 함수(`inlinePictureDrawingXml`, 글상자·도형·선·워드아트 빌더, `anchoredInkRunXml`)는 `RangeError('a non-finite number: <옵션>')`로 거절한다. id는 정수가 아니면 반올림하지 않고 거절한다(이웃 id와 겹칠 수 있다). 빌더의 `widthEmu`·`heightEmu`는 반올림한다. 빌더의 거절은 프로그램 오류를 막는 마지막 선이고, 문서에서 온 숫자(파일의 깨진 크기·위치, 동료가 보낸 노드 속성, 변환할 원본의 기하)가 열기·편집·저장을 멈추게 해서는 안 된다. 그래서 그런 숫자는 빌더를 부르기 전에 `usableNumber`·`usablePictureSize`(유한하고 그림 좌표 범위 안인지)로 읽고, 쓸 수 없으면 없는 값으로 다룬다: 저장의 새 그림·잉크·메모 그림(`usableNewImage`), 편집기의 그림 노드 속성(`apps/docs` `convert.ts`의 `attrNumber`), hwp2docx 그림의 크기·위치·여백, pdf2docx 카드(만들지 않고 글을 본문에 흘린다). 크기를 쓸 수 없으면 그림 자신의 크기, 그것도 없으면 96px 정사각형이다. 글상자의 DrawingML과 VML 쌍둥이는 같은 길이(`boxLength`)를 쓰고, 한쪽이 못 쓰는 값이면 둘 다 그대로 둔다. 시험: `tests/non-finite-geometry.test.ts`, `apps/docs/tests/document-numbers-save.test.ts`, hwp2docx `tests/hwpx-docx.test.ts`, pdf2docx `tests/cards.test.ts`. 그림 좌표 범위보다 좁은 속성은 그 속성의 스키마 범위로 쓴다(`xml-number.ts`): `wp:posOffset`은 xsd:int(`xmlPositionOffset`), `wp:extent`와 `a:ext`의 `cx`·`cy`는 ST_PositiveCoordinate(`xmlPositiveCoordinate`, 0부터 27273042316900까지), `relativeHeight`는 xsd:unsignedInt(`xmlUnsignedInt`). 범위 밖이면 고치는 쪽은 그림이 가진 값을 두고 새로 만드는 쪽은 거절하며, pdf2docx의 카드처럼 빌더를 부르는 쪽은 그 전에 같은 범위로 읽는다. `distT`·`distB`·`distL`·`distR`은 엔진이 수에서 쓰지 않고 상수(0, 114300)만 쓴다. 파일에 있던 범위 밖 값은 손대지 않은 그림의 원본 바이트로 남는다.
- **빈 요소로 쓴 속성 변경 기록은 한 요소다.** `<w:pPrChange …/>`나 `<w:sectPrChange …/>`를 짝 있는 기록의 시작으로 보고 지워서, 뒤에 같은 이름의 닫는 태그가 있으면 그 사이의 살아 있는 속성까지 지웠다(보호 블록의 `pageBreakBefore`, 마지막 구역의 각주 형식). 짝이 없으면 지우지 못해 `setPPrChange`가 기록을 둘 썼다. 이런 지우기는 `src/xml-tag.ts`의 `removeElements` 하나를 거친다(`parse-block-passes.ts`의 `hostParagraphBreaksBefore`, `parse.ts`의 `parseNoteProps`, `generate.ts`의 `stripPPrChange`). `resolveParaMarkRPrChange`는 전부터 빈 요소를 알았다. 시험: `tests/self-closing-change-records.test.ts`.
- **차트 캐시의 idx 구멍은 빈 칸이고 배열 길이를 지킨다.** chartEx(`cx:strDim`·`cx:numDim`)의 `cx:pt idx`가 건너뛰면 성긴 배열이 나와, `categories: string[]`가 JSON으로 건너갈 때 `null`이 되고 `map`·`forEach`는 그 자리를 건너뛰었다. 이제 고전 차트의 `cachePoints`처럼 빽빽하게 채워, 범주의 구멍은 빈 문자열, 값의 구멍은 `null`(차트가 그 점을 비워 그린다)이다. 시험: `tests/chart-parse-model.test.ts`.
- **문단을 다시 써도 런을 감싼 구조를 잃지 않는다.** 런이 들어 있는 런 단위 `w:sdt`·`w:smartTag`·`w:customXml`·`w:dir`·`w:bdo`는 `Run.wrap`으로 실려 다시 써진다(본문과 표 칸은 원문 바이트, 머리글·글상자는 직렬화). 예전에는 그 문단에 한 글자만 쳐도 컨트롤이 사라졌다. 글자 없는 표식(`w:permStart`/`w:permEnd`, `w:customXml*Range*`, `w:subDoc`)과 런이 하나도 없는 감싸개는 싣지 않는다: 이 수정 전과 똑같이 읽히고, 고치지 않은 문단에서는 원문 조각에 남고, 다시 쓰는 문단에서는 사라진다. 한때 이것들도 실었다가 걷어 냈다: 보이지 않는 런이 빈 줄 판정, 이웃 런 찾기, 추적 변경에 새 결함을 회차마다 만들었다. 다시 실으려면 그 셋을 먼저 풀어야 한다. 시험: `tests/inline-wrappers.test.ts`, `tests/inline-textless-elements.test.ts`.
  - **실을 수 없으면 싣지 않는다.** 고치지 않은 문서가 읽히거나 저장되는 결과를 바꾸지 않고는 실을 수 없는 모양은 이 수정 전처럼 읽는다(다시 쓰면 그 감싸개만 사라진다): 필드 결과 안이거나 필드 경계에 걸친 감싸개, `hyperlink > 감싸개 > ins/del`, `ins > 감싸개 > del`, `w:sdtContent`가 둘이거나 그 밖에 읽을 자식이 있는 깨진 컨트롤. 새 모양을 실으려 할 때도 이 기준을 쓴다: 옛 동작이 바닥이고, 새로운 오동작은 받지 않는다. 시험: `tests/inline-wrappers-reading.test.ts`.
  - **감싸개는 읽은 깊이에 다시 쓰고, 런에서 쓴 컨트롤의 id는 파트에 한 번만 나온다.** `w:ins > w:sdt`와 `w:hyperlink > w:smartTag`의 순서를 지키고 하이퍼링크를 감싸개 경계에서 자르지 않는다. 원본 조각, `xml` 조각, 체크 상자 컨트롤, 블록 컨트롤(`sdtShell`)은 id의 자리만 잡고 절대 벗겨지지 않는다(Word는 글상자의 `mc:Choice`와 `mc:Fallback`에 같은 id를 두 번 쓴다). `Run.wrap`으로 쓴 컨트롤만, 그 id가 파트에 이미 있으면 감싸개 없이 글자만 쓴다(`inline-control-ids.ts`). 서로 다른 편집된 표나 글상자에 반복된 id는 걸러지지 않는다. 시험: `tests/inline-control-ids.test.ts`.
  - **글자가 바뀐 컨트롤에서는 `w:showingPlcHdr`와 `w:dataBinding`을 뗀다.** 그대로 두면 Word가 친 글자를 자리표시자로 보거나 연결된 값으로 덮는다. 글자가 그대로면 `w:sdtPr`은 바이트 그대로다.
  - **실린 바이트는 엄격하게 검사한다.** 태그와 공백만 허용하고, 여는 바이트와 닫는 바이트를 합쳐 UTF-16 단위 65,536 이하이며(실제 문서에서 본 가장 큰 것은 595), 허용된 감싸개 하나에 허용 목록의 속성 요소만 들 수 있고, 엄격히 well-formed이고, 그 파트가 다시 써질 루트가 선언한 접두사만 쓸 수 있다. 싣는지는 파싱 때 정하고, 쓰기 전에 같은 검사를 다시 한다. 글자만 있는 머리글·꼬리말은 엔진이 만든 루트(`w`, `r`, `v`, `o`, `w10`) 아래에 다시 써지므로 `w:`만 쓰는 감싸개는 남고, `w15:` 같은 다른 접두사를 쓰는 감싸개는 이 수정 전처럼 글자만 남는다. 표나 그림이 있어 원래 루트를 유지하는 머리글·꼬리말은 원래 루트의 선언을 따른다(`hf-root.ts`: 파서와 작성기가 같은 판정을 쓴다). 검사에 걸린 바이트는 싣지도 쓰지도 않고 글자는 쓴다. 공동 편집에서는 동료가 이 바이트를 주므로, 틀린 타입의 값이 와도 저장은 던지지 않는다. 시험: `tests/inline-wrappers-validity.test.ts`.
  - **다른 문단·문서로 복사되는 런은 `w:sdt`를 두고 간다**(`runCopiedElsewhere`): 비교의 원본 쪽 런, 메일 머지의 둘째 레코드부터.

## 테스트

- 패키지 폴더에서 `npx vitest run`, 또는 저장소 루트에서 `npm run test -w @seuoffice/docx-engine`. 테스트 타임아웃은 20초다.
- 단위 테스트는 `tests/helpers/build-docx.ts`로 docx를 메모리에서 만들고, `tests/fixtures/`에는 메타파일 견본만 있다. 엔진 테스트를 돌리는 데 `npm run fixtures`는 필요 없다.
- `npm run fixtures`는 `fixtures/generated/*.docx`를 다시 만든다. 이 파일들은 저장소에 들어 있고 CI가 생성 결과와 커밋된 파일의 차이를 검사한다. 생성기(`scripts/generate-fixtures.ts`, `tests/helpers/build-docx.ts`)를 바꿨다면 다시 만들어 함께 커밋한다.
- 열기·저장 경로를 건드리면 왕복 테스트로 증명한다. 편집 없음 → 결과가 원본 파일과 바이트 동일, 한 블록 편집 → 다른 zip 항목과 다른 `w:p`가 바이트 동일(`tests/roundtrip.test.ts`의 형태).
- 한도와 방어 코드를 바꾸면 거부 사례와 정상 문서가 통과하는 사례를 둘 다 넣는다.
- Windows에서 원본 코드 그대로도 실패하는 테스트는 없다.
