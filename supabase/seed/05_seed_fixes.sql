-- Session 8 data fixes — POST-SEED corrections. Run LAST, after seed:parcels.
-- Re-running seed:parcels repopulates raw compound zoning (e.g. "BP/CR CU HS SS"),
-- so these normalizations to base zone must run after that seed to take effect.
-- Overlays remain preserved in parcels.raw_attrs.zoningCode.

-- Normalize parcel zone codes to operative base zone (matches claim zone_district_code keys)
update parcels set zone_district_code = 'RR-5' where source_apn = '5200000561';
update parcels set zone_district_code = 'I-2'  where source_apn = '5300000265';
update parcels set zone_district_code = 'BP'   where source_apn = '6307405009';
update parcels set zone_district_code = 'LI'   where source_apn = '7336400022';

-- Normalize malformed rule key (human label belongs in RULE_LABELS, not the key)
update claims set rule_key = 'setback.front.max' where rule_key = 'setback.front.max (build-to)';
