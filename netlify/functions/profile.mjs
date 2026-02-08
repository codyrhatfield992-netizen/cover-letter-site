import { getAuthenticatedUser, getSupabaseAdmin, getFreeLimit } from "./shared/supabase.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = getSupabaseAdmin();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    return new Response(
      JSON.stringify({
        profile: {
          is_pro: false,
          subscription_status: "none",
          generations_used: 0,
          free_limit: getFreeLimit(),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      profile: {
        ...profile,
        free_limit: getFreeLimit(),
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};

export const config = {
  path: "/api/profile",
};
