import type { zh } from './zh'

export const cs = {
  ntOpen: 'Otevřít poznámku',
  ntOpenTip: 'Otevřít poznámku Markdown propojenou s tímto PDF',
  ntInsert: 'Přidat do poznámky',
  ntInsertTip: 'Přidá toto na konec poznámky. Uložte ji na kartě poznámky',
  ntSaveFirst: 'Nejprve PDF uložte',
  ntUnavailable: 'Poznámky lze otevřít jen v aplikaci GenOffice',
  ntFailed: 'Poznámku se nepodařilo otevřít. {reason}',
  ntInserted: 'Přidáno do poznámky',
} satisfies Record<keyof typeof zh, string>
