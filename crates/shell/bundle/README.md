# crates/shell/bundle

설치본을 만드는 설정이다(U 묶음, 3단계 셸 계약 7절의 파일 표). `cargo build`와 `check-local.sh`는 이 폴더를 읽지 않는다. 설치본을 만들 때만 `tauri build`에 더한다.

```sh
node crates/shell/bundle/node-runtime.mjs              # 명령줄이 돌 Node(아래)
node crates/shell/bundle/release-feed.mjs app-update   # 업데이트 피드 설정(아래)
npx tauri build --config bundle/macos.conf.json        # crates/shell에서, macOS
npx tauri build --config bundle/windows.conf.json      # crates/shell에서, Windows(NSIS)
node crates/shell/bundle/release-feed.mjs feed --version <판> <설치 파일>...  # 블록맵과 채널 파일
```

## 파일

| 파일                | 내용                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `macos.conf.json`   | 리소스, 파일 연결 24개(Electron 판의 `FILE_ASSOCIATIONS` 그대로, 열기 전용은 `rank: Alternate`), 강화 런타임과 권한(`apps/shell/build/entitlements.mac.plist`), `Info.plist`                                                                         |
| `windows.conf.json` | 리소스(Electron 판처럼 설치 폴더의 `resources\` 아래), 기본 연결 11개(ProgId는 Electron 판과 같은 `seuoffice.WordDocument` 들), NSIS(사용자별 설치, `hooks.nsh`)                                                                                     |
| `hooks.nsh`         | Electron 설치 넘겨받기, 이전 판을 새 판이 뜰 때까지 남겨 두기와 되돌리기, Electron 판 `build/installer.nsh`가 하던 등록(종류별 아이콘, 새로 만들기 메뉴, 연결 프로그램 전용 ProgId, 기본 앱 기능 목록, 명령줄 PATH)                                  |
| `Info.plist`        | 마이크 사용 설명, draw.io 형식 선언(Electron 판의 `extendInfo`)                                                                                                                                                                                      |
| `release-feed.mjs`  | `app-update`: 리소스에 들어갈 `app-update.yml`(GitHub 공급자, `SEUOFFICE_UPDATE_CHANNEL`의 채널, 캐시 폴더 `seuoffice-updater`). `feed`: 설치 파일마다 `.blockmap`과 채널 파일(`latest.yml`, `stable-mac.yml` 들)을 Electron 판과 같은 모양으로 쓴다 |
| `node-runtime.mjs`  | 명령줄용 Node를 내려받아 해시를 확인하고 `out/node`에 둔다. 판과 해시는 파일 안 표에 고정한다(CI와 같은 22판)                                                                                                                                        |

리소스 자리는 Electron 판과 같다. macOS는 `Contents/Resources/<자리>`, Windows는 `<설치 폴더>\resources\<자리>`다. 그래서 명령줄 실행기(`packages/cli/bin`), `wasm/`, `modules/<앱>`을 읽는 코드가 바뀌지 않는다. 화면 묶음은 `modules/<앱>/renderer`(셸 자신은 `modules/shell/renderer`)다.

## 명령줄과 Node

Electron 판은 명령줄을 앱 실행 파일로 돌렸다(`ELECTRON_RUN_AS_NODE=1`). CEF 판에는 Node가 없어서 설치본이 Node를 `resources/cli/node`에 싣는다(2026-11-14 메인 세션 결정). 셸은 `ELECTRON_RUN_AS_NODE=1`로 시작되면 창을 띄우지 않고 그 Node에 인자를 그대로 넘긴다(`src/host/os.rs`). 그래서 실행기, 사용자 에이전트 설정에 이미 적힌 MCP 항목(`SeuOffice.exe` + `ELECTRON_RUN_AS_NODE`)이 고치지 않고 돈다.

설치본이 커지는 정도(2026-11-14, Node 22.23.5를 이 Mac에서 잼): Windows는 `node.exe` 83.0 MB, LZMA로 21.1 MB. macOS arm64는 `node` 107.8 MB, deflate로 35.3 MB.

## 되돌리기(Windows)

업데이트로 설치할 때 설치 폴더를 `<폴더>.previous`로 옮긴 뒤 새 판을 깐다. 새 판을 `--updated`로 띄우고 90초 안에 `%APPDATA%\seuoffice\shell-started.txt`에 그 판 번호가 적히기를 기다린다(`src/host/os.rs`가 시작할 때 적는다). 적히지 않으면 새 파일을 지우고 이전 폴더를 되돌려 띄운다. 설치 프로그램이 도중에 끝나면, 다음 로그인 때 RunOnce가 `%LOCALAPPDATA%\seuoffice-restore-previous.cmd`로 이전 폴더를 되돌린다. 설치가 끝난 표시(`.seuoffice-install-complete`)가 있으면 아무것도 하지 않는다. 옛 폴더를 통째로 옮기지 못하면(안의 파일을 다른 프로그램이 열고 있을 때) 설치 프로그램은 새 파일을 하나도 쓰지 않고 멈추고, 업데이트였다면 옛 판을 다시 띄운다. 이 길은 넘어가기 시험의 `lock-file`이 본다.

## 차분 업데이트

Electron 판처럼 업데이트는 바뀐 블록만 내려받는다(`src/host/update/differential.rs`, `feed.rs`). 옛 파일은 마지막 설치가 캐시에 남긴 설치 프로그램(`%LOCALAPPDATA%\seuoffice-updater\installer.exe`, `hooks.nsh`가 설치 뒤 복사한다)이나 마지막 macOS 업데이트의 zip(`~/Library/Caches/seuoffice-updater/update.zip`)이다. 옛 블록맵은 그 옆 `current.blockmap`, 없으면 릴리스의 옛 판 `.blockmap`이다. 어디서든 어긋나면 파일 전체를 받는다.

블록이 판마다 같은 바이트로 남으려면 파일마다 따로 압축해야 한다. Tauri 기본(LZMA 통압축)은 파일 하나만 바뀌어도 그 뒤 바이트가 모두 바뀐다. 그래서 `windows.conf.json`은 압축을 끄고(`"compression": "none"`, 템플릿 머리의 `SetCompressor /SOLID`를 건너뛴다) `hooks.nsh`가 `SetCompress auto`로 파일마다 zlib 압축을 되살린다. 2026-11-14 이 Mac에서 `makensis` 3.13으로 잼: 큰 파일 하나는 그대로, 모듈 하나를 바꾸고 파일 하나를 더한 두 설치 프로그램 사이에 받을 몫이 파일마다 zlib은 13.6%(5.95 MB 중 0.81 MB), LZMA 통압축은 99.3%였다. 대신 설치 프로그램이 커진다(같은 시험에서 4.49 MB → 5.95 MB).

## 아직 안 된 것

- macOS의 종류별 문서 아이콘(Electron 판의 `icon: 'docx'` 들). Tauri 3의 파일 연결에는 아이콘 칸이 없다.
- 이 설정으로 만든 설치본은 아직 러너에서 지어 보지 않았다(2026-11-14 러너 정지). `hooks.nsh`는 Tauri 템플릿 머리와 훅 자리를 흉내 낸 틀에 넣어 `makensis` 3.13(Homebrew)으로 컴파일만 해 봤다. Windows에서 돌려 보지는 않았다.
