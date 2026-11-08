# @seuoffice/embed

호스트 웹앱이 문서(docx, xlsx, pptx, pdf, hwp, hwpx)를 seuoffice iframe 안에 열게 해 주는 작은 라이브러리. 문서 바이트와 파일명만 넘기면 된다.

seuoffice 웹 묶음(`@seuoffice/web`)을 호스트가 직접 정적 파일로 서빙하고, 그 주소를 `baseUrl`로 넘긴다. 이 패키지는 그 웹 묶음과 같은 버전을 쓴다. 호스트는 두 패키지를 같은 정확한 버전으로 고정한다.

```sh
npm install @seuoffice/embed @seuoffice/web
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

## 오류

`SeuofficeEmbedError.code`: `unsupported_format`, `too_large`(50 MB 초과), `open_failed`, `timeout`, `save_failed`.

## 라이선스

Apache-2.0. 저장소: https://github.com/SeuPut0705/seuoffice
