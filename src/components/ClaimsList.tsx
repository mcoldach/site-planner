import {
  CATEGORY_ORDER,
  getRuleCategory,
  type RuleCategory,
} from '../lib/rule-catalog'
import type { Claim } from '../lib/types'
import { ClaimCard } from './ClaimCard'

type ClaimsListProps = {
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

export function ClaimsList({ claims }: ClaimsListProps) {
  if (claims.length === 0) return null

  const byCategory = groupClaimsByCategory(claims)

  return (
    <div>
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
    </div>
  )
}
