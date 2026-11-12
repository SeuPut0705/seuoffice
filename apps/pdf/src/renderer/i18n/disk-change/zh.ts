/** Strings for the notice that the open file changed on disk, zh: defines the key set every other locale shard must match. */
export const zh = {
  diskChanged: '此文件已被更改。要重新载入吗？',
  diskChangedUnsaved: '此文件已被更改。重新载入将丢弃尚未保存的编辑。',
  diskMissing: '此文件已被删除或重命名。屏幕上的内容仍然保留。',
  diskReload: '重新载入',
  diskIgnore: '忽略',
  diskDismiss: '确定',
  diskReloadFailed: '无法重新载入文件：{detail}',
  diskChangedNoUndo: '此文件已被其他程序更改或删除，因此未执行此更改的撤销或重做。',
  // asked before a page operation on a file too large to keep for Undo
  pageOpNoUndoConfirm:
    '此文件（{size}）超过了可为撤销保留的大小（{limit}），因此此页面操作无法撤销。是否继续？',
}
