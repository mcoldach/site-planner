import { Search as SearchIcon } from 'lucide-react'
import type { Parcel } from '../lib/types'

type SearchProps = {
  allParcels: Parcel[]
  setSelectedParcelId: (id: string | null) => void
}

export function Search({ allParcels, setSelectedParcelId }: SearchProps) {
  void allParcels
  void setSelectedParcelId

  return (
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
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2 text-[var(--color-slate)]"
          aria-hidden
          strokeWidth={2}
        />
        <input
          id="parcel-search"
          type="search"
          name="q"
          placeholder="Address or parcel number…"
          className="hairline w-full rounded-sm bg-white py-2 pl-9 pr-3 font-sans text-sm text-[var(--color-ink)] placeholder:text-[var(--color-slate)]"
          autoComplete="off"
        />
      </div>
    </form>
  )
}
