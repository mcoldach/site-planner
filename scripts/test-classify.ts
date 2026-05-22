/**
 * scripts/test-classify.ts
 *
 * Fetches all parcels; for each, calls classify_zoning and get_parcel_context.
 *
 * Run:
 *   pnpm classify:test
 *
 * Env (loaded from .env.local):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type ParcelRow = {
  id: string;
  source_apn: string;
  zoning_code: string | null;
};

type ClaimRow = {
  zone_district_code: string | null;
};

type ParcelContextResponse = {
  jurisdiction: { id: string } | null;
  classification: unknown;
  claims: ClaimRow[];
};

function claimsSummary(claims: ClaimRow[]): {
  count: number;
  zone_district_codes: (string | null)[];
} {
  return {
    count: claims.length,
    zone_district_codes: [...new Set(claims.map((c) => c.zone_district_code))],
  };
}

async function main(): Promise<void> {
  console.log('test-classify: starting\n');

  const { data: parcels, error } = await supabase
    .from('parcels')
    .select('id, source_apn, zoning_code:raw_attrs->>zoningCode')
    .order('source_apn');

  if (error) {
    throw new Error(`Failed to fetch parcels: ${error.message}`);
  }

  if (!parcels || parcels.length === 0) {
    console.log('No parcels found.');
    return;
  }

  for (const parcel of parcels as ParcelRow[]) {
    const zoningString = parcel.zoning_code ?? '';

    const { data: ctx, error: ctxErr } = await supabase.rpc('get_parcel_context', {
      _parcel_id: parcel.id,
    });
    if (ctxErr) {
      throw new Error(`get_parcel_context failed for ${parcel.source_apn}: ${ctxErr.message}`);
    }

    const context = ctx as ParcelContextResponse | null;
    const jurisdictionId = context?.jurisdiction?.id ?? null;

    const { error: rpcErr } = await supabase.rpc('classify_zoning', {
      p_jurisdiction_id: jurisdictionId,
      p_zoning_string: zoningString,
    });
    if (rpcErr) {
      throw new Error(`classify_zoning failed for ${parcel.source_apn}: ${rpcErr.message}`);
    }

    const claims = context?.claims ?? [];

    console.log(`--- ${parcel.source_apn} ---`);
    console.log('classification:');
    console.log(JSON.stringify(context?.classification ?? null, null, 2));
    console.log('claims:', claimsSummary(claims));
    console.log();
  }

  console.log('test-classify: done');
}

main().catch((err) => {
  console.error('\ntest-classify: FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
