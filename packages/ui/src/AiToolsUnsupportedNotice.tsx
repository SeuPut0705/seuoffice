import React from 'react'
import type { Lang } from '@genoffice/i18n'
import { aiContextText } from './strings-ai-context'
import './ai-subscription.css'

/**
 * Shown when the selected model reported that it cannot call tools: answers are
 * text-only, so nothing in the document will change. The app renders it only
 * for such a model (or when it has not reported); this part never guesses.
 */
export function AiToolsUnsupportedNotice({ lang }: { readonly lang: Lang }): React.JSX.Element {
  return (
    <div className="ai-sub-notice" role="note">
      <p className="ai-sub-notice-text">{aiContextText(lang, 'toolsUnsupported')}</p>
    </div>
  )
}
