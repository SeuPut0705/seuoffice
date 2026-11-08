import type { zh } from './zh'

export const en = {
  noticeText:
    'Skills are now turned on and off in Settings → Skills. Skills in the Claude and Codex skill folders start turned off.',
  noticeOpenSettings: 'Open Settings',
  noticeClose: 'Close',
  nextSession: 'Changed skills apply from the next session',
  templateLabel: 'Document to save as the template',
  templateNone: 'No template',
  templateFromTab: 'Open in a tab',
  templateFromProject: 'Project folder',
  templateUnsaved: 'This tab has unsaved changes. The saved file becomes the template.',
  templateChecking: 'Checking for withheld content…',
  templateUnknown:
    'For this format the app cannot tell here whether anything is withheld, so it cannot be saved as it is. Make a blank template and save that instead.',
  templateTooLarge: 'This document is too large to save as a template',
  installTitle: 'The AI proposes installing this skill',
  installHint:
    'Open the preview to see what it holds, then decide whether to install it. An installed skill is available from the next session.',
  installOpen: 'Open preview',
  installDismiss: 'Close',
  installDismissed: 'Not installed',
  installCancel: 'Cancel',
  actProposeSkill: 'Suggest a skill',
} satisfies Record<keyof typeof zh, string>
