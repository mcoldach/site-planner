import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (url == null || String(url).trim() === "") {
  throw new Error(
    "Missing VITE_SUPABASE_URL: add it to .env.local (see .env.example). This must be your Supabase project URL.",
  );
}

if (anonKey == null || String(anonKey).trim() === "") {
  throw new Error(
    "Missing VITE_SUPABASE_ANON_KEY: add it to .env.local (see .env.example). This must be your Supabase anon (public) API key.",
  );
}

export const supabase = createClient(url, anonKey);
