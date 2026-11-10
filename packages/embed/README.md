# @seuoffice/embed

호스트 웹앱이 문서(docx, xlsx, pptx, pdf, hwp, hwpx)를 seuoffice iframe 안에 열게 해 주는 작은 라이브러리. 문서 바이트와 파일명만 넘기면 된다.

seuoffice 웹 묶음(`@seuoffice/web`)을 호스트가 직접 정적 파일로 서빙하고, 그 주소를 `baseUrl`로 넘긴다. 이 패키지는 그 웹 묶음과 같은 버전을 쓴다. 호스트는 두 패키지를 같은 정확한 버전으로 고정한다.

```sh
# 안정 판 하나를 골라 같은 판의 두 묶음을 릴리스 주소로 설치한다(npm 레지스트리에는 없다)
V=0.12.15
npm install \
  https://github.com/SeuPut0705/seuoffice/releases/download/v$V/seuoffice-embed-$V.tgz \
  https://github.com/SeuPut0705/seuoffice/releases/download/v$V/seuoffice-web-$V.tgz
```

## 보기

```ts
import { openDocument } from '@seuoffice/embed'

const doc = openDocument(container, {
  baseUrl: `${location.origin}/seuoffice/`, // @seuoffice/web 의 dist/ 를 서빙하는 절대 주소
  bytes, // ArrayBuffer | Uint8Array
  fileName: 'report.docx',
})
await doc.opened // 문서가 화면에 뜨면 끝, 실패하면 SeuofficeEmbedError
doc.destroy()
```

## 고치기

호스트가 그 문서의 편집 잠금을 먼저 잡은 다음 `mode: 'edit'`로 연다. 저장은 `onSave`가 맡는다. 호스트가 바이트를 저장하면 resolve하고, 저장하지 못하면 이유와 함께 reject한다.

```ts
const doc = openDocument(container, {
  baseUrl: `${location.origin}/seuoffice/`,
  bytes,
  fileName: 'report.docx',
  mode: 'edit',
  onSave: async ({ fileName, bytes }) => {
    await uploadToServer(fileName, bytes) // 실패하면 throw
  },
  onDirtyChange: (dirty) => setUnsaved(dirty),
})

await doc.save() // 페이지에 저장을 요청한다
```

## AI

`ai`를 넘기면 문서 안 AI 도우미가 켜진다. 보기·고치기 둘 다 된다. 페이지는 토큰을 갖지 않는다. AI 한 턴마다 OpenAI Chat Completions 요청 본문(`gateway-complete`, 결정 0009)을 호스트에 넘기고, 호스트가 자기 토큰을 붙여 게이트웨이를 부른 뒤 응답을 돌려준다. SSE 본문은 그대로 페이지로 흘러간다.

```ts
const doc = openDocument(container, {
  baseUrl: `${location.origin}/seuoffice/`,
  bytes,
  fileName: 'report.docx',
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

- 2xx가 아닌 응답은 상태 번호와 본문이 페이지로 가서 데스크톱과 같은 오류 문구가 된다. 거절할 때는 429 같은 응답을 돌려주면 된다. 본문에 토큰을 싣지 않는다.
- `ai`를 주지 않으면 페이지는 "AI 연결 안 됨"을 보이고 아무것도 보내지 않는다. AI를 쓸 수 없는 사람에게는 넘기지 않는다.
- 요청 수와 토큰 양 제한은 호스트가 한다. 도구를 부를 때마다 요청이 하나 더 온다.
- 응답 머리글은 `Content-Type`과 `Retry-After`만 페이지로 간다. 혼잡 응답에 `Retry-After`를 20초보다 길게 주면 페이지는 다시 보내지 않는다.

## 함께 고치기

`collab`을 넘기면 여러 사람이 같은 문서를 동시에 고친다. 보기·고치기 둘 다 된다. 공동 편집 서버와의 WebSocket은 호스트가 연다. 호스트가 자기 인증으로 연결을 만들고, 이 패키지는 페이지와 그 소켓 사이에서 프레임을 그대로 나른다. 페이지는 문서 주소나 토큰을 모른다.

```ts
const doc = openDocument(container, {
  baseUrl: `${location.origin}/seuoffice/`,
  bytes,
  fileName: 'report.docx',
  mode: 'edit',
  collab: {
    connect: () => new WebSocket(`${collabUrl}?doc=${documentId}`), // 열리기 전의 소켓을 바로 돌려준다
    onStatus: (status) => showPeers(status.peers),
  },
  onSave: async ({ fileName, bytes, version }) => {
    await uploadToServer(fileName, bytes, version) // bytes는 정확히 version 판이다
  },
})

if (!(await doc.collabCapable)) {
  // 이 앱은 아직 함께 고치기를 못 한다: 닫고 편집 잠금을 잡은 뒤 collab 없이 다시 연다
}
```

- 편집 잠금은 잡지 않는다. 같은 문서를 연 사람은 모두 같은 서버에 붙는다.
- `connect()`는 페이지가 연결을 원할 때마다 불린다. 끊긴 뒤 다시 붙을 때도 불리고, 그때 이전 소켓은 닫힌다. `connect()`가 실패하거나 소켓에 오류가 나면 페이지는 끊긴 것으로 보고 다시 시도한다.
- `onSave`는 `version`을 함께 받는다. 그 판보다 오래된 판이 나중에 와도 덮어쓰지 않으려면 호스트가 판 번호를 비교한다.
- `doc.collabCapable`은 페이지가 `ready`에서 알린 값이다. `false`면 그 앱은 함께 고치기를 못 하니 잠금 방식으로 연다.
- `doc.destroy()`는 소켓도 닫는다. `collab`을 주지 않으면 공동 편집 메시지는 하나도 오가지 않는다.

## 오류

`SeuofficeEmbedError.code`: `unsupported_format`, `too_large`(50 MB 초과), `open_failed`, `timeout`, `save_failed`.

## 라이선스

Apache-2.0. 저장소: https://github.com/SeuPut0705/seuoffice
