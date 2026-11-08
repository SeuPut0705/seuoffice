import type { zh } from './zh'

export const en = {
  contextConfirm:
    'This request is close to the model’s context limit: about {estimated} of {limit} tokens ({percent}%). Send it anyway?',
  contextUnknown: 'The model’s context size could not be confirmed; {limit} tokens are assumed.',
  toolsUnsupported:
    'This model does not support tool calls. It will suggest text only and will not edit the document.',
  errContextLimit:
    'Nothing was sent: the request is close to the model’s context limit. Split it into smaller requests and try again.',
} satisfies Record<keyof typeof zh, string>
