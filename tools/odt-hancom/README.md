# ODT 한컴 합격 시험 도구

받은 ODT를 이 체크아웃의 명령줄(`docs apply`)로 고쳐 저장하고, 새 문서를 ODT로 내보낸 결과를 **한컴 한글 2024가 어떻게 읽는지**로 판정한다. CI에서 돌리지 않는다. 한컴 한글이 설치된 Windows PC에서 사람이 돌린다.

## 필요한 것

- 한컴 한글 2024(자동화 개체 `HWPFrame.HwpObject`). 보안 모듈 `FilePathCheckDLL`이 등록돼 있으면 파일 접근 확인 창이 뜨지 않는다.
- Python 3.9 이상과 pywin32(`pip install pywin32`).
- Java 17 이상(ODF 검사기 odfvalidator 0.13.0, 기본 위치 `<말뭉치>/scripts/odfvalidator.jar`, `--jar`로 바꾼다).
- Node 22 이상, 이 저장소의 의존성(`npm ci`). 새 npm 패키지는 쓰지 않는다. 그림 바꾸기와 칸 채우기 스크립트(`*.mts`)는 저장소의 `tsx`로 돈다.

## 말뭉치

시험 파일은 개인 정보가 들어 있어 저장소에 넣지 않는다. 폴더는 `--corpus <폴더>`, 없으면 환경변수 `ODT_CORPUS`, 그것도 없으면 `E:\github\odt-corpus`다.

```
<말뭉치>/hancom/*.odt   한글 2024가 HWP에서 저장한 ODT (36)
<말뭉치>/gov/*.odt      정부 누리집에서 받은 ODT (30, 폴라리스 오피스 1개 포함)
<말뭉치>/docx/*.docx    새 문서 내보내기 시험용 docx (27)
<말뭉치>/scripts/odfvalidator.jar
```

결과는 모두 `<말뭉치>/run-<날짜>/`(`--run`으로 바꾼다)에 쓴다. 저장소 안에는 아무것도 쓰지 않는다.

## 이 체크아웃을 빌드하기

```bash
npm run build -w @genoffice/cli     # packages/cli/dist/genoffice.cjs: 모든 스크립트가 이것을 부른다
npm run build -w @genoffice/docs    # PDF 내보내기(편집기 쪽 수)에만 필요
npm run build -w @genoffice/shell
```

명령줄은 체크아웃 안에서 돌면 이 체크아웃의 `node_modules/electron`으로 `apps/shell`을 띄워 PDF를 만든다. 설치한 앱이나 다른 빌드를 쓰려면 `GENOFFICE_APP_BIN=<실행 파일>`을 준다.

## 순서

```bash
node tools/odt-hancom/make-edits.mjs              # 받은 ODT 66개 × 편집 종류 16가지 → run/edits/<종류>/
node tools/odt-hancom/export.mjs                  # docx 27개 → run/export/odt/ (ODT), run/export/pdf/ (앱 PDF)
node tools/odt-hancom/look-edits.mjs              # 한컴으로 읽기: base, edits, export, docx (한 번에 한글 하나)
node tools/odt-hancom/validate.mjs                # ODF 검사기: 받은 파일, 고친 사본, 내보낸 ODT
node tools/odt-hancom/judge.mjs                   # 고친 사본 판정 → run/judge.json
node tools/odt-hancom/judge-export.mjs            # 내보내기 판정 → run/export/judge.json
```

각 스크립트는 `--corpus`, `--run`을 받는다. `make-edits.mjs`는 `--kinds none,text`, `--only <파일 이름 정규식>`, `--jobs 3`도 받는다. `look-edits.mjs`는 `--what base,edits`, `--kinds`로 일부만 읽는다.

### 다른 폴더의 ODT로 돌리기

`make-edits.mjs --src <폴더>`는 말뭉치 묶음 대신 그 폴더의 ODT를 쓴다(한컴 외 프로그램이 만든 ODT, 이 체크아웃이 내보낸 ODT, 시험용으로 고친 사본). 결과 폴더(`--run`)를 따로 주고, 원본의 한컴 판독을 먼저 만든 뒤 `judge.mjs --base <그 판독 폴더>`로 판정한다.

```bash
python tools/odt-hancom/hancom.py look --out <run2>/base <폴더> --match "\.odt$"
node tools/odt-hancom/make-edits.mjs --run <run2> --src <폴더> --kinds none,noop,para,rowadd
node tools/odt-hancom/look-edits.mjs --run <run2> --what edits
node tools/odt-hancom/judge.mjs --run <run2> --base <run2>/base
```

말뭉치에는 여러 쪽 흐름이 한 바탕쪽을 함께 쓰는 파일이 없다. 바탕쪽 복제는 받은 파일을 조금 고친 사본(예: 셋째 흐름의 `style:master-page-name`을 첫 흐름의 것으로 바꾼 사본)을 이렇게 돌려 확인한다.

## 한컴 읽기 (`hancom.py`)

```bash
python tools/odt-hancom/hancom.py look --out <폴더> <파일 또는 폴더>... [--match 정규식] [--marks 글자1,글자2] [--timeout 180] [--fresh]
```

- 파일마다 `look.json`에 열림 여부, 쪽 수, 조판 부호 수(`tbl` 표, `gso` 그림·도형, `%clk` 누름틀, `secd` 구역, `fn` 각주, `head`/`foot` 머리말·꼬리말), 글자(`TEXT`), 첫 구역의 용지·여백, 맨 앞의 글자·문단 모양, `--marks`로 준 글자를 찾아 그 자리의 굵게·크기·색·정렬을 적는다.
- 문서 전체를 한글의 XML(HWPML 2.x, 그림 데이터는 뺌)로 `hwpml/<파일 이름>.xml`에 쓴다. 판정은 여기서 표의 행·열·칸 수, 구역마다의 용지와 여백, 머리말·꼬리말·각주 글자, 누름틀 안의 글자, 첫 문단의 글꼴·크기·줄 간격을 읽는다.
- 한글 프로세스는 이 스크립트가 띄운 것 하나만 쓴다. 파일 하나가 `--timeout`초를 넘기면 **그 프로세스만** 끝내고 새로 띄워 이어 간다. 다른 한글 창은 건드리지 않는다. 결과는 파일마다 저장되므로 끊겨도 다시 돌리면 이어서 한다(`--fresh`는 처음부터).

## 편집 종류 (`make-edits.mjs`)

| 종류                        | 무엇을                                | 어떻게                                                              |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `none`                      | 고친 것 없는 저장                     | 열고 그대로 저장(편집기 저장과 같은 엔진 경로, `save-unedited.mts`) |
| `noop`                      | 명령줄을 거치되 바뀌는 것이 없는 편집 | 글자를 그 글자로 바꾸기(`findReplace`)                              |
| `text`                      | 문단 일부에 글자 덧붙이고 굵게·빨강   | `findReplace` + `setMatchedFont`                                    |
| `para`                      | 새 문단(가운데, 굵게, 14pt)           | `insert_content` + `setParagraphFormat` + `setFont`                 |
| `cell`                      | 잠기지 않은 칸에 글자 덧붙이기        | 편집기 저장과 같은 엔진 경로(`cell-edit.mts`)                       |
| `rowadd`, `rowdel`          | 행 추가, 행 삭제                      | `insertTableRow`, `deleteTableRow`                                  |
| `merge`                     | 나란한 두 칸 합치기                   | `mergeTableCells`                                                   |
| `picins`                    | 그림 넣기                             | `insert_image`                                                      |
| `picrep`                    | 그림 바꾸기                           | 편집기 저장과 같은 엔진 경로(`replace-picture.mts`)                 |
| `header`                    | 머리말(없으면 꼬리말) 글자            | `set_header_footer`                                                 |
| `footnote`                  | 각주 글자                             | `edit_note`                                                         |
| `margin`, `paper`, `orient` | 좌우 여백 +1cm, 용지(A4↔B5), 방향     | `set_page_setup`                                                    |
| `field`                     | 누름틀 안 글자 바꾸기                 | `findReplace`, 칸 안이면 `cell-edit.mts --replace`                  |
| `secmargin`                 | 둘째 구역만 왼쪽 여백                 | `set_page_setup section: 1`                                         |

명령줄 작업(op)에는 기존 표 칸에 글자를 치는 것과 그림을 바꾸는 것이 없다(`findReplace`는 표 밖 문단의 글자 묶음 하나 안에서만 찾는다). 이 둘은 공개 엔진 API로 편집기가 저장하는 방식(`patchTableCellTexts`, `replaceImage`)을 그대로 따라 한다. 명령줄은 작업이 하나 이상 있어야 저장하므로, 고친 것 없는 저장도 엔진 경로로 만든다. 파일에 해당 요소가 없거나 후보가 모두 잠긴 칸에 닿으면(`op_rejected`) 그 종류는 건너뛰고 이유를 `manifest.json`에 적는다.

## 판정

- 고친 것 없는 저장: 쪽·조판 부호·표·글자·용지가 받은 파일과 같다.
- 고친 저장: 표시 글자가 보이고, 표·조판 부호 수가 의도대로이며(행·칸·그림 ±1), 받은 글자가 빠지지 않고(행 삭제는 그 행의 글자만), 표시 자리의 모양(굵게 1, 크기 1400, 가운데 3, 색)이 의도대로다. 쪽 수가 2쪽 이상 달라지면 원인을 적어야 하는 항목으로 따로 센다.
- ODF 검사기: 고친 사본의 오류가 받은 파일보다 많지 않고, 받은 파일에 없던 오류 문구가 없다.
- 새 문서 내보내기: 글자·표·그림·각주가 빠지지 않고, 용지·여백이 같으며, 첫 본문 문단의 글꼴·크기·줄 간격이 한컴이 docx를 직접 읽은 것과 같고, 쪽 수가 편집기(앱 PDF) 쪽 수의 10% 안이다.
