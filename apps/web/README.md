# @seuoffice/web

seuoffice를 브라우저에서 돌리는 정적 파일 묶음이다. 패키지에는 빌드 결과인 `dist/`만 들어 있다. 호스트는 `dist/` 안의 파일을 그대로 한 주소(`baseUrl`) 아래에 서빙한다. 서버 코드는 필요 없다.

```sh
# 설치는 @seuoffice/embed README처럼 GitHub 릴리스 주소로 한다(npm 레지스트리에는 없다)
# dist/ 를 호스트의 정적 경로로 복사하거나 그대로 서빙한다. 예:
cp -r node_modules/@seuoffice/web/dist ./public/seuoffice
```

호스트 화면에서는 `@seuoffice/embed`의 `openDocument`로 문서를 연다. `baseUrl`에는 `dist/`를 서빙하는 절대 주소(예: `https://호스트/seuoffice/`)를 넘긴다. 사용법은 `@seuoffice/embed` README를 본다.

- 두 패키지는 항상 같은 판을 쓴다. 호스트는 정확한 판 번호로 고정한다.
- `dist/index.html`은 파일을 직접 열어 보는 시험용 런처다. 호스트 화면에 쓰는 것은 `dist/<앱>/` 아래 페이지(`docs`, `sheets`, `slides`, `pdf`, `hwp`)이고, `@seuoffice/embed`가 주소를 알아서 만든다.

## 압축해서 보내기

`dist/`의 파일은 압축해서 보내야 한다. 처음 여는 데 걸리는 시간은 거의 받는 바이트가 정한다. 아래는 빈 캐시에서 문서 하나를 처음 열 때 받는 양이다(2026-11-10, v0.12.18 빌드, Chromium으로 잼. brotli 값은 받은 파일을 brotli로 눌러 계산).

| 형식 | 압축 없이 | brotli |
| ---- | --------- | ------ |
| hwpx | 30.8 MB   | 9.6 MB |
| xlsx | 16.9 MB   | 4.6 MB |
| docx | 10.7 MB   | 4.5 MB |
| pptx | 9.0 MB    | 2.7 MB |
| pdf  | 5.7 MB    | 1.6 MB |

- 서버의 압축 대상에 `application/wasm`, `text/javascript`, `text/css`, `application/json`, `text/plain`, `font/ttf`, `font/otf`를 넣는다. 많은 서버의 기본 목록에는 wasm과 글꼴이 없다(nginx `gzip_types`, `vite preview`도 wasm과 ttf는 압축하지 않는다). 한글 엔진 wasm 하나가 25.6MB라서, 이것이 빠지면 표의 왼쪽 값이 된다.
- CDN이 큰 파일을 자동 압축하지 않으면(파일 크기 상한이 있는 곳이 있다) 올리기 전에 미리 압축해 `Content-Encoding`을 붙인다.
- 확인: 브라우저 개발자 도구의 네트워크 탭에서 `rhwp_bg-*.wasm`의 응답 머리글에 `content-encoding: br`(또는 `gzip`)이 있는지 본다.

라이선스: FSL-1.1-ALv2(소스 공개, 판마다 2년 뒤 Apache-2.0), GenOffice·이음오피스에서 온 부분은 Apache-2.0. 저장소: https://github.com/seuput-inc/seuoffice
