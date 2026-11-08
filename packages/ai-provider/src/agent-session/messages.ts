/**
 * What a program is told when the app or the person turns an action down.
 * These go to the model, not to the screen, so they are English and say what
 * to do instead.
 */
import type { AgentDenyReason } from './types'

export const DECLINED_BY_PERSON =
  'The person declined this action. Do not try it again in another way; ask them what to do instead.'

export function denyMessage(reason: AgentDenyReason): string {
  switch (reason) {
    case 'open-document':
      return 'This file is open in the office app, which holds its current state. Do not write the file; change it with the ieumoffice-editor tools instead.'
    case 'outside-project':
      return 'Files outside the project folder cannot be written in this session. Write inside the project folder instead.'
    case 'protected-path':
      return 'This location is protected (sign-in data or app data) and cannot be used in this session.'
  }
}
