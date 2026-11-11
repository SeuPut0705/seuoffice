---
name: hwp-document
description: 'Write a new Hangul (.hwp / .hwpx) document from a request, notes or source material: settle what kind of document it is and who reads it, lay out its parts, write it in the register Korean documents use, build it with the editor tools in the right order, then check the result. Use for reports, plans, notices, official letters, minutes and proposals written from scratch.'
metadata:
  ieum-editors: hwp
---

# Writing a Hangul document

For a document written **from scratch** (or a large new part of one). Filling in a form that is already there needs no skill: read the table and fill it. When the user asks for the Ministry of the Interior and Safety report format (행안부 형식), use `administration-report-draft` instead.

The tool names below are those of the Hangul editor's AI panel. In another window, do the same steps with the tools that window gives you.

## 1. Settle four things first

Take them from the request and the attachments. Ask only for what is missing and matters, in one question; otherwise choose a sensible default and say in your reply what you assumed.

| Decide | Why it matters |
| --- | --- |
| Kind of document | Fixes the parts and their order (section 2) |
| Reader | Inside the organisation → terse items (개조식). Outside it (residents, customers, members) → full polite sentences (서술식) |
| Length | One page is the default for a notice or a report to a superior. Go longer only when the material needs it |
| Material | The facts, dates, names and figures to use. Nothing else may appear as a fact |

## 2. Lay out the parts

| Kind | Parts, in order |
| --- | --- |
| 보고서 (report) | 제목 → 개요(목적·배경) → 현황 및 문제점 → 추진 내용 또는 분석 → 향후 계획 → 붙임 |
| 계획서 (plan) | 제목 → 목적 → 방침 → 세부 추진 계획(일정·담당은 표) → 소요 예산(표) → 기대 효과 → 행정 사항 |
| 안내문 (notice) | 제목 → 인사 한 문단 → 안내 사항(일시·장소·대상·준비물) → 유의 사항 → 문의처 → 날짜 → 발신 명의 |
| 공문 (official letter) | 수신 → (경유) → 제목 → `1. 관련: …` → `2.` 본문 → `붙임  1. ○○ 1부.  끝.` |
| 회의록 (minutes) | 회의명 → 일시·장소·참석자(표) → 안건 → 논의 내용 → 결정 사항 → 향후 일정(담당·기한은 표) |
| 제안서 (proposal) | 제목 → 제안 배경 → 제안 내용 → 추진 방법·일정 → 소요 예산 → 기대 효과 |

Leave out a part the material has nothing for; never pad one. A document in another language keeps the same tools and follows that language's own conventions (numbered headings, full sentences).

## 3. Write in the document register

- **Title:** a short noun phrase naming the matter, with no sentence ending: `2026년 상반기 직원 연수 운영 계획`, `○○ 사업 추진 결과 보고`.
- **One sentence style per document.** 개조식 ends lines in nouns or `~함`, `~임`, `~예정`; 서술식 ends in `~합니다`, `~바랍니다`. Do not mix them at the same level.
- **Level marks are typed as text, one scheme for the whole document:** `□ → ○ → - → ·`, or `1. → 가. → 1) → 가) → (1) → (가) → ①`. Never skip a level, never use two marks at one depth. Indent each level two spaces more than the level above it.
- **One line says one thing.** Three or more parallel items that each have two or more attributes (who, when, how much) become a table, not a long line.
- **Dates and figures:** `2026. 11. 11.(수)`, `14:00~16:00`, `1,200천원`, with the unit named. Every figure comes from the material; a value you do not have is written `○○` and listed in your reply.
- **Emphasis is rare:** bold for the title and the part headings only, unless the user asks for more.

## 4. Build it in this order

1. **All the text first.** Put the title and every part into the document with `insert_paragraphs` (`where: "end"` on an empty document), in as few calls as possible: one call takes up to 100 paragraphs, each paragraph is one line, and `""` is an empty line. Put one empty line between top-level parts, none inside a part.
2. **Tables after the text.** Write a caption line above the place (`<표 1> 세부 추진 일정`), then `insert_table` with that line as the `anchor`, `where: "after"` and `header: true`. Keep to six columns or fewer on a portrait page, name units in the header row, and keep each cell to a short phrase. Then call `check_layout`; if a cell overflows, shorten its text.
3. **Looks last, and only for the text you wrote in this request.** Centre the title and make it bold and larger (16 to 20 pt); make part headings bold. When the context lists a paragraph style made for titles or headings, apply it instead of setting values one by one, but not a style that numbers its paragraphs (an outline style such as 개요 1) on a line whose level mark you typed: the number would show twice. Right-align the date and sender lines of a notice. Leave the body text as it came out.
4. **Extras only when the user wants them:** for a document of about five pages or more, offer a table of contents in your reply and add it with `insert_toc` only on a yes; use `insert_note` for a source the text cites when the user asked for sources. Change the page setup only when the user asks.

## 5. What the tools cannot make

Headers and footers, page numbers, columns, borders around paragraphs or pages, table border lines, and an approval box (결재란) placed and sized like a real one: the tools add a plain table where the text flows, they cannot put it in a corner or fix its size. Say that the user adds these in the editor. Do not fake them: no 1×1 table as a title box, no line drawn with repeated `─` characters, no page number typed at the bottom.

## 6. Check before you answer (required)

Read the document once with `read_document` and go through this list. Fix what fails, then answer.

- Every planned part is there, in order, and none appears twice.
- Level marks follow one scheme with no skipped level; lines at the same depth start at the same indent.
- One sentence style throughout.
- No markdown left in the text (`#`, `**`, table pipes).
- Every date, name and figure is in the user's material; each `○○` is listed in your reply.
- Each table has a caption line above it and a header row, and `check_layout` reports no overflow.

In your reply say in a few lines what you wrote (the parts and roughly how many pages), what you assumed, which `○○` places are left and what belongs in each, and what the user has to add by hand (page numbers, a header, an approval box).
