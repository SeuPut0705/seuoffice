export function readCosts(path: string): Record<string, number>
export function planShards(
  ids: string[],
  costs: Record<string, number>,
  count: number,
): { shards: string[][]; loads: number[] }
export function parseShard(text: string): { index: number; count: number }
export function refreshCosts(
  costs: Record<string, number>,
  reports: Array<
    | Array<{ id?: unknown; seconds?: unknown }>
    | { results?: Array<{ id?: unknown; seconds?: unknown }> }
  >,
): Record<string, number>
