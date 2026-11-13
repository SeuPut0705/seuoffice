# 2단계 넘김 글 (MacBook, 2026-11-14)

중심 프로세스(Electron main)를 Rust로 옮기는 일(결정 0030)의 지금 상태. 가지는 `feat/rust-stage2-plan`이고 main에는 아직 합치지 않았다. 합치는 순서는 B → C2/C3 → D3 → 2단계다.

## 지금 상태

- `crates/main-core`는 B1–B6의 옮길 모듈을 모두 가졌다(엔진을 기다리는 모듈 제외; `shell/knowledge-base`는 검토 뒤 마저 옮김). 남은 B3·B4·B5는 다섯 가지(`feat/rust-stage2-{b3b4,projects,ai,mcp,provider}`)에서 옮겨 408290026에 합쳤다. 호스트를 모르는 크레이트이고, `tests/hosts.rs`가 napi·tauri·wry·cef·neon 의존을 막는다. Electron은 `crates/main-node`(Node-API 애드온, `#[napi(catch_unwind)]`)로 부른다.
- main 8b9fd99ea를 합쳤다(305eba4a8). 이 가지의 `apps/`, `packages/`는 그 main과 같다.
- 엔진을 기다리는 모듈, E·S3 묶음, preload 브리지는 옮기지 않았다. 목록과 까닭은 결정 0030의 결과 절에 있다.
- 합친 뒤 이 기계에서 본 것: `cargo check -p main-core --tests` 경고 없음, `cargo fmt --all --check`, `tools/main-diff`의 tsc·prettier, 결함 5,973개의 `find`가 모두 한 번.
- 마지막 러너 결과(43415208707, e8208d3d2, 다섯 가지를 합치기 전): 비교 35,914번 다른 것 0, 적힌 것 10, 함수 1,223개; 결함 1,707개 모두 잡힘; Windows 비교, clippy, 서식 통과. 남았던 빨강(sites 시험, 비교 엔진의 `host_callback`)은 680d88362에서 고쳤다.
- 소유자 결정으로 OMPdesk 1판이 나올 때까지 Actions 실행을 시작하지 않는다(`gh workflow run`, `gh run rerun`, 실행을 부르는 가지로의 푸시 모두). `feat/rust-stage2-*`로의 푸시는 실행을 부르지 않는다.

## 다음 할 일

1. Actions가 다시 열리면: 이 가지에서 비교+clippy+이 가지 몫의 결함을 한 번, 다섯 가지는 각자 자기 결함 파일로 한 번(한 실행에 다 넣으면 120분 제한을 넘는다). 고친 것은 그 가지에서 고치고 여기로 다시 합친다.
2. 다르게 나온 것과 놓친 결함을 고친다(새 케이스는 목록 끝에).
3. main을 다시 합치고, 바뀐 TypeScript 가운데 이 가지가 옮긴 파일을 Rust로 따라 고친다.
4. 엔진을 기다리는 모듈은 B4/C/D가 들어간 뒤에 한다.

## 돌리는 법

Node 22와 rustc 1.100.0을 쓴다. `npm ci`는 저장소 뿌리에서 돌린다. 이 MacBook에서는 무거운 일을 `/tmp/heavy.sh`로만 돌린다.

```sh
cd tools/main-diff
MAIN_DIFF_ADDON=/tmp/addon/main_node.node MAIN_DIFF_OUT=/tmp/out node build.mjs
MAIN_DIFF_ADDON=/tmp/addon/main_node.node MAIN_DIFF_OUT=/tmp/out npx tsx main.ts            # 전체(그룹마다 프로세스 하나)
npx tsx main.ts --group b6-tabs --fn 'tab-manager.split' --show 10                          # 일부
npx tsx main.ts --list                                                                       # 그룹과 함수

# 결함: 하나씩 Rust를 바꿔 짓고 비교가 차이를 내는지 본다. 소스를 고쳐 쓰므로 다른 일과 같이 돌리지 않는다
node faults.mjs faults/b1.json,faults/b2.json      # FAULT_SHARD=i/n 으로 나눠 돌림

# 러너(비교 + Windows + 결함 6조각)
# 실행 파일의 작업은 모두 `needs: quick`이다(main 0d78db19c의 규칙): 서식·clippy·단위 시험은 quick에서 돈다.
# 결함 1,707개가 6조각에 85-100분 걸렸다(작업 제한 120분). 6,109개 전부는 한 실행에 들지 않으므로
# 묶음별로 나눠 돌린다. 이 가지 몫(b1-b6, d8, d9, b2-cli, b4-fonts, b4-pdf-store, b5-kb):
gh workflow run "seuoffice rust" --ref feat/rust-stage2-plan \
  -f main_faults=$(ls tools/main-diff/faults/{b1,b2,b3,b4,b5,d8,d9,b2-cli,b4-fonts,b4-pdf-store,b5-kb}.json tools/main-diff/faults/b6-*.json | paste -sd, -)
# 나머지는 실행마다 한 묶음: b3-projects.*, b3b4-rest-*, b5-agent-*, b5-mcp, b5-provider-*
```

산출물은 `main-diff-out`, `main-diff-windows-out`, `main-diff-faults-0..5`다. 같은 가지에 푸시하면 돌던 실행이 취소된다.

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
