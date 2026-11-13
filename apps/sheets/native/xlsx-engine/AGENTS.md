# 엑셀 처리 프로그램 (xlsx-engine)

통합 문서 파일을 읽고 다시 묶는 Rust 프로그램이다. 폴더 이름은 `xlsx-engine`이지만 패키지와 실행 파일의 이름은 `xlsx-sidecar`(라이브러리는 `xlsx_sidecar`)다. TypeScript 쪽이 자식 프로세스로 띄우고 표준 입출력으로 요청을 주고받는다. 원본(GenOffice)의 문서 엔진을 그대로 쓰는 곳이다.

## 맡은 범위

- 열기와 읽기. `open`은 압축 파일을 검사하고 시트 목록·서식·도형·정의된 이름 같은 메타데이터만 돌려준다. 셀은 `read_range`가 주고, `read_formula_cells`·`read_row_outline`·`read_media`·`find_cells`가 같은 세션을 읽는다.
- 저장용 묶기(`src/archive.rs`): `archive_manifest`, `read_entries`, `scan_entries`, `save_archive`. 세션 없이 파일 경로만 받는다.
- 수식 재계산 `recalc_cells`(IronCalc)와 옛 형식 가져오기 `convert_workbook`(calamine), ODS 내보내기 `convert_to_ods`.
- 표준 입출력 프로토콜(`src/main.rs`의 `Command`, `Request`, `Response`).

## 맡지 않는 것 (경계)

- 고친 XML을 만드는 일은 `packages/xlsx-gateway`가 한다(`saveWorkbookViaSidecar`, `planCellEditsToXlsx`). 이 프로그램은 항목을 꺼내 주고 받은 내용 파일로 압축 파일을 다시 묶을 뿐, 무엇이 편집됐는지 모른다. 저장 전후 목록 비교(`assertManifestPreserved`)와 임시 대상을 최종 경로로 옮기는 일(`promoteFileAtomically`)도 그쪽이다.
- 프로세스를 띄우고 죽이는 일, 시간 제한(기본 30초, 묶기·변환·재계산 180초), 응답 짝 맞추기는 `apps/sheets/src/main/xlsx-sidecar-client.ts`가 한다. 어느 파일을 열지도 뒷단이 정한다. `sheets-main.ts`는 사용자의 파일이 아니라 스냅숏 사본의 경로를 `open`에 넘긴다.
- 응답 검증은 `apps/sheets/src/shared/desktop-api.ts`의 zod 스키마(`workbookRangeResultSchema`, `workbookFindCellsResultSchema` 등)가 한다.
- 저장하지 않은 편집은 여기서 보이지 않는다. `find_cells`는 파일에 있는 값만 찾고, 편집분은 렌더러가 덧씌운다.
- CLI(`packages/cli/src/formats/xlsx.ts`의 `withSidecar`)는 호출마다 프로세스를 새로 띄우고 끝나면 멈춘다. 실행 파일을 찾는 순서는 `packages/cli/src/resources.ts`의 `xlsxSidecarPath()`가 정한다.
- 설치 파일에 실행 파일을 넣는 일은 `apps/shell/electron-builder.cjs`가 한다.

## 항상 지켜야 하는 것

- 이 프로젝트는 원본의 수정을 병합할 때만 이 크레이트의 동작을 바꾼다. 예외는 사람이 정해 아래 "원본과 다른 점"에 적은 수정뿐이다(결정 0111). 그 밖에는 같은 파일에서 나오는 결과가 원본이 내는 것과 같아야 한다. 이름(`xlsx-sidecar`, 명령과 필드 이름, 기본 로캘 `"zh"`, 임시 폴더 접두사)을 고치지 않고, 파일을 옮기거나 다시 포맷하지 않는다. 그래야 원본의 수정이 충돌 없이 들어온다.
- 예외: calamine은 원본보다 먼저 0.38로 올렸다(결정 0126). 0.37까지는 Excel 5.0/95 `.xls`의 2바이트 코드페이지(949·932·936·950) 글자를 모두 `�`로 읽었다. 원본을 받아오다 calamine 줄이 충돌하면 더 높은 판을 남기고, `convert.rs`의 `a_biff5_workbook_in_a_double_byte_code_page_keeps_its_text`가 통과하는지 본다.
- 요청과 응답은 한 줄에 JSON 하나다. 요청은 `version`, `requestId`, `command`(snake_case 값)와 그 명령의 필드(camelCase)를 한 객체에 평평하게 담는다. 응답은 `version`, `requestId`, `ok`와 `result` 또는 `error: { code, message }` 중 하나다. 이 모양과 이름을 바꾸지 않는다.
- `PROTOCOL_VERSION`(지금 1)은 `src/main.rs`와 `xlsx-sidecar-client.ts`에 따로 있다. 한쪽만 올리지 않는다. 클라이언트는 버전이 다른 줄을 잡음으로 버리므로, 어긋나면 오류가 아니라 모든 요청의 시간 초과로 나타난다. 깨진 JSON 요청도 같다. `invalid_json` 응답은 `requestId`가 비어 있어 짝이 맞지 않는다.
- stdout에는 `write_response`로만 쓴다. `println!` 같은 출력을 넣지 않는다. 응답은 요청 루프, `xlsx-reader`, `xlsx-recalc` 세 스레드가 한 잠금 아래에서 쓰므로 요청 순서와 다르게 나올 수 있고, 짝은 `requestId`로만 맞춘다.
- 오류 문장도 계약이다. 클라이언트는 `error.code`를 버리고 `message`만 `Error`로 넘긴다. 렌더러(`univer-sync.ts`)는 재계산이 겹쳤는지를 `busy with another recalculation`이라는 문장 조각으로 알아본다. `recalc_busy`의 문장을 바꾸면 "바쁨"이 실패로 세어지고, 실패가 쌓이면 렌더러가 재계산을 끈다.
- 원본의 수정이 응답에 필드를 더할 때는 zod 스키마도 함께 고치고 선택 필드로 받는다. `.strict()`로 선언된 객체에 모르는 필드가 생기면 응답 전체가 거절되고, 반대로 낡은 실행 파일이 붙으면 그 필드가 없다. 새 명령 variant에는 `#[serde(rename_all = "camelCase")]`를 붙인다. `Command`의 `rename_all`은 명령 이름에만 걸리므로 빼먹으면 필드를 snake_case로 기다린다.
- `save_archive`는 손대지 않은 항목을 압축된 바이트 그대로 옮긴다(`raw_copy_file_rename`). 풀었다가 다시 압축하지 않는다. 바뀐 항목과 새 항목만 `contentPath` 파일을 읽어 Deflate로 쓴다. 항목은 원본 순서를 따르고 새 항목은 끝에 붙는다. 응답의 `beforeEntries`·`afterEntries`(이름, CRC, 압축 크기, 원래 크기)가 보존을 증명하는 자료이므로 그 뜻을 바꾸지 않는다.
- `save_archive`는 `targetPath`를 바로 덮어쓴다. 원본과 같은 파일이면 `Save target must differ from the source archive.`로 거절한다. 원본을 읽으면서 쓰기 때문이다. 한 이름은 `replacements`·`removals`·`additions`·`streamPatches` 중 한 곳에만 올 수 있고, 없는 항목의 교체·삭제·`streamPatches`와 있는 항목의 추가는 거절한다. `streamPatches`(선택, 원본 36a509e8f)는 문자열로 고칠 수 없을 만큼 큰 시트 부품을 칸 단위 패치 프로그램(`patchPath`의 JSON)으로 받아 흘려 쓰며 고친다(`src/stream_patch.rs`). 지금 뒷단은 이 필드를 보내지 않는다. 디스크가 fsync를 거절해도(ENOTSUP 등) 저장은 실패로 치지 않는다(`sync_best_effort`).
- 읽기 명령은 통합 문서 파일에 쓰지 않는다. 재계산도 값만 돌려주고 IronCalc 모델을 파일로 저장하지 않는다. 예외는 `convert_workbook` 하나다. 값, 수식, 서식, 그림, 병합, 인쇄 설정을 담은 새 파일을 만드는 것이고 보존 저장이 아니다.
- 크기 한도는 아래 상수가 정한다. 값을 바꾸지 않는다.

  | 상수                                        | 값                 | 걸리는 곳                                                       |
  | ------------------------------------------- | ------------------ | --------------------------------------------------------------- |
  | `MAX_ENTRY_COUNT`                           | 10,000개           | `open`과 묶기 명령의 압축 항목 수. 저장은 원본 항목 + 추가 항목 |
  | `MAX_EXTRACTED_ENTRY_BYTES`                 | 500 MiB            | `read_entries`가 꺼내는 항목                                    |
  | `MAX_METADATA_PART_BYTES`                   | 64 MiB             | `read_zip_string`으로 통째로 읽는 부품, 관계 부품 정리          |
  | `MAX_MEDIA_BYTES`                           | 20 MiB             | `read_media` 한 건                                              |
  | `MAX_RANGE_CELLS`                           | 100,000칸          | `read_range` 한 번                                              |
  | `MAX_FIND_MATCHES`, `FIND_TIME_BUDGET`      | 100,000건, 8초     | `find_cells` 한 쪽. 넘으면 `nextCursor`를 주고 끊는다           |
  | `MAX_RECALC_EDITS`, `MAX_RECALC_READ_CELLS` | 10,000건, 20,000칸 | `recalc_cells` 한 번                                            |

- 항목이 선언한 크기를 믿지 않는다. 항목을 메모리나 파일로 옮길 때는 `copy_entry_bounded`를 거친다. 선언 크기와 한도 중 작은 값보다 1바이트를 더 읽어 보고, 읽히면 `ZIP entry inflates past the size it declares.`로 거절한다. `visuals.rs`의 `read_optional_xml`은 원본 그대로 `read_to_string`을 쓴다. 이것을 근거로 한도 없는 읽기를 더하지 않는다.
- 500 MiB를 512 MiB로 올리지 않는다. 뒷단은 항목을 JavaScript 문자열로 고치는데 V8 문자열의 최대 길이가 536,870,888바이트라, 그 사이 크기의 항목은 한도를 통과한 뒤 문자열로 만들다 실패한다. `packages/xlsx-gateway/src/shared/edit-schemas.ts`의 `MAX_PATCH_ENTRY_BYTES`와 같은 값이어야 한다. 압축 파일 전체 크기의 한도는 이 프로그램에 없다.
- 항목 이름 검사를 더 엄격하게 만들지 않는다. `canonical_entry_name`은 앞의 `/`, `\` 구분자, `./`, 빈 구간을 접어 준다(Excel이 여는 파일이다). 거절하는 것은 NUL 문자와 `..`로 패키지 밖으로 나가는 이름뿐이다. 저장하면 접힌 이름으로 다시 쓴다.
- `open`마다 UUID v4 세션 id를 만들고 시스템 임시 폴더 아래에 "접두사 + 세션 id" 폴더를 하나 둔다. 접두사는 원본 시절의 접두사를 일부러 그대로 둔 것이다. 이 문자열은 `src/lib.rs`(`create_cache_directory`)와 `src/tests.rs`에만 있고, 저장소의 이름 검사는 그 두 파일에서만 이를 허용한다. 바꾸지 않고, 다른 파일(이 문서 포함)에 옮겨 적지 않는다.
- 세션과 임시 폴더는 짝이다. 폴더는 `CacheDirectory`가 쥐고, `commit` 전에 끝나는 모든 경로(취소, 오류, panic)에서 지운다. `commit`은 세션을 등록한 바로 뒤에만 한다. 등록된 폴더는 `close`가 색인 스레드를 멈추고 기다린 뒤 지운다. 세션 없는 폴더나 폴더 없는 세션이 남는 순서로 고치지 않는다.
- 남은 세션의 일괄 정리(`WorkbookSessions`의 `Drop`)는 stdin이 닫혀 `main`이 끝날 때만 돈다. `XlsxSidecarClient.stop()`은 프로세스를 `kill()`하므로, 그 전에 `close`를 받지 못한 세션의 폴더는 이 프로그램이 지우지 못한다.
- `read_entries`는 호출자가 준 `outputDir`에 `entry-{index}.bin`으로 쓴다. 그 폴더는 이미 있어야 하고, 이 프로그램은 만들지도 지우지도 않는다.
- 네트워크를 쓰지 않는다. 코드에 `std::net`이 없고 `Cargo.lock`에 HTTP 클라이언트가 없다. 다른 통합 문서를 가리키는 수식은 그 파일을 찾아가지 않고 파일에 저장된 값을 고정한다(`pin_unparsable_formulas`). URI 스킴이 붙은 관계 대상은 `resolve_relationship_target`이 거절한다. 네트워크나 다른 프로세스를 여는 의존성을 더하지 않는다.

## 이 모듈의 방식

- 명령줄 인자를 받지 않고 설정용 환경 변수도 없다. 클라이언트의 첫 요청 때(또는 `start()`로 미리) 뜨고, 앱의 모든 시트 탭이 한 프로세스를 같이 쓴다. 세션은 메모리에만 있어서 다시 뜬 프로세스는 이전 세션 id를 모두 `Unknown workbook session.`으로 거절한다.
- `xlsx-reader` 스레드가 stdin을 읽어 길이 8의 큐에 넣고, 요청 루프가 도착 순서대로 하나씩 실행한다. `cancel`만 리더 스레드가 큐를 거치지 않고 처리한다.
- 오래 걸리는 일을 요청 루프에서 직접 돌리지 않는다. 재계산이 `xlsx-recalc` 스레드로 빠진 이유다. 수식이 많은 파일의 첫 가져오기는 몇 분이 걸리고, 그동안 뒤에 선 `read_range`가 전부 시간 초과되어 시트가 빈 화면이 됐다. 재계산은 한 번에 하나만 돌고 겹치면 바로 `recalc_busy`로 답한다.
- 읽기 흐름: `open`은 셀을 주지 않는다. 시트별 색인 스레드(`xlsx-index-{n}`)는 그 시트를 처음 읽을 때 뜨고(`ensure_parser`), 256행(`CHUNK_ROW_COUNT`)씩 임시 폴더의 `sheet-{i}-chunk-{n}.json`에 쓴다. `read_range`는 색인이 `endRow`에 닿기를 최대 750ms(`RANGE_WAIT`) 기다리고, 색인보다 4,096행(`RANGE_WAIT_MAX_LAG_ROWS`) 이상 앞선 범위는 기다리지 않고 바로 답한다. 호출자는 응답의 `indexedThroughRow`·`indexingComplete`를 보고 다시 묻는다.
- 조건부 서식, 자동 필터, 데이터 유효성, 시트 보호, 페이지 나누기, 보호 범위, 인쇄 설정은 `indexingComplete`가 참일 때만 채운다. 그 전의 빈 값은 "없음"이 아니라 "아직 모름"이다.
- 응답의 시트 id는 `sheet-` 뒤에 통합 문서의 `sheetId` 값을 붙인 것이고, 조각 파일 이름의 `{i}`는 시트의 순번이다. 둘을 섞지 않는다. 행과 열은 0부터 세고, 1부터 세는 IronCalc에는 `recalc.rs`가 1을 더해 넘긴다.
- 저장 흐름: `archive_manifest`로 목록을 받고, `read_entries`로 고칠 항목을 파일로 꺼내고, 뒷단이 고친 내용을 파일로 쓴 뒤, `save_archive`가 다시 묶는다. 큰 내용은 stdout의 JSON이 아니라 파일 경로로 오간다. `scan_entries`는 고치기에는 너무 큰 항목이 편집된 시트를 가리키는지 XML 글자만 훑어 알려 준다.
- 재계산 모델은 경로별로 최대 2개(`MAX_RESIDENT_MODELS`)를 쥐고, 원본이 8,000,000바이트(`HEAVY_SOURCE_BYTES`)를 넘는 것은 하나만 둔다. 파일의 수정 시각이나 크기가 달라졌거나, 앞서 넣은 편집이 이번 편집 목록에 없으면(되돌리기) 파일에서 다시 가져온다. `close`는 모델을 바로 버리고(재계산 중이면 예약한다), `save_archive`는 대상 경로의 모델만 버리도록 예약한다. 원본 경로의 모델을 남기는 것은 복구 사본을 저장할 때마다 처음부터 다시 가져오지 않기 위해서다.
- IronCalc의 가져오기는 엄격해서 panic할 수 있다. `catch_unwind`로 그 요청만 `workbook_error`가 되게 하고, 작업 중인 모델은 캐시에서 빼 두어 실패한 모델이 다시 쓰이지 않게 한다.
- 취소는 두 갈래다. 큐에서 기다리는 요청은 `CancelledRequests`(최대 256개, 넘치면 오래된 것부터 잊는다)가 실행 직전에 걸러 내고, 이미 실행 중인 `open`과 `find_cells`는 `InFlightRequest`의 깃발을 단계 경계에서 확인한다. 그 밖의 실행 중인 명령은 멈추지 않는다. 취소된 `open`은 세션도 폴더도 남기지 않는다.
- `lib.rs`가 하위 모듈을 `use workbook::*`처럼 통째로 들이고 대부분의 모듈은 `use super::*`로 받는다. 항목이 어느 파일에 있든 크레이트 루트의 이름으로 쓰이므로, 같은 이름을 두 모듈에 두면 충돌한다.
- cargo는 `.cargo/config.toml`을 `--manifest-path`가 아니라 현재 폴더에서 찾는다. `apps/sheets`에서 도는 `native:build`가 `--config`로 따로 넘기는 이유다. 이 설정이 MSVC CRT를 정적으로 묶는다. 빠지면 VC++ 재배포 패키지가 없는 PC에서 실행 파일이 뜨지 않아 모든 열기가 실패한다.
- 산출물 위치가 둘이다. `native:build`와 `cargo build --release`는 `target/release/xlsx-sidecar.exe`를 만든다(개발 실행, 테스트, CLI가 찾는 곳). 설치 파일 빌더는 x64에서 `target/x86_64-pc-windows-gnu/release/xlsx-sidecar.exe`를 찾고, 없으면 `beforePack`에서 `win extraResources source missing`으로 멈춘다. MSVC 도구로 빌드하는 PC에서는 실행 파일을 그 폴더로 복사해 둔다. 이 복사를 해 주는 스크립트는 없으므로, 다시 빌드하고 복사를 빠뜨리면 예전 실행 파일이 설치 파일에 들어간다.
- 의존성을 더하면 `Cargo.lock`도 함께 커밋하고, 라이선스가 저장소 뿌리의 `deny.toml` 허용 목록에 있어야 한다(CI의 `rust-licenses`가 `cargo deny`로 이 크레이트와 `xlsx-wasm`을 확인한다).
- 배포하고 검증하는 플랫폼은 Windows뿐이다. 빌더 설정의 macOS·Linux 경로는 원본의 것이 남아 있을 뿐 이 프로젝트에서 검증하지 않았다.

## 원본과 다른 점 (결정 0111)

원본의 개선을 받아온 뒤 아래 시험이 모두 통과해야 한다. 충돌을 풀 때 이 동작이 사라지지 않게 한다. 원본이 같은 일을 하게 되면 그 항목을 지우고 원본 코드로 돌아간다.

- **`.xls`의 인쇄 설정.** `xls_print.rs`가 시트의 `WSBOOL`, `SETUP`, 여백, 가운데, 눈금선·머리글, `HEADER`·`FOOTER`, 쪽 나누기 기록과 전역의 Print_Area·Print_Titles `NAME` 기록을 읽는다. `convert.rs`가 그것을 `sheetPr/pageSetUpPr`, `printOptions`부터 `colBreaks`까지(`mergeCells` 뒤, `drawing` 앞), `definedNames`로 쓴다. `xls_biff.rs`에서는 전역의 `0x0018`과 시트 기록의 나머지 갈래(`print.take_record`)만 이 모듈로 넘긴다. 시험 `xls_print::tests` 전체, `convert::tests`의 `carries_print_settings_from_a_legacy_workbook`, `print_area_and_titles_become_defined_names`.
- **`.xls`의 글꼴에 맞춘 줄 높이.** 원본은 손으로 정한 줄 높이(`ROW`의 0x40)만 쓴다. 여기서는 시트 기본 높이(`DEFAULTROWHEIGHT`, `default_row_twips`)와 다른 높이도 `customHeight` 없이 `ht`로 쓴다. 시험 `carries_print_settings_from_a_legacy_workbook`의 1행.
- 원본 2026-11-04 묶음 커밋의 `.xls` 셀 서식(`xls_styles.rs` 등)은 원본 코드를 미리 받아온 것이다. 다음 원본 받아오기에서 같은 내용이 들어오면 충돌은 원본 쪽으로 푼다.
- **ODS 불러오기.** ODF 스프레드시트를 옮길 때 `convert.rs`가 원본(calamine이 주는 값만 쓰는 변환)과 다르게 하는 것들이다(결정 [0119](../../../../docs/archive/ieum/tracking/decisions/0119-ods-open-and-export.md)). `.xls`·XML 스프레드시트의 결과는 그대로다.
  - `odf_formula.rs`가 `table:formula`의 OpenFormula(`of:=` 접두사, `[.B1:.B2]` 참조, `;` 인수 구분)를 엑셀 문법으로 번역한다. 함수 이름은 `odf_functions.rs`의 표로 바꾼다. 표는 ODF를 읽는 다른 프로그램에 엑셀 함수를 하나씩 넣어 보고 받아 적은 것이다. 이름이 같아도 뜻이 다른 것이 있어서다. OpenFormula의 `FDIST`는 엑셀의 `F.DIST`(왼쪽 꼬리)이고 엑셀의 `FDIST`는 `LEGACY.FDIST`다. 2007년 뒤에 생긴 함수에는 엑셀이 파일에 붙이는 `_xlfn.`(`FILTER`·`SORT`는 `_xlfn._xlws.`)을 붙인다. 빼먹으면 엑셀이 `#NAME?`으로 읽는다.
  - 이름 정의(`table:named-expressions`)를 `definedNames`로 옮기고, 그 이름을 쓰는 수식을 살린다. 합집합 `~`은 묶음 괄호 안에서만 `,`로, 교차 `!`는 공백으로, 배열 상수 `{1;2|3;4}`는 `{1,2;3,4}`로 바꾼다. 번역할 수 없는 수식(문서에 없는 이름, `oooc:`·`msoxl:`, 함수 인수 자리의 합집합, ODF 전용 함수, 3-D 참조)은 **그 셀의 수식만 버리고 값은 남기며** `formulasDropped`로 센다.
  - `odf_layout.rs`가 `content.xml`과 `styles.xml`에서 병합, 열 너비·행 높이, 배열 수식의 결과 범위(`table:number-matrix-*-spanned`)를 읽어 `mergeCells`·`cols`·`row/@ht`·`<f t="array" ref>`로 쓴다. calamine의 ODS 읽기는 이것들을 알려 주지 않는다. 배열 수식을 보통 수식으로 쓰면 그 칸 하나만 계산되어 답이 달라진다.
  - ODS 시간(`office:time-value`)은 하루를 1로 하는 일련번호와 `[h]:mm:ss` 서식으로 옮긴다. 음수 시간도 숫자로 옮긴다. 서식을 읽지 못한 문서는 이 서식 하나를 더한 최소 스타일(`ods_styles_xml()`)로 연다.
  - 날짜에 시간대가 붙어 있으면(`…Z`, `…+09:00`) 시계는 적힌 대로 두고 시간대만 뗀다. 1900년 3월 이전 날짜는 그 날짜를 지킨다(엑셀은 없는 1900-02-29를 세므로 일련번호가 하루 적다).
  - 수식의 저장된 결과가 빈 문자열이면 값을 쓰지 않는다. 오류가 난 수식을 그렇게 저장하는 프로그램이 있어서, 빈 칸을 `#DIV/0!` 위에 덮지 않기 위해서다.
  - 표 스타일이 `table:display="false"`인 시트는 숨긴 시트로 옮긴다(모두 숨겨져 있으면 모두 보이게 연다).
  - 서식과 구조는 꾸러미를 한 번 더 읽어 가져온다(`odf_sheet_format.rs`). `content.xml`은 흘려 읽으며 칸을 연속 구간으로, 반복 행을 한 항목으로 둔다. 그 머리의 자동 스타일과 `styles.xml`·`settings.xml`은 나무로 읽는다. 이 읽기가 실패하면 값만으로 연다.
  - `odf_cell_styles.rs`가 셀 스타일을 부모(`style:parent-style-name`)와 기본 스타일까지 풀어 통합 문서의 `styles.xml`(글꼴·채우기·테두리·맞춤·보호·숫자 서식)을 만든다. 글꼴은 서양 속성을 먼저 보고, 없으면 동아시아 속성을 본다. 첫 네 셀 서식은 기본·날짜·날짜와 시간·시간으로 자리가 정해져 있다. 날짜 값인데 스타일의 서식이 날짜가 아니면 날짜 서식을 준다. `odf_number_format.rs`가 데이터 스타일을 엑셀 서식 코드로 되돌리고, `style:map`으로 나뉜 스타일을 `;` 구간으로 다시 잇는다. 숫자 서식을 쪽 스타일 옆(`styles.xml`의 자동 스타일)에 적는 문서가 있어 그곳도 읽는다.
  - 반복은 풀지 않는다. 열·행의 기본 셀 스타일은 `<col style>`·`<row s customFormat>`으로, 값 없이 서식만 있는 칸은 `<c s/>`로 쓴다. 시트 끝까지 반복되는 행의 칸 서식은 열 서식으로, 행 전체를 덮는 칸 서식은 행 서식으로, "아래를 모두 숨김"은 `zeroHeight`로 쓴다. 병합한 칸의 테두리와 채우기는 덮인 칸에 자리별로 나눠 적는다. ODF는 병합의 테두리를 첫 칸 스타일 하나로 말하고, 엑셀은 바깥 테두리를 그 자리에 놓인 칸에서 그리기 때문이다.
  - `odf_sheet_parts.rs`가 워크시트 조각을 만든다. 숨긴 행·열, 개요(묶음과 접힘), 시트 보호, 탭 색, 오른쪽에서 왼쪽, 자동 필터와 조건(`table:database-ranges`), 틀 고정·확대·눈금선·활성 시트(`settings.xml`), 하이퍼링크, 메모(`comments` 파트와 레거시 VML), 칸 안 글자별 서식, 쪽 나누기, 인쇄 영역과 반복 행·열(시트 범위 이름)이다. 링크 글자는 스타일에 색이 없으면 파란색으로 쓴다(ODF 판독기는 스타일과 상관없이 링크 색으로 그린다). calamine은 `text:s`(연속 공백)·탭·줄 바꿈 요소를 버리므로, 그런 요소가 든 글자는 여기서 읽은 글자로 쓴다.
  - `odf_page.rs`가 쪽 스타일을 `printOptions`·`pageMargins`·`pageSetup`·`headerFooter`로 옮긴다. 머리글·꼬리말의 영역과 필드는 엑셀의 `&` 부호로 되돌린다. ODF는 쪽 여백 다음에 머리글 높이를 두므로, 엑셀의 위 여백은 둘을 더한 값이고 머리글 여백이 쪽 여백이다.
  - `odf_rules.rs`가 데이터 유효성 검사(`table:content-validations`)와 조건부 서식(`calcext:conditional-formats`의 조건·색조·데이터 막대)을 옮긴다. 조건의 수식은 기준 칸에서 범위의 첫 칸으로 참조를 옮긴 뒤 번역한다. 엑셀로 적을 수 없는 규칙은 그 규칙만 뺀다.
  - 워크시트 안의 순서는 스키마가 정한다. `sheetPr`, `dimension`, `sheetViews`, `sheetFormatPr`, `cols`, `sheetData`, `sheetProtection`, `autoFilter`, `mergeCells`, `conditionalFormatting`, `dataValidations`, `hyperlinks`, 인쇄 조각, 쪽 나누기, `legacyDrawing` 순이다. 조각을 더할 때 이 순서를 지킨다.
  - 그리기는 꾸러미를 한 번 더 흘려 읽어 가져온다(`odf_drawings.rs`). `content.xml`에 `<draw:`가 한 번도 없으면 XML을 읽기 전에 그만둔다. 보통의 문서가 그렇고, 드는 것은 압축 풀기 한 번이다. 그림, 도형·글상자, 선·연결선, 차트 틀을 그것이 든 칸과 함께 읽고, 묶음(`draw:g`) 안의 것은 하나씩 읽는다. 쪽에 고정된 것(`table:shapes`)은 절대 위치로 둔다. `odf_drawing_parts.rs`가 시트마다 `xl/drawings/drawingN.xml`과 그 관계를 쓴다. 그림 파일은 꾸러미에서 `xl/media/`로 흘려 복사한다. 칸을 벗어나는 오프셋은 열·행을 따라 걸어 실제로 놓이는 칸으로 옮긴다(엑셀은 오프셋을 칸 끝에서 멈춘다). 문서가 잰 눈금과 통합 문서가 쓸 눈금이 다르면 칸 안에서의 비율을 지킨다. 도형 모양은 `draw:type`이 이름을 대면 그 프리셋으로(다른 프로그램의 이름표와 `ooxml-` 접두사), 내보내기가 쓴 길과 같으면 그 프리셋으로, 그 밖에는 길을 사용자 지정 윤곽으로 쓴다. 회전한 도형은 끝 칸 없이 시작 칸과 크기로 묶는다(끝 칸이 도는 틀이 아니라 둘레 상자를 말하기 때문이다). 글자 자리를 적지 않은 도형은 판독기가 그리는 대로 둔다. `draw:custom-shape`는 세로 가운데, 줄 바꿈 없는 글자는 가로 가운데다.
  - 차트는 `odf_chart_parts.rs`가 `Object N/content.xml`을 읽어 `xl/charts/chartN.xml`로 쓴다. 막대·선·영역·원·도넛·분산형·방사형과 섞인 차트, 보조 축, 제목·범례·축 제목·눈금선·데이터 레이블·계열 색을 옮긴다. 범위는 수식으로, 차트 안의 표에 저장된 값은 캐시로 쓴다. 한 칸짜리 범위는 그 칸 하나로 적는다(계열 이름이 그렇게 적힌다). 이름 붙일 수 없는 차트(주식·거품·표면)는 틀째 뺀다. 3차원 차트는 평면으로 쓴다.
  - 쓴 `.xlsx`는 공개 규격(ECMA-376 과도기)의 스키마로 검사한다. 워크시트·스타일·그리기·차트 파트가 요소 순서까지 맞아야 엑셀이 복구 창 없이 연다. 그리기나 차트의 요소를 더할 때는 스키마의 순서를 지킨다.
  - 선과 채우기: 이름 붙은 점선(`draw:stroke-dash`)은 가장 가까운 프리셋 점선으로 옮긴다. 내보내기가 쓴 점선은 표(`ods_drawing::DASHES`)에서 그대로 찾고, 다른 프로그램의 점선은 긴 획의 길이와 사이의 점 개수로 가린다. 이름 붙은 선형 그라데이션(`draw:gradient`)은 색 멈춤과 각도를 가진 그라데이션 채우기로 옮긴다. ODF는 위에서 아래로 가는 그라데이션을 반시계로 돌리고 DrawingML은 왼쪽에서 오른쪽을 시계로 돌리므로 각도는 `90 - 각도`다. 선형이 아닌 그라데이션, 무늬, 그림 채우기는 옆에 적힌 단색으로 둔다.
  - 추세선(`chart:regression-curve`)은 종류와 다항식 차수·이동 평균 구간을 `c:trendline`으로 옮긴다. 스파크라인(`calcext:sparkline-groups`)은 워크시트의 확장 목록(`extLst`)에 엑셀이 쓰는 꼴로 쓴다. 종류, 켜진 옵션, 선 굵기, 색 여덟 개를 모두 적고, 문서가 적지 않은 색은 엑셀의 기본색으로 채운다. 확장 목록은 워크시트의 마지막 요소다.
  - 피벗 테이블(`odf_pivots.rs`)은 `table:data-pilot-tables`를 읽어 피벗 테이블 파트와 캐시 정의 파트로 쓴다. 캐시에는 레코드를 넣지 않고 `saveData="0" refreshOnLoad="1"`로 표시해, 엑셀이 열 때 시트에서 다시 만들게 한다. 피벗 엔진이 없는 작성기가 엑셀에 피벗을 넘기는 방법이다. 원본 범위, 행·열·쪽·값 필드, 요약 함수, 부분합, 총합계, 배치(표 형식·개요·압축), 필드와 값의 사용자 이름, 숨긴 항목(글자와 그냥 숫자)을 옮긴다. 캐시 필드 이름은 원본 범위의 머리글 행에서 읽는다. **온전히 말할 수 없는 피벗은 통째로 뺀다**(칸의 값은 그대로 온다). 시트 범위가 아닌 원본, 거른 원본, 한 줄뿐인 원본, 비었거나 겹치는 머리글, 묶기, 상위 N, 통합 문서에 낱말이 없는 함수, 캐시가 이름 붙일 수 없는 숨긴 항목이 그렇다. 반쯤 쓴 피벗은 엑셀이 파일째 거부한다. 스타일 이름은 적지 않는다. 칸이 이미 문서의 서식을 갖고 있어, 이름 붙은 스타일은 그 위에 띠를 덧그린다.
  - 아직 옮기지 않는 것: 양식 컨트롤, OLE 개체, 주식·거품·표면 차트, 그림 자르기, 말풍선 꼬리 같은 도형 조절점(기본값으로 그린다), 원 차트의 반시계 방향, 표(이름 붙은 범위는 필터 단추만 옮긴다), 시트 보호 암호, 아이콘 집합, `style:map`으로만 적힌 옛 방식의 조건부 서식. 열 너비는 기본 글꼴의 글자 폭을 7픽셀로 보고 바꾼다.
  - 시험: `odf_formula::tests`와 `odf_layout::tests` 전체, `convert::tests`의 `converts_ods_values_dates_times_and_error_results`·`translates_odf_formulas_and_counts_the_dropped_ones`·`carries_merged_ranges_across_repeated_rows_and_cells`·`carries_explicit_column_widths_and_row_heights`·`iso_durations_become_fractions_of_a_day`·`a_string_that_is_an_error_literal_becomes_an_error_cell`·`keeps_a_row_height_repeated_over_a_span_too_wide_to_expand`·`carries_a_row_height_repeated_over_rows_that_hold_data`·`the_ods_stylesheet_keeps_the_minimal_one_and_adds_a_time_format`·`odf_dates_keep_their_day_with_a_zone_or_before_march_1900`·`carries_names_arrays_hidden_sheets_and_failed_formulas_from_ods`, `main.rs`의 `convert_workbook_reports_dropped_formulas`. 서식과 구조는 `odf_import_tests` 전체(꾸러미를 넣고 나온 `.xlsx`를 다시 읽는다)와 `odf_cell_styles`·`odf_number_format`·`odf_page`·`odf_rules`·`odf_sheet_format`·`odf_sheet_parts`의 `tests`. 그리기는 `odf_drawings`·`odf_drawing_parts`·`odf_chart_parts`의 `tests`와 `odf_import_tests`의 `carries_pictures_shapes_and_charts_from_ods`·`a_document_without_drawings_gets_no_drawing_parts`. 피벗은 `odf_pivots::tests`와 `odf_import_tests::carries_pivot_tables_from_ods`(불러온 것을 다시 내보내면 처음 글자 그대로인지까지 본다).
- **ODS로 내보내기.** `convert_to_ods` 명령이 `.xlsx`를 새 ODS 꾸러미로 쓴다(결정 [0119](../../../../docs/archive/ieum/tracking/decisions/0119-ods-open-and-export.md)). 원본 바이트 보존이 아니라 **전체 변환**이고, `convert_workbook`의 동작과 `.xls` 결과는 그대로다.
  - `ods_export.rs`가 `WorkbookSessions`의 세션 모델을 그대로 읽어 `mimetype`·`META-INF/manifest.xml`·`content.xml`·`styles.xml`·`meta.xml`·`settings.xml`을 만든다. 시트는 `read_range` 창 단위로 읽고 행마다 바로 쓰며, 꾸러미는 대상 옆 임시 파일에 쓴 뒤 이름을 바꾼다. 대상 경로가 원본과 같으면 거절한다. 꾸러미는 ODF 1.3이라고 적는다(축별 맞추기 인쇄, 첫 쪽 머리글, 탭 색이 1.3의 표기다).
  - **계산 설정을 반드시 적는다**(`table:calculation-settings`). 엑셀은 글자를 대소문자 없이 견주고 조건의 `*`·`?`를 와일드카드로 읽는데, ODF의 기본값은 둘 다 반대다. 적지 않으면 `="a"="A"`와 `COUNTIF(A:A,"a*")`가 다른 답을 낸다.
  - `odf_formula::to_odf_with`가 엑셀 수식을 `of:=` 문법으로 되돌린다. 함수 이름은 위의 표를 거꾸로 쓴다(`CEILING` → `COM.MICROSOFT.CEILING`, `IFS` → `COM.MICROSOFT.IFS`). 이름 정의를 `table:named-expressions`로 쓰고 그 이름을 쓰는 수식을 살린다. 배열 수식은 결과 범위를 붙여(`table:number-matrix-*-spanned`) 쓴다. 묶음 괄호 안의 쉼표(합집합)는 `~`, 참조 사이 공백(교차)은 `!`, 배열 상수는 `{1;2|3;4}`로 쓴다. 쓸 수 없는 것(통합 문서에 없는 이름, 표의 구조적 참조, 다른 파일 참조, 3-D 참조, OpenFormula에 이름이 없는 함수)은 **그 셀의 수식만 버리고 값은 남기며** `formulasDropped`로 센다.
  - `ods_styles.rs`가 글꼴·글자색·채우기·테두리(대각선 포함)·맞춤·들여쓰기·회전·줄 바꿈·셀 보호를 ODF 자동 스타일로 옮긴다. 글꼴 속성은 동아시아·복합 문자용 속성(`style:font-weight-asian` 등)에도 같이 적는다. 판독기는 한글에 그쪽 속성을 쓰므로, 빼면 한글 셀의 굵게·크기가 사라진다. 줄 바꿈은 `fo:wrap-option`이다(`style:wrap-text`는 ODF에 없는 이름이다).
  - 숫자 서식은 구간(`양수;음수;0;글자`)마다 데이터 스타일을 하나씩 만들고, 마지막 숫자 구간이 `style:map` 조건으로 나머지에 보낸다(음수 빨강, 회계 서식의 `-`). 숫자 앞뒤와 사이의 글자(`#,##0"원"`, `000"-"00`), 천 단위 줄임, 과학 표기, 분수, 글자 서식, 요일(`aaa`)을 옮긴다. 읽지 못하는 서식은 데이터 스타일 없이 값만 쓴다.
  - 하이퍼링크(글자 셀), 메모, 셀 안 글자별 서식, 개요(행·열 묶음), 자동 필터와 그 조건, 표, 시트 보호(암호 없이), 탭 색, 쪽 나누기, 틀 고정·확대·눈금선을 옮긴다. 열과 행의 기본 스타일은 빈 셀에도 이름을 적는다. 판독기가 적히지 않은 행에는 열의 기본 스타일을 칠하지 않아서다.
  - 병합에 가려진 칸에 값이 있으면 가려진 칸(`table:covered-table-cell`)에 그대로 적는다. 병합한 글자를 범위의 모든 칸에 써넣는 프로그램이 있고, 엑셀은 그 값을 그 칸을 가리키는 수식에 돌려준다. ISO 글자로 저장된 날짜 셀(`t="d"`)은 날짜 값으로 쓴다. 빈 글자 셀은 빈 칸으로 쓰고 `cells`에 세지 않는다.
  - 인쇄(`ods_print.rs`): 용지·방향·여백·배율·맞추기 인쇄, 인쇄 영역(`table:print-ranges`), 반복 행·열(`table:table-header-rows`/`-columns`), 머리글·꼬리말(엑셀의 `&` 부호를 세 구역과 필드로), 눈금선·행열 머리글 인쇄. 머리글이 없는 시트는 없다고 적는다. 적지 않으면 판독기가 자기 기본 머리글을 넣어 본문이 아래로 밀린다.
  - 옮기지 않고 개수를 `dropped`로 돌려주는 것: 슬라이서·매크로(`slicers`·`macros`). `charts`·`images`·`shapes`·`pivots`·`sparklines`·`conditionalFormats`·`validations`·`comments`는 옮기지 못한 것만 센다.
  - 스파크라인은 판독기들이 함께 쓰는 확장 요소(`calcext:sparkline-groups`)로 시트 끝에 쓴다. 세션 모델은 종류, 계열 색, 읽는 범위만 준다. 켜진 옵션(표식, 최고·최저, 처음·끝, 음수, 가로축), 선 굵기, 나머지 색은 시트 파트의 꼬리에서 읽는다(`parse_sparkline_extras`). 꼬리의 묶음 수가 모델과 같을 때만 짝지어 쓴다. 색은 여덟 개를 모두 적는다. 빼 두면 다음 작성기가 제 기본색을 채워, 쓰고 열고 다시 쓴 글이 달라진다.
  - 피벗(`ods_pivot.rs`): 피벗 테이블이 채운 칸은 보통 칸이라 시트와 함께 간다. 여기에 그 뒤의 표를 더한다. 어디서 읽는지, 어느 필드가 행·열·쪽·값에 있는지, 어떻게 요약하는지를 `table:data-pilot-tables`에 적어 판독기가 새로 고치거나 다시 배치할 수 있게 한다. 세션 모델은 피벗 파트의 경로만 주므로 정의와 캐시 정의를 꾸러미에서 직접 읽는다. 같은 통합 문서의 시트 범위를 읽는 피벗을 쓴다. 캐시가 범위 대신 이름을 대면(이름 정의나 표) 그 이름이 가리키는 범위를 찾아 쓴다(`named_sources`, 피벗이 있는 통합 문서에서만 한 번 찾는다). 표는 요약 행을 뺀 범위다. 다른 파일·데이터 모델을 읽는 피벗은 판독기가 따라갈 원본이 없어 개수로 센다. 행·열 필드의 배치를 적는다. 압축 형식은 표준에 낱말이 없어 표 형식으로 적고 그 옆에 `loext:layout-mode="compact-layout"`을 둔다. 필드와 값의 이름은 `tableooo:display-name`으로 적는다. 값이 스스로 얻는 이름(`Sum of …`)과 표 형식 배치는 적지 않는다. 적으면 불러온 것을 다시 내보낸 글이 달라진다. 숨긴 항목은 글자와 그냥 숫자인 것을 옮긴다. 값이 여럿인데 통합 문서가 값의 자리(`x="-2"`)를 빼 두었으면 `dataOnRows`를 따라 자리를 적는다. 값 표시 방식(전체 대비 비율 등), 계산 필드, 묶기는 옮기지 않는다.
  - 그리기(`ods_drawing.rs`): 그림·도형·글상자·선·차트 틀은 시작 칸 안에 쓴다. 엑셀은 그리기를 시작 칸과 끝 칸에 묶고, ODF는 도형을 시작 칸 안에 넣고 끝 칸을 도형에 적는다(`table:end-cell-address`). 그래서 행을 쓰다가 그 칸에 닿을 때 함께 쓰고, 한 번 훑기를 유지한다. 시작 칸이 데이터 범위 밖(오른쪽이나 아래)이어도 그 칸까지 행을 이어 쓴다. 메모도 같다. 크기는 걸친 열 너비와 행 높이로 계산한다. 그림 파일은 통합 문서 꾸러미에서 `Pictures/`로 그대로 복사한다. 도형은 모양 표에 있는 것(사각형, 타원, 둥근 사각형, 삼각형, 마름모, 화살표 등)과 사용자 지정 윤곽을 그리고, 표에 없는 모양은 테두리 사각형으로 쓰고 이름을 `draw:type="ooxml-이름"`으로 남긴다(자리·크기·색·글자는 남고, 우리 불러오기는 그 이름으로 모양을 되돌린다). 이름만 적고 길을 빼면 판독기가 아무것도 그리지 않는다. 회전한 그리기는 제 크기와 `draw:transform`(틀의 모서리를 축으로 돌린 뒤 옮기기, 각도는 반대 방향)으로 쓰고 끝 칸을 적지 않는다. 끝 칸을 적으면 판독기가 돌린 틀을 시트 축으로 늘여 모양이 찌그러진다. 도형의 글자 서식은 문단 스타일과 글자 스타일로 쓴다. 도형 스타일에 적은 글자 속성은 판독기가 글자에 적용하지 않는다.
  - 차트(`ods_chart.rs`): 차트는 꾸러미 안의 작은 문서(`Object N/content.xml`)다. 세션 모델이 편집기가 그리는 대로 차트를 설명하므로(종류, 계열과 범위·캐시 값, 축, 범례, 레이블) 그 설명을 옮긴다. 막대·선·영역·원·도넛·분산형·방사형과 막대+선 혼합을 쓴다. 계열은 시트 범위를 가리키고, 저장 당시 값은 차트 안의 표에도 적는다. **한 차트는 시트 범위와 차트 안의 표를 섞지 않는다.** 주소 하나라도 차트 안의 표를 가리키면 판독기가 차트 전체를 그 표에서 읽어, 캐시 없이 저장된 차트가 빈 그림이 된다. 범위를 모르는 계열이 하나라도 있을 때만 전부 표에서 읽는다. 캐시 없는 차트의 점 개수는 범위 크기로 센다. 축 제목과 값 축은 종류로 찾는다(두 축을 같은 쪽에 적는 작성기가 있다). 분산형만 놓인 쪽으로 찾는다. 차트 바탕이 어두우면 색을 정하지 않은 글자를 밝게 쓴다. 색을 정하지 않은 조각과 계열은 통합 문서 테마의 강조색 여섯 개를 차례로 쓴다. 계열 이름이 칸에서 오면 그 칸을 가리키게 쓴다(`chart:label-cell-address`). 세션 모델은 차트가 이름을 캐시해 두면 칸 주소를 주지 않고, 이름 없는 계열에는 엑셀이 보여 주는 이름(`Series1`)을 붙여 준다. 그래서 차트 파트에서 계열마다 이름이 칸인지, 직접 적은 것인지, 없는지를 읽는다(`series_names`). 이름을 글자로만 받은 판독기는 시트를 옮길 때 그 이름을 잃는다. 이름 없는 계열은 이름을 적지 않는다. 추세선은 종류를 계열 안에 쓴다(`chart:regression-curve`). 차트 둘레에는 엑셀의 기본인 가는 회색 테두리를 그린다.
  - 점선은 프리셋마다 이름 붙은 점선으로, 세션 모델이 풀어 준 그라데이션(테마 채우기 스타일에서 온 것)은 이름 붙은 선형 그라데이션으로 쓴다. 둘 다 `styles.xml`의 `office:styles`에 한 번씩 선언한다. 도형에 직접 적힌 그라데이션(`a:gradFill`)은 세션 모델이 단색으로만 알려 줘서 단색으로 나간다.
  - 그리기에서 옮기지 않는 것: 그림 자르기, 선 끝 화살표, 3차원 효과, 오차 막대, 차트 요소의 수동 배치, 주식·표면 차트(개수로 센다), OLE 개체(개수로 센다). 그림 자르기는 ODF가 그림의 원래 크기를 기준으로 한 길이로 적는데(`fo:clip`), 해상도 정보가 없는 그림은 판독기가 화면 해상도로 원래 크기를 정한다. 같은 파일이 PC마다 다르게 잘려 보여서 쓰지 않는다.
  - 서식 코드의 글자 구간(네 번째 구간, 또는 `@`가 든 마지막 구간)은 글자 스타일(`number:text-style`)로 쓰고 숫자 구간들을 조건으로 건다. 빈 네 번째 구간(`;;;`)은 글자를 숨긴다. 버리면 숨긴 글자가 드러난다.
  - 병합 영역의 오른쪽·아래 테두리는 엑셀이 마지막 열·마지막 행의 칸에 둔다. ODF는 병합 영역 전체를 첫 칸의 서식으로 그리므로 그 테두리를 첫 칸 스타일로 옮긴다. 마지막 행은 지금 쓰는 읽기 창 안에 있을 때만 본다.
  - 숫자·날짜·논리 칸의 하이퍼링크는 칸이 보여 주는 글자를 `text:a`로 감싼다. 값은 그대로 숫자다.
  - 테마를 따르는 글꼴(`scheme`)은 세션 모델이 테마의 라틴 글꼴 이름으로 준다. 동아시아 글꼴 속성에는 테마의 동아시아 글꼴이나 통합 문서가 기본 글꼴에 적어 둔 이름(`normal_font_name`)을 쓴다. 그러지 않으면 `맑은 고딕`으로 만든 문서의 한글이 판독기 기본 글꼴로 나온다.
  - 열 너비를 정하지 않은 열에도 엑셀의 기본 너비(64픽셀)를 적는다. 적지 않으면 판독기가 자기 기본값을 써서 열이 3분의 1쯤 넓어진다. 높이를 정하지 않은 행은 그대로 둔다. 판독기는 그런 행의 높이를 열 때마다 글꼴로 다시 계산해서, 적어도 따르지 않는다.
  - 규칙(`ods_rules.rs`): 데이터 유효성 검사는 문서 앞의 `table:content-validations`에 한 번 적고, 그 범위의 칸마다 이름(`table:content-validation-name`)을 붙인다. 유효성 검사가 지키는 칸은 대개 비어 있으므로 빈 칸에도 붙인다. 빈 행은 범위가 시작하거나 끝나는 곳에서만 모양이 바뀌어, 그 사이를 반복 행 하나로 쓴다(데이터 아래로 마지막 행까지 내려가는 범위도 같다). 조건부 서식은 표 끝의 `calcext:conditional-formats`에 우선순위 순서로 쓴다. 표준에 조건부 서식 요소가 없어 판독기들이 함께 쓰는 확장 이름 공간이다. 바꿀 서식(dxf)은 `styles.xml`의 이름 있는 셀 스타일(`ConditionalStyle_N`)로 쓰고, 빈 바탕에서 차이만 적는다. 색조·데이터 막대·아이콘 집합도 옮긴다.
  - 규칙에서 옮기지 못해 세는 것: 수식이 번역되지 않는 규칙, 바꿀 서식이 없는 규칙, 표준 편차 띠, 뒤집힌 아이콘 집합. '참이면 중지'는 대응이 없어 알리지 않고 빠진다. 평균 위·아래와 기간 규칙의 세부 값은 세션 모델에 없어 시트 파트의 꼬리에서 우선순위로 찾아 읽는다(`parse_rule_extras`).
  - 인쇄 가운데 맞춤, 시작 쪽 번호, 인쇄 순서, 메모 인쇄는 세션 모델이 읽지 않는다. 내보내기가 시트 파트에서 `</sheetData>` 뒤만 따로 읽어 옮긴다(`read_print_extras`). 칸을 다시 훑지 않도록 압축을 풀면서 그 자리만 찾고, 못 읽으면 기본값으로 둔다. 시작 쪽 번호가 없으면 `continue`를 적는다(적지 않으면 판독기가 시트마다 1쪽부터 센다).
  - 옮기지 않는 것: 머리글 그림, 시트 보호 암호, 와일드카드·색·상위 N 필터 조건, 채우기 무늬.
  - 시험: `ods_export::tests` 전체, `ods_styles::tests` 전체, `ods_print::tests` 전체, `odf_formula::tests`의 `to_odf` 시험들, `main.rs`의 `convert_to_ods_reports_the_package_it_wrote`.
- **출력 범위를 읽지 못한 피벗을 센다.** 시트의 `pivotTable` 관계 가운데 파트가 없거나, `<location>`이 없거나, `ref`가 없거나, `ref`가 범위가 아닌 것은 `pivotRanges`·`pivotTables`에 넣을 수 없다. 원본은 그냥 건너뛰었다. 그러면 편집기는 그 시트에 피벗이 있는 줄 모르고 출력 셀을 일반 셀로 읽어, 가린 셀로 만든 피벗의 값이 AI에 간다(`file-parse`는 이런 시트를 통째로 가린다). 건너뛰는 그 자리에서 세어 시트 메타데이터 `pivotsUnlocated`로 낸다(`visuals.rs`의 `read_pivot_tables`가 앞의 세 경우를, `lib.rs`가 범위가 아닌 `ref`를 센다). 0이면 직렬화하지 않으므로 그런 피벗이 없는 파일의 응답은 한 글자도 바뀌지 않는다. 웹의 엔진(`native/xlsx-wasm`)도 같은 코드다. 받는 쪽은 `desktop-api.ts`의 `pivotsUnlocated`(예전 실행 파일이면 0)이고, 0이 아니면 그 시트 전체를 피벗 출력으로 다뤄야 한다. 건너뛰는 갈래를 더하면 같이 센다. 시험: `tests.rs`의 `counts_pivots_whose_output_cannot_be_located`, `apps/sheets/tests/pivots-unlocated-wire.test.ts`.

## 테스트

- 빌드 PC의 PATH에는 `cargo`가 없다. Git Bash에서 `export PATH="$HOME/.cargo/bin:$PATH"`를 먼저 하고 이 폴더에서 `cargo test`를 돌린다. 저장소 어디서든 `npm run native:test -w @seuoffice/sheets`로도 같다.
- 테스트는 `src/tests.rs`, `src/visuals/tests.rs`와 `archive.rs`·`main.rs`·`recalc.rs`·`find.rs` 등의 `mod tests`에 있다. 따로 둔 `tests/` 폴더나 픽스처 파일은 없다. 통합 문서는 `open_fixture(&[(항목 이름, XML)])`로 테스트 안에서 만든다.
- `cargo test`는 `target/release`의 실행 파일을 다시 만들지 않는다. `apps/sheets/tests`의 사이드카 테스트(`xlsx-sidecar.test.ts`, `xlsx-streaming-save.test.ts`, `xlsx-recalc.test.ts`, `xlsx-borders.test.ts`, `ole-roundtrip.test.ts`)는 `XLSX_SIDECAR_PATH`를 읽지 않고 `native/xlsx-engine/target/release/`의 실행 파일을 직접 연다. Rust를 고친 뒤 `cargo build --release`(또는 `npm run native:build -w @seuoffice/sheets`) 없이 돌리면 예전 실행 파일을 시험하게 된다.
- `XLSX_SIDECAR_PATH`를 읽는 곳은 둘이다. CLI의 `xlsxSidecarPath()`는 이 값을 가장 먼저 본다. 시트 뒷단의 `resolveSidecarPath()`는 주입된 `runtime.sidecarPath` 다음에 보는데, shell이 항상 경로를 주입하므로 통합 앱에서는 이 변수가 효과가 없고 시트 단독 실행에서만 적용된다.
- `packages/cli/tests`의 사이드카 테스트는 실행 파일을 찾지 못하면 `skipIf`로 건너뛴다. 실패가 없다는 것만 보지 말고 건너뛴 수를 본다.
- 바꾼 곳에 따라 반드시 덮는 것:
  - 프로토콜: `main.rs`의 테스트처럼 `handle_line`에 요청 한 줄을 넣어 확인하고, `xlsx-sidecar.test.ts`로 실제 응답이 zod 스키마를 통과하는지 본다.
  - 저장: 손대지 않은 항목의 저장 전후 목록이 같은지(`saves_with_raw_copy_replacement_removal_and_addition`), 겹치거나 없는 항목의 편집이 거절되는지, 그리고 `xlsx-streaming-save.test.ts`.
  - 한도: 한도를 넘는 입력의 거절과, 선언보다 크게 풀리는 항목의 거절(`rejects_xml_entry_that_inflates_past_its_declared_size`, `rejects_media_entry_that_inflates_past_its_declared_size`).
  - 세션과 취소: `cancelled_open_registers_no_session`, `cancel_after_the_cache_directory_is_created_reclaims_it`, `cancel_during_an_in_flight_open_abandons_it`.
  - 재계산 캐시: `save_archive_keeps_the_source_resident_model_warm`, `concurrent_recalc_reports_busy`.
- 원본의 수정을 병합할 때는 그 수정의 테스트도 함께 가져오고, 병합 뒤에 Rust 테스트와 TypeScript 사이드카 테스트를 둘 다 돌린다.
