# 원본 MCP 결함 203의 표적 감도 검증

이 모드는 두 추출 사례가 원본 결함을 실제로 검출하는지만 확인한다. 전체 중심 프로세스 baseline이나 6,121개 결함 관문을 대신하지 않는다.

## 고정 대상

- 제품은 `main_sensitivity_product_sha`로 받은 소문자 40자리 SHA에서 checkout한다. workflow 정의의 `github.sha`와 구분한다.
- `b5-mcp.json`의 원본 0번 양성 대조와 203번 변이를 그대로 쓴다. catalog를 복사·재번호화하거나 `faults.mjs`를 바꾸지 않는다.
- 원본 목록 파일 SHA256은 `a45058cef79809d51c1eda0116ccb3086bd05df0838f4757e820db0c4fb8cc25`, 203번 변이 객체 SHA256은 `0544ee04bf0d2ce6697e4a18b9a8ae67f47f3113c07dc6aa9e050958f720568d`다.
- `N`은 목록 길이 이상인 4의 배수다. 현재 810개 목록에서는 `FAULT_SHARD=203/812`로 원본 0·203만 고른다. 원본 203이 네 조각 중 3번이었다는 계보도 남긴다.

## 실행 순서

단일 `ubuntu-latest` job에서 다음 순서로 실행한다. 다른 선택 입력은 비워 두고 `all_faults=false`, `fault_shards=1`을 사용한다. 이 workflow 입력의 조각 수는 내부의 `203/812` 선택과 다른 계약이다.

1. 정의와 제품의 실제 checkout SHA를 검증한다. 다른 baseline·결함 선택 입력이 섞이면 실패한다.
2. 정확 제품의 RHWP 소스와 npm 의존성을 준비하고 표준 `npm run build:wasm`으로 실제 제품 WASM을 만든다.
3. 제품의 실제 함수 목록에서 catalog selector가 모두 등록됐는지 확인한다. 선택한 함수와 사례는 제품의 registry에서 읽는다.
4. `MAIN_DIFF_PROFILE=node-faults`로 정상 addon을 짓고 `zod.toJsonSchema` 118개와 `runtime-archive.extractRuntimeArchive` 82개 사례를 비교한다. 200개 모두 동등해야 한다. 등록 차이도 허용하지 않는다.
5. 정상 baseline의 정확 identity와 완전성을 먼저 감사한다.
6. 같은 프로필에서 수정하지 않은 제품 `faults.mjs`로 원본 0·203을 실행한다.
7. 양성 대조와 203의 실제 검출, 새 사례 80·81의 소비자 파일·오류 차이, 원본 소스 복구를 감사한다.

정상 비교와 변이 비교는 서로 다른 출력 폴더를 쓴다. 단순 `CAUGHT` 접두사, unknown-group 오류, 관계없는 `DIFF`, 누락된 JSON으로 성공을 만들지 않는다. 변이 결과의 추가 사례 두 개가 실제로 달라야 한다.

## 판정 범위

결과의 scope는 `targeted-sensitivity-only`다. 정의 SHA, 제품 SHA, run·attempt, 프로필, 표준 WASM 해시, 원본 catalog·변이 ID와 해시를 기록한다. `legacyFaultGateCompatible`, `fullBaselineCompatible`, `fullFaultRunCompatible`은 모두 `false`다. 기존 `faults-only.mjs`의 제품-head gate 계약을 우회하지 않는다.

이 모드를 고르면 `cancel-in-progress=false`이며 일반 quick·다른 엔진·Windows·전체 비교·기존 결함 행렬은 실행하지 않는다. 기존 고정 제품·정의·실행을 취소하거나 그 결과를 새 제품의 증거로 바꾸지 않는다. 같은 정확 제품·범위의 활성 실행이 있는지 먼저 확인하고 한 번만 dispatch한다.

로컬에서는 감사기 단위 회귀와 workflow 선택·실패 전파를 확인한다. Rust 빌드·비교·변이 증명은 hosted 러너에서만 수행한다.

## 실패 실행의 원본 artifact 재감사

`43591069529`는 정상200사례와 원본0·203 실행 뒤 마지막 감사기가 JSON 값의 `RuntimeArchiveError`를 fatal 진단으로 읽어 실패했다. 원본 실행의 `failure`는 그대로 둔다. fatal 검사는 비교 출력의 진단 segment 시작점에만 적용하고 소비자 값의 오류 이름은 typed JSON 검사로 판정한다.

`sensitivity-replay.mjs`는 정확 원본 ZIP 해시, 정의·제품·run·시도, 필수 producer step 성공, 알려진 감사 실패 로그와 새 감사기 정의 SHA를 `main-sensitivity-replay/v1`에 결속한다. 원본 artifact의 baseline identity와 실제80·81 사례 차이를 다시 감사한다. 미검출·누락·다른 오류를 허용하지 않는다.

복구된 소스 파일 자체와 최종 WASM hash는 원본 artifact에 없다. 소스 복구는 원본 감사기가 복구 guard를 지난 뒤 알려진 typed assertion에서 실패한 코드·로그 경로로만 결속한다. 이 한계를 receipt에 기록하고 없는 WASM hash를 만들지 않는다. 이 재감사도 전체 baseline이나 전체 결함 성공이 아니다.
