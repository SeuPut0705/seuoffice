/**
 * The agent window's skill screens (spec 6.2 to 6.5, 9.4). This file
 * defines the key set; every other language file satisfies
 * `Record<keyof typeof zh, string>`.
 */
export const zh = {
  noticeText:
    '技能现在在 设置 → 技能 中开启和关闭。Claude 和 Codex 技能文件夹中的技能开始时为关闭状态。',
  noticeOpenSettings: '打开设置',
  noticeClose: '关闭',
  nextSession: '更改的技能将从下一个会话起生效',
  templateLabel: '一起保存为模板的文档',
  templateNone: '无模板',
  templateFromTab: '已在标签页中打开',
  templateFromProject: '项目文件夹',
  templateUnsaved: '此标签页有未保存的更改。模板将使用已保存的文件。',
  templateChecking: '正在检查是否有隐藏的内容…',
  templateUnknown:
    '无法在此确认这种格式是否有隐藏的内容，因此不能按原样保存。请制作空白模板后保存。',
  templateTooLarge: '此文档太大，无法保存为模板',
  installTitle: 'AI 建议安装这个技能',
  installHint: '请在预览中确认内容后再决定是否安装。安装的技能将从下一个会话起使用。',
  installOpen: '打开预览',
  installDismiss: '关闭',
  installDismissed: '未安装',
  installCancel: '取消',
  actProposeSkill: '建议技能',
}
