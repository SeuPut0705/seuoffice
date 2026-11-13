# crates/shell

3단계의 껍데기다. Tauri 3 알파 + `tauri-runtime-cef`(CEF)로 만든 실행 파일 하나이고, `main-core`를 같은 프로세스에 링크한다. 근거는 결정 0025(Rust 전환), 0029(껍데기 선택), 0030(중심 프로세스 `main-core`)이고, 모양은 `docs/seuoffice/3단계-셸-계약.md`가 정한다. 이 폴더는 자기 작업 공간과 잠금 파일을 가진다(`crates/Cargo.toml`이 `exclude`). CEF가 약 1 GB 내려받기라 Mac과 Windows 러너에서만 짓는다(`.github/workflows/seuoffice-shell.yml`).

## 지금 되는 것과 안 되는 것

|                                                                                  | 상태                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 셸 뼈대: 스레드 셋, 서비스, 채널 표 시작 검사, 실패하면 오류를 찍고 끝남         | 됨                                                                                                       |
| IPC 경계: `ipc_invoke`, `ipc_send`, `ipc_listen`, 동기 스킴 `seuoffice-ipc`      | 됨(러너에서 처음 돈다)                                                                                   |
| 앱 스킴: 호스트마다 스킴 하나로 렌더러 묶음을 내줌                               | 됨                                                                                                       |
| preload 묶기와 브리지(`ipcRenderer`, `contextBridge`, `webUtils`, `webFrame`)    | 됨. `node crates/shell/bridge/preloads.mjs`가 19개를 만든다                                              |
| 공용 호스트: 대화 상자, OS 셸, 클립보드, 웹 콘텐츠, 셸 창                        | 됨                                                                                                       |
| 묶음 W 전용 호스트                                                               | **로그만 찍는 대역**이다. 표는 `src/host/w.rs`                                                           |
| 창·탭 계층(`WindowsHost`)과 `TabHooks`                                           | 대역. 진짜 구현은 다음 단위다                                                                            |
| 다른 묶음의 호스트(`src/host/{crash,d1,d2,menu,net,os,print,secrets,update}.rs`) | 파일만 있고 `install`이 비어 있다. 맡은 묶음이 채운다                                                    |
| 셸 창을 띄우는 일                                                                | 셸 렌더러(`apps/shell/out/renderer`)를 한 창에 띄우기만 한다. 탭 관리는 `tabs` 처리기를 이을 때 들어온다 |

## 짓기와 점검

러너 밖에서 CEF를 받지 않고 점검하려면(`cef` 크레이트의 `dox` 기능을 쓴다):

```sh
node crates/shell/bridge/preloads.mjs        # src/preload.rs가 묶음을 포함하므로 먼저
crates/shell/ci/check-local.sh check
crates/shell/ci/check-local.sh clippy --no-deps --all-targets -- -D warnings
crates/shell/ci/check-local.sh test          # 순수한 시험만 돈다. CEF는 부르지 않는다
```

러너에서는 워크플로가 같은 순서로 지은 뒤 측정까지 돌린다. Mac은 `npx tauri build --bundles app`(CEF 프레임워크가 `.app` 안에 있어야 한다), Windows는 `cargo build --release`다. `cef-dll-sys`는 CEF 실행 파일들을 빌드 스크립트 OUT_DIR에서 세 단계 위로 복사하는데, 새 cargo의 빌드 폴더 배치에서는 `target/release/build`에 떨어져 `target/release`의 exe 옆에 `libcef.dll`이 없다(실행하면 bash가 127). 그래서 워크플로가 CEF 배포판에서 `target/release`로 따로 복사한다. CEF 목록(`index.json`)이 `cef` 크레이트의 10 MB 상한을 넘어 `ci/cef-index-mirror.py`로 줄인 목록을 내준다(`CEF_DOWNLOAD_URL`).

## 환경 변수와 인자

|                               | 뜻                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEUOFFICE_SHELL_PARTIAL=1`   | 채널 표가 덜 찼어도 시작한다. 없으면 `Completeness::Complete`라서 처리기가 없는 채널이 하나라도 있으면 시작하지 않고 목록을 찍는다. 묶음이 다 차기 전에는 이것이 있어야 뜬다 |
| `SEUOFFICE_USER_DATA`         | userData 폴더를 바꾼다(Electron 판의 시험 몰이꾼과 같다). Chromium 프로필은 그 옆 `<값>-cef`에 둔다                                                                          |
| `SEUOFFICE_APPS_DIR`          | `apps` 폴더. 기본은 빌드한 체크아웃이다. 렌더러는 `<apps>/<앱>/out/renderer`에서 읽는다                                                                                      |
| `--measure-dialog <out.json>` | 아래 측정                                                                                                                                                                    |
| `SEUOFFICE_SHELL_TRACE=1`     | 시각이 붙은 IPC 길 기록(`src/trace.rs`)을 stderr에 남긴다. `--measure-dialog`은 늘 켠다                                                                                      |
| `CI`                          | 시작 실패 때 대화 상자를 띄우지 않는다                                                                                                                                       |

userData는 Electron 판과 같은 자리다(결정 0013, 0019): 기본이 `appData/seuoffice`, 디버그 판은 Electron의 포장하지 않은 실행처럼 `appData/seuoffice-Dev`.

## 파일 지도

```
bridge/        preload 쪽. wire.ts, electron.ts(Transport 인터페이스, 계약), tauri.ts(Tauri 전송), electron-entry.ts(preload가 `electron`으로 받는 것), preloads.mjs
frontend/      Tauri의 frontendDist(자리 채움)와 측정 페이지 measure.html
src/main.rs    스레드, 서비스, 시작
src/ipc/       명령 셋(mod.rs), 뷰마다 출력 흐름(outlet.rs), 동기 스킴(sync.rs)
src/views.rs   뷰 표: 웹뷰 이름표 → Sender(ViewId, WindowId, Surface)
src/app_scheme.rs  앱 스킴, 주소 바꾸기
src/preload.rs     묶은 preload를 바이너리에 넣음
src/paths.rs       app.getPath
src/host/      호스트들(dialog, os_shell, clipboard, contents, window, w, unbuilt 와 다른 묶음의 빈 파일)
src/measure.rs --measure-dialog
ci/            CEF 목록 줄이기, 로컬 점검
```

## IPC (계약 2절의 실제 모양)

- 명령 `ipc_invoke`의 본문은 프레임 `{id, channel, args}`(raw)다. 명령은 받았다는 표시만 답하고, 처리기의 답은 그 뷰의 출력 흐름에 `{reply: id, value | error}` 프레임으로 간다. `ipc_send`는 `{channel, args}`이고 답이 없다.
- 출력 흐름은 Tauri `ipc::Channel`이다. 브리지가 페이지가 시작될 때 `ipc_listen`으로 건넨다. 그 전에 나가는 프레임은 `TauriOutlet`이 기다려 두었다가(최대 1024개) 흐름이 열리면 순서대로 보낸다. 같은 뷰가 `ipc_listen`을 다시 부르면 새 문서로 보고 이전 문서의 호출을 취소한다.
- 브리지는 명령을 한 줄로 세운다(앞 명령의 받았다는 표시를 기다린 뒤 다음을 보낸다). 동시에 보낸 요청은 Tauri의 HTTP 길에서 순서가 뒤바뀔 수 있는데, 처리기는 뷰마다 보낸 순서를 지켜야 해서다. 대가는 호출마다 받았다는 표시 한 번의 왕복이다.
- 동기 호출은 **`http://seuoffice-ipc.localhost/<채널>`로 가는 동기 XHR**이다. 계약 문서의 `seuoffice-ipc://sync/<ch>`는 Electron/WKWebView식 이름이고, CEF 런타임은 사용자 스킴을 `http://<스킴>.localhost`로만 내준다. 같은 스킴이 표에 없는 예약 채널 셋을 답한다: `webutils:dropped-paths`, `webframe:set-zoom-factor`, `webframe:get-zoom-factor`.
- 보낸 이는 호출한 웹뷰의 이름표로 찾는다(`ViewTable`). 브리지가 없는 웹뷰의 메시지는 거절하고, 채널의 `surfaces`에 없는 웹뷰는 `Dispatcher`가 거절한다. 브리지가 있는 웹뷰는 자기 앱 스킴 밖으로 이동하지 못하고(`on_navigation`) `window.open`도 못 연다.
- 처리기의 panic은 `catch_unwind`로 오류 답이 된다. 이를 위해 `Cargo.toml`의 release 프로필이 `panic = "unwind"`다.

## 렌더러 주소

Electron 판은 `genoffice-app://<host>/<파일>`로 내줬고 처리기들(`main_core`의 `renderer_url`)이 지금도 그 이름으로 페이지를 부른다. CEF 런타임은 사용자 스킴을 `http://<스킴>.localhost/`로만 내주므로 호스트마다 스킴을 하나씩 둔다: `http://genoffice-app-<host>.localhost/<파일>`. 호스트마다 출처가 따로라서 localStorage와 IndexedDB가 호스트별로 갈린다(Electron도 그랬다). `app_scheme::webview_url`과 `electron_url`이 두 모양을 바꾼다. 처리기 쪽은 바뀌지 않는다. 호스트는 `main_core`의 `RENDERER_HOSTS` 열하나에 셸 자신의 `shell`이 더해진 것이고, 폴더는 `<apps>/<앱>/out/renderer`(`help`는 셸 것)다. 포장한 셸은 `<resources>/renderer/<host>`를 먼저 본다(묶음 설정은 묶음 U).

## preload

`bridge/preloads.mjs`가 `PRELOADS`(`channels.rs`)에서 19개를 읽어 preload마다 IIFE를 `out/preloads/<Surface>.js`로 만든다. `electron`은 `bridge/electron-entry.ts`로 바꾸고, `process`는 작은 대역(`process-shim.ts`)이다. 묶은 뒤 표에 적힌 전역이 모두 묶음 안에 있고 `electron`을 더는 부르지 않는지 확인한다. 셸은 웹뷰를 만들 때 그 `Surface`의 묶음을 초기화 스크립트로 싣는다(주 프레임만).

계약과 다른 점:

- Tauri 내부 객체를 전역에서 **지우지는 못한다**. Tauri 자신의 `invoke`가 호출마다 `window.__TAURI_INTERNALS__`를 읽기 때문이다(`scripts/core.js`). 브리지는 참조를 클로저에 잡고 속성을 열거되지 않게 고정한다. 웹뷰에는 capability가 없어 플러그인 명령은 막혀 있고, 셸의 명령 셋은 `Dispatcher`의 surface 검사가 지킨다.
- `webFrame`은 확대 배율만 이어졌다. `isWordMisspelled`와 `getWordSuggestions`(sheets의 `nativeSpell`)는 CEF 페이지에서 닿는 철자 엔진이 없어 `false`와 `[]`를 답하고 한 번 경고한다.
- `webUtils.getPathForFile`은 창의 끌어 놓기 이벤트가 준 경로를 `dataTransfer.files` 순서로 짝짓는다. 끌어 놓기 이벤트가 DOM 이벤트보다 먼저 오는지는 러너에서 처음 본다.

## 호스트

| 호스트                            | 구현                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dialogs`                         | `rfd`, UI 스레드에서. 버튼 1~3개까지만 되고 체크 상자와 4개 이상은 취소 버튼으로 답하며 로그를 찍는다(`rfd`의 한계)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OsShell`                         | `open`, `trash`, 탐색기·Finder 열기                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Clipboard`                       | `clipboard-rs`, UI 스레드에서                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Contents`                        | 캡처와 PDF는 CDP(`Page.captureScreenshot`, `Page.printToPDF`). Electron 옵션을 CDP 인자로 바꾼다. `print`는 Tauri의 `print()`로 대화 상자를 열고 결과는 모른다                                                                                                                                                                                                                                                                                                                                                                                       |
| `MainWindow`                      | 셸 창으로 표시한 뷰(없으면 첫 `Shell` 뷰)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Arc<Mutex<SharedRecoveryState>>` | 프로세스에 하나, 임의 run id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 묶음 W 전용                       | `src/host/w.rs`가 `shell-ipc-w`가 `need`하는 호스트를 모두 넣는다. `ClockHost`는 진짜다. 나머지는 `unbuilt.rs`의 대역이다(처음 부를 때 한 번 로그): `QuickLookHost`, `QuickLookWindowHost`, `QuickLookEnginesHost`, `DocPickerWindowHost`, `DocPickerSourcesHost`, `DocsTabsHost`, `SheetsTabsHost`, `OpenFilesHost`, `FileParseHost`, `UiLanguageHost`, `HomeFilesHost`, `FileSearchHost`, `FolderTreeHost`, `FolderWatchHost`, `HomeAppHost`, `WindowsHostRef`. 반환값을 지어낼 수 없는 호출(창, 뷰)은 panic하고 `Dispatcher`가 오류 답으로 바꾼다 |

`dyn TabHooks`는 코어 스레드의 `Provided`에 들어가야 해서(`tabs::register`가 거기서 첫 것을 꺼낸다) `host::w::register_hooks`가 묶음 W보다 먼저 도는 묶음으로 추가한다. 진짜 구현이 생기면 그 자리에서 바꾼다.

## 측정 (`--measure-dialog <out.json>`)

계약 3절의 "알려진 차이"가 묻는 것이다. 모달 대화 상자가 떠 있는 동안 코어 스레드는 `run_on(ui, …)`에서 선다. 그동안 다른 창의 IPC 답이 얼마나 늦는지 잰다. 측정 페이지(`frontend/measure.html`)는 진짜 브리지가 있는 뷰에서 열리고, 같은 앱 스킴 길(`genoffice-app://shell/measure.html`)로 내준다.

- `idle`: 등록된 값싼 채널(`quick-look:get-settings`)을 순서대로 200번 부른 왕복(ms).
- `echo`: 1 KB와 10 MB를 진짜 프레임으로 되받는 왕복. `measure:echo`는 표에 없는 시험용 채널이고, 명령 → 코어 스레드 → 출력 흐름의 같은 길을 지난다. 시제품의 값은 Mac 1.3 / 64.6 ms, Windows 1.4 / 55.8 ms(결정 0029)였다.
- `sync`: 동기 XHR 100번.
- `dialog.ui`와 `dialog.core`: 20 ms마다 한 번씩 쉬지 않고 호출을 보내다가, 1초 뒤 코어 스레드를 2초 세운다. 호출을 **보낸 때**로 `before`(세우기 전), `during`(2초 동안), `after`(그 뒤 1.5초)로 나누어 `p50`, `p95`, `max`를 적는다. `ui`는 코어 스레드가 `run_on(ui, …)`로 기다리고 UI 스레드 일도 2초 잡고 있다(모달 대화 상자가 코어 스레드에 하는 일의 최악 경우. 진짜 대화 상자는 UI 스레드의 이벤트를 계속 돌리지만 이 일은 돌리지 않는다). `core`는 코어 스레드만 세우고 UI 스레드는 돈다. 두 값의 차이가 "코어가 서는 탓"과 "UI도 서는 탓"을 가른다.
- `environment`: OS, 아키텍처, 판, 프로필. 페이지의 `userAgent`도 들어 있다.

2초 뒤에도 답이 안 온 호출이 있으면 `unanswered`로 센다. 멈추면 셸이 스스로 `{error}`와 기록을 적고 끝낸다(아래 "기록", 러너가 걸리지 않게).

## 첫 러너 실행에서 확인할 것

1. **빌드**: Mac `.app`에 CEF 프레임워크가 들어가고, Windows `target/release`에 `libcef.dll` 등이 복사된다.
2. **시작**: `shell: N handlers registered`가 찍히고(`PARTIAL`이 필요 없는 측정 모드는 `AsRegistered`), 측정 창이 뜬다. `genoffice-app-shell.localhost`가 파일 처리기로 내주는 HTML에 Tauri와 preload 스크립트가 들어가는지.
3. **`ipc_listen`의 `Channel`**: 첫 프레임이 와서 `measureIpc.invoke`가 풀린다.
4. **동기 XHR**: `http://seuoffice-ipc.localhost/…`로 교차 출처 요청이 되고(`Access-Control-Allow-Origin: *`), `sync.error`가 없다.
5. **측정값**: `idle`과 `echo`가 시제품 값과 비슷한지, 직렬화한 명령의 값이 얼마나 느린지. `dialog`의 `during`이 2초 가까이 되는 것은 설계대로다. 받아들일 수 없는 쪽은 `ui`와 `core` 가운데 어느 쪽 값이 큰지로 가른다.
6. 팝업 거부와 `on_navigation`이 페이지를 막지 않는지(측정 페이지는 앱 스킴 밖으로 나가지 않는다).

러너에서 처음 보는 것이라 로컬에서 확인하지 못한 API는 다음이다: `Window::add_child`(탭 뷰, 아직 부르지 않음), `WebviewCefExt::on_dev_tools_protocol`로 받은 CDP 결과의 `data` 모양(`Page.printToPDF`는 시제품이 같은 방식으로 썼다), 끌어 놓기 이벤트와 DOM `drop`의 순서, 앱 스킴 HTML에 주입되는 초기화 스크립트가 `<head>` 맨 앞인지.

## 기록(trace)

`SEUOFFICE_SHELL_TRACE=1`이거나 `--measure-dialog`이면 `src/trace.rs`가 `[+  123.4ms] 꼬리표: 글` 줄을 stderr와 600줄 고리에 남긴다. 꼬리표는 다음과 같다.

- `window`: 창을 연 주소, 브리지 종류, 초기화 스크립트 크기.
- `scheme`: 앱 스킴 요청과 답.
- `page`, `frame`: 페이지 시작과 끝, 이동 실패, 렌더러 종료.
- `console`: 그 웹뷰의 console을 CEF `on_console_message`로 받은 것.
- `ipc`, `sync`: 명령이 닿은 것(뷰, 채널, 인자 수, 바이트).
- `outlet`: 출력 흐름이 열린 것과 보낸 프레임.
- `measure`: 측정 처리기.

브리지(`bridge/tauri.ts`)와 측정 페이지는 단계마다 console.log로 알린다(`[bridge +ms] …`, `[measure +ms] …`). preload가 돈 주소와 `__TAURI_INTERNALS__` 속성, `ipc_listen`을 보낸 때와 받았다는 표시가 온 때, 흐름의 첫 프레임, 첫 invoke와 첫 답, 5초마다 지금 단계가 나온다. 처리 길의 줄(`ipc`, `outlet`, `measure`, `sync`)은 처음 40줄만 모두 적고 이후는 100번에 한 번만 적어 측정을 늦추지 않는다. 센 값은 `traceCounts`에 남는다.

측정이 멈추면 셸이 `dialog.json`에 `{error, environment, traceCounts, trace: [...]}`를 적고 끝낸다. 40초 안에 아무 명령도 닿지 않았거나(preload가 안 돌았거나, 페이지가 안 떴거나, Tauri의 invoke가 페이지를 못 떠남), 150초 안에 보고가 없을 때다. `trace`의 마지막 줄들이 멈춘 곳이다. 읽는 법:

- `window … script N bytes`가 0이거나 없다: 브리지를 싣지 않았다.
- `scheme … measure.html -> 200`이 없다: 페이지를 받지 못했다. `404`면 폴더가 틀렸고, `frame … NAVIGATION FAILED`면 스킴 처리기가 이름을 받지 못한 것이다.
- `console … page …; measureIpc undefined`: 페이지는 떴으나 preload가 주입되지 않았다. `[bridge …] loaded …`가 없어도 같은 뜻이다.
- `[bridge …] ipc_listen #1 sent`만 있고 `ipc: … listen`이 없다: 명령이 페이지를 떠나지 못한다(CORS, ACL, invoke key). console에 `[shell bridge] ipc_listen failed`가 뒤따른다.
- `ipc: listen`은 있고 `outlet: stream attached`가 없다: `ipc_listen` 처리에서 막혔다.
- `outlet: … bytes sent`는 있고 `[bridge] stream frame #1`이 없다: `Channel`의 `eval`·fetch 길이 페이지에 닿지 못한다.

## 묶음 W 트레이트가 바뀌었을 때

`host/unbuilt.rs`는 `shell-ipc-w`의 호스트 트레이트마다 대역을 하나씩 구현한다. 트레이트가 바뀌면 `ci/check-local.sh check`가 어긋난 메서드를 rustc 오류로 알려 준다. 새 호스트가 생기면 `host/w.rs`의 `install_hosts`에 넣고, `the_batches_register_over_the_stubs`(묶음 여섯이 `AsRegistered`로 `MissingHost` 없이 등록되는지)가 빠진 것을 잡는다.
