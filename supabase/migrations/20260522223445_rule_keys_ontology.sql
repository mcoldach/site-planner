-- Rule-keys ontology: controlled vocabulary for claim rule_keys.
-- Serves (1) canonicalization (prevent drift as claims grow) and
-- (2) directionality metadata for the future most-restrictive overlay resolver.
-- SOFT validation: claims keep rule_key as free text (no FK); unregistered keys
-- are SURFACED, not rejected (rule-layer echo of unclassified zone tokens).
-- Absorbs the hardcoded RULE_LABELS + getRuleCategory from src/lib/rule-catalog.ts.
-- NOT a rules engine: no unit conversion, no value validation, no cross-rule deps.

create table public.rule_keys (
    key             text primary key,            -- canonical dotted key, e.g. 'setback.front.min'
    label           text not null,               -- human-readable, e.g. 'Front setback — minimum'
    category        text not null check (category in (
                       'Setbacks', 'Height', 'Lot dimensions', 'Permitted uses', 'Other'
                    )),
    value_type      text not null check (value_type in ('numeric', 'boolean', 'text')),
    canonical_unit  text,                         -- e.g. 'ft', 'acres', 'percent'; null for boolean/text
    direction       text not null check (direction in ('lower', 'higher', 'false', 'n/a')),
                    -- which way is MORE restrictive (for the deferred resolver):
                    -- 'lower' = smaller value more restrictive (height.max, coverage.max)
                    -- 'higher' = larger value more restrictive (lot.area.min, setback.*.min)
                    -- 'false' = the boolean false is more restrictive (use.permitted.*)
                    -- 'n/a' = directionality not meaningful
    description     text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create trigger rule_keys_set_updated_at
    before update on public.rule_keys
    for each row execute function public.set_updated_at();

comment on table public.rule_keys is
    'Controlled vocabulary for claim rule_keys. Soft-validated (no FK from claims). '
    'Direction column feeds the future most-restrictive overlay resolver (not yet built).';

-- Seed the 10 existing keys, lifted from rule-catalog.ts (labels/categories) with
-- directionality derived from key grammar.
insert into public.rule_keys (key, label, category, value_type, canonical_unit, direction) values
  ('setback.front.min',        'Front setback — minimum',              'Setbacks',       'numeric', 'ft',      'higher'),
  ('setback.front.max',        'Front setback — max / build-to line',  'Setbacks',       'numeric', 'ft',      'lower'),
  ('setback.side.min',         'Side setback — minimum',               'Setbacks',       'numeric', 'ft',      'higher'),
  ('setback.rear.min',         'Rear setback — minimum',               'Setbacks',       'numeric', 'ft',      'higher'),
  ('height.max',               'Building height — maximum',            'Height',         'numeric', 'ft',      'lower'),
  ('height.max.principal',     'Principal building height — maximum',  'Height',         'numeric', 'ft',      'lower'),
  ('lot.coverage.max',         'Lot coverage — maximum',               'Lot dimensions', 'numeric', 'percent', 'lower'),
  ('lot.area.min',             'Lot area — minimum',                   'Lot dimensions', 'numeric', 'acres',   'higher'),
  ('use.permitted.multifamily','Multifamily dwellings',                'Permitted uses', 'boolean', null,      'false'),
  ('use.permitted.agriculture','Agricultural uses',                    'Permitted uses', 'boolean', null,      'false')
on conflict (key) do update set
  label          = excluded.label,
  category       = excluded.category,
  value_type     = excluded.value_type,
  canonical_unit = excluded.canonical_unit,
  direction      = excluded.direction;
