# 0033 셸의 safeStorage: Electron과 같은 값, 같은 열쇠

- 날짜: 2026-11-13
- 상태: 확정(실기기 넘어가기 시험은 0029의 마지막 묶음 시험에서)
- 결정한 사람: 3단계 A 묶음 세션(메인 세션이 "OS 키체인을 크레이트로, 고른 것과 옛 값 옮기기를 기록"을 맡김)

## 맥락

Electron 판은 비밀값을 `safeStorage`로 봉한다. Drive 새로 고침 토큰(`google-drive.json`)과 MCP 서버 비밀값은 두 OS 모두에서, AI 키와 토큰(`ai-settings.json`의 `sealed:v1:` 값)과 홈 검색의 재순위 키(`app-settings.json`)는 Windows에서만 봉한다(이음오피스 결정 0063, `docs/archive/`). 봉한 바이트는 Chromium OSCrypt의 `v10` 값이다.

- macOS: 열쇠는 키체인 항목 service `seuoffice Safe Storage`, account `seuoffice Key`의 암호에서 PBKDF2-SHA1로 얻는다. 값은 AES-128-CBC다. 앱 이름이 `seuoffice`인 까닭은 0019.
- Windows: 열쇠는 `<userData>/Local State`의 `os_crypt.encrypted_key`이고 DPAPI로 풀린다. 값은 AES-256-GCM이다.

3단계 셸(Tauri 3 + CEF)에는 Electron이 없다. 0029 (b)가 Rust로 두 OS의 값을 여는 것을 러너에서 보였다(`proto/secrets`). 남은 물음은 셸이 새로 봉할 때 무엇을 쓰느냐, 옛 값을 옮기느냐다.

## 결정

1. **셸은 Electron과 같은 형식, 같은 열쇠로 봉하고 연다.** `crates/shell-ipc/a/src/secrets`의 `OsSafeStorage`가 `main-core`의 `SafeStorageLike`를 구현한다.
   - 열쇠를 처음 봉하거나 열 때 한 번 읽는다(Chromium과 같다). 없으면 Chromium이 만드는 자리에 같은 모양으로 만든다. macOS는 16바이트 난수의 base64를 암호로 키체인 항목에 넣고, Windows는 32바이트 난수를 DPAPI로 봉해 `Local State`에 적으면서 그 파일의 다른 키는 남긴다.
   - 항목이 **없을 때만** 만든다. 읽기가 거절되거나 실패하면 새로 만들지 않고 "암호화를 쓸 수 없음"으로 답한다. 새 열쇠를 만들면 그 전에 봉한 값을 모두 잃는다.
   - `v10` 머리가 없는 값은 Chromium처럼 다룬다. macOS는 평문으로, Windows는 DPAPI만으로 봉한 옛 값으로 본다.
   - 오류 글은 Electron의 `encryptString`·`decryptString` 문구 그대로다.
   - 쓰는 크레이트: `aes`, `aes-gcm`, `cbc`, `pbkdf2`(RustCrypto), macOS `security-framework`, Windows `windows-sys`(DPAPI). Linux 셸은 암호화를 쓸 수 없다고 답한다. 판은 Mac과 Windows만 낸다.
2. **옛 값은 옮기지 않는다.** 같은 값과 같은 열쇠를 쓰니 옮길 것이 없다. 셸로 넘어간 뒤 옛 Electron 판으로 돌아가도(0026 5항의 실패 경로) 셸이 봉한 값이 그대로 열린다.
3. **macOS 키체인 대화상자는 지금 수준으로 둔다.** 키체인 항목의 접근 목록은 그것을 만든 Electron의 cdhash다. 그래서 셸이 처음 읽을 때 "항상 허용" 대화상자가 한 번 뜬다. 지금의 ad hoc 서명 Electron도 업데이트마다 같은 대화상자를 만난다(0029 (b) T3b). 셸의 업데이트도 cdhash가 바뀌므로 업데이트마다 뜨는 것까지 지금과 같다. 대화상자는 Chromium처럼 열쇠가 처음 필요할 때 코어 스레드에서 뜨고, 그동안 IPC 답이 기다린다(3단계 셸 계약 3절의 "알려진 차이"와 같은 종류).

## 버린 대안

- **새 열쇠(`keyring` 크레이트의 새 항목)로 다시 봉하기.** 셸이 처음 켤 때 옛 값을 열어 새 열쇠로 다시 봉한다. 버린 까닭: 옛 Electron 판으로 돌아가면 다시 봉한 값을 열지 못해 AI 키와 Drive 연결을 잃는다. 옮기는 도중 꺼지면 반쯤 옮긴 파일이 남는다. 대화상자는 어차피 옛 항목을 한 번 읽을 때 뜬다.
- **마지막 Electron 판이 값을 새 항목으로 옮기기(0029 (b) R1).** 대화상자를 없앨 수 있다. 버린 까닭: 마지막 Electron 판에 일을 더하고, 위와 같이 되돌리기를 깬다. 대화상자는 지금도 업데이트마다 뜨므로 없애는 일은 서명 정체를 고정하는 일(0029 R4, R5)과 함께 따로 정한다.
- **Electron처럼 `basic_text`를 Linux에서 흉내 내기.** 판을 내지 않는 플랫폼이고, 이음오피스 결정 0063이 그 값을 "봉한 척"으로 보아 평문으로 두었다.

## 결과

- 처리기는 `OsSafeStorage::new(KeyPlace { app_name: "seuoffice", user_data })`를 쓴다. 셸의 `host/secrets.rs`(A 묶음 파일)가 W가 만든 `crates/shell` 위에서 이것을 만든다. 개발 판은 Electron 개발 판이 쓰던 앱 이름을 넘긴다.
- 형식은 러너 시험이 지킨다. macOS 값은 바깥 도구(`openssl`)로 만든 값과 바이트까지 같다. Windows 값은 왕복과 바뀐 바이트 거절로 본다. 실제 키체인과 DPAPI를 부르는 길은 맥북에서 돌리지 않는다(실제 키체인을 건드리지 않으려고). 0029의 마지막 묶음 넘어가기 시험이 Mac과 Windows 실기기에서 옛 Electron 판이 봉한 AI 키가 셸에서 열리는지 본다.
