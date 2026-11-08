import type { zh } from './zh'

export const ru = {
  actWebSearch: 'Поиск в интернете',
  actWebFetch: 'Чтение веб-страницы',
  permWebSearch: 'Искать в интернете',
  permWebFetch: 'Прочитать эту веб-страницу',
  permAllowSearchSession: 'Разрешить поиск до конца сеанса',
  permAllowSiteSession: 'Разрешить этот сайт до конца сеанса',
  codexWebLabel: 'Поиск в интернете',
  codexWebCached: 'Сохранённые результаты',
  codexWebLive: 'В реальном времени',
  codexWebDisabled: 'Выключен',
  codexWebNote:
    'Сохранённые результаты берутся из заранее собранных веб-материалов; поиск в реальном времени ищет в интернете сейчас.',
  codexNetworkLabel: 'Доступ команд к интернету',
  codexNetworkOff: 'Выключен',
  codexNetworkOn: 'Включён',
  codexNetworkWarning:
    'Если включить, команды, которые запускает Codex, смогут выходить в интернет. В режиме «Доверять этому проекту» они делают это без вопросов. Скрытые указания в полученном документе могут заставить их отправить ваши данные наружу.',
  codexFolderNote: 'Эти две настройки запоминаются для каждой папки проекта.',
  providerCodexNoteWeb:
    'Команды выполняются в изолированной среде Codex: записывать можно только в папку проекта, а доступа к интернету нет, пока вы его не включите.',
} satisfies Record<keyof typeof zh, string>
