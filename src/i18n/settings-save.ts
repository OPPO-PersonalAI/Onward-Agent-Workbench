/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const en = {
  'settings.save.hint': 'Changes on this page take effect after saving.',
  'settings.save.dirty': 'Unsaved changes',
  'settings.save.clean': 'No unsaved changes',
  'settings.save.saved': 'Changes saved',
  'settings.save.discarded': 'Changes discarded',
  'settings.save.saving': 'Saving…',
  'settings.save.discard': 'Discard changes',
  'settings.save.scope': 'Current page: {{page}}',
  'settings.save.failed': 'Couldn’t save. Your edits are safe. Try again.',
  'settings.save.conflict': 'These settings changed elsewhere. Discard your edits to load the latest values, then try again.',
  'settings.save.shortcutUnavailable': 'The global shortcut could not be registered. Choose another shortcut and try again.',
  'settings.save.invalid': 'Review the highlighted fields before saving.',
  'settings.save.busy': 'Finish the current edit before saving.',
  'settings.save.leaveTitle': 'Save changes to {{page}}?',
  'settings.save.leaveBody': 'You have unsaved changes. Save them before leaving this page?',
  'settings.save.keepEditing': 'Keep editing',
  'settings.save.leaveWithout': 'Leave without saving',
  'settings.save.saveLeave': 'Save and leave',
  'settings.save.preview': 'Preview only · Save to apply to your workspace',
  'settings.save.done': 'Done editing',
  'settings.save.exportHint': 'Export uses the saved theme. Save or discard your changes first.',
  'settings.save.fontSample': 'Aa Bb 0123 → Terminal and code',
  'settings.save.applyAllHint': 'Updates the font draft for all Tasks. Save this page to apply.',
  'settings.save.importDraft': 'Add to draft'
} as const

export const zhCN: Record<keyof typeof en, string> = {
  'settings.save.hint': '本页修改将在保存后生效。',
  'settings.save.dirty': '有未保存修改',
  'settings.save.clean': '没有未保存修改',
  'settings.save.saved': '更改已保存',
  'settings.save.discarded': '已放弃更改',
  'settings.save.saving': '保存中…',
  'settings.save.discard': '放弃更改',
  'settings.save.scope': '当前保存范围：{{page}}',
  'settings.save.failed': '保存失败，修改已保留，请重试。',
  'settings.save.conflict': '这些设置已在其他位置发生变化。请放弃当前修改，载入最新值后重新编辑。',
  'settings.save.shortcutUnavailable': '无法注册全局快捷键，请更换快捷键后重试。',
  'settings.save.invalid': '请检查标记的字段后再保存。',
  'settings.save.busy': '请先完成当前编辑操作再保存。',
  'settings.save.leaveTitle': '保存对「{{page}}」的更改？',
  'settings.save.leaveBody': '你有尚未保存的修改。是否保存后离开此页面？',
  'settings.save.keepEditing': '继续编辑',
  'settings.save.leaveWithout': '不保存并离开',
  'settings.save.saveLeave': '保存并离开',
  'settings.save.preview': '仅预览 · 保存后应用到工作区',
  'settings.save.done': '完成编辑',
  'settings.save.exportHint': '导出使用已保存的主题。请先保存或放弃当前修改。',
  'settings.save.fontSample': 'Aa Bb 0123 → 终端与代码',
  'settings.save.applyAllHint': '更新所有 Task 的字体草稿，保存本页后生效。',
  'settings.save.importDraft': '添加到草稿'
}
