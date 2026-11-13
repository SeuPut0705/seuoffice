# 2단계 넘김 글 (MacBook, 2026-11-13)

중심 프로세스(Electron main)를 Rust로 옮기는 일(결정 0030)의 지금 상태. 가지는 `feat/rust-stage2-plan`이고 main에는 아직 합치지 않았다. 합치는 순서는 B → C2/C3 → D3 → 2단계다.

## 지금 상태

- `crates/main-core`는 B1–B5 묶음의 Electron 없는 모듈과 B6(Electron을 직접 쓰는 모듈)의 판단을 옮겼다. 호스트를 모르는 크레이트이고, `tests/hosts.rs`가 napi·tauri·wry·cef·neon 의존을 막는다. Electron은 `crates/main-node`(Node-API 애드온, `#[napi(catch_unwind)]`)로 부른다.
- main 07a251652를 합쳤다(1bf2c0bfd). 이 가지의 `apps/`, `packages/`는 그 main과 같다.
- 엔진을 기다리는 모듈, E·S3 묶음, preload 브리지는 옮기지 않았다. 목록과 까닭은 결정 0030의 결과 절에 있다.
- 이 기계에서 마지막으로 본 결과(전체 비교, 그룹마다 따로 프로세스): 함수 1,095개, 34,692번, 다른 것 0, 적힌 것 10. clippy(`-D warnings`)는 macOS에서 깨끗하다.
- 러너 실행 43348725507(헤드 87af9aa75, B1–B5와 d8·d9 결함)은 GitHub API 한도에 걸려 끝을 확인하지 못했다. B6 결함(`faults/b6-*.json`, 452개)은 아직 러너에서 돌리지 않았다.

## 다음 할 일

1. 러너에서 비교와 결함 전부를 돌린다(아래 명령에 `b6-*.json`과 `d9.json`을 더함). 놓친 결함은 경계 입력을 더하거나 결함을 바꾼다.
2. 지울 후보(결정 0030): `packages/electron_utils/{project_folder_bridge,split_pane_bridge}.rs`와 그 케이스. 메인의 확인 뒤에 지운다.
3. B3의 `shell/launch-recovery`(633줄, Electron에 간접으로 닿음)를 옮기고 `recovery_shell.rs`의 `LaunchPlanner` trait를 그 포트로 바꾼다.
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
gh workflow run "seuoffice rust" --ref feat/rust-stage2-plan \
  -f main_faults=tools/main-diff/faults/b1.json,tools/main-diff/faults/b2.json,tools/main-diff/faults/b3.json,tools/main-diff/faults/b4.json,tools/main-diff/faults/b5.json,tools/main-diff/faults/d8.json,tools/main-diff/faults/d9.json,tools/main-diff/faults/b6-utils.json,tools/main-diff/faults/b6-shell.json,tools/main-diff/faults/b6-apps.json,tools/main-diff/faults/b6-tabs.json
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

- `crates` 작업의 Format: `office-wasm/src/invoke/table.rs`
- Unit tests의 `jscompat` sites: B의 `docx-engine` 파일. main-core 시험은 따로 돌린다(`cargo test -p main-core`).
- docx gate와 pptx 작업들: 이 가지에 B·C의 TypeScript가 없다.

## 열린 질문

- `system-certificates`의 `CertificateReader`, PDFium, HarfBuzz 부분 집합, `zip-splice`(lazy-media)는 비교 틀의 가짜 구현으로만 맞댔다. 실제 뒷단이 오면 그 모듈을 다시 비교해야 한다.
- Windows 러너에서 OCR 도우미를 도는 비교를 따로 둘지는 정하지 않았다.
