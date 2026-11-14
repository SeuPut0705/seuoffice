# 2단계 넘김 글 (MacBook, 2026-11-14)

중심 프로세스(Electron main)를 Rust로 옮기는 일(결정 0030)의 지금 상태. 가지는 `feat/rust-stage2-plan`이고 main에는 아직 합치지 않았다. 합치는 순서는 B → C2/C3 → D3 → 2단계다.

## 지금 상태

- `crates/main-core`는 B1–B6의 옮길 모듈을 모두 가졌다(엔진을 기다리는 모듈 제외; `shell/knowledge-base`는 검토 뒤 마저 옮김). 남은 B3·B4·B5는 다섯 가지(`feat/rust-stage2-{b3b4,projects,ai,mcp,provider}`)에서 옮겨 408290026에 합쳤다. 호스트를 모르는 크레이트이고, `tests/hosts.rs`가 napi·tauri·wry·cef·neon 의존을 막는다. Electron은 `crates/main-node`(Node-API 애드온, `#[napi(catch_unwind)]`)로 부른다.
- main b412c45e5의 검사 속도 수정과 결함 선택 규칙, 1a4a391ff의 수동 선택 우선순위를 합쳤다. `faultMode`·`--mode`와 workflow의 `ALL_FAULTS`·`MODE` 대입은 main 그대로다. 이 가지의 `apps/`, `packages/`는 main과 같다.
- 엔진을 기다리는 모듈, E·S3 묶음, preload 브리지는 옮기지 않았다. 목록과 까닭은 결정 0030의 결과 절에 있다.
- 408290026을 합친 직후 로컬 컴파일·서식·형 검사와 결함 5,973개의 위치 검사를 통과했다. 아래 후속 수정까지 포함한 후보의 로컬 검사와 러너 결과는 별도로 확인한다.
- 진단 실행 43529326459(cb4dfada1)는 비교, Windows, DOCX·PPTX·ODT 관문과 ODT 결함 조각을 통과했다. `main-faults`와 `pptx-faults`는 생략했으므로 최종 합격이 아니다. 이후 인수한 provider·MCP 수정의 검증 결과로도 쓰지 않는다.
- 새 Actions 실행은 메인 세션의 신호까지 보류한다. `feat/rust-stage2-plan`으로의 푸시는 실행을 부르지 않는다.

## 다음 할 일

1. 다음 후보에 provider 1562196d3·1eec4bf1a와 MCP c2cde66c4·51ca1af04를 인수했다. provider의 추가 회귀 766419d90과 수정 d402555c4도 인수했다. 스트림의 host 종료 응답이 뒤의 abort보다 우선하며 `Cmd`·`Event` 계약은 그대로다. MCP `RELAY_TEXT`는 잘린 UTF-16 쌍을 JSON escape로 정확히 쓰고, 해당 차이 장부 항목은 지웠다.
2. 메인 세션이 실행을 허용하면 최신 후보에서 비교와 결함을 확인한다. `tools/fault-reach.mjs`가 실제 차이로 선택한 엔진 결함을 모두 포함한다. `jscompat`·`ooxml-pkg`가 엔진 의존이므로 PPTX도 포함된다. DOCX는 네 결함 목록을 선택하며, 미분류 소스는 모든 엔진을 선택한다. DOCX의 `MISSED`·`SET ASIDE`는 실패다.
3. 이 가지 몫과 다섯 묶음의 중심 프로세스 결함도 확인한다. 다르게 나온 것과 놓친 결함을 고치고 새 케이스는 목록 끝에 붙인다. main의 수동 선택 우선순위는 D3가 소유하며 여기서 별도 모드를 만들지 않는다.
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

## 제품 후보를 고정한 결함 전용 실행

`ci/stage2-main-faults-only`의 드라이버 정의와 제품 `30f303cde7b496bf640aadffcb0b70bf7fb2ad21`은 서로 다른 커밋이다. 드라이버는 `github.sha`를 `driver/`에, 제품은 입력의 전체 SHA를 `product/`에 따로 checkout한다.

기존 제품 관문 43554838447이 성공한 뒤 아래 명령을 한 번만 실행한다. 계획 단계가 관문의 제품 SHA와 성공한 중심 프로세스 비교를 확인한다.

```sh
gh workflow run "seuoffice rust" --ref ci/stage2-main-faults-only \
  -f main_faults_product_sha=30f303cde7b496bf640aadffcb0b70bf7fb2ad21 \
  -f main_faults_gate_run=43554838447 -f fault_shards=4
```

이 명시 입력이 있으면 기존 `quick`과 그 뒤의 비교·엔진 행렬은 실행하지 않는다. 다른 결함 선택 입력이나 `all_faults=true`와 섞으면 실패한다. 일반 실행의 `faultMode`와 수동 선택 우선순위는 바꾸지 않는다.

`tools/main-diff/faults-only.mjs`는 제품의 모든 결함 목록을 계획에 담는다. 목록마다 네 조각으로 나누되 전체 동시 job은 넷으로 제한한다. 각 목록의 첫 양성 대조군은 네 번, 나머지 결함은 각각 한 번 실행한다. 제품의 `faults.mjs`는 그대로 쓴다. 감사 단계가 예상 결과 전체와 `CAUGHT` 판정을 확인해 `MISSED`·`BUILD`·`BAD`, 누락·중복·다른 조각의 결과를 실패로 만든다.

계획과 조각별 `identity.json`에는 정의 SHA, 제품 SHA, 기준 관문 ID와 attempt를 남긴다. 산출물 이름은 `main-faults-only-plan`과 `main-faults-only-<목록>-<조각>`이다. 전용 실행의 `cancel-in-progress`는 꺼지며, 별도 CI ref는 제품·D3 ref의 기존 실행을 취소하지 않는다.
