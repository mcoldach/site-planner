-- Session 8 data fixes (run manually in SQL Editor 2026-05-22)
-- Normalize parcel zone codes to base zone (overlays preserved in raw_attrs.zoningCode)
-- update parcels set zone_district_code = '...' where source_apn = '...';  -- fill in the ones you ran
update claims set rule_key = 'setback.front.max' where rule_key = 'setback.front.max (build-to)';
