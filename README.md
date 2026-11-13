<p align="center"><b>한국어</b> · <a href="README.en.md">English</a></p>

<p align="center">
  <img src="apps/shell/build/brand/app-icon.svg" width="96" height="96" alt="SeuOffice">
</p>

<h1 align="center">SeuOffice</h1>

<p align="center">
  웹과 PC에서 PDF, 워드, 엑셀, 파워포인트, 한글 문서를 보고 고치고, AI로 편집하는 오피스
</p>

<p align="center">
  <a href="https://github.com/SeuPut0705/seuoffice/releases/latest/download/SeuOffice-mac-arm64.dmg"><img src="docs/seuoffice/readme/download-mac.svg" width="300" alt="macOS 다운로드 (Apple Silicon)"></a>
  &nbsp;
  <a href="https://github.com/SeuPut0705/seuoffice/releases/latest/download/SeuOffice-windows-x64.exe"><img src="docs/seuoffice/readme/download-windows.svg" width="300" alt="Windows 다운로드 (x64)"></a>
</p>

<p align="center">
  <sub>Apple Silicon Mac · Windows x64 · 무료 · 소스 공개(FSL-1.1-ALv2) · <a href="https://github.com/SeuPut0705/seuoffice/releases">모든 판과 미리보기 판</a></sub>
</p>

<p align="center">
  <img src="docs/seuoffice/readme/hero.jpg" width="820" alt="노트북과 브라우저에서 PDF, DOCX, XLSX, PPTX, HWP 문서를 여는 SeuOffice">
</p>

## 할 수 있는 일

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/seuoffice/readme/web-and-pc.jpg" width="220" alt=""></td>
    <td align="center" width="33%"><img src="docs/seuoffice/readme/ai-review.jpg" width="220" alt=""></td>
    <td align="center" width="33%"><img src="docs/seuoffice/readme/edit-lock.jpg" width="220" alt=""></td>
  </tr>
  <tr>
    <td valign="top"><b>웹과 PC에서 같은 편집기</b><br>PC 앱과 똑같은 편집기가 브라우저에서도 돈다. 변환 서버 없이 정적 파일만 쓰고, 다른 웹 앱 안에 끼워 넣을 수 있다.</td>
    <td valign="top"><b>AI가 고치고, 사람이 받아들인다</b><br>워드는 AI 편집이 변경 추적으로 남는다. 한글, 엑셀, 파워포인트는 AI가 고친 것이 제안으로 남고, 사람이 받아들여야 문서에 들어간다.</td>
    <td valign="top"><b>여럿이 함께 고친다(시험 단계)</b><br>워드, 엑셀, 파워포인트, PDF는 여러 사람이 같은 문서를 같은 순간에 고칠 수 있다. 붙이는 쪽이 공동 편집 서버를 돌릴 때만 켜지고, 실제 서비스에 붙여 쓴 적은 아직 없다. 한글과 그 밖의 경우는 편집 잠금을 가진 한 사람이 고치고 나머지는 읽는다.</td>
  </tr>
</table>

| 형식            | 보기 | 고치고 같은 형식으로 저장 |   AI 편집    |
| --------------- | :--: | :-----------------------: | :----------: |
| PDF             |  ✅  |            ✅             |      ✅      |
| 워드 docx       |  ✅  |            ✅             | ✅ 변경 추적 |
| 엑셀 xlsx       |  ✅  |            ✅             |   ✅ 제안    |
| 파워포인트 pptx |  ✅  |            ✅             |   ✅ 제안    |
| 한글 hwp, hwpx  |  ✅  |            ✅             |   ✅ 제안    |

지금 단계와 계획은 `docs/seuoffice/로드맵.md`에 있다.

## 설치

위 단추로 받는다. 두 플랫폼 모두 앱이 스스로 새 판을 받아 바꾼다.

지금은 코드 서명 없이 낸다(결정 0013). 처음 열 때 운영체제가 한 번 막는다.

- **Mac**: dmg를 열어 SeuOffice를 응용 프로그램 폴더로 옮긴다. 처음 열 때 막히면 시스템 설정 → 개인정보 보호 및 보안에서 "그래도 열기"를 누른다.
- **Windows**: 설치 파일을 실행했을 때 "Windows의 PC 보호" 창이 뜨면 "추가 정보" → "실행"을 누른다.

## 웹에서 열기

다섯 형식을 스위트 앱 그대로 브라우저에서 연다. 변환 서버 없이 정적 파일만 쓴다.

- 빌드: `npm run build -w @seuoffice/web`. 결과는 `apps/web/dist/`이고, 첫 빌드는 rhwp 스튜디오를 GitHub에서 받으며 엑셀 엔진을 `wasm32-wasip1`로 빌드한다.
- 미리보기: `npm run preview -w @seuoffice/web` → http://localhost:5300. 파일을 고르거나 끌어 놓으면 열린다.
- 시험: `npm run test -w @seuoffice/web`(Playwright, 빌드 뒤).

## 다른 웹 앱에 붙이기

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

고쳐서 저장하게 하려면 붙이는 쪽이 먼저 그 문서의 편집 잠금을 잡고 `mode: 'edit'`로 연다. 잠금을 못 잡았으면 읽기 모드(기본값)로 연다. 한 문서는 한 사람만 고친다.

```ts
const doc = openDocument(viewer, {
  baseUrl,
  bytes,
  fileName: '회의록.hwpx',
  mode: 'edit',
  // 사용자가 저장하면 같은 형식, 같은 이름의 바이트가 온다. 거절하면 화면에 저장 실패로 보인다.
  onSave: async ({ fileName, bytes }) => uploadNewVersion(fileName, bytes),
  onDirtyChange: (dirty) => setUnsaved(dirty),
})
await doc.save() // 닫기 전에 붙이는 쪽에서 저장을 시킬 때. 실패하면 SeuofficeEmbedError(code: save_failed)
```

잠금은 붙이는 쪽이 가진다(결정 0008). 잠금에 만료 시간을 두고 편집 화면이 열린 동안 연장한다. `onSave`에서는 잠금이 아직 자기 것인지, 열 때 받은 판 위에 저장하는지 확인하고, 아니면 거절한다. 넘겨 달라는 요청이 오면 `doc.save()` 뒤 잠금을 푼다.

여러 사람이 같은 순간에 고치게 하려면 `collab`을 넘기고 공동 편집 서버(`@seuoffice/collab/server`)를 돌린다(결정 0023). 시험 단계다. 형식별로 되는 것, 붙이는 쪽이 할 일, 확인한 것과 아닌 것은 [`docs/seuoffice/공동-편집.md`](docs/seuoffice/공동-편집.md)에 있다.

문서 안 AI 도우미를 켜려면 `ai`를 넘긴다(보기·고치기 둘 다). 페이지는 토큰을 갖지 않는다. AI 한 턴마다 OpenAI Chat Completions 요청 본문(`gateway-complete`, 결정 0009)을 붙이는 쪽에 넘기고, 붙이는 쪽이 자기 로그인 토큰으로 게이트웨이를 불러 응답을 그대로 돌려준다(결정 0017).

```ts
const doc = openDocument(viewer, {
  baseUrl,
  bytes,
  fileName: '회의록.docx',
  mode: 'edit',
  onSave,
  ai: {
    request: (body, signal) =>
      fetch(`${gatewayUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal, // 사용자가 멈추거나 doc.destroy()하면 끊긴다
      }),
  },
})
```

`ai`를 주지 않으면 AI는 "연결 안 됨"으로 보이고 아무 요청도 오지 않는다. AI를 쓸 수 있는 사람에게만 `ai`를 주고, 사람·문서마다 요청 수와 토큰 양을 붙이는 쪽에서 제한한다. 거절은 429 같은 2xx가 아닌 응답으로 돌려주면 페이지가 데스크톱과 같은 문구로 보인다. 응답 머리글은 `Content-Type`과 `Retry-After`만 페이지로 간다. 오류 본문에 토큰을 싣지 않는다. 다섯 형식 모두 웹에서 AI가 돈다. pptx의 AI 편집 도구는 웹에서 `apply_ops` 하나다.

운영에서 지킬 것:

- SeuOffice 쪽 페이지는 CSP에 `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`이 있어야 한다(pdf.js, rhwp, 엑셀 엔진이 WASM과 워커를 쓴다).
- 붙이는 쪽 페이지는 `frame-src`에 SeuOffice 출처를 넣는다.
- 다른 출처에서 문서를 보내려면 SeuOffice를 빌드할 때 `VITE_SEUOFFICE_EMBED_ORIGINS`(쉼표로 구분한 출처 목록)를 준다. 목록에 없는 출처가 보낸 문서는 받지 않는다.
- 파일 크기 상한은 50MiB(`MAX_EMBED_BYTES`)다.
- 정적 파일은 압축해서 보낸다(brotli나 gzip). `application/wasm`과 글꼴(`font/ttf`, `font/otf`)은 서버 기본 압축 목록에 없는 경우가 많으니 직접 넣는다. 압축하지 않으면 한글 문서를 처음 열 때 30.8MB를 받고, brotli면 9.6MB다(`apps/web/README.md`에 형식별 값).

## 소유와 경계

- SeuOffice는 스풋(GitHub SeuPut0705)의 개인 자산이다. 스풋 개인 시간과 비용으로 만들며, 유유헬스케어와의 계약 산출물이 아니다. 유유헬스케어는 SeuOffice를 가져다 쓰는 사용자다.
- 유유헬스케어 저장소(`yuyuhealthcare/yuyu-mos`)의 코드·설정·데이터는 이 저장소에 가져오지 않는다. 유유 실데이터와 고객 원본 문서도 넣지 않는다. 시험은 모의 문서와 권리가 확인된 문서로 한다.
- 유유 메신저·업무 앱에 SeuOffice를 연결하는 코드(첨부를 보기 창에 넘기는 일, 권한 확인)는 yuyu-mos 쪽에 있다. SeuOffice는 "바이트 + 파일 이름 → 화면" 부품(`@seuoffice/embed`)과 정적 웹 묶음을 내놓는다.
- 저장소 전체를 공개한다(`docs/seuoffice/decisions/0007-전부-공개.md`). <FSL_FIRST_VERSION>부터는 오픈 소스가 아니라 소스 공개(FSL-1.1-ALv2)다(`docs/seuoffice/decisions/0031-라이선스-FSL.md`, 초안). 유유헬스케어는 판 번호가 붙은 `@seuoffice/*` 묶음과 유유용 안정 판 PC 프로그램을 받아 쓴다. FSL에서 이 쓰임이 허용 목적에 드는지, 따로 사용 허락 문서가 필요한지는 결정 0031에서 정한다.

## 개발

- Node 22 이상, npm 10 이상. Rust stable(엑셀 엔진), 웹 빌드에는 `wasm32-wasip1` 타깃.
- `npm ci`, 데스크톱 실행 `npm run shell`. 나머지 명령과 작업 규칙은 `AGENTS.md`에 있다.

## 라이선스와 출처

- <FSL_FIRST_VERSION>부터 FSL-1.1-ALv2(`LICENSE`): 경쟁 용도가 아니면 쓰고 고치고 다시 배포할 수 있고, 각 판은 나온 지 2년 뒤 Apache-2.0으로도 쓸 수 있다. 그 전 판과 GenOffice·이음오피스에서 온 부분은 Apache-2.0(`LICENSE-APACHE`). 고지는 `NOTICE`.
- 바탕: 이음오피스 https://github.com/pblsketch/ieumoffice (커밋 aea1414에서 들여옴), 그 원본 GenOffice https://github.com/genspark-ai/genoffice. GenOffice의 `ee/`(Enterprise License)는 포함하지 않는다.
- 한글 엔진 rhwp(MIT, Edward Kim)와 이음오피스 패치판(`vendor/rhwp-core`).
