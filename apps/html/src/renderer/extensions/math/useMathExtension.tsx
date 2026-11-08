import { lazy, Suspense, useRef, useState } from 'react'
import type { ParseMap } from '../../document/parse-map'
import type { HtmlOp } from '../../document/ops'
import { findMath, mathEditOps, mathInsertOp, type HtmlMathTarget } from './html-adapter'
import type { MathValue } from './model'

const MathDialog = lazy(() =>
  import('./MathDialog').then((module) => ({ default: module.MathDialog })),
)

interface Snapshot {
  source: string
  identity: string | null
  map: ParseMap
  sid: number | null
}

interface Session extends Snapshot {
  target: HtmlMathTarget | null
  initial: MathValue
}

/** Small host boundary: the extension owns editing; the host owns undo, save and selection. */
interface Host {
  flush: () => void
  read: () => Snapshot
  apply: (ops: HtmlOp[]) => boolean
  unavailable: () => void
}

export function useMathExtension(host: Host) {
  const hostRef = useRef(host)
  hostRef.current = host
  const [session, setSession] = useState<Session | null>(null)
  const [serial, setSerial] = useState(0)
  const openRef = useRef<(sid?: number, version?: number) => void>(() => {})
  openRef.current = (sid, version) => {
    hostRef.current.flush()
    const next = hostRef.current.read()
    if (version !== undefined && version !== next.map.version) return
    if (sid !== undefined) {
      if (!Number.isSafeInteger(sid) || !findMath(next.source, next.map, sid)) return
      next.sid = sid
    }
    if (
      !findMath(next.source, next.map, next.sid) &&
      !mathInsertOp(next.map, next.sid, { latex: 'x', display: true })
    ) {
      hostRef.current.unavailable()
      return
    }
    setSerial((n) => n + 1)
    const target = findMath(next.source, next.map, next.sid)
    setSession({ ...next, target, initial: target?.value ?? { latex: '', display: true } })
  }
  const target = session?.target
  const dialog = session ? (
    <Suspense fallback={null}>
      <MathDialog
        key={serial}
        initial={session.initial}
        editing={!!target}
        onCancel={() => setSession(null)}
        onApply={(value) => {
          hostRef.current.flush()
          const current = hostRef.current.read()
          if (
            current.identity !== session.identity ||
            current.source !== session.source ||
            current.map.version !== session.map.version
          )
            return false
          const insertion = !target && mathInsertOp(session.map, session.sid, value)
          const ops = target ? mathEditOps(target, value) : insertion ? [insertion] : null
          if (!ops || (ops.length && !hostRef.current.apply(ops))) return false
          setSession(null)
          return true
        }}
      />
    </Suspense>
  ) : null
  return { openRef, dialog }
}
