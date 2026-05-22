-- Zone classification reference data (idempotent upsert).
-- Authority for base-vs-overlay classification; authored from UDC/LDC with citations.
-- Append-only: corrections ship as NEW migrations, never edits to this file.
-- Covers the 7 verified tokens in Phase 0 parcel data.
-- CR / CU / UV deliberately omitted (unresolved) -> handled by the coverage-honesty path until classified from SpringsView.

insert into public.zone_registry (jurisdiction_id, code, kind, label, code_section, source_url, notes)
values
  ((select id from public.jurisdictions where slug = 'el_paso_county_unincorporated'),
   'RR-5', 'base_zone', 'Residential Rural (5-acre)',
   'LDC Ch. 3 §3.2 (Zoning District Purposes); Table 3.1',
   'https://library.municode.com/co/el_paso_county/codes/land_development_code', null),

  ((select id from public.jurisdictions where slug = 'el_paso_county_unincorporated'),
   'I-2', 'base_zone', 'Limited Industrial',
   'LDC Ch. 3 §3.2 (Zoning District Purposes); Table 3.1',
   'https://library.municode.com/co/el_paso_county/codes/land_development_code', null),

  ((select id from public.jurisdictions where slug = 'el_paso_county_unincorporated'),
   'CAD-O', 'overlay', 'Commercial Airport Overlay District',
   'LDC Ch. 4 §4.3 (Overlay Zoning Districts)',
   'https://library.municode.com/co/el_paso_county/codes/land_development_code',
   'Use/procedural overlay; LDC mandates most-restrictive of overlay and base controls. Sub-zones (ANAV, ADNL, APZ-1, APZ-2) not yet modeled.'),

  ((select id from public.jurisdictions where slug = 'colorado_springs'),
   'BP', 'base_zone', 'Business Park', 'UDC §7.2.401',
   'https://codelibrary.amlegal.com/codes/coloradospringsco/latest/overview', null),

  ((select id from public.jurisdictions where slug = 'colorado_springs'),
   'LI', 'base_zone', 'Light Industrial', 'UDC §7.2.402',
   'https://codelibrary.amlegal.com/codes/coloradospringsco/latest/overview', null),

  ((select id from public.jurisdictions where slug = 'colorado_springs'),
   'HS', 'overlay', 'Hillside Overlay', 'UDC §7.2.610 (HS-O)',
   'https://codelibrary.amlegal.com/codes/coloradospringsco/latest/overview',
   'Assessor records legacy bare form "HS"; current UDC code is HS-O.'),

  ((select id from public.jurisdictions where slug = 'colorado_springs'),
   'SS', 'overlay', 'Streamside Overlay', 'UDC §7.2.603 (SS-O)',
   'https://codelibrary.amlegal.com/codes/coloradospringsco/latest/overview',
   'Assessor records legacy bare form "SS"; current UDC code is SS-O.')

on conflict (jurisdiction_id, code) do update set
  kind         = excluded.kind,
  label        = excluded.label,
  code_section = excluded.code_section,
  source_url   = excluded.source_url,
  notes        = excluded.notes;
