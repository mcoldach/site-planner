import { useEffect, useState } from 'react'
import { ParcelContextPanel } from './ParcelContextPanel'
import { fetchParcelWithJurisdictionAndClaims } from '../lib/data'
import type { ParcelContext } from '../lib/types'

type SidebarProps = {
  selectedParcelId: string | null
}

function EmptyState() {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        SELECTED PARCEL
      </p>
      <p className="mt-3 text-sm italic text-[var(--color-mist)]">
        Search or click a parcel to view jurisdiction and cited rules.
      </p>
    </div>
  )
}

export function Sidebar({ selectedParcelId }: SidebarProps) {
  const [context, setContext] = useState<ParcelContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedParcelId) return
    let cancelled = false
    // Synchronous priming of loading state before kicking off an async
    // fetch — the canonical data-fetch pattern in React docs. The
    // set-state-in-effect rule's exception only covers writes inside async
    // callbacks (.then/.catch/.finally) and doesn't recognize the prime.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)

    void fetchParcelWithJurisdictionAndClaims(selectedParcelId)
      .then((data) => {
        if (!cancelled) setContext(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load parcel context',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedParcelId])

  return (
    <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-[var(--color-fog)] bg-[var(--color-paper)] px-6 py-6">
      {!selectedParcelId ? (
        <EmptyState />
      ) : loading ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          loading…
        </p>
      ) : error ? (
        <p className="text-sm text-[var(--color-slate)]">{error}</p>
      ) : context ? (
        <ParcelContextPanel {...context} />
      ) : null}
    </aside>
  )
}
