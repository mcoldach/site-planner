-- Step 2 of auth: populate ownership. No RLS enforcement yet (Step 3) — this
-- just ensures every user-owned row has an owner before policies turn on.
--
-- User-owned tables: projects, schemes. (sites/site_parcels are owned
-- transitively via their parent project — no direct owner_id, by design.)
-- buckets/objects/s3_* are Supabase Storage internals — not touched.

-- Backfill existing orphaned rows to the founding user.
update projects
  set owner_id = '49b6ad51-9b88-4c9d-87a8-deb83f354656'
  where owner_id is null;

update schemes
  set owner_id = '49b6ad51-9b88-4c9d-87a8-deb83f354656'
  where owner_id is null;

-- New rows: stamp owner_id from the authenticated caller automatically.
-- auth.uid() resolves to the logged-in user's id on inserts through an
-- authenticated client (which the app now is, post-login).
alter table projects alter column owner_id set default auth.uid();
alter table schemes  alter column owner_id set default auth.uid();
