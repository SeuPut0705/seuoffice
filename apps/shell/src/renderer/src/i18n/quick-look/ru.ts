import type { zh } from './zh'

export const ru = {
  windowTitle: 'Быстрый просмотр',
  openInEditor: 'Открыть в GenOffice',
  revealInFolder: 'Показать в папке',
  close: 'Закрыть',
  prevFile: 'Предыдущий файл (↑)',
  nextFile: 'Следующий файл (↓)',
  shortcutHint: 'Пробел / Esc закрыть · ↑↓ переключить · Enter открыть',
  loading: 'Загрузка предпросмотра…',
  empty: 'В этом документе нет текста для предпросмотра.',
  encrypted: 'Документ защищён паролем. Откройте его в GenOffice для разблокировки.',
  unsupported: 'Этот формат файла нельзя просмотреть напрямую.',
  failed: 'Не удалось прочитать предпросмотр файла.',
  truncated: 'Показано начало документа. Откройте в GenOffice для просмотра целиком.',
  slideLabel: 'Слайд {n}',
  sheetCount: '{n} листов',
  slideCount: '{n} слайдов',
  lineCount: '{n} строк',
  charCount: '{n} симв.',
  tabThumbnail: 'Эскиз',
  tabContent: 'Текст документа',
  setQuickLookTitle: 'Быстрый просмотр (Пробел)',
  setQuickLookHint:
    'Нажмите Пробел на файле в списках GenOffice, чтобы просмотреть содержимое без открытия вкладки.',
  setExplorerSpace: 'Предпросмотр файлов по Пробелу в Проводнике Windows и на Рабочем столе',
  setExplorerSpaceDesc:
    'Нажмите Пробел на выбранном файле в Проводнике или на Рабочем столе для открытия окна быстрого просмотра.',
  setKeepInTray: 'Оставлять в системном трее при закрытии окна',
  setKeepInTrayDesc:
    'Сохраняет GenOffice в фоне, чтобы быстрый просмотр по Пробелу работал в Проводнике даже после закрытия главного окна.',
  trayOpen: 'Открыть GenOffice',
  trayQuit: 'Выйти из GenOffice',
} satisfies Record<keyof typeof zh, string>
