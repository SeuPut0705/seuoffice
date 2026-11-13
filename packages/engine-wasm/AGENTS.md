# engine-wasm

## 맡은 범위

Rust 엔진의 WASM 빌드(`crates/office-wasm`)를 싣고 부르는 단 하나의 로더다. 엔진 바인딩(`@seuoffice/pptx-engine`, `@seuoffice/docx-engine`)이 이것으로 `seu_call`을 부른다. 시작 지점에서 한 번 인스턴스를 만들고(`initEngineSync(bytes)` 또는 `await initEngine(url)`), 그 뒤의 호출은 모두 동기다.

## 맡지 않는 것 (경계)

- wasm 파일을 찾는 일은 하지 않는다. 호스트(Electron main, 웹 페이지, Node 도구)가 바이트나 URL을 넘긴다.
- 명령의 의미는 모른다. 헤더 JSON과 blob을 넘기고 받을 뿐이다.

## 항상 지켜야 하는 것

- `src/`에서 Node 내장 모듈을 import하지 않는다. Electron main, 웹 페이지, Node 어디서나 같은 코드가 돈다.
- WASI는 엔진이 쓰는 다섯 함수(`random_get`, `environ_get`, `environ_sizes_get`, `fd_write`, `proc_exit`)만 직접 준다. 엔진이 새 import를 요구하면 여기에 더한다.
- `seu_host.host_collate(a, b, locale)`는 세 UTF-8 문자열을 받아 `new Intl.Collator(locale).compare(a, b)`를 준다. 로캘마다 콜레이터를 하나씩 캐시한다. 로캘이 잘못돼 `Intl.Collator`가 던지면 `-2147483648`을 돌려주고 엔진이 그 호출을 거부한다(localeCompare가 던지는 것과 같다). 로캘 인자가 없는 이전 빌드는 `zh-CN`으로 읽는다.
- `seu_host.host_callback(slot, ptr, len) -> u64`는 호출마다 등록한 JS 콜백(`engineCall(command, blobs, { [slot]: fn })`)을 부른다. 입력은 UTF-8 텍스트, 답도 텍스트다. 답은 엔진의 `seu_alloc`으로 잡은 메모리에 써서 `(ptr << 32) | len`으로 돌려주고 엔진이 해제한다. 그런 슬롯이 없거나 콜백이 던지면 `u64::MAX`를 돌려주고 엔진이 그 호출을 거부한다. 콜백이 던진 것은 호출이 끝난 뒤 다시 던진다. 콜백 안에서 엔진을 다시 불러도 된다(안쪽 호출의 콜백이 우선).
- 엔진의 실패 응답은 `EngineError`(code, message)로 던진다.

## 테스트

- `npx vitest run` (패키지 폴더). 릴리스 wasm(`crates/target/wasm32-wasip1/release/office_wasm.wasm`)이 없으면 건너뛴다.
