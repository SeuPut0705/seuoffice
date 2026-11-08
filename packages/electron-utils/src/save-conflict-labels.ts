import { createI18n, defineStrings, normalizeLang } from '@genoffice/i18n'

/**
 * Wording for the same-document save conflict prompt raised by
 * save-conflict.ts. The disk version the prompt talks about may have been
 * written by a sibling copy of the document (the split view) or by another
 * program, so the sentence says "changed elsewhere" rather than naming a
 * program. The Word editor keeps its own older wording for external changes
 * (apps/docs `extModifiedMsg`/`extModifiedDetail`).
 *
 * Going through createI18n keeps the repo conventions: the product name is
 * swapped into the template at output time.
 *
 * `zh` defines the key set; every other language must cover exactly the same
 * keys (compile-time checked).
 */
const zh = {
  message: '此文件已在其他地方被修改。',
  detail: '仍要保存并覆盖磁盘上的更改吗?',
  overwrite: '覆盖',
  cancel: '取消',
}

type Keys = Record<keyof typeof zh, string>

export const SAVE_CONFLICT_STRINGS = defineStrings({
  zh,
  en: {
    message: 'This document has changed elsewhere.',
    detail: 'Save anyway and overwrite the changes on disk?',
    overwrite: 'Overwrite',
    cancel: 'Cancel',
  } satisfies Keys,
  ja: {
    message: 'このファイルは別の場所で変更されています。',
    detail: 'このまま保存してディスク上の変更を上書きしますか?',
    overwrite: '上書き',
    cancel: 'キャンセル',
  } satisfies Keys,
  ko: {
    message: '이 문서가 다른 곳에서 바뀌었습니다.',
    detail: '그래도 저장하여 디스크의 변경 사항을 덮어쓸까요?',
    overwrite: '덮어쓰기',
    cancel: '취소',
  } satisfies Keys,
  fr: {
    message: 'Ce document a été modifié ailleurs.',
    detail: 'Enregistrer quand même et écraser les modifications sur le disque ?',
    overwrite: 'Écraser',
    cancel: 'Annuler',
  } satisfies Keys,
  de: {
    message: 'Dieses Dokument wurde an anderer Stelle geändert.',
    detail: 'Trotzdem speichern und die Änderungen auf dem Datenträger überschreiben?',
    overwrite: 'Überschreiben',
    cancel: 'Abbrechen',
  } satisfies Keys,
  es: {
    message: 'Este documento se ha modificado en otro lugar.',
    detail: '¿Guardar de todos modos y sobrescribir los cambios en el disco?',
    overwrite: 'Sobrescribir',
    cancel: 'Cancelar',
  } satisfies Keys,
  th: {
    message: 'เอกสารนี้ถูกแก้ไขที่อื่น',
    detail: 'บันทึกต่อไปและเขียนทับการเปลี่ยนแปลงบนดิสก์หรือไม่?',
    overwrite: 'เขียนทับ',
    cancel: 'ยกเลิก',
  } satisfies Keys,
  id: {
    message: 'Dokumen ini telah diubah di tempat lain.',
    detail: 'Tetap simpan dan timpa perubahan di disk?',
    overwrite: 'Timpa',
    cancel: 'Batal',
  } satisfies Keys,
  ru: {
    message: 'Этот документ был изменён в другом месте.',
    detail: 'Всё равно сохранить и перезаписать изменения на диске?',
    overwrite: 'Перезаписать',
    cancel: 'Отмена',
  } satisfies Keys,
  ar: {
    message: 'تم تعديل هذا المستند في مكان آخر.',
    detail: 'هل تريد الحفظ على أي حال والكتابة فوق التغييرات على القرص؟',
    overwrite: 'استبدال',
    cancel: 'إلغاء',
  } satisfies Keys,
  pt: {
    message: 'Este documento foi modificado em outro lugar.',
    detail: 'Salvar mesmo assim e sobrescrever as alterações no disco?',
    overwrite: 'Sobrescrever',
    cancel: 'Cancelar',
  } satisfies Keys,
  it: {
    message: 'Questo documento è stato modificato altrove.',
    detail: 'Salvare comunque e sovrascrivere le modifiche sul disco?',
    overwrite: 'Sovrascrivi',
    cancel: 'Annulla',
  } satisfies Keys,
  pl: {
    message: 'Ten dokument został zmieniony w innym miejscu.',
    detail: 'Zapisać mimo to i nadpisać zmiany na dysku?',
    overwrite: 'Nadpisz',
    cancel: 'Anuluj',
  } satisfies Keys,
  cs: {
    message: 'Tento dokument byl změněn jinde.',
    detail: 'Přesto uložit a přepsat změny na disku?',
    overwrite: 'Přepsat',
    cancel: 'Zrušit',
  } satisfies Keys,
  nl: {
    message: 'Dit document is ergens anders gewijzigd.',
    detail: 'Toch opslaan en de wijzigingen op schijf overschrijven?',
    overwrite: 'Overschrijven',
    cancel: 'Annuleren',
  } satisfies Keys,
  ms: {
    message: 'Dokumen ini telah diubah di tempat lain.',
    detail: 'Simpan juga dan tulis ganti perubahan pada cakera?',
    overwrite: 'Tulis Ganti',
    cancel: 'Batal',
  } satisfies Keys,
  he: {
    message: 'המסמך שונה במקום אחר.',
    detail: 'לשמור בכל זאת ולדרוס את השינויים בדיסק?',
    overwrite: 'דרוס',
    cancel: 'ביטול',
  } satisfies Keys,
  hi: {
    message: 'यह दस्तावेज़ कहीं और बदल दिया गया है।',
    detail: 'फिर भी सहेजें और डिस्क पर मौजूद बदलावों को अधिलेखित करें?',
    overwrite: 'अधिलेखित करें',
    cancel: 'रद्द करें',
  } satisfies Keys,
  'zh-TW': {
    message: '此檔案已在其他地方被修改。',
    detail: '仍要儲存並覆寫磁碟上的變更嗎?',
    overwrite: '覆寫',
    cancel: '取消',
  } satisfies Keys,
  vi: {
    message: 'Tài liệu này đã được sửa đổi ở nơi khác.',
    detail: 'Vẫn lưu và ghi đè các thay đổi trên ổ đĩa?',
    overwrite: 'Ghi đè',
    cancel: 'Hủy',
  } satisfies Keys,
})

const t = createI18n(SAVE_CONFLICT_STRINGS)

export interface SaveConflictLabels {
  message: string
  detail: string
  overwrite: string
  cancel: string
}

/** The four prompt strings in the given UI language (raw locale tags accepted). */
export function saveConflictLabels(lang: string): SaveConflictLabels {
  const loc = normalizeLang(lang)
  return {
    message: t(loc, 'message'),
    detail: t(loc, 'detail'),
    overwrite: t(loc, 'overwrite'),
    cancel: t(loc, 'cancel'),
  }
}
