import { describe, expect, it } from 'vitest'
import { redactHtmlSource } from '@genoffice/file-parse'
import { MARK_ATTR, MARK_ATTR_PREFIX, buildProjection } from '../src/renderer/ai/redact'
import { buildParseMap } from '../src/renderer/document/parse-map'

/**
 * A page read as another file's material (attachment, knowledge base, search
 * index) goes through `@genoffice/file-parse`, which cannot import this app and
 * so restates the withholding rules. This holds the two together: for a page
 * whose marks can be read, the text handed to another conversation is exactly
 * the view this editor hands its own model.
 */

const editorView = (html: string) => buildProjection(html, buildParseMap(html, 1, null)).view

const LABEL = 'API key'
const SECRET = 'sk-ABC123'

const PAGES: Array<[string, string]> = [
  ['nothing withheld', '<p>Hello</p><img src="logo.png">'],
  ['visible text', `<p>Call <span ${MARK_ATTR}="${LABEL}">13800138000</span> now</p>`],
  [
    'an attribute value',
    `<img src="https://cdn.example.com/logo.png" alt="company logo" ${MARK_ATTR_PREFIX}src="${LABEL}">`,
  ],
  [
    'an attribute named inside another value',
    `<img src="secret.png" alt="src= not this" ${MARK_ATTR_PREFIX}src="logo">`,
  ],
  ['a single-quoted attribute', `<img src='secret.png' alt='logo' ${MARK_ATTR_PREFIX}src='brand'>`],
  ['an unquoted attribute', `<img src=secret.png alt=logo ${MARK_ATTR_PREFIX}src=brand>`],
  ['a mark for an absent attribute', `<img src="a.png" ${MARK_ATTR_PREFIX}href="${LABEL}">`],
  [
    'a script literal',
    `<script>const KEY = /*gx:redact:${LABEL}*/ "${SECRET}"; render(KEY);</script>`,
  ],
  [
    'a single-quoted script literal',
    `<script>const K = /*gx:redact:${LABEL}*/ '${SECRET}';</script>`,
  ],
  [
    'a template literal over several lines',
    `<script>const K = /*gx:redact:${LABEL}*/ \`${SECRET}\n${SECRET}\`;\nrun()</script>`,
  ],
  [
    'a script mark spelled in ordinary text',
    `<p>literal /*gx:redact:${LABEL}*/ "${SECRET}" in a paragraph</p>`,
  ],
  [
    'two spans',
    `<p><span ${MARK_ATTR}="one">AAAA</span> mid <span ${MARK_ATTR}="two">BBBB</span></p>`,
  ],
  [
    'a withheld element holding another',
    `<div ${MARK_ATTR}="address"><p>1 Main St</p><span ${MARK_ATTR}="zip">02139</span></div><p>after</p>`,
  ],
  [
    'an element and one of its own attributes',
    `<a href="https://x.example/t/${SECRET}" ${MARK_ATTR_PREFIX}href="link" ${MARK_ATTR}="name">Jane</a>`,
  ],
  [
    'an element closed by the next one',
    `<ul><li ${MARK_ATTR}="first">secret one<li>public two</ul>`,
  ],
  [
    'a whole document over several lines',
    [
      '<!doctype html>',
      '<html><head>',
      `<meta name="token" content="tok-999" ${MARK_ATTR_PREFIX}content="token">`,
      `<script>const K = /*gx:redact:${LABEL}*/ "${SECRET}";</script>`,
      '</head><body>',
      `<table><tr><td ${MARK_ATTR}="salary">5,000</td><td>public</td></tr></table>`,
      `<template><p ${MARK_ATTR}="draft">unpublished</p></template>`,
      '</body></html>',
    ].join('\n'),
  ],
  ['a label a comment could not carry', `<b ${MARK_ATTR}="a*/b {x}">hidden</b>`],
]

describe('a page read as another file’s material matches the editor’s own model view', () => {
  for (const [name, html] of PAGES) {
    it(name, () => {
      expect(redactHtmlSource(html)).toBe(editorView(html))
    })
  }
})

describe('where the cross-file read is stricter than the editor', () => {
  // each of these withholds nothing in the editor, which only ever shows the
  // page to the reader's own model; read for another conversation, a mark that
  // names something and hides nothing fails the read instead
  const STRICTER: Array<[string, string]> = [
    ['a mark written without a value', `<span ${MARK_ATTR}>${SECRET}</span>`],
    ['a mark in upper case', `<span ${MARK_ATTR.toUpperCase()}="${LABEL}">${SECRET}</span>`],
    ['a script mark with no literal after it', `<script>/*gx:redact:${LABEL}*/ render();</script>`],
  ]
  for (const [name, html] of STRICTER) {
    it(name, () => {
      expect(editorView(html)).toBe(html)
      expect(() => redactHtmlSource(html)).toThrow(/redaction/i)
    })
  }
})
