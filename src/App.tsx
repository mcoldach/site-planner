import { useCallback, useEffect, useState } from 'react'
import { Map } from './components/Map'
import { ParcelSearch } from './components/ParcelSearch'
import { Sidebar } from './components/Sidebar'
import { fetchAllParcels } from './lib/data'
import type { Parcel } from './lib/types'

function App() {
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null)
  const [allParcels, setAllParcels] = useState<Parcel[]>([])

  const loadParcels = useCallback(async () => {
    try {
      const parcels = await fetchAllParcels()
      setAllParcels(parcels)
    } catch {
      setAllParcels([])
    }
  }, [])

  useEffect(() => {
    void loadParcels()
  }, [loadParcels])

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="hairline flex h-14 shrink-0 flex-nowrap items-stretch border-t-0 border-l-0 border-r-0 bg-[var(--color-canvas)]">
        <div className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden px-6 py-2">
          <h1 className="truncate font-serif text-base leading-tight text-[var(--color-ink)]">
            Site Planner
          </h1>
          <p className="truncate font-mono text-xs leading-tight text-[var(--color-slate)]">
            Phase 0 — Colorado Springs + El Paso County
          </p>
        </div>
        <div className="flex w-[min(480px,40vw)] min-w-[220px] shrink-0 items-center justify-center px-3">
          <ParcelSearch
            parcels={allParcels}
            selectedParcelId={selectedParcelId}
            onSelect={setSelectedParcelId}
            onLookupComplete={loadParcels}
          />
        </div>
        <div className="min-w-0 flex-1" aria-hidden />
      </header>

      <main className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Map
            selectedParcelId={selectedParcelId}
            onParcelClick={setSelectedParcelId}
          />
        </div>
        <Sidebar
          selectedParcelId={selectedParcelId}
          allParcels={allParcels}
        />
      </main>
    </div>
  )
}

export default App
