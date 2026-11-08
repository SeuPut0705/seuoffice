// Types for tools/growth-log.mjs, consumed by tests via a relative import.
export declare const GROWTH_REPO: string
export declare const GROWTH_HISTORY_FILE: string
export declare const GROWTH_LATEST_FILE: string

export interface GrowthReleaseEntry {
  tag: string
  publishedAt: string
  downloads: number
}

export interface GrowthSnapshot {
  date: string
  totalDownloads: number
  installs: { windows: number; macos: number; linux: number }
  updateChecks: number
  releaseCount: number
  stars: number
  forks: number
  releases: GrowthReleaseEntry[]
  perAsset: { release: string; asset: string; downloads: number }[]
}

export function buildSnapshot(input: {
  releases: unknown
  stars: number
  forks: number
  date: string
}): GrowthSnapshot

export function mergeSnapshot<T>(history: T[], snapshot: T): T[]

export function buildSummary(snapshot: GrowthSnapshot): {
  date: string
  totalDownloads: number
  windowsInstalls: number
  macosInstalls: number
  linuxInstalls: number
  updateChecks: number
  stars: number
  forks: number
}

export function renderReport(history: GrowthSnapshot[]): string
