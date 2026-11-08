# seuoffice

웹과 PC에서 문서(PDF, 워드, 엑셀, 파워포인트, 한글)를 보고 고치고 AI로 편집하는 오피스. 이음오피스를 바탕으로 웹에서도 돌게 개조하고 있다. 지금 단계와 계획은 `docs/seuoffice/로드맵.md`에 있다.

## 웹에서 열기

다섯 형식(PDF, docx, xlsx, pptx, hwp/hwpx)을 스위트 앱 그대로 브라우저에서 읽기 모드로 연다. 변환 서버 없이 정적 파일만 쓴다.

- 빌드: `npm run build -w @seuoffice/web`. 결과는 `apps/web/dist/`이고, 첫 빌드는 rhwp 스튜디오를 GitHub에서 받으며 엑셀 엔진을 `wasm32-wasip1`로 빌드한다.
- 미리보기: `npm run preview -w @seuoffice/web` → http://localhost:5300. 파일을 고르거나 끌어 놓으면 열린다.
- 시험: `npm run test -w @seuoffice/web`(Playwright, 빌드 뒤).

다른 웹 앱에 붙일 때는 `@seuoffice/embed`를 쓴다.

```ts
import { openDocument } from '@seuoffice/embed'

const doc = openDocument(document.getElementById('viewer')!, {
  baseUrl: 'https://office.example/', // apps/web/dist를 올린 주소
  bytes, // ArrayBuffer 또는 Uint8Array
  fileName: '회의록.hwpx',
})
await doc.opened // 실패하면 SeuofficeEmbedError(code: unsupported_format | too_large | open_failed | timeout)
```

운영에서 지킬 것:

- seuoffice 쪽 페이지는 CSP에 `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`이 있어야 한다(pdf.js, rhwp, 엑셀 엔진이 WASM과 워커를 쓴다).
- 붙이는 쪽 페이지는 `frame-src`에 seuoffice 출처를 넣는다.
- 다른 출처에서 문서를 보내려면 seuoffice를 빌드할 때 `VITE_SEUOFFICE_EMBED_ORIGINS`(쉼표로 구분한 출처 목록)를 준다. 목록에 없는 출처가 보낸 문서는 받지 않는다.
- 파일 크기 상한은 50MiB(`MAX_EMBED_BYTES`)다.

## 소유와 경계

- seuoffice는 스풋(GitHub SeuPut0705)의 개인 자산이다. 스풋 개인 시간과 비용으로 만들며, 유유헬스케어와의 계약 산출물이 아니다. 유유헬스케어는 seuoffice를 가져다 쓰는 사용자다.
- 유유헬스케어 저장소(`yuyuhealthcare/yuyu-mos`)의 코드·설정·데이터는 이 저장소에 가져오지 않는다. 유유 실데이터와 고객 원본 문서도 넣지 않는다. 시험은 모의 문서와 권리가 확인된 문서로 한다.
- 유유 메신저·업무 앱에 seuoffice를 연결하는 코드(첨부를 보기 창에 넘기는 일, 권한 확인)는 yuyu-mos 쪽에 있다. seuoffice는 "바이트 + 파일 이름 → 화면" 부품(`@seuoffice/embed`)과 정적 웹 묶음을 내놓는다.
- 저장소 전체를 Apache-2.0으로 공개한다(`docs/seuoffice/decisions/0007-전부-공개.md`). 유유헬스케어는 판 번호가 붙은 `@seuoffice/*` 묶음과 유유용 안정 판 PC 프로그램을 받아 쓰며, 따로 사용 허락 문서는 없다.

## 개발

- Node 22 이상, npm 10 이상. Rust stable(엑셀 엔진), 웹 빌드에는 `wasm32-wasip1` 타깃.
- `npm ci`, 데스크톱 실행 `npm run shell`. 나머지 명령과 작업 규칙은 `AGENTS.md`에 있다.

## 라이선스와 출처

- Apache-2.0(`LICENSE`). 고지는 `NOTICE`.
- 바탕: 이음오피스 https://github.com/pblsketch/ieumoffice (커밋 aea1414에서 들여옴), 그 원본 GenOffice https://github.com/genspark-ai/genoffice. GenOffice의 `ee/`(Enterprise License)는 포함하지 않는다.
- 한글 엔진 rhwp(MIT, Edward Kim)와 이음오피스 패치판(`vendor/rhwp-core`).
