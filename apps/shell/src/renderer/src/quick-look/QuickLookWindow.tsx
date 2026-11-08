import React, { useEffect, useState } from 'react'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import type { QuickLookPayload } from '../../../shared/quick-look-api'
import { QuickLookView } from './QuickLookView'

export interface QuickLookWindowProps {
  initialLang: Lang
  initialPayload: QuickLookPayload | null
}

export function QuickLookWindow({
  initialLang,
  initialPayload,
}: QuickLookWindowProps): React.JSX.Element {
  const [lang, setLang] = useState<Lang>(initialLang)
  const [payload, setPayload] = useState<QuickLookPayload | null>(initialPayload)
  const [closing, setClosing] = useState(false)
  const [openCycle, setOpenCycle] = useState(0)

  useEffect(() => {
    const api = window.aiOfficeQuickLook
    if (!api) return
    const offUpdate = api.onUpdate((next) => setPayload(next))
    const offWillShow = api.onWillShow(() => {
      setClosing(false)
      setOpenCycle((n) => n + 1)
    })
    const offWillHide = api.onWillHide(() => {
      setClosing(true)
    })
    const offLang = api.onLangChanged((nextLang) => {
      setLang(nextLang)
      document.documentElement.lang = htmlLang(nextLang)
      document.documentElement.dir = htmlDir(nextLang)
    })
    return () => {
      offUpdate()
      offWillShow()
      offWillHide()
      offLang()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault()
        setClosing(true)
        void window.aiOfficeQuickLook?.close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        setClosing(true)
        void window.aiOfficeQuickLook?.openInEditor()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <QuickLookView
      key={openCycle}
      lang={lang}
      payload={payload}
      standalone
      closing={closing}
      onOpenInEditor={() => {
        setClosing(true)
        void window.aiOfficeQuickLook?.openInEditor()
      }}
      onRevealInFolder={() => {
        void window.aiOfficeQuickLook?.revealInFolder()
      }}
      onClose={() => {
        setClosing(true)
        void window.aiOfficeQuickLook?.close()
      }}
    />
  )
}
