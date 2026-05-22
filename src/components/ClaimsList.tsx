import {
  CATEGORY_ORDER,
  getRuleCategory,
  type RuleCategory,
} from '../lib/rule-catalog'
import type { Claim, ZoneCode } from '../lib/types'
import { ClaimCard } from './ClaimCard'

type ClaimsListProps = {
  claims: Claim[]
  baseCodes: ZoneCode[]
}

type DistrictGroup = {
  key: string
  code: string | null
  claims: Claim[]
}

function groupClaimsByCategory(claims: Claim[]): Map<RuleCategory, Claim[]> {
  const grouped = new Map<RuleCategory, Claim[]>()
  for (const claim of claims) {
    const category = getRuleCategory(claim.rule_key)
    const list = grouped.get(category) ?? []
    list.push(claim)
    grouped.set(category, list)
  }
  return grouped
}

function CategoryGroupedClaims({ claims }: { claims: Claim[] }) {
  const byCategory = groupClaimsByCategory(claims)

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
                <ClaimCard claim={claim} />
              </div>
            ))}
          </section>
        )
      })}
    </>
  )
}

function buildDistrictGroups(
  claims: Claim[],
  baseCodes: ZoneCode[],
): DistrictGroup[] {
  const byDistrict = new Map<string | null, Claim[]>()
  for (const claim of claims) {
    const key = claim.zone_district_code
    const list = byDistrict.get(key) ?? []
    list.push(claim)
    byDistrict.set(key, list)
  }

  const groups: DistrictGroup[] = []
  const seen = new Set<string>()

  for (const base of baseCodes) {
    const districtClaims = byDistrict.get(base.code)
    if (!districtClaims?.length) continue
    seen.add(base.code)
    groups.push({
      key: base.code,
      code: base.code,
      claims: districtClaims,
    })
  }

  for (const [code, districtClaims] of byDistrict) {
    if (code === null || !districtClaims.length || seen.has(code)) continue
    groups.push({ key: code, code, claims: districtClaims })
  }

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

function districtHeading(code: string | null, baseCodes: ZoneCode[]): string {
  if (code === null) return 'JURISDICTION-WIDE'
  const base = baseCodes.find((b) => b.code === code)
  return base?.label ? `${code} · ${base.label}` : code
}

export function ClaimsList({ claims, baseCodes }: ClaimsListProps) {
  if (claims.length === 0) return null

  const districtGroups = buildDistrictGroups(claims, baseCodes)
  const showDistrictHeaders =
    districtGroups.length > 1 ||
    (districtGroups.length === 1 && districtGroups[0].code === null)

  if (!showDistrictHeaders) {
    return (
      <div>
        <CategoryGroupedClaims claims={claims} />
      </div>
    )
  }

  return (
    <div>
      {districtGroups.map((group, groupIndex) => (
        <div
          key={group.key}
          className={groupIndex > 0 ? 'mt-6 border-t border-[var(--color-fog)] pt-6' : undefined}
        >
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            {districtHeading(group.code, baseCodes)}
          </p>
          <CategoryGroupedClaims claims={group.claims} />
        </div>
      ))}
    </div>
  )
}
