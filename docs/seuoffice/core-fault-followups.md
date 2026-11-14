# 중심 프로세스 결함 감도 후속

## 글로벌 PAX 메타데이터 사이의 파일 이름

원본 제품은 `30f303cde7b496bf640aadffcb0b70bf7fb2ad21`이며, 전용 실행 `43568242384`의 `b5-mcp` 3번 조각은 다음 결과를 남겼다. 이 결과는 후속 수정으로 덮지 않는다.

```text
MISSED extract a global pax header is a file  (80 checks, 80 equal, 0 differences, 0 listed, 1 functions)
```

- 원본 목록: `tools/main-diff/faults/b5-mcp.json`, 0부터 세는 위치 `203`.
- 변이 객체의 SHA256: `0544ee04bf0d2ce6697e4a18b9a8ae67f47f3113c07dc6aa9e050958f720568d`. 객체를 읽어 `JSON.stringify`한 UTF-8 바이트의 값이다.
- 원본 목록 파일의 SHA256: `a45058cef79809d51c1eda0116ccb3086bd05df0838f4757e820db0c4fb8cc25`.
- 원본 변이: `runtime_archive.rs`의 메타데이터 guard에서 `b'g'`만 뺀다. 이름·대상·find·replace·함수 목록·원본 위치는 후속에서도 바꾸지 않는다.

이 변이는 모든 입력에서 동등하지 않다. 정상 `g` 경로는 메타데이터를 읽고 다음 헤더로 넘어가며 pending `pax`, `long_name`, `long_link`를 보존한다. 변이는 일반 항목 경로로 내려가 이 상태를 소비하고 지운다. 또한 파일을 쓰는 kind guard보다 먼저 항목 이름을 검증한다.

후속 제품은 `f5065c06a52b7ebbe4100da637140da4beb67182`의 기존 80개 사례 뒤에 두 개만 더한다. 기존 사례를 지우거나 번호를 옮기지 않는다.

| 새 위치 | 입력                                                           | 소비자가 관측하는 동작                                       |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 80      | local PAX의 `kept.txt` 경로, global PAX, 일반 파일 `short.txt` | 메타데이터를 지나도 실제 파일은 `kept.txt`로 풀린다.         |
| 81      | 이름이 `../ignored-global`인 global PAX, 정상 파일             | 추출하지 않는 메타데이터의 이름은 무시하고 정상 파일을 푼다. |

사례는 기존 `TarEntry[]`, checksum·padding·gzip 생성기와 실제 `extractRuntimeArchive`를 사용한다. 가짜 엔진이나 예외 억제를 추가하지 않는다. TS 오라클 확인과 Rust 정상 baseline·같은 원본 변이의 검출은 별개의 근거다. Rust 증명은 저장소 규칙에 따라 hosted 러너에서 수행하고 정확 제품·정의·실행을 함께 기록한다. 이 두 사례의 좁은 성공을 전체 6,121개 결함 성공으로 확대하지 않는다.
