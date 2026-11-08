# 0083 데스크톱 앱 없이 도는 명령줄 묶음을 따로 낸다

## 맥락

개인형 에이전트(피클 등)가 쓰는 샌드박스에는 GTK 같은 화면 라이브러리가 없고 Node도 없는 경우가 많다. 지금 배포하는 Linux deb은 Electron 실행 파일을 `ELECTRON_RUN_AS_NODE`로 부르는 구조라, CLI만 쓰려 해도 `libgtk-3` 등이 먼저 링크되어 exit 127로 죽는다. apt로 설치하면 GTK가 딸려 오지만 200MB대이고, 그 환경들은 보통 세션마다 초기화된다. 같은 샌드박스가 `ulimit -v`를 2GB로 묶어 두면 PDF·한글·웹 엔진이 쓰는 WebAssembly 메모리를 만들 수 없어 별도 문제가 된다(같은 날 `wasm.ts`와 `capabilities.wasm`으로 정리했다).

요청은 셋이었다. GUI 라이브러리 없는 경량 배포판, 제한된 환경에서의 wasm/fetch 실패 방지, `curl … | sh` 한 줄 설치.

## 결정

- **Linux x64용 `ieumoffice-cli_<버전>_linux-x64.tar.gz`(+ `.sha256`)를 따로 낸다.** 내용은 앱의 `resources/`와 같다(`cli/`, `wasm/`, `native/xlsx-sidecar`, 고지 3종). Electron 실행 파일만 없고, 문서 엔진·번들·jsdom은 설치본과 같은 바이트다. 그래서 동작이 앱 안의 `ieumoffice`와 같다.
- **Node는 묶음에 넣지 않고 설치 스크립트가 받는다.** nodejs.org의 공식 빌드와 `SHASUMS256.txt`를 확인해 `--prefix` 아래에 넣는다. 재배포 고지·업데이트 부담을 지지 않고, 이미 Node 22가 있으면 그것을 쓴다.
- **`packaging/cli/install.sh`가 설치의 유일한 입구다.** `~/.local/share/ieumoffice-cli`와 `~/.local/bin` 밖에는 쓰지 않고, root를 쓰지 않으며, 다른 프로그램의 `ieumoffice`는 건드리지 않는다. `--uninstall`, `--version`, `--node`를 둔다.
- **PDF·HTML·PNG 내보내기와 `open`/`selection`은 묶음의 범위가 아니다.** 앱의 렌더러가 필요하므로 `app_unavailable`로 답하고, 데스크톱 앱이나 Xvfb를 안내한다.
- **wasm을 만들 수 없는 환경은 기능을 줄이지 않고 이유를 알린다.** `capabilities.wasm`과 `resource_limit` 봉투가 그 계약이다. DOCX·XLSX·PPTX·Markdown·HTML·CSV·ODT는 wasm 없이 돈다.

## 택하지 않은 것

- **npm 패키지(`@ieumoffice/cli`).** `@genoffice`는 원본 스코프이고, 새 스코프는 새 등록 이름·계정·배포 매트릭스를 뜻한다. 묶음은 55MB 안팎이라 npm 배포에도 맞지 않는다. 수요가 확인되면 다시 본다.
- **단일 실행 파일(Node SEA, bun compile 등).** `rhwp_bg.wasm` 11MB, `pdfium.wasm` 4.4MB, Rust 사이드카, jsdom 파일은 결국 옆에 풀어야 해서 얻는 것이 없다.
- **묶음에 Node 동봉.** 내려받기가 20~30MB 늘고 Node 고지를 묶음에 넣어야 한다. 설치 때 한 번 받는 편이 작다.
- **GTK 없이 도는 deb.** Electron 실행 파일 자체가 GTK를 링크하므로 패키지 안에서 풀 수 없다.
- **앱 없이 PDF 내보내기.** 레이아웃을 그리는 Chromium 렌더러가 필요하다.

## 결과

- `packages/cli/pack-tarball.mjs`가 앱 빌드의 `resources/`에서 묶음을 만들고 `.sha256`을 함께 쓴다. 버전은 번들에 박힌 앱 버전을 읽으므로 앱과 어긋나지 않는다.
- `.github/workflows/linux-build.yml`이 묶음을 만들어 올리고, **GTK도 앱도 없는 `node:22-slim` 컨테이너에서 `ulimit -v 2GB`로** 생성·읽기(`create`, `docs read`)와 `capabilities.wasm: false`·`pdf read`의 `resource_limit` 봉투까지 확인한다.
- 릴리스 표와 `docs/releasing.ko.md`에 묶음과 사이트 `install.sh`의 버전 갱신이 들어갔다.
- 한계: Linux x64만, Node 22 필요(설치 때 자동), PDF 내보내기·`open`/`selection`·앱이 봉인한 키 풀기 불가, 2GB에서 PDF·한글·웹 엔진 불가(이유와 해결책은 봉투로 답한다).
