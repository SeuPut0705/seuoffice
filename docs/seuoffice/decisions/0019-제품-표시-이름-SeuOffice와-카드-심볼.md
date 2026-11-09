# 0019 제품 표시 이름 SeuOffice와 카드 심볼

- 날짜: 2026-11-09
- 상태: 확정
- 결정한 사람: 스풋(이름 `SeuOffice`, 글자가 아닌 심볼, 이미지 생성 시안 중 "펼친 카드 + 별"). 바꾸는 범위는 메인 세션이 정했다.

## 맥락

결정 0013은 사용자에게 보이는 이름을 모든 언어에서 소문자 `seuoffice`로 정했다. 첫 릴리스 v0.12.11을 낸 뒤 스풋이 화면에 옛 이름이 남은 곳을 봤다. 사이드바 로고에는 "IeumOffice" 글자가 그림으로 박혀 있었다. 앱 아이콘은 이음오피스의 마크(고리와 둥근 네모, "이음"의 ㅇ·ㅁ)였다. 창 제목은 `seuoffice Docs`처럼 소문자였다. 스풋은 이름을 `SeuOffice`로 적고, 좁은 곳은 로고만 두어도 된다고 했다.

## 결정

- 사람이 보는 제품 이름은 모든 언어에서 `SeuOffice`다. 한 곳에서만 정한다. `packages/i18n/src/product.ts`의 `PRODUCT_NAME`이고, `apps/shell/electron-builder.cjs`와 `apps/shell/package.json`의 `productName`이 이 값을 따라 적는다(`product-identity.test.ts`가 셋이 같은지 확인한다). 창 제목, Mac 메뉴와 앱 이름, 설치 프로그램 이름, 설치 파일 이름(`SeuOffice-Setup-<판>.exe`, `SeuOffice-<판>-arm64.dmg`), 웹 페이지 제목, 릴리스 본문이 모두 이 값을 쓴다.
- 앱 아이콘과 사이드바 로고의 마크는 이음오피스 마크 대신 글자 없는 심볼로 바꾼다. 흰 타일 위에 둥근 카드 세 장(주황 `#FFB020`, 보라 `#6D5DF6`, 남색 `#4338CA`)을 부채처럼 펼치고, 맨 위 카드에 흰 네 갈래 별(AI)을 둔다. 여러 문서 형식과 AI 편집을 뜻한다. 이미지 생성으로 시안을 뽑아 스풋이 고른 것을 SVG로 다시 그렸다. 원본은 `apps/shell/build/brand/app-icon.svg`이고, 32px 이하용 `app-icon-small.svg`는 별을 키웠다. 다른 아이콘은 모두 `tools/gen-brand-assets.mjs`가 여기서 만든다. 사이드바 로고는 같은 카드를 검정 한 색(카드 사이는 흰 틈)으로 그리고 그 옆에 "SeuOffice" 글자를 둔다. AI 단추 마크와 파일 종류 아이콘은 그대로 둔다.
- 내부 이름은 바꾸지 않는다: `appId` `com.seuput.seuoffice`, `PACKAGED_APP_NAME` `seuoffice`(업데이트 캐시 폴더, 리눅스 실행 파일), 패키지 이름, 저장소 이름, embed 통로 표지 `seuoffice`, 업데이트 피드 파일 이름, 명령 이름(`genoffice`, `ieumoffice`), `~/.genoffice`, `~/.ieumoffice`, MCP 서버 설정 이름.

## 버린 대안

- **표시 이름만 따로 두고 `PRODUCT_NAME`은 소문자로 둔다.** 이렇게 하면 사용자 데이터 폴더와 레지스트리 이름은 글자 그대로 같다. 하지만 Mac 메뉴 막대와 Dock, 설치 프로그램은 electron-builder `productName`을 쓰므로 거기에 소문자가 남는다. 표시 이름과 등록 이름이 둘로 갈려 새 코드가 어느 쪽을 쓸지 매번 골라야 한다.
- **이음오피스 마크를 그대로 쓴다.** Apache-2.0으로 파일은 쓸 수 있지만, 마크가 "이음"을 뜻해서 다른 제품으로 보이지 않는다. 0013 맥락처럼 상위 이름과 상징을 쓸 권리는 라이선스에 없다.
- **S 글자 마크.** 처음에 S 두 획 마크를 넣었으나, 스풋이 글자가 아닌 심볼을 원했다. 이미지 생성 심볼 시안 중 "겹친 두 문서 + 별", "접힌 종이"는 고르지 않았고, "물결 액자"는 흔한 사진 아이콘과 닮아 뺐다.

## 결과

- 이미 깐 v0.12.11과 이어지도록 기계 이름은 소문자 `seuoffice`로 둔다. `USER_DATA_DIR_NAME`은 `PRODUCT_NAME`을 따르지 않고 `'seuoffice'`로 적는다. 설치된 앱은 켤 때 `app.setName('seuoffice')`를 부르고 사용자 데이터 폴더를 `<appData>/seuoffice`에 고정한다. 준비가 끝나면 `app.setName('SeuOffice')`로 표시 이름을 돌려놓는다(`apps/shell/src/main/index.ts`).
  - 까닭: Electron은 Mac 키체인 항목 `"<앱 이름> Safe Storage"`에 safeStorage 키를 둔다. 키체인 이름은 대소문자를 가린다. 앱 이름이 `SeuOffice`가 되면 업데이트된 앱이 키를 못 찾고 새 키를 만들어, Drive 연결과 MCP 비밀값을 조용히 잃는다. Drive 캐시 목록도 절대 경로를 대소문자를 가려 비교하므로, 폴더 경로 문자열이 바뀌면 올리지 않은 수정본을 버린다(독립 검토에서 찾음).
  - 확인: 저장소의 Electron 43.7.6으로 시험 앱을 돌렸다. 시작할 때 `setName`으로 준 이름이 키체인 항목과 userData에 쓰이고, 준비 뒤 이름을 바꿔도 키체인 항목은 그대로였다. 메뉴의 "종료" 같은 글자는 바뀐 표시 이름을 따랐다.
- Windows 파일 연결 ProgId와 레지스트리 키도 `seuoffice`(`PACKAGED_APP_NAME`)로 둔다. `installer.nsh`와 `default-app.ts`가 소문자로 적어 둔 것과 맞춘다.
- Mac 자체 업데이트(`apps/shell/src/main/mac-update.ts`)는 번들 ID와 판만 비교하고, 받은 zip 안의 `.app`을 이름과 상관없이 설치된 자리에 옮긴다. 그래서 업데이트로 받은 Mac 앱의 폴더 이름은 `seuoffice.app`으로 남는다. 새로 설치해야 `SeuOffice.app`이 된다. Windows는 원래 설치 폴더에 그대로 깔고, 옛 바로가기 이름 `seuoffice`가 남을 수 있다.
- 리눅스 패키지(릴리스하지 않음)는 `/opt/SeuOffice`에 깔린다. CLI와 설치 뒤 스크립트가 그 경로를 쓴다.
- 0013의 "제품 이름" 절에서 소문자 이름과 설치 파일 이름을 적은 줄은 이 결정으로 바뀐다.
