# 상위 파일 편집 목록

이음오피스에서 들여온 파일을 고친 기록이다. 이음 따라잡기 때 이 목록과 대조해 우리 편집을 다시 적용한다. 커밋 칸에는 해시 대신 그 편집을 담은 커밋 제목을 적는다.

| 파일                                        | 까닭                                                                                                          | 커밋 제목                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `.github/workflows/growth.yml`(삭제)        | 상위 프로젝트 운영용. 매시간 이 저장소에 커밋하고 비공개 Actions 시간을 쓴다                                  | chore: adapt the imported tree to seuoffice         |
| `.github/workflows/free-models.yml`(삭제)   | 상위 프로젝트 운영용 주간 작업                                                                                | chore: adapt the imported tree to seuoffice         |
| `.github/CODEOWNERS`                        | 검토자를 `@pblsketch`에서 `@SeuPut0705`로                                                                     | chore: adapt the imported tree to seuoffice         |
| `tools/check-no-genspark.mjs`               | `ALLOW`에 `docs/seuoffice/`와 인계 문서 항목 추가(상위 프로젝트 이름과 주소를 인용하는 기록)                  | chore: adapt the imported tree to seuoffice         |
| `NOTICE`                                    | 끝에 seuoffice 수정 고지 단락 추가                                                                            | chore: adapt the imported tree to seuoffice         |
| `apps/markdown/tests/source-splice.test.ts` | `git ls-files`를 `core.quotepath=off`로 읽게 함. seuoffice의 한글 파일 이름이 따옴표로 감싸져 시험이 실패했다 | test(markdown): read repository paths unquoted      |
| `.prettierignore`                           | 인계 문서(`docs/인계-2026-11-08.md`)를 받은 그대로 두려고 포맷 검사에서 뺌                                    | docs: format the seuoffice records for format:check |
