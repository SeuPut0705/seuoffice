# 중심 프로세스 결함의 원본 ID 재개

이 드라이버는 중단된 원본 실행을 성공으로 바꾸지 않는다. 새 제품의 짧은 job을 완결하고 각각의 artifact를 원본 ID로 합친다. 원본 제품·정의·실행과 표적 증명 ref는 변경하지 않는다.

## 고정 계보

| 구분                     | 제품                                       | 정의                                       | 실행 / 시도       |
| ------------------------ | ------------------------------------------ | ------------------------------------------ | ----------------- |
| 원본 결함                | `30f303cde7b496bf640aadffcb0b70bf7fb2ad21` | `7594c1243ef0c2965c202dead1fd983ad7ab77e9` | `43568242384` / 1 |
| 전체 중심 baseline       | `f5065c06a52b7ebbe4100da637140da4beb67182` | `59682c00f070a406f108b47dca592381f57d40fa` | `43578414343` / 1 |
| 추가 두 사례의 표적 증명 | `375b08bd0e1f7e8432e6514468cc9d25be01b100` | `7d30359f16efc9a117963ae38787dfdbe3e88a39` | `43591069529` / 1 |

표적 실행은 전체 baseline이 아니다. 준비 단계는 전체 baseline의 Linux·Windows 두 lane을 원본 inventory와 report로 다시 감사한다. 표적 원본 실행은 최종 감사기가 공개 오류 이름을 잘못 읽어 실패했다. 이 결론을 성공으로 바꾸지 않는다. 별도 `main-sensitivity-replay/v1` 계약이 정확 원본 ZIP 해시·정의·제품·run·시도와 필수 producer step 성공, 알려진 마지막 감사 실패의 로그, 새 감사기 정의 SHA를 결속한다. 같은 원본 artifact의 정상200사례·원본0/203·새80/81의 실제 차이와 baseline identity를 모두 다시 감사해야 한다. 일반 `verifyRun`의 성공 조건은 그대로다.

`f506`에서 제품375까지 바뀐 것은 두 추출 사례를 뒤에 더한 파일, 폐기된 추가 selector만 정리한 `b2.json`, 계보 문서다. `recovery-manifest.json`은 이 세 파일의 정확 전후 해시를 기록한다. 준비 단계에서 실제 git object의 변경 목록과 바이트가 하나라도 다르면 실패한다. 제품 Rust·빌드·의존성·변이 실행기를 바꾸는 계보는 허용하지 않는다. 표적 원본 artifact에는 최종 identity와 WASM이 없으므로 그 해시는 미확인으로 남긴다. 대신 재개 job이 실제로 만든 표준 WASM을 전체 Linux baseline의 해시와 직접 대조한다.

소스 복구는 원본 감사기가 정확 소스 해시·복구 guard를 통과한 뒤 알려진 typed 감사 지점에서 실패했다는 고정 코드·완료 로그의 실행 경로로 결속한다. 복구된 파일 자체가 artifact에 있었다고 주장하지 않는다. replay receipt도 legacy gate·전체 baseline·전체 결함 합격과 호환되지 않는다.

## 완료 snapshot으로 고정한 선택 집합

- 원본46개 catalog의 6,121개 ID는 `catalog 경로#원본 index`다. 각 catalog 바이트 해시와 각 변이 객체의 원본·제품 해시를 보존한다.
- 영향 집합3,834개를 이유와 함께 표시한다. 원본 전체 run의 종료나 녹색을 기다리지 않고 `2026-11-14T12:37:43Z`에 읽은194개 job·13개 artifact의 전페이지 snapshot을 고정한다.
- 그 시각의 producer 성공 mutation job6개에는595개 고유 원본 ID의 행이 있다. 그러나 apps shard2의 네 행에 실제 STALE 진단이 있어 그155개 ID 전체를 엄격 인수에서 거부한다. 나머지5개 job의440개 ID만 완결 증거로 인수하고, 그중 영향67개는 유지한다. 네 b4 조각의 완결·비영향373개만 재사용한다. 해당119개 Rust 변이 파일은 old30/375 git object의 전체 바이트 해시도 같다. pending·미공개·불완전·실패·MISSED와 영향3,834개는 모두 필요 집합에 남긴다.
- `recovery-snapshot.json`의 원본 metadata·행·summary·로그·해시를 감사하고, 실제 ZIP·완료 로그와 소스 바이트를 다시 결속한 경우만 차감한다. 임의의 `approvedReuse` 배열은 계속 거부한다. manifest는 snapshot 파일 바이트 해시를, plan은 JSON 객체 직렬화 해시를 별도로 기록한다.
- `b2.json#14`는 원본 index·변이 본문·활성 사례를 유지하고 추가 ghost selector만 없앴다. 원본·제품 객체 해시와 selector 계보를 따로 기록한다. 원본 로그의 성공 여부를 이 metadata 수정으로 추정하지 않는다.
- 기존 실행의 `CAUGHT` 접두사나 불완전 report를 소급 checkpoint로 인정하지 않는다. 기존203 MISSED도 보존한다.

## 작은 원본 residue

길이 `L`인 catalog에 `N=max(4,4*ceil((L-1)/96))`을 쓴다. job은 원본 control0과 `index % N == residue`인 나머지 원본 항목을 선택한다. `N`은4의 배수이므로 원본4조각 계보가 유지된다. catalog 복사·부분 배열·재번호화는 없다. 제품의 수정하지 않은 `faults.mjs`와 `MAIN_DIFF_PROFILE=node-faults`를 사용한다.

job당 **control을 포함해 최대25 records**다. 각 noncontrol은 계획 전체에서 정확히 한 번 선택한다. control의 반복은 job별로 명시한다. 잠정 전체6,121개 선택은348 jobs였고, 고정 완료 snapshot의 비영향373개만 뺀 필요 집합은5,748개다. 기본 선택332 jobs에서 아래 네 증거 요구를 정상 세분화한 최종 계획은341 jobs,256개·85개 두 배치다. 고유 필요 ID와 변이 본문은 늘거나 줄지 않으며 control만9번 더 실행한다. 실제 catalog 비용이 아직 측정되지 않은 제품375의 시간 상한이나 성공 보장은 아니다.

원본6개 job의 설치·첫 control 지연·후속 결과 간격은 manifest의 `costEvidence`에 원본 실행·제품·catalog·shard와 함께 남긴다. 이 간격에는 native 증분 빌드·TS 비교·출력이 섞여 있다. 초기 빌드만의 시간과 제품375의 변이 시간은 미측정이다. 개수 내림차순은 비용 대리값일 뿐 실제 시간 균형이라고 부르지 않는다.

## 마지막 변이의 typed 장부 반응

원본 apps shard2의 `#382`, `#470`, `#526`, `#546`은 실제 독립 DIFF와 STALE 진단을 함께 냈다. 고정 정상 baseline의 장부 tuple이 변이 때문에 바뀌는 경계와 정상 baseline 자체의 STALE는 다르다. 원본 artifact에는 이 네 변이의 중간 전체 report가 없으므로 여전히 인수하지 않는다. 보존한 `recovery-stale-rows.json`도 성공 증거가 아니라 그 거부 회귀 자료다.

manifest의 `typedEvidenceRequirements`는 원본 index·변이 객체 해시·selector·장부 ID·정확 tuple 해시를 기록한다. 판정 예외가 아니라 추가 증거 요구다. 일반 분할기는 요구가 있는 residue만 `r/N`에서 `r/(2N)`, `(r+N)/(2N)`으로 세분화해 요구 변이가 해당 job의 마지막 noncontrol이 되게 한다. 원본 index와 `%4` 계보, 전체 선택 합집합, 최대25 제한을 그대로 유지한다. 장부 함수를 고르는 다른 변이를 미리 모두 세분화하지 않는다.

추가 정상 비교는 이 네 job의 요구 변이가 고른 함수·사례에만 수행한다. 정확 제품 registry의 사례 개수, 전체 함수 report, 장부의 정확 TS/Rust tuple 재현, unlisted0·STALE0·FLOOR0·정상 종료를 강제한다. 다른 job에는 같은 정상 baseline을 복제하지 않고 기존 전체 baseline 계보를 사용한다.

원본 `faults.mjs`가 성공 종료한 뒤 남은 `report.json`을 마지막 index·변이 해시·단일 group·전체 선택 함수·기대 사례 수에 결속한다. 각 알려진 STALE ID는 장부 case3의 실제 typed DIFF를 가져야 한다. mutant TS는 고정 장부 TS와 같고 mutant Rust는 고정 장부 Rust와 다르며 실제 TS/Rust도 달라야 한다. 이와 별개로 모든 장부 사례 밖의 독립 unlisted DIFF가 최소 하나 있어야 한다. 다른 함수·범위 밖 사례·중복·누락·fatal·FLOOR·unknown STALE·onlySTALE는 거부한다.

`report.json`은 모든 사례의 양쪽 출력이 아니라 차이와 집계만 보존한다. 따라서 장부 case가 differences에 없으면 새 tuple이나 TS 동등을 추정하지 않고 추가 증거 부족으로 거부한다. typed 감사가 입증한 정확 ID의 해당 행만 STALE 진단을 소비할 수 있다. 장부 삭제·ID별 verdict 우회·포괄 STALE 허용은 없다.

소스 적용 근거는 정확 원본 runner 바이트 해시, committed 소스 해시, find1회와 파생 replace 해시, 정상 producer 종료와 `finally` 복구 및 실제 복구 해시의 결속이다. 실제 build 직전 소스를 직접 관측했다고 주장하지 않는다. 전역 preload·child-process hook·폴링은 쓰지 않고 제품 runner·catalog·profile은 바꾸지 않는다.

## 두 배치는 명시적으로 순서 실행

`main_recovery_product_sha`로 정확 제품375를 고른다. 다른 모드 입력은 비우고 `all_faults=false`, `fault_shards=1`로 둔다. `main_recovery_batch=0`에는 이전 실행을 주지 않는다.

1. 첫 배치를 한 번 enqueue한다. 최대4개 job, timeout120분을 유지한다.
2. 첫 배치 실행의 실제 성공과 모든 job의 완결 artifact를 엄격히 감사한다.
3. 그 뒤에만 두 번째 배치를 한 번 enqueue한다. `main_recovery_batch=1`, `main_recovery_previous_run`에 성공한 첫 배치 실행을 준다.
4. 두 번째 준비 단계도 첫 배치의 성공 API metadata와 완결 artifact를 다시 감사한다. 둘을 합쳐 전체 ID 집합을 확인한다.

두 배치를 동시에 enqueue하지 않는다. product별 concurrency와 `cancel-in-progress=false`는 실행 중인 배치의 취소를 막지만, GitHub의 기본 pending 교체 정책을 없애지 않는다. 모든 대기 배치를 보존하는 queue라고 주장하지 않는다. 자동 dispatch·retry·lease·공유 checkpoint 서비스는 없다. 원본 core·표적·CI 실행과는 다른 concurrency group이다.

## job 인수 조건

각 runner는 별도 checkout·출력 폴더를 갖는다. 실제 제품 WASM을 만들고 실제 함수 목록에 모든 selector가 있는지 확인한다. 선택한 Rust 소스의 실행 전 해시를 정확 product git object에 결속한다.

재개 native 실행은 `MAIN_DIFF_PROFILE=node-faults`, `CARGO_INCREMENTAL=1`을 준비·변이·감사 step에 명시하고 실제 값을 identity에 기록한다. rust-cache가 내보내는 기본값으로 이 계약이 바뀌지 않게 step 환경에서 고정한다. 제품의 최적화·panic·overflow 설정은 바꾸지 않는다. 이 설정을 원본 시간 초과의 원인이나 속도 개선 실측 근거로 쓰지 않는다.

job의 `completion.json`은 다음이 모두 맞을 때만 생성한다.

- 정확 정의·제품·run·attempt·manifest·plan·job identity.
- 원본 순서와 개수에 맞는 모든 결과 행, 정확 변이 해시·파일·함수 목록.
- 첫 행의 실제 control DIFF와 각 행의 해당 selector에 대한 실제 DIFF·CAUGHT.
- 완전한 결과 JSON과 단 한 번의 전체 성공 summary. MISSED·BUILD·BAD·FLOOR·unknown selector·누락은 실패다. STALE는 기본 거부하며, 위 계약의 실제 typed 증거를 모두 통과한 해당 마지막 행·정확 장부 ID만 별도 반응으로 인수한다.
- 정확 원본 소스의 복구.

job이 끝나면 고유 이름의 artifact를 즉시 업로드한다. 실패·중단 때 raw 파일을 남겨도 완결 표시는 없다. 합치는 쪽은 embedded evidence를 다시 감사하고 committed product 소스와 catalog에 다시 결속한다. `Error`가 함수명이나 JSON 값에 들어 있다는 이유로 정상 오류 비교를 거부하지는 않는다.

첫 배치 결과의 scope는 `recovery-batch-only`다. 전체 배치의 정확 job·ID 집합과 control이 모두 확인된 뒤에만 `recovery-complete`를 만든다. 누락·중복·미완료를 성공 skip으로 바꾸지 않는다.

## 로컬 검증과 남은 관문

로컬에서는 계획·감사·입력 충돌·계보·workflow 선택의 결정적 회귀만 확인한다. Rust 빌드·정상 비교·변이는 hosted에서만 수행한다. 원본 전체 종료는 선택 고정의 선행 조건이 아니다. 고정 완료 snapshot의 엄격 감사와 raw 증거 결속, 제품375에 대한 명시 baseline·replay 계보, 부모의 새 정의 정적 검토 뒤에만 필요한 배치 실행을 판단한다. 아직 새 recovery dispatch는 하지 않았다.
