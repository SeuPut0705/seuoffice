# 2단계 넘김 글 (Mac mini → MacBook, 2026-11-13)

중심 프로세스(Electron main)를 Rust로 옮기는 일(결정 0030)의 지금 상태. 가지는 `feat/rust-stage2-plan`이고 main에는 아직 합치지 않았다. 합치는 순서는 B → C2/C3 → D3 → 2단계다.

## 지금 상태

- `crates/main-core`는 B1–B5 묶음의 Electron 없는 모듈을 모두 옮겼다. 호스트를 모르는 크레이트이고, `tests/hosts.rs`가 napi·tauri·wry·cef·neon 의존을 막는다. Electron은 `crates/main-node`(Node-API 애드온, `#[napi(catch_unwind)]`)로 부른다.
- 엔진을 기다리는 모듈과 E·S3 묶음은 옮기지 않았다. 목록은 결정 0030의 결과 절에 있다.
- 마지막으로 확인한 러너 결과:
  - 실행 43331027021(헤드 eef58680e): 비교 33,442번/972함수, 다른 것 0, 적힌 것 7. 결함 816건(겹치는 대조군 포함) 모두 잡힘. Windows node-fs 64/64, 파일 정체 23/23.
  - 실행 43341278969(헤드 ac40dd3ed): Windows의 libuv 표 대조는 100건 모두 맞았다. 다만 두 번째 시험이 틀린 기대를 해서 실패했고, 1ce6d219f에서 고쳤다. 결함 조각 2는 지운 `ord_map.rs`를 가리키던 결함 하나 때문에 멈췄고, 283cbc535에서 고쳤다. 그 뒤로는 러너에서 다시 돌리지 않았다.
- 이 기계에서 마지막으로 본 결과(ac40dd3ed 위): 비교 33,444번, 다른 것 0, 적힌 것 8(`excerptForNaming`의 서로게이트 자르기를 더함). clippy는 macOS와 `x86_64-pc-windows-msvc` 둘 다 깨끗하다.
- 이 가지의 `apps/`, `packages/`, `package.json`, `package-lock.json`은 origin/main과 같다(5c9e16f64). B·C 흐름의 TypeScript는 그들이 main에 넣은 뒤 다시 합친다.

## 다음 할 일 (메인 지시 d9, 아직 안 함)

1. `git merge origin/main`. main은 07a251652까지 움직였다(가림 묶음). 내가 맡지 않은 파일은 main 쪽을 받는다. 바뀐 TypeScript 가운데 이 가지가 옮긴 파일(`apps/*/src/main`, `packages/electron-utils`, `packages/i18n`, `packages/ai-provider`의 설정 층)이 있으면 Rust를 따라 고친다. 비교에서 차이가 보이면 그것이 할 일이다. 그런 다음 케이스를 목록 끝에 더하고, 옮긴 것을 되돌리는 결함을 `faults/`에 더한다.
2. 러너에서 비교와 결함을 다시 돌려 B4/B5까지 100% 잡히는지 확인한다(아래 명령).
3. 다음 묶음은 B6이다(결정 0030 표: Electron을 직접 쓰는 논리, 33모듈 8,616줄). 판단(창 위치 계산, 탭 상태, 감시 시간표)은 `main-core`로 옮기고, Electron을 부르는 몇 줄만 TypeScript에 남긴다. 목록은 `npx tsx tools/main-inventory/inventory.ts`의 `out/batches.json`에 있다. 엔진을 기다리는 모듈은 B4/C/D가 들어간 뒤에 한다.

## 돌리는 법

Node 22와 rustc 1.100.0을 쓴다. `npm ci`는 저장소 뿌리에서 돌린다.

```sh
# 애드온을 짓고 비교한다(전체 1–2분)
cd tools/main-diff
MAIN_DIFF_ADDON=/tmp/addon/main_node.node MAIN_DIFF_OUT=/tmp/out node build.mjs
MAIN_DIFF_ADDON=/tmp/addon/main_node.node MAIN_DIFF_OUT=/tmp/out npx tsx main.ts            # 전체
npx tsx main.ts --group b4-markdown --fn 'i18n.existingOrCurrent' --show 10                 # 일부

# 결함: 하나씩 Rust를 바꿔 짓고 비교가 차이를 내는지 본다
node faults.mjs faults/b1.json,faults/b2.json      # FAULT_SHARD=i/n 으로 나눠 돌림

# 러너(비교 + Windows + 결함 6조각)
gh workflow run "seuoffice rust" --ref feat/rust-stage2-plan \
  -f main_faults=tools/main-diff/faults/b1.json,tools/main-diff/faults/b2.json,tools/main-diff/faults/b3.json,tools/main-diff/faults/b4.json,tools/main-diff/faults/b5.json,tools/main-diff/faults/d8.json
```

산출물은 `main-diff-out`, `main-diff-windows-out`, `main-diff-faults-0..5`다. 같은 가지에 푸시하면 돌던 실행이 취소된다.

규칙(`crates/README.md`):

- JS 연산은 `jscompat`에 하나만 둔다(`JsMap`, `node_path`, `json_value` 등).
- 함수마다 서로 다른 답이 둘 이상 나와야 한다(`single`은 상수만).
- 새 묶음의 첫 비교는 러너에서 돌리고, 고치기 전 출력을 `tools/main-diff/first/`에 둔다.
- 차이는 가리지 않는다. 남길 차이는 이유와 함께 `divergences.json`에 적는다.
- 새 케이스는 목록 끝에 붙인다(장부가 케이스 번호로 찾는다).

## 알려진 빨강 (이 가지 탓 아님)

- `crates` 작업의 Format: `office-wasm/src/invoke/table.rs`
- Unit tests의 `jscompat` sites: B의 `docx-engine` 파일. `cargo test`가 거기서 멈추므로 main-core 시험은 따로 돌린다(`cargo test -p main-core`).
- docx gate와 pptx 작업들: 이 가지에 B·C의 TypeScript가 없다.

## 열린 질문

- 메인에게 확인할 것: 놓친 결함을 정리하며 PDF 결함 둘을 지웠다(Windows·macOS 도우미에서만 도는 BOM, 종료 상태). Windows 러너에서 OCR 도우미를 도는 비교를 따로 둘지는 정하지 않았다.
- `system-certificates`의 `CertificateReader`, PDFium, HarfBuzz 부분 집합은 비교 틀의 가짜 구현으로만 맞댔다. 실제 뒷단이 오면(엔진 흐름) 그 모듈을 다시 비교해야 한다. 결정 0030에는 아직 이것을 기다리는 모듈로 적지 않았다.
- Mac mini 전용이던 `/tmp/stage2-heavy.sh`(무거운 작업 두 자리 나누기)는 MacBook에서는 필요 없다.
