# 0021 웹 묶음은 npm 대신 GitHub 릴리스로

- 날짜: 2026-11-10
- 상태: 확정
- 결정한 사람: 스풋

## 맥락

결정 0007은 `@seuoffice/embed`와 `@seuoffice/web`을 npm 공개 저장소에 내기로 했다. 그러려면 스풋이 npmjs.com에 `seuoffice` 조직을 만들고, 첫 판을 손으로 올리고, 신뢰 게시자(GitHub Actions)를 연결해야 했다. 이 일이 1.5단계의 마지막 남은 일이었다.

그런데 지금 이 묶음을 쓰는 곳은 유유헬스케어 하나뿐이다. 저장소가 이미 Apache-2.0으로 전부 공개라서, npm 비공개로 받는 사람을 고르는 것도 의미가 없다. 앱은 main 푸시마다 판이 나온다(결정 0020).

## 결정

- 두 웹 묶음을 npm 저장소에 올리지 않는다. 앱 릴리스 워크플로(`seuoffice-desktop.yml`)의 `web` 작업이 웹 묶음을 빌드하고 `npm pack`으로 `seuoffice-embed-<판>.tgz`와 `seuoffice-web-<판>.tgz`를 만들어, 같은 GitHub 릴리스에 붙인다.
- 판 번호는 앱과 같다. 빌드할 때 워크플로가 두 `package.json`에 판 번호를 적는다. 따로 태그(`npm-v*`)를 달거나 판을 올리는 일은 없다.
- 붙이는 쪽은 안정 판의 릴리스 주소로 설치한다(`npm install https://github.com/SeuPut0705/seuoffice/releases/download/v<판>/seuoffice-embed-<판>.tgz`). 미리보기 판은 10개가 넘으면 지워지므로 고정하지 않는다.
- npm 게시 워크플로 `seuoffice-release.yml`, 판 스크립트 `scripts/seuoffice-release.mjs`, 두 패키지의 `publishConfig`를 지운다.

## 버린 대안

- **npm 공개 게시(0007의 원래 계획).** 이름 `@seuoffice`를 선점하고 누구나 `npm install @seuoffice/embed`로 받게 할 수 있다. 하지만 쓰는 곳이 하나라 지금 얻는 것이 없고, 스풋이 계정·조직·신뢰 게시자를 설정해야 한다. 59.6MB 웹 묶음을 npm이 받는지도 확인하지 못했다. 쓰는 곳이 늘면 그때 다시 정한다.
- **npm 비공개 패키지, GitHub Packages.** 받는 사람을 고를 수 있지만 유료이거나 비공개 저장소가 따로 필요하다. 소스가 공개라 막는 효과도 없다.

## 결과

- 1.5단계에 스풋이 할 일이 없어졌다.
- 유유는 npm 계정이나 토큰 없이 설치한다. `package-lock.json`이 받은 파일의 해시를 고정한다.
- 자동 업데이트는 데스크톱 앱만 해당한다. 웹 묶음은 붙이는 쪽이 판 올리기 커밋으로 주소의 판 번호를 바꿀 때만 바뀐다(`판-내기.md`).
- 앱 릴리스가 붙는 파일이 두 개 늘고, `web` 작업(웹 빌드)이 앱 빌드와 함께 돈다.
