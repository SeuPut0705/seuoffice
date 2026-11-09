# 0019 제품 표시 이름 SeuOffice와 S 마크

- 날짜: 2026-11-09
- 상태: 확정
- 결정한 사람: 스풋(이름 `SeuOffice`, 마크 시안 A). 바꾸는 범위는 메인 세션이 정했다.

## 맥락

결정 0013은 사용자에게 보이는 이름을 모든 언어에서 소문자 `seuoffice`로 정했다. 첫 릴리스 v0.12.11을 낸 뒤 스풋이 화면에 옛 이름이 남은 곳을 봤다. 사이드바 로고에는 "IeumOffice" 글자가 그림으로 박혀 있었다. 앱 아이콘은 이음오피스의 마크(고리와 둥근 네모, "이음"의 ㅇ·ㅁ)였다. 창 제목은 `seuoffice Docs`처럼 소문자였다. 스풋은 이름을 `SeuOffice`로 적고, 좁은 곳은 로고만 두어도 된다고 했다.

## 결정

- 사람이 보는 제품 이름은 모든 언어에서 `SeuOffice`다. 한 곳에서만 정한다. `packages/i18n/src/product.ts`의 `PRODUCT_NAME`이고, `apps/shell/electron-builder.cjs`와 `apps/shell/package.json`의 `productName`이 이 값을 따라 적는다(`product-identity.test.ts`가 셋이 같은지 확인한다). 창 제목, Mac 메뉴와 앱 이름, 설치 프로그램 이름, 설치 파일 이름(`SeuOffice-Setup-<판>.exe`, `SeuOffice-<판>-arm64.dmg`), 웹 페이지 제목, 릴리스 본문이 모두 이 값을 쓴다.
- 앱 아이콘과 사이드바 로고의 마크는 이음오피스 마크 대신 SeuOffice의 S로 바꾼다. 보라 바탕(`#4338CA`)에 흰 윗획과 주황(`#FFB020`) 아랫획 두 개로 S를 그린다. 원본은 `apps/shell/build/brand/app-icon.svg`이고, 다른 아이콘은 모두 `tools/gen-brand-assets.mjs`가 여기서 만든다. 사이드바 로고는 같은 S를 한 색으로 그리고 그 옆에 "SeuOffice" 글자를 둔다. AI 단추 마크와 파일 종류 아이콘에는 이름이 없어 그대로 둔다.
- 내부 이름은 바꾸지 않는다: `appId` `com.seuput.seuoffice`, `PACKAGED_APP_NAME` `seuoffice`(업데이트 캐시 폴더, 리눅스 실행 파일), 패키지 이름, 저장소 이름, embed 통로 표지 `seuoffice`, 업데이트 피드 파일 이름, 명령 이름(`genoffice`, `ieumoffice`), `~/.genoffice`, `~/.ieumoffice`, MCP 서버 설정 이름.

## 버린 대안

- **표시 이름만 따로 두고 `PRODUCT_NAME`은 소문자로 둔다.** 이렇게 하면 사용자 데이터 폴더와 레지스트리 이름은 글자 그대로 같다. 하지만 Mac 메뉴 막대와 Dock, 설치 프로그램은 electron-builder `productName`을 쓰므로 거기에 소문자가 남는다. 표시 이름과 등록 이름이 둘로 갈려 새 코드가 어느 쪽을 쓸지 매번 골라야 한다.
- **이음오피스 마크를 그대로 쓴다.** Apache-2.0으로 파일은 쓸 수 있지만, 마크가 "이음"을 뜻해서 다른 제품으로 보이지 않는다. 0013 맥락처럼 상위 이름과 상징을 쓸 권리는 라이선스에 없다.
- **문서 위에 S를 얹은 시안 B.** 오피스 앱인 것은 잘 드러나지만, 16~32px에서 S가 작아 알아보기 어렵다.

## 결과

- 이미 깐 v0.12.11과 이어진다. 사용자 데이터 폴더(`seuoffice` → `SeuOffice`), 기본 저장 폴더, Windows ProgId와 레지스트리 키는 대소문자만 다르다. 두 배포 플랫폼(Mac 기본 APFS, Windows)은 대소문자를 가리지 않으므로 같은 폴더와 키다. Mac 자체 업데이트(`apps/shell/src/main/mac-update.ts`)는 받은 zip 안의 `.app`을 이름과 상관없이 설치된 자리에 옮긴다. 그래서 업데이트로 받은 Mac 앱의 폴더 이름은 `seuoffice.app`으로 남는다. 새로 설치해야 `SeuOffice.app`이 된다. Windows도 업데이트는 원래 설치 폴더에 그대로 깐다.
- 대소문자를 가리는 APFS 볼륨에 Mac 앱을 깐 사용자는 업데이트 뒤 새 데이터 폴더를 보게 된다. 드문 설정이라 옮기는 코드는 넣지 않았다.
- 0013의 "제품 이름" 절에서 소문자 이름과 설치 파일 이름을 적은 줄은 이 결정으로 바뀐다.
