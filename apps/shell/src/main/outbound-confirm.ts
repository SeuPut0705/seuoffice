import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from 'electron'
import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'
import { OUTBOUND_CHANNELS, confirmRequestOf } from '@genoffice/electron-utils/outbound-channels'

/**
 * The main-process side of the editors' outbound guard (decision 0062):
 * whether "Let AI use internet tools" is on, and the question put to the
 * person before the AI fetches an address that has not appeared in the
 * conversation. Only the person's click allows; a closed dialog, a bad
 * request or a window gone mid-question all answer no.
 */

const en = {
  title: 'AI wants to open a web address',
  body: 'The AI wants to fetch the address below. It has not appeared in this conversation before.',
  warn: 'Hidden text in a document or web page may have told the AI to do this. Block it if the address carries document content or you do not know the site.',
  allow: 'Allow',
  block: 'Block',
}

type Keys = Record<keyof typeof en, string>

export const OUTBOUND_CONFIRM_STRINGS = defineStrings({
  en,
  ko: {
    title: 'AI가 웹 주소에 접속하려고 합니다',
    body: 'AI가 아래 주소를 가져오려고 합니다. 지금까지 대화에 나온 적 없는 주소입니다.',
    warn: '문서나 웹 페이지에 숨은 글이 AI에게 이 일을 시켰을 수 있습니다. 주소에 문서 내용이 담겨 있거나 모르는 사이트라면 막으세요.',
    allow: '허용',
    block: '막기',
  } satisfies Keys,
})

export const outboundConfirmText = createI18n(OUTBOUND_CONFIRM_STRINGS)

/** Characters of one address the dialog shows; the rest is cut with an ellipsis */
const SHOWN_ADDRESS_CHARS = 300

/** The dialog for one question: "Block" is the default and what closing the dialog means */
export function confirmDialogOptions(
  lang: Lang,
  tool: string,
  addresses: string[],
): MessageBoxOptions {
  const t = (key: keyof typeof en) => outboundConfirmText(lang, key)
  const shown = addresses
    .map((a) => (a.length > SHOWN_ADDRESS_CHARS ? `${a.slice(0, SHOWN_ADDRESS_CHARS)}…` : a))
    .join('\n')
  return {
    type: 'warning',
    title: t('title'),
    message: t('body'),
    detail: `${shown}\n\n(${tool})\n\n${t('warn')}`,
    buttons: [t('block'), t('allow')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

export interface OutboundIpcDeps {
  /** ai-settings.json's switch: only an explicit false turns the tools off */
  internetToolsOn(): boolean
  lang(): Lang
  /** the window to put the question over when the caller's own cannot be found */
  window(): BrowserWindow | null
}

export function registerOutboundIpc(deps: OutboundIpcDeps): void {
  ipcMain.handle(OUTBOUND_CHANNELS.internetTools, (): boolean => deps.internetToolsOn())
  ipcMain.handle(OUTBOUND_CHANNELS.confirmAddresses, async (event, raw: unknown) => {
    const request = confirmRequestOf(raw)
    if (!request || !deps.internetToolsOn()) return false
    const parent = BrowserWindow.fromWebContents(event.sender) ?? deps.window()
    const options = confirmDialogOptions(deps.lang(), request.tool, request.addresses)
    try {
      const { response } =
        parent && !parent.isDestroyed()
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options)
      return response === 1
    } catch {
      return false
    }
  })
}
