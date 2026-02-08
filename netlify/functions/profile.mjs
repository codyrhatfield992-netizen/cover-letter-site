import { getAuthenticatedUser, getSupabaseAdmin, getFreeLimit } from "./shared/supabase.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return optionsResponse();
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse(401, { error: "Not authenticated" });
  }

  const supabase = getSupabaseAdmin();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    return jsonResponse(200, {
      profile: {
        is_pro: false,
        subscription_status: "none",
        generations_used: 0,
        free_limit: getFreeLimit(),
      },
    });
  }

  return jsonResponse(200, {
    profile: {
      ...profile,
      free_limit: getFreeLimit(),
    },
  });
};

export const config = {
  path: "/api/profile",
};
