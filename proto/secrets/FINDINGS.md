# safeStorage 비밀값을 Rust로 여는 증명: 결과

실행: https://github.com/SeuPut0705/seuoffice/actions/runs/43257019231 (macos-latest 26.7.2 arm64, windows-latest 10.0.26100, Electron 43.8.3, rustc 1.99.1). 원본 줄은 아티팩트 `proto-secrets-mac`/`proto-secrets-win`의 `findings.txt`.

## 확인한 형식

| | macOS | Windows |
| --- | --- | --- |
| 봉한 모양 | `sealed:v1:` + base64(`v10` + AES-128-CBC) | `sealed:v1:` + base64(`v10` + 12바이트 nonce + AES-256-GCM 암호문 + 16바이트 태그) |
| 키 | 키체인 암호(문자열 그대로) → PBKDF2-HMAC-SHA1(salt `saltysalt`, 1003회, 16바이트), IV 공백 16개, PKCS7 | `Local State`의 `os_crypt.encrypted_key`(base64) → 앞 5바이트 `DPAPI` 떼고 `CryptUnprotectData`(엔트로피 없음) → 32바이트 |
| 키가 사는 곳 | 키체인 항목 service `seuoffice Safe Storage`, account `seuoffice Key`(account는 `seuoffice`가 아니다) | `%APPDATA%\seuoffice\Local State`(첫 사용 뒤 수 초 안에 써진다) |
| 블롭 크기 | 35바이트(3 + 32) | 54와 60바이트(3 + 12 + 평문 + 16) |

Drive 토큰은 같은 블롭의 순수 base64다(`--blob`으로 연다).

## Windows

`open-sealed.exe --user-data %APPDATA%\seuoffice --json proto-secrets.json`이 두 평문(`sk-test-한글-✓-0001`, `ya29.drive-테스트-✓-0002`)을 시드한 값 그대로 냈다(W1). 순수 base64 블롭(W2)도 같다. 깨진 블롭은 `AES-256-GCM tag mismatch`로 종료 코드 1(W3).

## macOS: 다른 바이너리는 키체인 항목을 못 연다 (이게 발견)

항목 접근 목록(`security dump-keychain -a`, 비밀값 없이):

```
access: 3 entries
  entry 0: authorizations (1): encrypt; applications: <null>
  entry 1: authorizations (6): decrypt derive export_clear export_wrapped mac sign; don't-require-password
           applications (1): 0: .../A/Electron.app (OK)  requirement: cdhash H"88ffa940d08d0d63cf9f4c7a743cc5ffdc4eecd4"
  entry 2: authorizations (1): change_acl; applications (0)
```

ad hoc로 서명한 Electron은 접근 목록에 자기 `cdhash`만 올린다. partition_id 항목은 없다.

- 같은 앱 A가 열기(T0): 된다.
- `open-sealed`, 키체인 대화상자 끔(T1): 실패, **`-25293` errSecAuthFailed**("The user name or passphrase you entered is not correct"). `-25308`(errSecInteractionNotAllowed)이 아니다.
- **업데이트한 ad hoc Electron**(Info.plist 바꾸고 `codesign -f -s -`로 다시 서명, cdhash `88ff…`→`3720…`)은 같은 항목에서 키체인 대화상자("Electron wants to use your confidential information stored in "seuoffice Safe Storage" in your keychain", 암호 칸, Always Allow/Deny/Allow)가 뜬다(T3b, 스크린샷 `t3b-prompt.png`, 40초 뒤 `SIGKILL`, 종료 124). 비트가 같은 재서명 사본(cdhash 같음)은 대화상자 없이 열린다(T3a).
  - 결론: 지금도 ad hoc Electron은 업데이트 때마다 이 대화상자를 만난다. `apps/shell/src/main/ai-secrets.ts` 머리 주석의 "an ad hoc signed app would meet a Keychain prompt after every update"가 측정으로 맞다. Rust 껍데기가 한 번 묻는 건 후퇴가 아니라 지금과 같은 수준이다. 업데이트마다 되풀이되는 것도 지금과 같다.
- 러너에서 대화상자를 눌러 끝내려는 시도(T3c)는 암호를 쳐 넣고 누르면 대화상자가 회색으로 멈추고 요청이 끝나지 않았다. 이 환경의 한계로 기록하고, 대화상자가 실제 Mac에서 눌러 통과하는 경로라는 증명은 하지 못했다(`[INFERENCE]`: 사용자가 "항상 허용"을 누르면 접근 목록에 새 cdhash가 올라간다는 건 macOS 문서 동작이다).

## CI로 증명한 길

- **R1 새 키 항목을 `-T <바이너리>`로 만들기**: Electron과 무관한 프로세스(`security add-generic-password -T`)가 Rust 바이너리 이름을 접근 목록에 올린 새 항목을 만들면 `open-sealed --probe`가 대화상자 없이 읽는다. 경로를 옮긴 같은 바이트 바이너리도 된다. cdhash가 달라진 재빌드는 `-25293`.
- **R2 `-A`(모든 앱 허용)** 항목: 누구나 읽는다. 읽을 수 있는 비밀값을 위한 `-T`에서 `-A`로 가는 길은 보호를 같은 사용자의 모든 프로그램으로 넓힌다(Windows DPAPI와 같은 수준).
- **R3 partition list 넓히기**: Electron 항목에는 partition_id 항목이 없어 효과 없음(여전히 `-25293`).
- **R4 안정한 서명 정체**: 자체 서명 인증서로 설치본 Electron을 서명하고 봉하면 접근 목록 요구사항이 `identifier "com.github.Electron" and certificate leaf = H"7bf9…"`가 된다. 같은 인증서로 서명한 **업데이트 빌드(cdhash 다름)가 대화상자 없이 연다**(종료 0, 평문 같음). 접근 목록이 cdhash가 아니라 인증서에 묶이기 때문이다.
- **R5 Rust 껍데기도 같다**: `-T <자체 서명 바이너리>`로 만든 항목을 같은 인증서·식별자로 서명한 **바이트가 다른 새 빌드가 읽고**(`X2`), ad hoc로 다시 서명한 빌드는 `-25293`(`X3`).

## 권고 (추론 포함)

1. 업데이트마다 대화상자를 없애려면 접근 목록이 cdhash가 아닌 서명 정체에 묶여야 한다. 유료 Developer ID가 없어도 자체 서명 인증서로 R4/R5가 성립했다(`[INFERENCE]`: 자체 서명 인증서는 Gatekeeper 면제가 없어 앱 배포 정책(결정 0031)과 따로 판단해야 한다).
2. 마지막 Electron 판(0.12.38)이 업데이트 앞단에서 비밀값을 안전 저장소로 한 번 옮기고(`safeStorage.decryptString` → 새 무작위 키로 AES-GCM 봉인, 새 키는 `security add-generic-password -T <새 껍데기>`로 보관), 껍데기가 그것을 읽게 하면 사용자 대화상자는 없다. R1이 그 구성 요소를 증명한다. 끝에서 끝까지의 이전은 이 시제품에 없다.
3. Windows는 손댈 것이 없다. 같은 사용자 계정이면 DPAPI가 그대로 열린다.

## 다시 돌리기

`gh workflow run "proto secrets" --ref proto/rust-shell`. 러너에서만 돌린다(맥북 로컬의 실제 키체인을 건드리지 않는다). `proto/secrets/ci/mac.sh`, `ci/win.ps1`.
