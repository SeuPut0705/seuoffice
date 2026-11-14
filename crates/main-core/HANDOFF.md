# 2단계 넘김 글 (MacBook, 2026-11-14)

중심 프로세스(Electron main)를 Rust로 옮기는 일(결정 0030)의 지금 상태. 고정 제품은 `feat/rust-stage2-plan`의 30f303cde이고, 최신 main을 합치는 별도 가지는 `feat/rust-stage2-main-d3`다. main에는 아직 합치지 않았다.

## 지금 상태

- `crates/main-core`는 B1–B6의 옮길 모듈을 모두 가졌다(엔진을 기다리는 모듈 제외; `shell/knowledge-base`는 검토 뒤 마저 옮김). 남은 B3·B4·B5는 다섯 가지(`feat/rust-stage2-{b3b4,projects,ai,mcp,provider}`)에서 옮겨 408290026에 합쳤다. 호스트를 모르는 크레이트이고, `tests/hosts.rs`가 napi·tauri·wry·cef·neon 의존을 막는다. Electron은 `crates/main-node`(Node-API 애드온, `#[napi(catch_unwind)]`)로 부른다.
- main 682563d76(D3 포함)을 별도 통합 가지에 정상 merge했다. main의 5엔진 workflow job, 입력·출력, `faultMode`·`--mode`, `ALL_FAULTS`·`MODE` 대입과 RHWP 준비를 보존한다. `apps/`, `packages/`, 제품 잠금과 `vendor/`는 main과 같다.
- 엔진을 기다리는 모듈, E·S3 묶음, preload 브리지는 옮기지 않았다. 목록과 까닭은 결정 0030의 결과 절에 있다.
- 408290026을 합친 직후 로컬 컴파일·서식·형 검사와 결함 5,973개의 위치 검사를 통과했다. 아래 후속 수정까지 포함한 후보의 로컬 검사와 러너 결과는 별도로 확인한다.
- 고정 제품 30f303cde의 실행 43554838447(시도 1)은 전체 성공했다. 중심 프로세스 비교는 52,688개 검사·2,327개 함수, 미등록 차이 0개·등록 차이 13개다. Windows 비교와 DOCX 네 목록 80개·PPTX 317개·ODT 26개 결함을 산출물 전체에서 확인했다.
- 중심 프로세스 결함 6,121개는 정의 7594c1243, 제품 30f303cde, 녹색 관문 43554838447을 고정한 전용 실행 43568242384에서 확인 중이다. 46개 목록마다 네 조각, 전체 최대 네 job이다. 이 실행과 별도 통합 후보의 코드를 섞지 않는다. 새 후보 Actions는 메인 세션의 범위 결정까지 보류한다.

## 다음 할 일

1. 다음 후보에 provider 1562196d3·1eec4bf1a와 MCP c2cde66c4·51ca1af04를 인수했다. provider의 추가 회귀 766419d90과 수정 d402555c4도 인수했다. 스트림의 host 종료 응답이 뒤의 abort보다 우선하며 `Cmd`·`Event` 계약은 그대로다. MCP `RELAY_TEXT`는 잘린 UTF-16 쌍을 JSON escape로 정확히 쓰고, 해당 차이 장부 항목은 지웠다.
2. 별도 통합 후보는 main의 5엔진과 RHWP source-only 준비를 보존한다. OOXML의 새 `load(bytes, keep_raw)`에는 MCP 압축 해제 호출에서 `false`를 넘겨 원시 압축 데이터 복사를 요구하지 않는다. main의 Cargo 잠금 316개 패키지 정체성을 유지하고 중심 프로세스 의존 50개를 더했다.
3. 고정 결함 실행은 단일 watcher로 끝까지 보고, 모든 목록·조각의 빠짐·중복·순서와 `CAUGHT` 판정을 감사한다. 새 후보는 별도로 전체 비교·Windows·실제 차이로 도달하는 5엔진 결함을 확인해야 하며, 고정 제품의 성공을 새 후보 합격으로 쓰지 않는다.
4. 엔진을 기다리는 모듈은 B4/C/D가 들어간 뒤에 한다.

## 돌리는 법

Node 22와 rustc 1.100.0을 쓴다. `npm ci`는 저장소 뿌리에서 돌린다. 로컬 검사는 `ompdesk check -- <명령>`, 그 밖의 무거운 명령은 `ompdesk run --heavy -- <명령>`으로 감싼다.

```sh
export SCRATCH=/Users/seuput/.cache/ompdesk/scratch/1eca6d513db26eeccf9b7721ee043cf8
export MAIN_DIFF_ADDON="$SCRATCH/addon/main_node.node" MAIN_DIFF_OUT="$SCRATCH/out"
cd tools/main-diff
node build.mjs
npx tsx main.ts                                                                            # 전체(그룹마다 프로세스 하나)
npx tsx main.ts --group b6-tabs --fn 'tab-manager.split' --show 10                           # 일부
npx tsx main.ts --list                                                                       # 그룹과 함수

# 결함: 하나씩 Rust를 바꿔 짓고 비교가 차이를 내는지 본다. 소스를 고쳐 쓰므로 다른 일과 같이 돌리지 않는다
node faults.mjs faults/b1.json,faults/b2.json      # FAULT_SHARD=i/n 으로 나눠 돌림

# 러너: 메인 세션이 허용한 뒤에만 실행한다.
# 모든 후속 작업은 quick에 의존한다. 서식·clippy·단위 시험은 quick에서 돈다.
# 실행 파일은 main 것에 이 가지의 것을 더해 만든다: main을 합친 뒤
#   git show origin/main:.github/workflows/seuoffice-rust.yml > "$SCRATCH/main.yml"
#   python3 tools/main-diff/compose-workflow.py "$SCRATCH/main.yml" tools/main-diff/workflow-additions.txt > "$SCRATCH/composed.yml"
# compose 결과로 실행 파일을 갱신한다. main의 엔진 job과 선택 조건은 그대로 보존한다.
# skip_pptx_faults 우회는 제거했다. fault_shards=1,2,4,8은 DOCX와 main-faults 조각 수에 함께 적용된다.
# 중심 프로세스 결함은 한 실행에 다 넣지 않고
# 묶음별로 나눠 돌린다. 이 가지 몫(b1-b6, d8, d9, b2-cli, b4-fonts, b4-pdf-store, b5-kb):
gh workflow run "seuoffice rust" --ref feat/rust-stage2-plan \
  -f fault_shards=8 -f main_faults=$(ls tools/main-diff/faults/{b1,b2,b3,b4,b5,d8,d9,b2-cli,b4-fonts,b4-pdf-store,b5-kb}.json tools/main-diff/faults/b6-*.json | paste -sd, -)
# 나머지는 실행마다 한 묶음: b3-projects.*, b3b4-rest-*, b5-agent-*, b5-mcp, b5-provider-*
```

산출물은 `main-diff-out`, `main-diff-windows-out`, `main-diff-faults-<조각>`이다. 같은 가지에 푸시하면 돌던 실행이 취소된다.

규칙(`crates/README.md`):

- JS 연산은 `jscompat`에 하나만 둔다(`JsMap`, `node_path`, `json_value`, `inherited_string` 등).
- Electron 객체는 모듈이 실제로 부르는 메서드만 가진 trait로 받는다. 대화 상자는 `electron_utils::message_box`, 파일 대화 상자는 `dialog_memory::Dialog`.
- 비교 틀의 Electron은 `electron-fake.ts`의 `useElectron` 하나, 대화 상자 가짜는 `fakes.ts`/`calls/fakes.rs` 하나다.
- 함수마다 서로 다른 답이 둘 이상 나와야 한다(`single`은 상수만).
- 차이는 가리지 않는다. 남길 차이는 이유와 함께 `divergences.json`에 적는다.
- 새 케이스는 목록 끝에 붙인다(장부가 케이스 번호로 찾는다).

## 알려진 빨강 (이 가지 탓 아님)

- 없음. B4가 main에 들어온 뒤(main 0d78db19c) main을 합치며 `crates/`의 엔진 쪽(`office-wasm`, `docx-engine`, `pptx-engine`, `tools/docx-diff`, `jscompat/tests/sites.rs`)은 main 그대로 두었다. `jscompat`과 `ooxml-pkg`에는 이 가지가 더한 것(`node_path`, `json_print`, `date_parse`, `jszip`의 `unix_permissions` 등)만 남는다.

## 열린 질문

- `system-certificates`의 `CertificateReader`, PDFium, HarfBuzz 부분 집합, `zip-splice`(lazy-media)는 비교 틀의 가짜 구현으로만 맞댔다. 실제 뒷단이 오면 그 모듈을 다시 비교해야 한다.
- Windows 러너에서 OCR 도우미를 도는 비교를 따로 둘지는 정하지 않았다.
