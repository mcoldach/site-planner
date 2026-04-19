import { Search } from 'lucide-react'

function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="hairline flex h-14 shrink-0 items-stretch border-t-0 border-l-0 border-r-0 bg-[var(--color-canvas)]">
        <div className="flex min-w-0 flex-1 flex-col justify-center px-6 py-2">
          <h1 className="font-serif text-base leading-tight text-[var(--color-ink)]">
            Site Planner
          </h1>
          <p className="font-mono text-xs leading-tight text-[var(--color-slate)]">
            Phase 0 — Colorado Springs + El Paso County
          </p>
        </div>
        <div className="flex w-[480px] shrink-0 items-center justify-center px-3">
          <form
            className="w-full"
            onSubmit={(e) => {
              e.preventDefault()
            }}
          >
            <label htmlFor="parcel-search" className="sr-only">
              Address or parcel number
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2 text-[var(--color-slate)]"
                aria-hidden
                strokeWidth={2}
              />
              <input
                id="parcel-search"
                type="search"
                name="q"
                placeholder="Address or parcel number…"
                className="hairline w-full rounded-sm bg-white py-2 pl-9 pr-3 font-sans text-sm text-[var(--color-ink)] placeholder:text-[var(--color-slate)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)]"
                autoComplete="off"
              />
            </div>
          </form>
        </div>
        <div className="min-w-0 flex-1" aria-hidden />
      </header>

      <main className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[var(--color-fog)]">
          <p className="font-mono text-sm text-[var(--color-slate)]">
            [Map loads in Session 6]
          </p>
        </div>
        <aside className="hairline w-[380px] shrink-0 border-t-0 border-b-0 border-r-0 bg-[var(--color-paper)] p-6">
          <p className="font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Selected parcel
          </p>
          <p className="mt-3 text-sm italic text-[var(--color-mist)]">
            Search or click a parcel to view jurisdiction and cited rules.
          </p>
        </aside>
      </main>
    </div>
  )
}

export default App
