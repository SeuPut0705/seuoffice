# crates/shell/bundle

설치본을 만드는 설정이다(U 묶음, 3단계 셸 계약 7절의 파일 표). `cargo build`와 `check-local.sh`는 이 폴더를 읽지 않는다. 설치본을 만들 때만 `tauri build`에 더한다.

```sh
node crates/shell/bundle/node-runtime.mjs              # 명령줄이 돌 Node(아래)
npx tauri build --config bundle/macos.conf.json        # crates/shell에서, macOS
npx tauri build --config bundle/windows.conf.json      # crates/shell에서, Windows(NSIS)
```

## 파일

| 파일                | 내용                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `macos.conf.json`   | 리소스, 파일 연결 24개(Electron 판의 `FILE_ASSOCIATIONS` 그대로, 열기 전용은 `rank: Alternate`), 강화 런타임과 권한(`apps/shell/build/entitlements.mac.plist`), `Info.plist`                                        |
| `windows.conf.json` | 리소스(Electron 판처럼 설치 폴더의 `resources\` 아래), 기본 연결 11개(ProgId는 Electron 판과 같은 `seuoffice.WordDocument` 들), NSIS(사용자별 설치, `hooks.nsh`)                                                    |
| `hooks.nsh`         | Electron 설치 넘겨받기, 이전 판을 새 판이 뜰 때까지 남겨 두기와 되돌리기, Electron 판 `build/installer.nsh`가 하던 등록(종류별 아이콘, 새로 만들기 메뉴, 연결 프로그램 전용 ProgId, 기본 앱 기능 목록, 명령줄 PATH) |
| `Info.plist`        | 마이크 사용 설명, draw.io 형식 선언(Electron 판의 `extendInfo`)                                                                                                                                                     |
| `node-runtime.mjs`  | 명령줄용 Node를 내려받아 해시를 확인하고 `out/node`에 둔다. 판과 해시는 파일 안 표에 고정한다(CI와 같은 22판)                                                                                                       |

리소스 자리는 Electron 판과 같다. macOS는 `Contents/Resources/<자리>`, Windows는 `<설치 폴더>\resources\<자리>`다. 그래서 명령줄 실행기(`packages/cli/bin`), `wasm/`, `modules/<앱>`을 읽는 코드가 바뀌지 않는다. 화면 묶음은 `modules/<앱>/renderer`(셸 자신은 `modules/shell/renderer`)다.

## 명령줄과 Node

Electron 판은 명령줄을 앱 실행 파일로 돌렸다(`ELECTRON_RUN_AS_NODE=1`). CEF 판에는 Node가 없어서 설치본이 Node를 `resources/cli/node`에 싣는다(2026-11-14 메인 세션 결정). 셸은 `ELECTRON_RUN_AS_NODE=1`로 시작되면 창을 띄우지 않고 그 Node에 인자를 그대로 넘긴다(`src/host/os.rs`). 그래서 실행기, 사용자 에이전트 설정에 이미 적힌 MCP 항목(`SeuOffice.exe` + `ELECTRON_RUN_AS_NODE`)이 고치지 않고 돈다.

설치본이 커지는 정도(2026-11-14, Node 22.23.5를 이 Mac에서 잼): Windows는 `node.exe` 83.0 MB, LZMA로 21.1 MB. macOS arm64는 `node` 107.8 MB, deflate로 35.3 MB.

## 되돌리기(Windows)

업데이트로 설치할 때 설치 폴더를 `<폴더>.previous`로 옮긴 뒤 새 판을 깐다. 새 판을 `--updated`로 띄우고 90초 안에 `%APPDATA%\seuoffice\shell-started.txt`에 그 판 번호가 적히기를 기다린다(`src/host/os.rs`가 시작할 때 적는다). 적히지 않으면 새 파일을 지우고 이전 폴더를 되돌려 띄운다. 설치 프로그램이 도중에 끝나면, 다음 로그인 때 RunOnce가 `%LOCALAPPDATA%\seuoffice-restore-previous.cmd`로 이전 폴더를 되돌린다. 설치가 끝난 표시(`.seuoffice-install-complete`)가 있으면 아무것도 하지 않는다.

## 아직 안 된 것

- macOS의 종류별 문서 아이콘(Electron 판의 `icon: 'docx'` 들). Tauri 3의 파일 연결에는 아이콘 칸이 없다.
- 이 설정으로 만든 설치본은 아직 러너에서 지어 보지 않았다(2026-11-14 러너 정지). `makensis`가 이 Mac에 없어 `hooks.nsh`도 컴파일해 보지 않았다.
