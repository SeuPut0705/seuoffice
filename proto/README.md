# 껍데기 시제품 (버리는 코드)

결정 0026 3항의 측정을 위한 시제품이다. `main`에 합치지 않는다. 고른 껍데기는 이 코드가 아니라 새 결정(`docs/seuoffice/decisions/`)과 그 뒤의 본 작업으로 이어진다.

| 폴더             | 무엇                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| `common/`        | 측정 호스트 페이지, 50쪽 모의 문서, 측정 하네스, 그림 비교                        |
| `electron/`      | 비교 기준: 같은 호스트 페이지를 Electron 43.8.3(앱과 같은 판)으로 띄운다          |
| `tauri2/`        | 후보 1: Tauri 2, 시스템 웹뷰(macOS WKWebView, Windows WebView2)                   |
| `cef/`           | 후보 2: Tauri 3 알파 + `tauri-runtime-cef`(Chromium을 함께 싣는다)                |
| `secrets/`       | Electron `safeStorage`가 봉한 비밀값을 Rust로 여는 증명                           |

## 화면

세 껍데기 모두 같은 것을 띄운다: v0.12.37 릴리스의 웹 묶음(`seuoffice-web-0.12.37.tgz`)에 든 워드 편집기(`dist/docs`, `apps/docs/src/renderer`를 웹 데스크톱 브리지 뒤에 둔 것)를 `common/host/host.html`이 iframe으로 열고 `@seuoffice/embed` 규약으로 문서를 건넨다. `common/stage-dist.sh <폴더>`가 그 폴더를 만든다(`host.html`이 시작 페이지, `docs/`, `template-fonts/`).

## 껍데기가 지킬 것 (계약)

### 실행할 때

- 창 하나, 논리 크기 1280x900, 제목 `SeuOffice`, 곧바로 보인다. 시작 페이지는 `host.html`.
- 호스트 페이지가 부르는 명령(Tauri는 같은 이름의 command, Electron은 preload의 `window.__shell`; 모양은 `common/host/host.js` 머리 주석과 `tauriShell()`):
  - `bench_config` → `{ doc, mode, t0, shellName }`: 환경 변수 `BENCH_DOC`(절대 경로, 없으면 null), `BENCH_MODE`(`bench`|`pdf`|`interactive`, 없으면 `interactive`), `BENCH_T0`(하네스가 실행 직전에 잰 epoch 밀리초, 숫자, 없으면 null), `BENCH_SHELL`.
  - `open_file { path }` → `{ path }`: path가 null이면 네이티브 열기 대화상자.
  - `read_file { path }` → 원시 바이트(`tauri::ipc::Response`).
  - `save_file`: 본문이 원시 바이트, 헤더 `x-path`(encodeURIComponent)에 쓸 경로.
  - `echo`: 원시 바이트를 받아 그대로 돌려준다.
  - `report { line }`: `BENCH_OUT`(JSONL)에 한 줄 덧붙인다.
  - `print_pdf { out, width, height }` → `{ ok, error? }`: 지금 최상위 페이지를 인치 단위 용지, 여백 0, 배경 포함으로 PDF로 `out`에 쓴다.
- 켜자마자: `BENCH_OUT`이 있으면 `{ "kind": "startup", "shell", "pid", "userDataDir", "userDataEntries": [...] }` 한 줄을 쓴다. 그리고 환경 변수와 상관없이 늘 `<userData>/proto-shell-started.json`에 `{ shell, version, args, time }`을 쓴다. userData는 Electron 판의 폴더 그대로다: Windows `%APPDATA%\seuoffice`, macOS `~/Library/Application Support/seuoffice`. 환경 변수 `BENCH_USER_DATA`가 있으면 그 폴더를 쓴다(이 맥북에서 돌릴 때 실제 사용자 폴더를 건드리지 않도록).
- 명령줄: `--updated`, `--force-run`은 받아서 무시한다. 위치 인자로 온 `.docx` 경로는 interactive 모드로 그 파일을 연다(파일 연결 확인용).

### 묶을 때 (아티팩트 `proto-<shell>-<mac|win>`)

- 정체: 표시 이름 `SeuOffice`, 식별자 `com.seuput.seuoffice`, 판 `0.13.0`(마지막 Electron 판 0.12.37보다 높다).
- Windows: 사용자별 NSIS 설치 파일 `SeuOffice-Setup-0.13.0.exe`. Electron 판이 깔려 있으면 그 자리(electron-builder가 `HKCU\Software\<제거 정보 키 이름>`의 `InstallLocation`에 적는다. 제거 정보 키에는 없다. 보통 `%LOCALAPPDATA%\Programs\SeuOffice`)에 덮어 깔고, 그 제거 정보 키를 이어 쓰고(앱 목록에 SeuOffice 하나), 옛 Electron 파일을 치운다. 파일 연결은 `apps/shell/electron-builder.cjs`의 `winProgId` 규칙(`seuoffice.WordDocument` 등)과 `apps/shell/build/installer.nsh`를 따른다(적어도 `.docx`). `/S`, `--updated`, `--force-run`(설치 뒤 앱을 연다)을 받는다. electron-updater는 `설치파일 --updated /S --force-run`으로 부른다.
- macOS: `SeuOffice-0.13.0-arm64-mac.zip`(`ditto -c -k --keepParent SeuOffice.app`), 앱은 하나, `CFBundleIdentifier` `com.seuput.seuoffice`, `CFBundleShortVersionString` `0.13.0`, `codesign --verify --deep --strict` 통과(임시 서명 가능), `CFBundleDocumentTypes`에 적어도 docx. 지금 업데이터(`apps/shell/src/main/mac-update.ts`)가 이 셋을 확인하고 바꿔 끼운다. 번들러가 dmg를 만들면 함께 싣는다.
- `build-info.json`: `{ shell, os, exe, versions, buildSeconds }`. `exe`는 설치 폴더(Windows) 또는 zip을 푼 폴더(macOS) 기준의 실행 파일 상대 경로.

## 측정

`.github/workflows/proto-measure.yml`(workflow_dispatch)이 빌드 실행 번호를 받아 아티팩트를 내려받고, 같은 러너에서 Electron 기준과 두 후보를 차례로 잰다. 하네스는 `common/bench.py`.
