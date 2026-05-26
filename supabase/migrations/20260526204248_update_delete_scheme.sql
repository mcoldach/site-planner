-- update_scheme: update an existing scheme's footprint/name/height in place
-- (mirrors save_scheme's server-side geometry conversion). Ends the
-- duplicate-creation problem — editing a scheme updates it rather than
-- inserting a new row.
create or replace function update_scheme(
  _scheme_id uuid,
  _name text,
  _footprint_geojson jsonb,
  _height_ft numeric
)
returns uuid
language plpgsql
as $$
begin
  update schemes
  set name = _name,
      footprint = extensions.ST_SetSRID(
        extensions.ST_GeomFromGeoJSON(_footprint_geojson::text), 4326),
      height_ft = _height_ft,
      updated_at = now()
  where id = _scheme_id;
  if not found then
    raise exception 'update_scheme: scheme % not found', _scheme_id;
  end if;
  return _scheme_id;
end;
$$;

-- delete_scheme: remove a scheme. (Not a "permanent destructive" app action in
-- the dangerous sense — it's a user deleting their own draft layout option.)
create or replace function delete_scheme(_scheme_id uuid)
returns void
language plpgsql
as $$
begin
  delete from schemes where id = _scheme_id;
  if not found then
    raise exception 'delete_scheme: scheme % not found', _scheme_id;
  end if;
end;
$$;
