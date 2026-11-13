# FSL 준비 인계 (2026-11-13, 맥미니 디스크가 차서 멈춤)

이 파일과 `fsl-handoff/`는 인계용이다. 일을 마치면 지운다. `fsl-handoff/*.md`는 하위 에이전트(scout)의 감사 원본이고 영어·일본어가 섞여 있어 `check:english-comments`에 걸릴 수 있다. `docs/seuoffice/라이선스-감사.md`로 한국어로 다시 써서 옮긴 뒤 지운다(결정 0031 초안이 그 경로를 가리킨다).

## 가지

- `chore/license-gate` = 커밋 `24637d6c7` (푸시함). Apache에서도 쓸모 있는 관문이라 main에 먼저 합칠 수 있다. **CI는 아직 한 번도 안 돌았다**(GitHub API 한도 초과). `gh workflow run ci.yml --ref chore/license-gate`로 돌리고 `rust-licenses` job을 본다.
  - 뿌리 `deny.toml`(licenses + bans). xlsx-engine, xlsx-wasm, rhwp(wasm32, `--exclude-dev`, vendor 패치 적용 뒤)를 `ci.yml`의 새 job `rust-licenses`가 검사. `crates/`가 있으면 `crates/deny.toml`로 검사.
  - `tools/build-rhwp-core.mjs --source-only`(feat/rust-fileparse-d3에 있는 것과 같은 내용. 그 가지가 먼저 합쳐지면 충돌 없이 같은 줄).
  - `tools/asset-licenses.json` + `tools/check-asset-licenses.mjs`(`npm run licenses`에 연결). 로컬에서 통과(523개 자산, 46항목), 항목을 빼면 실패하는 것 확인.
  - 예상 위험: rhwp 그래프에서 IJG 외 다른 라이선스나 bans(wildcard)가 걸릴 수 있다. 그러면 `deny.toml`에 근거와 함께 크레이트별 예외를 둔다.
- `chore/fsl-prep` = 위 커밋 + `b036c1d14`(LICENSE→FSL 원문, `LICENSE-APACHE`, NOTICE 끝 단락, license 필드 47개 + lockfile + Cargo 2개, 설치본·npm·CLI 묶음에 LICENSE-APACHE 싣기, About·온보딩 문구, README 둘, AGENTS.md·CLAUDE.md) + 이 인계 커밋(결정 0031 초안 포함). 합치지 않는다.
- `chore/remove-genoffice-branding`: 다른 세션(GenOffice 제거)이 작업. 그 세션의 마지막 커밋이 인계 시점의 것이다.

## 남은 일

1. `chore/license-gate` CI 돌려 녹색으로 만들기.
2. `chore/fsl-prep`: CI(`CI`, `seuoffice`) 돌리기. 바꾼 시험: `apps/shell/tests/{third-party-notices,onboarding,settings-about}.test.ts`, `packages/cli/tests/{pack-tarball,home-and-launcher.old-names}.test.ts`. 로컬에선 돌리지 않았다.
3. `docs/seuoffice/라이선스-감사.md` 작성(아래 요약 + `fsl-handoff/`), 결정 `index.md`에 0031 한 줄, `로드맵.md` 1.5단계의 "Apache-2.0으로 공개" 줄에 0031 초안 표시.
4. 웹 사이트 문구: 저장소 안에서 별도 웹사이트를 찾지 못했다. 앱 도움말 `apps/shell/src/renderer/src/i18n/help/topics/{install,settings-integrations}.*.md`의 "오픈 소스 프로젝트"는 GenOffice를 가리키는 것이라 그대로 뒀다. `setLicenses`("오픈소스 라이선스")는 제3자 라이선스 목록이라 그대로 뒀다.
5. 메인 세션에 보고(d1, d2): 아래 표와 "스풋이 정할 것".

## 감사 요약 (blocked 0)

| 범위 | fine | 법률 검토 필요 | blocked |
|---|---|---|---|
| npm 출하 의존성 549 | 543 | 6: `@univerjs/telemetry`·`khroma`(lock에 license 없음, 수동 예외), `jszip`(MIT OR GPL-3), `dompurify`(MPL-2.0 OR Apache), `node-forge`(BSD-3 OR GPL-2, devDependency인데 apps/pdf에 묶여 출하), 묶인 wasm(pdfium FreeType/AGG, canvaskit) | 0 |
| Rust main(xlsx-engine, xlsx-wasm) | 약 100 | `r-efi`(MIT OR Apache OR LGPL, UEFI 전용이라 출하 안 될 것) | 0 |
| Rust 가지 crates/ | 나머지 | `crates/mtx` MPL-2.0(libeot 이식, PATENTS 파일), `ported` 선언이 file-parse에만 있음(ooxml-*, saxes, epub-engine은 이식인데 선언 없음), rhwp IJG·GUST·DejaVu·URW 메트릭 | 0 |
| vendor | | `vendor/rhwp-core`(MIT + IJG 등), `vendor/drawio`(Atlassian 사용 제한 문구, ELK EPL·libavoid LGPL 잘라냄 승인됨, CC-BY-4.0 템플릿, OFL 글꼴), `packages/docx-engine/src/vendor/emf-converter`(Apache §4(b) 변경 고지), `packages/pptx-engine/src/vendor/mtx`(MPL-2.0, main에서 출하 중) | 0 |
| 글꼴·그림·스킬·자료 48행 | 26 | 22: Carlito GO(OFL RFN "Carlito"가 이름에 남음), Noto Serif KR 변환본 이름 유지, Aptos/Century Gothic/David/Bookman GO(다른 회사 글꼴 이름), 태국어 글꼴 두 벌이 THIRD-PARTY-NOTICES에서 빠짐, 웹 묶음에 THIRD-PARTY-NOTICES 없음(OFL 전문 미동봉), Lucide ISC/MIT 허가문 전문 없음, k-slide, 출처 기록 없는 GenOffice 시절 그림(send-*/attach/icon-*/textures 8/도움말 스크린샷 7, 모두 GenOffice 공개 이력에서 왔음 확인), 스킬 안 Microsoft/ECMA XSD, libhangul 한자 사전 | 0 |

FSL 원문의 제3자 관련 조항: FSL은 "Software"(Licensor가 이 조건으로 내놓은 것)에만 적용되고 제3자 구성요소를 따로 다루지 않는다. Redistribution 조항은 "copyright notices provided in or with the Software"를 지우지 말라고만 한다. 제3자 라이선스 의무는 그대로 남는다(해석은 법률 검토).

지켜야 하는 고지(Apache §4): (a) 라이선스 사본 → `LICENSE-APACHE`를 모든 묶음에 싣는다(이번 커밋). (b) 바꾼 파일의 눈에 띄는 변경 고지 → 원본 파일의 변경 표시, `docs/seuoffice/upstream-edits.md`, emf-converter README, BookmanOldStyleGO(README에만 있음 → 법률 검토). (c) 원본 파일 안의 저작권·특허·상표·출처 고지 → 소스 파일 머리말 그대로. (d) NOTICE → 276줄 전부 그대로, 끝에 FSL 단락만 더함. 상표(§6): GenOffice 이름은 출처 표시에만.

## 기여자

- 커밋 4758. GenOffice 공개 이력(`438d9c657`까지) 917, 이음오피스 이력 3951(겹침 포함, 이음 tip `aea1414` `bad01df0e` `2b5293d9a` `3624c15ee`), seuoffice 고유 807.
- pblsketch 2321(전부 이음오피스), ANIRUDDHA ADAK 653(GenOffice 606, 이음 28, seuoffice 19), SeuPut 742(seuoffice 490, 이음 252) + 최진서 156(seuoffice, 같은 사람의 로컬 이름), tokg 339(GenOffice 145, 이음 116, seuoffice 78), Neosiki 102 + YoungShig Yoon 36(같은 사람, 전부 이음).
- seuoffice 고유 커밋 중 스풋 아닌 23명의 161개는 모두 SeuPut이 커밋했고 제목에 GenOffice PR 번호(#NNNN)가 있다. GenOffice 마지막 따라잡기(`sync/genoffice-20261111`, `fix/genoffice-followups-*`)에서 가져온 GenOffice 기여다. seuoffice에 직접 PR을 보낸 외부 기여자는 없다.
- CLA·DCO: 어느 단계에도 없다. Signed-off-by는 ANIRUDDHA 8개뿐. CONTRIBUTORS.md는 이음오피스 시절 목록.
- Apache-2.0 4조: 4(a)~(d)를 지키면 파생물 전체에 다른 조건을 붙일 수 있다고 적혀 있다. 이것으로 GenOffice·이음 기여자 코드를 품은 파생물을 FSL로 내기에 충분한지는 **법률 검토 필요**. 5조(기여는 별도 조건 없으면 Apache 조건) 때문에 위 161개도 Apache로 들어온 것으로 보이나 역시 **법률 검토 필요**.

## GenOffice 잔존량 (d2fe8ddaa → origin/main 07a251652, `git diff -M --numstat`)

- d2fe8ddaa: 파일 994(`ee/` 2개 제외 992), 줄 431,607. 남은 파일 957, 원본에서 바뀌지 않고 남은 줄 280,230, 지워진 파일 35(17,770줄), 하나도 안 바뀐 파일 187.
- 출하 코드(TS/JS/CSS/HTML/Rust, 시험 제외) 원본 275,796줄:
  - TS로 남음, Rust 이식 없음: 397파일, 원본 235,242줄 중 118,365줄 남음
  - TS로 남음, 가지에 Rust 이식 있음(packages/docx-engine, pptx-engine, file-parse): 63파일, 25,266줄 중 20,782줄 남음
  - GenOffice가 쓴 Rust(xlsx-engine 7파일): 6,536줄 중 2,128줄 남음
  - 지워짐: 23파일, 8,752줄
- 비교: 지금 main의 apps+packages 출하 소스는 3,524파일 1,166,978줄.
- 다시 재려면: `git diff -M --numstat d2fe8ddaa origin/main`, 원본 줄 수는 `git grep -c '' d2fe8ddaa`. 이식이 원본의 파생물인지는 법률 검토.

## 스풋이 정할 것

- Licensor 이름: 개인(SeuPut/최진서)인가 회사인가. `LICENSE`의 `<LICENSOR>`, NOTICE 끝 단락.
- 어느 판이 "완성"인가: `<FSL_FIRST_VERSION>`, `<FSL_FIRST_COMMIT>`, `<YEAR>`.
- 유유헬스케어 쓰임이 FSL 허용 목적인지, 따로 허락 문서를 줄지(0007의 "허락 문서 없음"을 바꿈).
- 법률 검토 질문 목록: 결정 0031 초안 "법률 검토가 답할 것".
