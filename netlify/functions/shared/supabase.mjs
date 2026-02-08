import { createClient } from "@supabase/supabase-js";

const supabaseUrl = Netlify.env.get("SUPABASE_URL") || "";
const supabaseServiceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export function getSupabaseAdmin() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getAuthenticatedUser(req) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const anonKey = Netlify.env.get("SUPABASE_ANON_KEY") || "";
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
