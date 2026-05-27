-- Storage RLS for the 'documents' bucket.
--
-- storage.objects has its own RLS (separate from the public-schema tables).
-- The schema migration created the bucket private but did NOT add object-level
-- policies — so authenticated users can't upload by default. These policies
-- mirror the pattern on the documents table itself: authenticated read,
-- owner-restricted write.
--
-- 'owner' on storage.objects is the auth.uid() of the uploader (set
-- automatically by Storage). Restricting writes by owner = auth.uid() means
-- a user can only modify/delete files they themselves uploaded.

create policy "documents bucket: authenticated select"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents');

create policy "documents bucket: authenticated insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'documents' and owner = auth.uid());

create policy "documents bucket: owner update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'documents' and owner = auth.uid())
  with check (bucket_id = 'documents' and owner = auth.uid());

create policy "documents bucket: owner delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'documents' and owner = auth.uid());
