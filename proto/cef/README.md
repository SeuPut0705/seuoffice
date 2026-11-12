# CEF 껍데기 (버리는 코드)

후보 2: Tauri 3 알파 + `tauri-runtime-cef`(Chromium을 함께 싣는다). 계약은 `../README.md`.

| 무엇                   | 어디                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| 명령, 시작 줄, userData | `src-tauri/src/main.rs`                                                      |
| 정체, 파일 연결, 서명  | `src-tauri/tauri.conf.json` (식별자 `com.seuput.seuoffice`, 판 `0.13.0`)     |
| Windows 덮어 깔기      | `src-tauri/windows/hooks.nsh` (NSIS 설치 훅), 시험은 `ci/win-takeover.ps1`   |
| macOS 묶기와 확인      | `ci/mac-package.sh` (zip, `codesign --verify --deep --strict`, 업데이터 점검) |
| 연기 시험              | `ci/smoke.py` (bench, pdf, OSCrypt 탐침)                                     |
| 빌드                   | `.github/workflows/proto-cef.yml` (아티팩트 `proto-cef-<mac\|win>`)          |

- 프런트엔드: `../common/stage-dist.sh proto/cef/dist`가 만든 폴더를 실행 파일에 넣는다(`http://tauri.localhost`).
- Chromium 프로필은 `{user cache}/com.seuput.seuoffice/cef`에 둔다. Electron userData 폴더(`seuoffice`)와 따로다. `BENCH_USER_DATA`가 있으면 그 옆 `<폴더>-cef`로 옮긴다.
- `print_pdf`는 CDP `Page.printToPDF`(`WebviewCefExt::send_dev_tools_message`)로 한다.
- `CEF_PROBE_OSCRYPT=1`이면 영속 쿠키를 하나 써서 Chromium OSCrypt가 키를 만들게 한다(연기 시험이 키체인 항목, `Local State`를 확인하려고 쓴다).
- 이 맥북에서 돌리지 않는다. 빌드와 시험은 러너에서만 한다.
