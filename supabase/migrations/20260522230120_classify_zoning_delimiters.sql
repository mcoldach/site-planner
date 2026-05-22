-- Fix: real assessor zoning strings use commas (e.g. 'RR-5, RS-5000'), not just
-- space/slash. Surfaced by arbitrary parcel lookup (5200000577). Add comma and
-- semicolon to the tokenizer split pattern. Hyphen still preserved (RR-5 intact).
-- Only the regexp split pattern changes; all other logic byte-identical.

create or replace function public.classify_zoning(
    p_jurisdiction_id uuid,
    p_zoning_string   text
)
returns jsonb
language sql
stable
as $$
    with tokens as (
        select distinct trim(tok) as code
        from regexp_split_to_table(coalesce(p_zoning_string, ''), '[[:space:]/,;]+') as tok
        where trim(tok) <> ''
    ),
    classified as (
        select t.code, zr.kind, zr.label, zr.code_section, zr.source_url
        from tokens t
        left join public.zone_registry zr
               on zr.jurisdiction_id = p_jurisdiction_id
              and zr.code = t.code
    )
    select jsonb_build_object(
        'base_codes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'code', code, 'label', label,
                'code_section', code_section, 'source_url', source_url) order by code)
            from classified where kind = 'base_zone'), '[]'::jsonb),
        'overlay_codes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'code', code, 'label', label,
                'code_section', code_section, 'source_url', source_url) order by code)
            from classified where kind = 'overlay'), '[]'::jsonb),
        'combined_codes', coalesce((
            select jsonb_agg(jsonb_build_object(
                'code', code, 'label', label,
                'code_section', code_section, 'source_url', source_url) order by code)
            from classified where kind = 'combined'), '[]'::jsonb),
        'unclassified_codes', coalesce((
            select jsonb_agg(code order by code)
            from classified where kind is null), '[]'::jsonb)
    );
$$;
