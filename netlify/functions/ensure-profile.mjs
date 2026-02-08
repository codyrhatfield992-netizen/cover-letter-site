import { getAuthenticatedUser, getSupabaseAdmin } from "./shared/supabase.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return optionsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse(401, { error: "Not authenticated" });
  }

  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      email: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  if (error) {
    return jsonResponse(500, { error: error.message });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return jsonResponse(200, { profile });
};

export const config = {
  path: "/api/ensure-profile",
};
