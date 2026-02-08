import { createClient } from "@supabase/supabase-js";
import { getEnv } from "./env.mjs";

const supabaseUrl = getEnv("SUPABASE_URL");
const supabaseServiceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

function assertSupabaseAdminEnv() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Supabase admin env is missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
}

export function getSupabaseAdmin() {
  assertSupabaseAdminEnv();
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getAuthenticatedUser(req) {
  if (!supabaseUrl) return null;

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const anonKey = getEnv("SUPABASE_ANON_KEY");
  if (!anonKey) return null;
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error,
  } = await userClient.auth.getUser(token);

  if (error || !user) return null;
  return user;
}

const FREE_GENERATION_LIMIT = 3;

export function getFreeLimit() {
  return FREE_GENERATION_LIMIT;
}
