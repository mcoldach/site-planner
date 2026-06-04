import { useState } from 'react'
import { ArrowUpRight, Check, X } from 'lucide-react'
import { resolveClaimCategory } from '../lib/rule-catalog'
import type { Claim } from '../lib/types'
import type { ReviewClaim, ReviewState } from '../lib/types'

type ReviewClaimCardProps = {
  claim: ReviewClaim
  onEdit: (
    claimId: string,
    editNote: string,
    reviewState: ReviewState,
  ) => Promise<void>
}

const STATE_LABELS: Record<ReviewState, string> = {
  extracted: 'EXTRACTED',
  reviewed: 'REVIEWED',
  approved: 'APPROVED',
  superseded: 'SUPERSEDED',
  conflicted: 'CONFLICTED',
  rejected: 'REJECTED',
}

const STATE_TONES: Record<ReviewState, string> = {
  extracted:
    'border-[var(--color-slate)] text-[var(--color-slate)]',
  reviewed:
    'border-[var(--color-slate)] text-[var(--color-slate)]',
  approved:
    'border-[var(--color-accent)] text-[var(--color-accent)]',
  superseded:
    'border-[var(--color-mist)] text-[var(--color-mist)]',
  conflicted:
    'border-[var(--color-ink)] text-[var(--color-ink)]',
  rejected:
    'border-[var(--color-mist)] text-[var(--color-mist)] line-through',
}

function ReviewStateBadge({ state }: { state: ReviewState }) {
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${STATE_TONES[state]}`}
    >
      {STATE_LABELS[state]}
    </span>
  )
}

function formatReviewValue(claim: ReviewClaim): { display: string; unit: string | null } {
  const v = claim.value
  if (!v) return { display: '—', unit: null }

  if (claim.value_kind === 'number') {
    return { display: String(v.n ?? '—'), unit: (v.unit as string) ?? null }
  }
  if (claim.value_kind === 'percent') {
    return { display: `${v.n ?? '—'}%`, unit: null }
  }
  if (claim.value_kind === 'ratio') {
    const num = v.numerator as number
    const den = v.denominator as number
    const denUnit = v.denominator_unit as string
    return {
      display: `${num} / ${den.toLocaleString()}`,
      unit: denUnit,
    }
  }
  if (claim.value_kind === 'boolean') {
    return { display: v.b === true ? 'Permitted' : 'Not permitted', unit: null }
  }
  if (claim.value_kind === 'prose_deferred') {
    return { display: (v.prose as string) ?? '—', unit: null }
  }

  return { display: '—', unit: null }
}

function claimToLegacy(rc: ReviewClaim): Claim {
  return {
    id: rc.id,
    jurisdiction_id: rc.jurisdiction_id,
    zone_district_code: rc.zone_district_code,
    rule_key: rc.rule_key,
    label: null,
    category: null,
    value_text: rc.value_text,
    value_numeric: rc.value_numeric,
    value_unit: rc.value_unit,
    section_ref: rc.section_ref,
    section_url: rc.section_url,
    source_snapshot: rc.source_snapshots,
  }
}

export function ReviewClaimCard({ claim, onEdit }: ReviewClaimCardProps) {
  const [action, setAction] = useState<'approve' | 'reject' | null>(null)
  const [editNote, setEditNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const legacy = claimToLegacy(claim)
  const { display, unit } = formatReviewValue(claim)
  const citeUrl = claim.section_url ?? claim.source_snapshots.url
  const isProse = display.length > 25
  const isRejected = claim.review_state === 'rejected'

  async function handleSubmit() {
    if (!action || !editNote.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const reviewState: ReviewState =
        action === 'approve' ? 'approved' : 'rejected'
      await onEdit(claim.id, editNote.trim(), reviewState)
      setAction(null)
      setEditNote('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={`py-3 transition-colors duration-150 ${isRejected ? 'opacity-50' : 'hover:bg-[var(--color-accent-wash)]'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-sans text-xs text-[var(--color-ink)]">
          {resolveClaimCategory(legacy)} · {claim.rule_key}
        </p>
        <ReviewStateBadge state={claim.review_state} />
      </div>

      <div className="mt-1 flex flex-row items-baseline">
        <span
          className={
            isProse
              ? 'font-serif text-lg leading-snug text-[var(--color-ink)]'
              : 'font-serif text-3xl leading-none text-[var(--color-ink)]'
          }
          style={isProse ? undefined : { fontVariantNumeric: 'tabular-nums' }}
        >
          {display}
        </span>
        {unit ? (
          <span className="ml-1 font-mono text-xs text-[var(--color-slate)]">
            {unit}
          </span>
        ) : null}
      </div>

      {claim.notes ? (
        <p className="mt-1 font-sans text-xs italic text-[var(--color-graphite)]">
          {claim.notes}
        </p>
      ) : null}

      <div className="mt-2 border-t border-[var(--color-fog)] pt-1">
        <p className="font-mono text-[11px] text-[var(--color-graphite)]">
          {claim.section_ref}
        </p>
        <p className="font-mono text-[11px]">
          {citeUrl ? (
            <a
              href={citeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-slate)] hover:text-[var(--color-accent)] hover:underline"
            >
              {claim.source_snapshots.title}
              <ArrowUpRight
                className="ml-0.5 inline-block align-text-top"
                size={10}
                aria-hidden
              />
            </a>
          ) : (
            <span className="text-[var(--color-slate)]">
              {claim.source_snapshots.title}
            </span>
          )}
        </p>
        {claim.edit_note ? (
          <p className="mt-1 font-mono text-[10px] text-[var(--color-mist)]">
            v{claim.claim_version}: {claim.edit_note}
          </p>
        ) : null}
      </div>

      {action === null &&
      claim.review_state !== 'approved' &&
      claim.review_state !== 'rejected' ? (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAction('approve')}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-accent)]"
          >
            <Check size={12} aria-hidden />
            Approve
          </button>
          <span aria-hidden className="text-[var(--color-fog)]">
            ·
          </span>
          <button
            type="button"
            onClick={() => setAction('reject')}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          >
            <X size={12} aria-hidden />
            Reject
          </button>
        </div>
      ) : null}

      {action !== null ? (
        <div className="mt-2 border-t border-[var(--color-fog)] pt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            {action === 'approve' ? 'Approve' : 'Reject'} — why?
          </p>
          <textarea
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            rows={2}
            placeholder="Required: explain the review decision"
            className="mt-1 w-full resize-none rounded-sm border border-[var(--color-fog)] bg-[var(--color-canvas)] px-2 py-1.5 font-sans text-xs text-[var(--color-ink)] placeholder:text-[var(--color-mist)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <div className="mt-1.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !editNote.trim()}
              className={`font-mono text-[10px] uppercase tracking-[0.08em] ${
                submitting || !editNote.trim()
                  ? 'cursor-not-allowed text-[var(--color-mist)]'
                  : 'text-[var(--color-ink)] hover:underline'
              }`}
            >
              {submitting ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAction(null)
                setEditNote('')
                setError(null)
              }}
              disabled={submitting}
              className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
            >
              Cancel
            </button>
          </div>
          {error ? (
            <p className="mt-1 font-mono text-[10px] text-[var(--color-ink)]">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
