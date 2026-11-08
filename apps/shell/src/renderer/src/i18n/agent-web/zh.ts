/**
 * The agent window's web choices and web permission prompts (spec 7). This
 * file defines the key set; every other language file satisfies
 * `Record<keyof typeof zh, string>`.
 */
export const zh = {
  actWebSearch: '网页搜索',
  actWebFetch: '读取网页',
  permWebSearch: '在网上搜索',
  permWebFetch: '读取此网页',
  permAllowSearchSession: '本次会话中允许搜索',
  permAllowSiteSession: '本次会话中允许此网站',
  codexWebLabel: '网页搜索',
  codexWebCached: '已保存的结果',
  codexWebLive: '实时',
  codexWebDisabled: '关闭',
  codexWebNote: '“已保存的结果”从预先收集的网页内容中查找；“实时”搜索当前的网页。',
  codexNetworkLabel: '命令的互联网访问',
  codexNetworkOff: '关闭',
  codexNetworkOn: '开启',
  codexNetworkWarning:
    '开启后，Codex 运行的命令可以访问互联网。在“信任此项目”中，命令会不经询问直接访问。收到的文档中隐藏的指令可能会让它把资料发送出去。',
  codexFolderNote: '这两项设置按项目文件夹分别记住。',
  providerCodexNoteWeb:
    '命令在 Codex 的隔离空间中运行：只能写入项目文件夹，除非你开启，否则无法访问互联网。',
}
