/**
 * The result store as the AI highlight job sees it (`HighlightJobStore`),
 * over the pdf editor's store channels. Like the other document jobs, every
 * read and write goes to the shell, which accepts only document hashes it
 * computed for this view. A failed call throws, so the engine stops with
 * 'store-write-failed' instead of counting a batch as done.
 */
import type { HighlightJobStore } from '../../../../../packages/pdf-structure/src/highlight'
import { blockKeyString } from '../../../../../packages/pdf-structure/src/store/keys'
import type { HighlightBlockEntry } from '../../../../../packages/pdf-structure/src/store/reading'
import type { PdfStoreApi, PdfStoreWriteRequest } from '../../shared/ipc'
import { JobStoreCallError } from '../doc-jobs/ipc-store'

export type HighlightJobStoreApi = Pick<PdfStoreApi, 'highlightBlocks' | 'write'>

async function write(api: HighlightJobStoreApi, request: PdfStoreWriteRequest): Promise<void> {
  const out = await api.write(request)
  if (!out.ok) throw new JobStoreCallError(out)
}

export function createIpcHighlightStore(api: HighlightJobStoreApi): HighlightJobStore {
  return {
    writeJob: (docHash, job) => write(api, { kind: 'job', docHash, job }),
    writeHighlightRun: (docHash, run) => write(api, { kind: 'highlightRun', docHash, run }),
    async readHighlightBlocks(docHash, runId) {
      const out = await api.highlightBlocks(docHash, runId)
      if (!out.ok) throw new JobStoreCallError(out)
      return new Map<string, HighlightBlockEntry>(out.blocks.map((b) => [blockKeyString(b.key), b]))
    },
    writeHighlightBlocks: (docHash, runId, blocks) =>
      write(api, { kind: 'highlightBlocks', docHash, runId, blocks: [...blocks] }),
  }
}
