# 0030 GenOffice 이름이 붙은 리눅스 꾸러미 정리

- 날짜: 2026-11-13
- 상태: 확정
- 결정한 사람: 스풋("사용자에게 보이는 GenOffice 이름과 로고를 제품에서 모두 없앤다"), 방식은 이 일을 맡은 세션
- 관련: [0024](0024-원본과-갈라서기.md)

## 맥락

`packaging/flatpak`, `packaging/nix`, `packaging/docker`는 이음오피스 0.11.0 릴리스(`pblsketch/ieumoffice`)의 deb·AppImage를 받아 감싸는 꾸러미였다. 파일 이름, 앱 id(`com.genoffice.app`), 데스크톱 항목의 이름("GenOffice"), 실행 명령(`genoffice`), 환경 변수(`GENOFFICE_*`)가 모두 원본 이름이다. 꾸러미가 내려받는 바이너리도 원본 이름으로 등록되는 앱이다.

seuoffice는 Linux 판을 내지 않는다(로드맵, 2026-11-09 스풋 결정). 그러니 이 꾸러미들이 가리킬 seuoffice 릴리스 파일이 없다. 이름만 바꾸면 "SeuOffice"라는 이름으로 원본 앱을 내려받는 꾸러미가 된다. 주소와 해시를 새로 적을 파일이 없어서 고쳐 쓸 수도 없다.

## 결정

- `packaging/flatpak`, `packaging/nix`, `packaging/docker`를 지운다. 이력에 남으므로 Linux 판을 다시 내게 되면 그때 seuoffice 이름과 seuoffice 릴리스 파일로 새로 쓴다.
- `packaging/cli`(명령줄만 담는 압축 파일과 설치 스크립트)는 남긴다. 묶는 쪽(`packages/cli/pack-tarball.mjs`)은 이미 `seuoffice-cli`, `cli/seuoffice.cjs`를 만든다. 설명과 설치 스크립트를 그 이름에 맞춘다.

## 버린 대안

- **이름만 seuoffice로 바꾸기.** 받는 파일이 원본 앱이라 이름과 내용이 어긋난다. 해시도 새로 적을 수 없다.
- **그대로 두기.** 앱 목록에 "GenOffice"로 보이는 항목을 만드는 파일이 저장소에 남는다.

## 결과

- 저장소에서 Linux용 Flatpak, Nix, Docker 꾸러미가 없어진다. 시험과 CI는 이 파일들을 쓰지 않았다(`packaging/README.md`: "not exercised by CI").
- `tools/rename-internal/mapping.mjs`의 `packaging/**` 항목은 남은 `packaging/cli`에 그대로 적용된다.
