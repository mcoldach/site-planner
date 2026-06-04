-- edit_claim RPC: gated write path for claim review + editing.
--
-- Claims are shared-reference (RLS select-only for authenticated users).
-- All writes flow through this function, which runs as SECURITY DEFINER
-- to bypass the select-only policy. The function enforces that every edit
-- carries an edit_note explaining the change.
--
-- Supported operations:
--   - Change review_state (extracted → approved, extracted → rejected, etc.)
--   - Update notes (free-text annotation)
-- Value editing (constraint_kind, value, scope) is a future extension;
-- the first use case is reviewing transformer-extracted claims.

create or replace function public.edit_claim(
  _claim_id     uuid,
  _edit_note    text,
  _review_state review_state_t default null,
  _notes        text           default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  _result record;
begin
  if _edit_note is null or trim(_edit_note) = '' then
    raise exception 'edit_claim: edit_note is required — explain what changed and why';
  end if;

  update claims set
    review_state  = coalesce(_review_state, claims.review_state),
    notes         = coalesce(_notes, claims.notes),
    edit_note     = _edit_note,
    claim_version = claim_version + 1,
    updated_at    = now()
  where id = _claim_id
  returning id, review_state, claim_version
  into _result;

  if not found then
    raise exception 'edit_claim: claim % not found', _claim_id;
  end if;

  return jsonb_build_object(
    'id',            _result.id,
    'review_state',  _result.review_state,
    'claim_version', _result.claim_version
  );
end;
$$;
