/**
 * The editor's wiring of the document overview: one `DocumentInsights` per
 * tab over the shell's store and structure channels, read when the open file
 * is ready and when the UI language changes. Reading never sends anything.
 * After an in-app save the editor calls `load()` again (after the store
 * migration), so an overview the store did not carry over shows as stale.
 */
import { useEffect, useMemo, useRef } from 'react'
import { DocumentInsights } from './insights-controller'

export function useDocumentInsights(o: {
  filePath: string
  password: string | undefined
  /** the UI language: the overview is written and kept in it */
  lang: string
  /** the document is loaded (an encrypted one only after its password) */
  ready: boolean
  /** bumped when the open file was rewritten in place under the same path (a page operation) */
  revision?: number
}): DocumentInsights {
  const live = useRef(o)
  live.current = o
  const insights = useMemo(
    () =>
      new DocumentInsights({
        store: window.pdfApi?.store ?? null,
        structure: window.pdfApi?.structure ?? null,
        file: () => {
          const { filePath, password } = live.current
          return filePath
            ? { path: filePath, ...(password !== undefined ? { password } : {}) }
            : null
        },
        lang: o.lang,
      }),
    // one per tab; the live values are read through the ref
    [],
  )
  useEffect(() => {
    if (o.ready && o.filePath) void insights.load()
  }, [insights, o.ready, o.filePath, o.revision])
  useEffect(() => {
    void insights.setLang(o.lang)
  }, [insights, o.lang])
  return insights
}
