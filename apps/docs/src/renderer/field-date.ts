/**
 * The result a date or time field shows when it is inserted or updated: DATE,
 * CREATEDATE and SAVEDATE as the date, TIME as hours and minutes, written the
 * way the document's language writes them. The field's own format switch
 * (\@ "…") is not read here. Null for any other field.
 */
export function dateTimeFieldText(keyword: string, now: Date, locale: string): string | null {
  switch (keyword) {
    case 'DATE':
    case 'CREATEDATE':
    case 'SAVEDATE':
      return now.toLocaleDateString(locale)
    case 'TIME':
      return now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    default:
      return null
  }
}
