# 0019 — 설치할 때 `.xmind`의 기본 프로그램을 가져오지 않는다

## 맥락

Windows 설치본은 워드·엑셀·파워포인트·PDF·마크다운·HTML 파일을 이 앱에 연결해 등록한다. `.txt`와 `.json`은 시스템의 기본 편집기를 빼앗지 않도록 이미 등록에서 빼 두었다. `.xmind`를 쓰는 사람은 대개 XMind를 이미 깔아 두고 그것으로 연다.

## 결정

- Windows 설치본은 `.xmind`를 이 앱에 연결해 등록하지 않는다(`apps/shell/electron-builder.cjs`의 `WIN_OPEN_WITH_ONLY_EXTS`에 `.txt`·`.json`과 함께 둔다). 설치해도 `.xmind`의 기본 프로그램은 그대로다.
- 앱 안에서는 열기 창, 끌어다 놓기, 최근 파일, 폴더 나무로 연다. 실행 인자로 `.xmind` 경로를 받으면 연다.
- 사용자가 결정했다.

## 택하지 않은 것

- **워드·엑셀·PPT처럼 이 앱을 기본으로 등록.** XMind를 쓰던 사람의 설정이 설치 한 번으로 바뀐다.

## 결과

- 탐색기에서 `.xmind`를 두 번 눌러 이 앱으로 열려면 사용자가 Windows의 "연결 프로그램"에서 직접 골라야 한다.
- 파일 연결 시험(`apps/shell/tests/file-associations.test.ts`)이 `.xmind`가 Windows 목록에 없는 것을 지킨다.
