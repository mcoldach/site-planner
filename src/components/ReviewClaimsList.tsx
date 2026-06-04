import { useState } from 'react'
import {
  CATEGORY_ORDER,
  resolveClaimCategory,
  type RuleCategory,
} from '../lib/rule-catalog'
import type { ReviewClaim, ReviewState } from '../lib/types'
import { ReviewClaimCard } from './ReviewClaimCard'

type ReviewClaimsListProps = {
  claims: ReviewClaim[]
  onEdit: (
    claimId: string,
    editNote: string,
    reviewState: ReviewState,
  ) => Promise<void>
}

type DistrictGroup = {
  key: string
  code: string | null
  claims: ReviewClaim[]
}

const STATE_FILTERS: { value: ReviewState | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'extracted', label: 'Extracted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

function groupByCategory(claims: ReviewClaim[]): Map<RuleCategory, ReviewClaim[]> {
  const grouped = new Map<RuleCategory, ReviewClaim[]>()
  for (const claim of claims) {
    const legacy = {
      ...claim,
      label: null as string | null,
      category: null as string | null,
      source_snapshot: claim.source_snapshots,
    }
    const category = resolveClaimCategory(legacy)
    const list = grouped.get(category) ?? []
    list.push(claim)
    grouped.set(category, list)
  }
  return grouped
}

function CategorySection({
  claims,
  onEdit,
}: {
  claims: ReviewClaim[]
  onEdit: ReviewClaimsListProps['onEdit']
}) {
  const byCategory = groupByCategory(claims)

  return (
    <>
      {CATEGORY_ORDER.map((category) => {
        const categoryClaims = byCategory.get(category)
        if (!categoryClaims?.length) return null

        return (
          <section key={category} className="mb-6">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
              {category}
            </p>
            {categoryClaims.map((claim, index) => (
              <div
                key={claim.id}
                className={
                  index > 0 ? 'border-t border-[var(--color-fog)]' : undefined
                }
              >
                <ReviewClaimCard claim={claim} onEdit={onEdit} />
              </div>
            ))}
          </section>
        )
      })}
    </>
  )
}

function buildDistrictGroups(claims: ReviewClaim[]): DistrictGroup[] {
  const byDistrict = new Map<string | null, ReviewClaim[]>()
  for (const claim of claims) {
    const key = claim.zone_district_code
    const list = byDistrict.get(key) ?? []
    list.push(claim)
    byDistrict.set(key, list)
  }

  const groups: DistrictGroup[] = []

  for (const [code, districtClaims] of byDistrict) {
    if (code !== null && districtClaims.length > 0) {
      groups.push({ key: code, code, claims: districtClaims })
    }
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const jurisdictionWide = byDistrict.get(null)
  if (jurisdictionWide?.length) {
    groups.push({
      key: '__jurisdiction-wide__',
      code: null,
      claims: jurisdictionWide,
    })
  }

  return groups
}

export function ReviewClaimsList({ claims, onEdit }: ReviewClaimsListProps) {
  const [filter, setFilter] = useState<ReviewState | 'all'>('all')

  const filtered =
    filter === 'all'
      ? claims
      : claims.filter((c) => c.review_state === filter)

  const counts = {
    all: claims.length,
    extracted: claims.filter((c) => c.review_state === 'extracted').length,
    approved: claims.filter((c) => c.review_state === 'approved').length,
    rejected: claims.filter((c) => c.review_state === 'rejected').length,
  }

  const districtGroups = buildDistrictGroups(filtered)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {STATE_FILTERS.map((f) => {
          const count = counts[f.value as keyof typeof counts] ?? 0
          const isActive = filter === f.value
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`font-mono text-[10px] uppercase tracking-[0.08em] ${
                isActive
                  ? 'text-[var(--color-ink)] underline'
                  : 'text-[var(--color-slate)] hover:text-[var(--color-ink)]'
              }`}
            >
              {f.label}
              <span className="ml-0.5 no-underline" style={{ fontVariantNumeric: 'tabular-nums' }}>
                ({count})
              </span>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
          No claims match this filter.
        </p>
      ) : (
        <div className="mt-4">
          {districtGroups.map((group, groupIndex) => (
            <div
              key={group.key}
              className={
                groupIndex > 0
                  ? 'mt-6 border-t border-[var(--color-fog)] pt-6'
                  : undefined
              }
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
                {group.code ?? 'JURISDICTION-WIDE'}
              </p>
              <CategorySection claims={group.claims} onEdit={onEdit} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
