// Stands in for main/font-scan.ts in the web build: there are no font directories to scan, and the
// callers treat an unfinished task as an empty one.
export type { ScanResult, ScanTask } from '../main/font-scan'
import type { ScanResult, ScanTask } from '../main/font-scan'

export function scanFontDirs(tasks: ScanTask[]): Array<ScanResult | undefined> {
  return new Array<ScanResult | undefined>(tasks.length)
}
