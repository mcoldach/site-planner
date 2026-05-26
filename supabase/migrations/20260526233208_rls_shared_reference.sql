-- Step 3b-i: RLS on shared-reference (public truth layer) tables.
-- Any AUTHENTICATED user may read. No client-side writes (these are populated
-- by Edge Functions [service-role, see 3b-ii] and migrations/seeds).
-- Enabling RLS defaults to deny-all, so each table gets its select policy here
-- in the same migration to avoid a gap where the data goes invisible.

-- parcels: readable by authenticated users. NOTE: Edge Functions also WRITE
-- here (lookup-parcel upserts). Those must use the service-role key (3b-ii),
-- which bypasses RLS. This policy only governs the authenticated app client,
-- which reads parcels for the map/lookup display.
alter table parcels enable row level security;
create policy parcels_select on parcels for select
  to authenticated using (true);

alter table jurisdictions enable row level security;
create policy jurisdictions_select on jurisdictions for select
  to authenticated using (true);

alter table claims enable row level security;
create policy claims_select on claims for select
  to authenticated using (true);

alter table source_snapshots enable row level security;
create policy source_snapshots_select on source_snapshots for select
  to authenticated using (true);

alter table rule_keys enable row level security;
create policy rule_keys_select on rule_keys for select
  to authenticated using (true);

alter table zone_registry enable row level security;
create policy zone_registry_select on zone_registry for select
  to authenticated using (true);
