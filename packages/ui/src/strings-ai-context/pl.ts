import type { zh } from './zh'

export const pl = {
  contextConfirm:
    'To żądanie jest blisko limitu kontekstu modelu: około {estimated} z {limit} tokenów ({percent}%). Wysłać mimo to?',
  contextUnknown:
    'Nie udało się potwierdzić rozmiaru kontekstu modelu; przyjmuje się {limit} tokenów.',
  toolsUnsupported:
    'Ten model nie obsługuje wywołań narzędzi. Będzie tylko sugerować tekst i nie zmieni dokumentu.',
  errContextLimit:
    'Nic nie zostało wysłane: żądanie jest blisko limitu kontekstu modelu. Podziel je na mniejsze żądania i spróbuj ponownie.',
} satisfies Record<keyof typeof zh, string>
