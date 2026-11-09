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

라이선스: Apache-2.0. 저장소: https://github.com/SeuPut0705/seuoffice
