-- Per-jurisdiction authority for classifying zoning-string tokens as base zone vs. overlay.
-- Structure only. Classifications are seeded separately (supabase/seed/).

create table public.zone_registry (
    id                uuid primary key default gen_random_uuid(),
    jurisdiction_id   uuid not null references public.jurisdictions(id) on delete cascade,
    code              text not null,
    kind              text not null check (kind in ('base_zone', 'overlay', 'combined')),
    label             text,
    code_section      text not null,
    source_url        text not null,
    notes             text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (jurisdiction_id, code)
);

create index zone_registry_jurisdiction_idx on public.zone_registry (jurisdiction_id);
create index zone_registry_code_idx on public.zone_registry (jurisdiction_id, code);

create trigger zone_registry_set_updated_at
    before update on public.zone_registry
    for each row execute function public.set_updated_at();

comment on table public.zone_registry is
    'Authority for base-vs-overlay classification of zoning tokens, per jurisdiction. Hand-authored from UDC/LDC with citations. Never inferred.';
