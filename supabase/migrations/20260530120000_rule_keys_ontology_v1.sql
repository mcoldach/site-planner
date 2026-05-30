-- Migration A: rule-keys ontology v1 (additive only).
-- Spec: rule_keys.md (repo root).
-- check_scheme_compliance and legacy value_* columns are NOT touched here.
-- Migration B (future) will update the engine and drop the legacy columns.

-- 1. Enums

create type constraint_kind_t as enum (
  'scalar_min', 'scalar_max', 'range', 'boolean', 'enum', 'ratio', 'prose_deferred'
);

create type value_kind_t as enum (
  'number', 'percent', 'ratio', 'boolean', 'enum', 'prose_deferred'
);

-- 2. New columns on claims

alter table public.claims
  add column constraint_kind constraint_kind_t,
  add column value_kind      value_kind_t,
  add column value           jsonb,
  add column scope           jsonb not null default '{}'::jsonb,
  add column source_table_id uuid references public.document_tables(id) on delete set null;

-- 3. Backfill (16 rows, 10 legacy rule_keys). All SET exprs see OLD row.

update public.claims set
  constraint_kind = case
    when rule_key like 'use.permitted.%' then 'boolean'::constraint_kind_t
    when value_numeric is null           then 'prose_deferred'::constraint_kind_t
    when rule_key like '%.min'           then 'scalar_min'::constraint_kind_t
    when rule_key like '%.max%'          then 'scalar_max'::constraint_kind_t
  end,
  value_kind = case
    when rule_key like 'use.permitted.%' then 'boolean'::value_kind_t
    when value_numeric is null           then 'prose_deferred'::value_kind_t
    when value_unit = 'percent'          then 'percent'::value_kind_t
    else                                      'number'::value_kind_t
  end,
  value = case
    when rule_key like 'use.permitted.%' then jsonb_build_object('b', value_text::boolean)
    when value_numeric is null           then jsonb_build_object('prose', value_text)
    when value_unit = 'percent'          then jsonb_build_object('n', value_numeric)
    else                                      jsonb_build_object('n', value_numeric, 'unit', value_unit)
  end,
  scope = case
    when rule_key = 'height.max.principal'      then jsonb_build_object('building_element', 'principal_building')
    when rule_key = 'use.permitted.agriculture' then jsonb_build_object('use_class', 'agriculture')
    when rule_key = 'use.permitted.multifamily' then jsonb_build_object('use_class', 'multifamily')
    else                                             '{}'::jsonb
  end,
  rule_key = case
    when rule_key in ('height.max', 'height.max.principal')     then 'building.height'
    when rule_key = 'lot.area.min'                              then 'lot.area'
    when rule_key = 'lot.coverage.max'                          then 'lot.coverage'
    when rule_key in ('setback.front.min', 'setback.front.max') then 'setback.front'
    when rule_key = 'setback.rear.min'                          then 'setback.rear'
    when rule_key = 'setback.side.min'                          then 'setback.side'
    when rule_key like 'use.permitted.%'                        then 'use.permitted'
  end;

-- 4. NOT NULL (fails loudly if any row missed backfill)

alter table public.claims
  alter column constraint_kind set not null,
  alter column value_kind      set not null,
  alter column value           set not null;

-- 5. Shape + pairing CHECK function

create or replace function public.claim_value_shape_valid(
  ck constraint_kind_t, vk value_kind_t, v jsonb
) returns boolean language plpgsql immutable as $$
begin
  if ck in ('scalar_min', 'scalar_max', 'range') and vk not in ('number', 'percent') then return false; end if;
  if ck = 'boolean'        and vk <> 'boolean'        then return false; end if;
  if ck = 'enum'           and vk <> 'enum'           then return false; end if;
  if ck = 'ratio'          and vk <> 'ratio'          then return false; end if;
  if ck = 'prose_deferred' and vk <> 'prose_deferred' then return false; end if;

  if ck = 'range' then
    return (v ? 'min') and (v ? 'max');
  end if;

  if vk = 'number' then
    return (v ? 'n') and (v ? 'unit')
      and jsonb_typeof(v->'n') = 'number' and jsonb_typeof(v->'unit') = 'string';
  elsif vk = 'percent' then
    return (v ? 'n') and jsonb_typeof(v->'n') = 'number';
  elsif vk = 'ratio' then
    return (v ? 'numerator') and (v ? 'denominator') and (v ? 'denominator_unit')
      and jsonb_typeof(v->'numerator') = 'number'
      and jsonb_typeof(v->'denominator') = 'number'
      and jsonb_typeof(v->'denominator_unit') = 'string';
  elsif vk = 'boolean' then
    return (v ? 'b') and jsonb_typeof(v->'b') = 'boolean';
  elsif vk = 'enum' then
    return (v ? 'e') and (v ? 'allowed')
      and jsonb_typeof(v->'e') = 'string' and jsonb_typeof(v->'allowed') = 'array';
  elsif vk = 'prose_deferred' then
    return (v ? 'prose') and jsonb_typeof(v->'prose') = 'string';
  end if;

  return false;
end;
$$;

alter table public.claims
  add constraint claims_value_shape_valid
    check (public.claim_value_shape_valid(constraint_kind, value_kind, value));

-- 6. New lookup index (old claims_lookup_idx retained until Migration B)

create index claims_lookup_v2_idx
  on public.claims (jurisdiction_id, zone_district_code, rule_key, constraint_kind);

-- 7. Column comments

comment on column public.claims.value_text    is 'DEPRECATED (Migration A). Use value + value_kind. Dropped in Migration B.';
comment on column public.claims.value_numeric is 'DEPRECATED (Migration A). Use value + value_kind. Dropped in Migration B.';
comment on column public.claims.value_unit    is 'DEPRECATED (Migration A). Use value + value_kind. Dropped in Migration B.';
comment on column public.claims.constraint_kind is 'Compliance semantics. See rule_keys.md §5.';
comment on column public.claims.value_kind      is 'Shape discriminator for value. See rule_keys.md §6.';
comment on column public.claims.value           is 'Structured payload, shape per value_kind, enforced by claim_value_shape_valid().';
comment on column public.claims.scope           is 'Scope axes beyond jurisdiction + zone. See rule_keys.md §7.';
comment on column public.claims.source_table_id is 'Optional FK to document_tables row that produced this claim. ON DELETE SET NULL.';
