# 중심 프로세스 baseline 전용 실행

`main_baseline_product_sha`에 40자리 제품 커밋을 넣는 명시적 모드다. 정의는 별도 CI 가지의 `github.sha`, 제품은 검증 뒤 출력한 SHA로 checkout한다. 기존 제품·결함 driver ref를 움직이지 않는다.

- Linux: 제품의 모든 group을 새 subprocess에서 읽어 함수·케이스 수를 수집한 뒤, 필터 없는 전체 중심 비교를 실행한다.
- Windows: 기존 네 플랫폼 함수, `node-fs` group, libuv 오류표 시험을 실행한다. 두 비교의 실패를 각각 보존한다.
- 두 lane 모두 제품의 RHWP 소스를 준비하고 표준 `build:wasm`으로 정확한 제품 WASM을 만든다. `SEUOFFICE_WASM`은 이 파일을 가리킨다.
- 입력 혼합은 거부한다. `quick`과 그 의존 행렬, 기존 fault-only 행렬은 선택하지 않는다. 엔진 소스·probe·변이 실행기를 고치거나 호출하지 않는다. 일반 main push의 조건은 바뀌지 않는다.
- 성공 비교라도 inventory와 함수 집합·케이스 수가 다르면 실패다. 미등록 차이, 계수 누락, 최소 서로 다른 답의 실패도 거부한다. inventory 역시 제품의 실제 registry와 cases를 사용한다.

각 산출물에는 정의·제품 SHA, GitHub run·attempt, lane, inventory, 비교 보고서, WASM 해시와 비교 판정이 남는다. 두 lane의 실제 job 결론은 해당 run API와 함께 확인한다. `comparisonVerdict`만으로 job 전체 성공을 주장하지 않는다.

이 run의 `head_sha`는 제품이 아니라 **정의 SHA**다. 따라서 기존 `faults-only.mjs`의 `validateGate`가 요구하는 제품-head·`crates`/`Central process comparison` 계약과 호환되지 않는다. `legacyFaultGateCompatible: false`를 기록하며 기존 검증기를 바꾸지 않는다. 향후 결함 실행의 baseline으로 소비하려면 별도의 명시적 계약이 필요하다.

새 제품은 `f5065c06a52b7ebbe4100da637140da4beb67182`다. `7363ba43c`의 엔진 결함 결과를 재사용할지는 엔진 소스·probe·빌드 설정·의존성 불변과 실제 모든 관련 job/step/산출물 성공을 확인한 뒤 결정한다. 이전 run 전체가 녹색일 것이라고 추정하거나, 새 CI 및 중심 baseline을 생략하지 않는다.
