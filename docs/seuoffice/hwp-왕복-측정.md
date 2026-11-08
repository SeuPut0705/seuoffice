# 한글 같은 형식 왕복 측정

측정일 2026-11-08. 시험 파일 `apps/hwp/tests/roundtrip-corpus.test.ts`. Node 22, 저장소의 패치판 엔진(`vendor/rhwp-core`).

## 무엇을 쟀나

- 파일을 연다(`new HwpDocument(bytes)`). `.hwp`는 앱 열기와 같이 추적 변경을 먼저 걷어낸다(`tracked-changes.ts`). 암호 문서와 배포용 문서는 "제외"로 센다.
- 같은 형식으로 내보낸다(`exportHwp()` 또는 `exportHwpx()`).
- 앱 저장 경로(`hwp-main.ts` 의 `commitSave`)가 쓰는 `applySaveFixes`를 같은 순서로 부른다. 열 때 얻은 구역 꼬리와 필드 종류(`sectionTailsOf`, `fieldKindsOf`)를 바탕으로 넘긴다. 탭 너비는 편집기가 재는 값이라 시험에는 없어 넘기지 않는다.
- 웹 저장 경로(`apps/hwp/src/web/`)도 같은 파일마다 돈다. 웹 열기(`openHwpFromBytes`, 편집 모드)가 편집기에 주는 바이트와 저장 바탕(구역 꼬리, 필드 종류)이 데스크톱 열기와 같은지, 웹 저장(`webSaveBytes`)이 같은 내보낸 바이트에서 데스크톱 `applySaveFixes`와 바이트까지 같은 결과를 내는지 본다. 어긋나면 불일치로 센다. 웹 열기가 바탕을 남기지 않게 바꿔 돌리면 `.hwp` 8건이 모두 실패했다.
- 저장한 바이트를 다시 열고 다음을 연 직후 값과 견준다. 쪽 수(`pageCount()`), 구역 수(`getSectionCount()`), 구역별 문단 수(`getParagraphCount(i)`), 글 전체(`getTextFileText()`, 줄끝은 `\n`으로 맞춤), 다시 열 때 예외 여부.
- 바이트가 원본과 같은지도 적는다(열 때 값이 아니라 원본 파일 기준).
- 대상은 `apps/hwp/tests/fixtures/` 36개와 `e2e/assets/hwp-picture-table.hwp` 1개, 모두 37개다. 환경 변수 `SEUOFFICE_HWP_CORPUS`가 가리키는 저장소 밖 폴더도 잴 수 있다.
- 시험은 알려진 손실 목록(`KNOWN_LOSSES`) 밖의 불일치가 하나라도 있으면 실패한다. 목록에 있는데 이제 일치하는 파일도 실패한다. 현재 목록은 비어 있다.
- 시험이 불일치를 잡는지 확인했다. 내보내기 전에 문서에 글자를 넣게 바꿔 돌리면 37건이 모두 실패했고, 되돌리면 37건이 통과한다.

## 결과

37개 모두 열기, 내보내기, 저장 보정, 다시 열기에 성공했고 비교 항목이 모두 일치했다. 제외 0건, 불일치 0건, 알려진 손실로 처리한 파일 0건.

| 파일                                           | 형식 | 쪽·구역·문단·글자 일치                  | 바이트 |
| ---------------------------------------------- | ---- | --------------------------------------- | ------ |
| `caption-footnote-flow-ieum17.hwp`             | hwp  | 일치 (쪽 8, 구역 1, 문단 25, 5078자)    | 다름   |
| `caption-footnote-flow.hwpx`                   | hwpx | 일치 (쪽 8, 구역 1, 문단 25, 5078자)    | 다름   |
| `cell-line-break-form.hwpx`                    | hwpx | 일치 (쪽 2, 구역 1, 문단 13, 383자)     | 다름   |
| `duplicate-field-ids.hwpx`                     | hwpx | 일치 (쪽 1, 구역 1, 문단 3, 100자)      | 다름   |
| `footnote-typed-number.hwpx`                   | hwpx | 일치 (쪽 4, 구역 1, 문단 40, 5158자)    | 다름   |
| `format-copy-table.hwp`                        | hwp  | 일치 (쪽 1, 구역 1, 문단 3, 67자)       | 같음   |
| `generated-form-aligned-cells.hwpx`            | hwpx | 일치 (쪽 1, 구역 1, 문단 29, 904자)     | 다름   |
| `generated-form-tables-hancom.hwpx`            | hwpx | 일치 (쪽 1, 구역 1, 문단 29, 883자)     | 다름   |
| `generated-form-tables.hwpx`                   | hwpx | 일치 (쪽 1, 구역 1, 문단 29, 883자)     | 다름   |
| `hancom-page-number-no-dash.hwpx`              | hwpx | 일치 (쪽 1, 구역 1, 문단 2, 8자)        | 다름   |
| `header-footer-paper-shapes.hwpx`              | hwpx | 일치 (쪽 1, 구역 1, 문단 3, 65자)       | 다름   |
| `header-footer-paper-tables.hwpx`              | hwpx | 일치 (쪽 1, 구역 1, 문단 3, 65자)       | 다름   |
| `header-picture-and-text.hwpx`                 | hwpx | 일치 (쪽 1, 구역 1, 문단 1, 11자)       | 다름   |
| `master-page-duplex-both.hwpx`                 | hwpx | 일치 (쪽 2, 구역 1, 문단 2, 43자)       | 다름   |
| `master-page-duplex-even-odd.hwp`              | hwp  | 일치 (쪽 2, 구역 1, 문단 2, 30자)       | 다름   |
| `master-page-duplex-odd-even.hwpx`             | hwpx | 일치 (쪽 2, 구역 1, 문단 2, 43자)       | 다름   |
| `master-page-next-section.hwpx`                | hwpx | 일치 (쪽 2, 구역 2, 문단 2, 40자)       | 다름   |
| `memo-short-header-tail.hwp`                   | hwp  | 일치 (쪽 3, 구역 1, 문단 41, 2813자)    | 다름   |
| `memo-source.hwp`                              | hwp  | 일치 (쪽 40, 구역 1, 문단 512, 74441자) | 다름   |
| `memo.hwp`                                     | hwp  | 일치 (쪽 1, 구역 1, 문단 2, 36자)       | 같음   |
| `memo.hwpx`                                    | hwpx | 일치 (쪽 1, 구역 1, 문단 2, 36자)       | 같음   |
| `nested-form.hwp`                              | hwp  | 일치 (쪽 2, 구역 1, 문단 4, 1011자)     | 다름   |
| `page-number-cell-position.hwpx`               | hwpx | 일치 (쪽 3, 구역 1, 문단 3, 45자)       | 다름   |
| `page-number-last-hide-wins.hwpx`              | hwpx | 일치 (쪽 5, 구역 1, 문단 5, 120자)      | 다름   |
| `page-number-late-position-no-new-number.hwpx` | hwpx | 일치 (쪽 4, 구역 1, 문단 4, 58자)       | 다름   |
| `page-number-late-position.hwpx`               | hwpx | 일치 (쪽 4, 구역 1, 문단 4, 58자)       | 다름   |
| `page-number-new-number-before-position.hwpx`  | hwpx | 일치 (쪽 5, 구역 1, 문단 5, 70자)       | 다름   |
| `page-number-pages.hwpx`                       | hwpx | 일치 (쪽 6, 구역 1, 문단 6, 92자)       | 다름   |
| `paper-square-table-tac-host.hwpx`             | hwpx | 일치 (쪽 1, 구역 1, 문단 5, 428자)      | 다름   |
| `paper-topbottom-box-stale-ladder.hwpx`        | hwpx | 일치 (쪽 2, 구역 1, 문단 55, 1389자)    | 다름   |
| `para-float-tail-table.hwpx`                   | hwpx | 일치 (쪽 2, 구역 1, 문단 9, 539자)      | 다름   |
| `picture-brightness-contrast-cell-fill.hwpx`   | hwpx | 일치 (쪽 1, 구역 1, 문단 1, 14자)       | 다름   |
| `single-line-record-paragraph.hwpx`            | hwpx | 일치 (쪽 1, 구역 1, 문단 1, 602자)      | 다름   |
| `square-picture-after-page-reset.hwpx`         | hwpx | 일치 (쪽 2, 구역 1, 문단 12, 1162자)    | 다름   |
| `title-table-then-inline-table.hwpx`           | hwpx | 일치 (쪽 1, 구역 1, 문단 6, 432자)      | 다름   |
| `title-table-zone-fill.hwpx`                   | hwpx | 일치 (쪽 1, 구역 1, 문단 5, 428자)      | 다름   |
| `hwp-picture-table.hwp`                        | hwp  | 일치 (쪽 1, 구역 1, 문단 5, 61자)       | 같음   |

- 바이트가 같은 파일은 `memo.hwp`, `memo.hwpx`, `format-copy-table.hwp`, `hwp-picture-table.hwp` 네 개뿐이다. 나머지는 내용이 같아도 파일 바이트가 다르다.
- 일치의 뜻은 엔진이 다시 읽은 쪽·구역·문단·글자가 같다는 것까지다. 줄바꿈 위치, 글꼴, 표 모양, 그림, 각주 장식, 바탕쪽 내용은 이 시험이 보지 않는다.

## 알려진 손실

아래는 손대지 않은 문서의 이 측정에는 나타나지 않는다. 고친 문서를 저장할 때나 특정 입력에서 생기는 손실이라 이 시험의 비교 항목으로 잡히지 않는다. 근거는 `docs/tracking/findings.md`다.

| 손실                                                        | 조건                                                             | 근거                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 고친 바탕쪽이 저장되지 않고 원본 것이 남는다                | 엔진이 쓰지 못하는 구역 뒤 바탕쪽을 편집기에서 고쳤을 때(`.hwp`) | findings.md 634-639행, 상위 이슈 edwardkim/rhwp#7899                                                                                                                                                                                                                                                        |
| 각주 장식 문자 `userChar`와 `suffixChar` 중 하나가 사라진다 | 생성기가 두 속성을 함께 쓴 HWPX의 각주                           | findings.md 204-209행. 이 측정은 속성을 비교하지 않아 확인하지 못했다                                                                                                                                                                                                                                       |
| 저장한 파일의 바이트가 원본과 다르다                        | 거의 모든 파일                                                   | findings.md 833-839행(스트림 내용은 같고 컨테이너 배치와 압축이 다름). 위 표 "바이트" 열이 이를 보여 준다. HWPX 29개를 풀어 견주면 대부분 `header.xml`, `section*.xml`, `content.hpf`가 다시 쓰이고, 미리보기 이미지나 `settings.xml` 같은 부분이 더해지거나 빠진다(압축을 푼 부분 목록과 내용 비교한 관찰) |

바이트가 다른 것 자체는 손실이 아닐 수 있다. 한컴 한글에서 같게 보이는지는 아래 한계 때문에 아직 모른다.

## 한계

- 이 PC에 한컴 한글이 없어 저장한 파일을 한글로 다시 여는 확인을 하지 못했다. 이 측정은 같은 엔진으로 다시 읽은 결과일 뿐이다. 2단계에 들어가기 전에 한글이 있는 PC에서 `memo.hwp`, `memo.hwpx`, `memo-source.hwp`, `master-page-duplex-both.hwpx`, `footnote-typed-number.hwpx` 같은 대표 파일을 저장해 열어 보고, 경고 대화상자 없이 열리는지와 쪽 수를 사람이 확인한다.
- 문서를 고치지 않은 상태의 저장만 쟀다. 편집 뒤 저장의 일치는 이 시험의 범위 밖이다.
- 탭 너비 보정(`writeTabWidths`)은 편집기의 측정값이 필요해 이 시험에서 빠졌다.
- 비교 항목이 쪽·구역·문단·글자뿐이라, 모양만 달라지는 손실은 잡지 못한다.

## 저장소 밖 말뭉치(건수만)

`SEUOFFICE_HWP_CORPUS`에 비공개 폴더를 주고 같은 시험을 돌렸다. 파일 이름은 적지 않는다.

| 폴더                                    | 파일 수 | 일치 | 불일치 | 열기 실패 | 제외 |
| --------------------------------------- | ------- | ---- | ------ | --------- | ---- |
| 유유 비공개 보기 시험 표본 폴더(최상위) | 4       | 4    | 0      | 0         | 0    |
| 같은 폴더의 공개 표본 하위 폴더         | 11      | 11   | 0      | 0         | 0    |

합계 15개 중 15개 일치(100%). 이 말뭉치의 권리는 확인되지 않아 저장소에 넣지 않는다.

## 다시 돌리기

- 저장소 파일만: `npm run test -w @genoffice/hwp -- roundtrip-corpus`. 표는 vitest 기본 보고기에서는 보이지 않을 수 있어 `--reporter=verbose`를 붙인다.
- 저장소 밖 폴더 포함: `SEUOFFICE_HWP_CORPUS=<폴더> npm run test -w @genoffice/hwp -- roundtrip-corpus`.
