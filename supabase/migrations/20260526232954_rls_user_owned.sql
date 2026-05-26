-- Step 3a of auth: RLS on USER-OWNED tables only.
-- projects/schemes own via owner_id; sites/site_parcels own transitively via
-- the parent project. Shared-reference tables (parcels, claims, jurisdictions,
-- rule_keys, source_snapshots, zone_registry) are handled in Step 3b.
--
-- Policies use auth.uid(). The app's authenticated client + the save_scheme/
-- update_scheme RPCs run in the caller's auth context (verified: new schemes
-- get the caller's owner_id), so these policies admit the owner correctly.

-- ---- projects: direct ownership -----------------------------------------
alter table projects enable row level security;

create policy projects_select on projects for select
  using (owner_id = auth.uid());
create policy projects_insert on projects for insert
  with check (owner_id = auth.uid());
create policy projects_update on projects for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy projects_delete on projects for delete
  using (owner_id = auth.uid());

-- ---- schemes: direct ownership ------------------------------------------
alter table schemes enable row level security;

create policy schemes_select on schemes for select
  using (owner_id = auth.uid());
create policy schemes_insert on schemes for insert
  with check (owner_id = auth.uid());
create policy schemes_update on schemes for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy schemes_delete on schemes for delete
  using (owner_id = auth.uid());

-- ---- sites: owned via parent project ------------------------------------
alter table sites enable row level security;

create policy sites_select on sites for select
  using (exists (
    select 1 from projects p where p.id = sites.project_id and p.owner_id = auth.uid()
  ));
create policy sites_insert on sites for insert
  with check (exists (
    select 1 from projects p where p.id = sites.project_id and p.owner_id = auth.uid()
  ));
create policy sites_update on sites for update
  using (exists (
    select 1 from projects p where p.id = sites.project_id and p.owner_id = auth.uid()
  ));
create policy sites_delete on sites for delete
  using (exists (
    select 1 from projects p where p.id = sites.project_id and p.owner_id = auth.uid()
  ));

-- ---- site_parcels: owned via parent site -> project ---------------------
alter table site_parcels enable row level security;

create policy site_parcels_select on site_parcels for select
  using (exists (
    select 1 from sites s
    join projects p on p.id = s.project_id
    where s.id = site_parcels.site_id and p.owner_id = auth.uid()
  ));
create policy site_parcels_insert on site_parcels for insert
  with check (exists (
    select 1 from sites s
    join projects p on p.id = s.project_id
    where s.id = site_parcels.site_id and p.owner_id = auth.uid()
  ));
create policy site_parcels_delete on site_parcels for delete
  using (exists (
    select 1 from sites s
    join projects p on p.id = s.project_id
    where s.id = site_parcels.site_id and p.owner_id = auth.uid()
  ));
