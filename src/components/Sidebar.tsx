type SidebarProps = {
  selectedParcelId: string | null
}

export function Sidebar({ selectedParcelId }: SidebarProps) {
  void selectedParcelId

  return (
    <aside className="hairline w-[380px] shrink-0 border-t-0 border-b-0 border-r-0 bg-[var(--color-paper)] p-6">
      <p className="font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-[var(--color-slate)]">
        Selected parcel
      </p>
      <p className="mt-3 text-sm italic text-[var(--color-mist)]">
        Search or click a parcel to view jurisdiction and cited rules.
      </p>
    </aside>
  )
}
