# seuoffice

웹과 PC에서 문서(PDF, 워드, 엑셀, 파워포인트, 한글)를 보고 고치고 AI로 편집하는 오피스. 이음오피스를 바탕으로 웹에서도 돌게 개조하고 있다. 지금 단계와 계획은 `docs/seuoffice/로드맵.md`에 있다.

## 소유와 경계
- seuoffice는 스풋(GitHub SeuPut0705)의 개인 자산이다. 스풋 개인 시간과 비용으로 만들며, 유유헬스케어와의 계약 산출물이 아니다. 유유헬스케어는 seuoffice를 가져다 쓰는 사용자다.
- 유유헬스케어 저장소(`yuyuhealthcare/yuyu-mos`)의 코드·설정·데이터는 이 저장소에 가져오지 않는다. 유유 실데이터와 고객 원본 문서도 넣지 않는다. 시험은 모의 문서와 권리가 확인된 문서로 한다.
- 유유 메신저·업무 앱에 seuoffice를 연결하는 코드(첨부를 보기 창에 넘기는 일, 권한 확인)는 yuyu-mos 쪽에 있다. seuoffice는 "바이트 + 파일 이름 → 화면" 부품(`@seuoffice/embed`)과 정적 웹 묶음을 내놓는다.
- 저장소는 비공개다. 공개 여부는 1단계(웹 보기) 뒤 다시 정한다.

## 개발
- Node 22 이상, npm 10 이상. Rust stable(엑셀 엔진), 웹 빌드에는 `wasm32-wasip1` 타깃.
- `npm ci`, 데스크톱 실행 `npm run shell`. 나머지 명령과 작업 규칙은 `AGENTS.md`에 있다.

## 라이선스와 출처
- Apache-2.0(`LICENSE`). 고지는 `NOTICE`.
- 바탕: 이음오피스 https://github.com/pblsketch/ieumoffice (커밋 aea1414에서 들여옴), 그 원본 GenOffice https://github.com/genspark-ai/genoffice. GenOffice의 `ee/`(Enterprise License)는 포함하지 않는다.
- 한글 엔진 rhwp(MIT, Edward Kim)와 이음오피스 패치판(`vendor/rhwp-core`).
