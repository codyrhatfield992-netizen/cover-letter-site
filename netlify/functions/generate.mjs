import { getAuthenticatedUser, getSupabaseAdmin, getFreeLimit } from "./shared/supabase.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Require authentication
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Fetch profile to check subscription and generation count
  const supabase = getSupabaseAdmin();
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_pro, subscription_status, generations_used")
    .eq("id", user.id)
    .single();

  const generationsUsed = profile?.generations_used || 0;
  const isSubscribed = profile?.is_pro === true && profile?.subscription_status === "active";
  const freeLimit = getFreeLimit();
  const freeRemaining = Math.max(0, freeLimit - generationsUsed);

  // 3. Block if no active subscription AND free generations exhausted
  if (!isSubscribed && freeRemaining <= 0) {
    // Log the blocked attempt
    await supabase.from("generation_logs").insert({
      user_email: user.email,
      user_id: user.id,
      success: false,
      generations_at_request: generationsUsed,
      error_message: "Free limit exhausted, no active subscription",
    }).catch(() => {});

    return new Response(
      JSON.stringify({
        error: "limit_reached",
        message: "You've used all 3 free generations. Upgrade for unlimited access.",
        generations_used: generationsUsed,
        free_limit: freeLimit,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // 4. Parse request body
  let body;
  try {
    body = await req.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { jobDescription, resume, tone } = body;
  if (!jobDescription || !resume) {
    return new Response(
      JSON.stringify({ error: "Job description and resume are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // 5. Run generation against the backend
 const backendUrl =
  process.env.BACKEND_URL ||
  "https://cover-letter-api-production-fe17.up.railway.app";

  try {
    const backendRes = await fetch(`${backendUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription, resume, tone }),
    });

    const data = await backendRes.json().catch(() => ({}));

    if (!backendRes.ok) {
      // Log failure
      await supabase.from("generation_logs").insert({
        user_email: user.email,
        user_id: user.id,
        success: false,
        generations_at_request: generationsUsed,
        error_message: data.error || "Backend generation failed",
      }).catch(() => {});

      return new Response(
        JSON.stringify({ error: data.error || "Generation failed" }),
        {
          status: backendRes.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 6. Increment generation count
    const newCount = generationsUsed + 1;
    await supabase
      .from("profiles")
      .update({ generations_used: newCount, updated_at: new Date().toISOString() })
      .eq("id", user.id)
      .catch(() => {});

    // 7. Log success
    await supabase.from("generation_logs").insert({
      user_email: user.email,
      user_id: user.id,
      success: true,
      generations_at_request: newCount,
    }).catch(() => {});

    const fullText = (data.text || "").trim();

    // 8. Determine access level
    // If subscribed: return full text
    // If free tier: return full text (they still have free generations)
    const responsePayload = {
      text: fullText,
      full_access: isSubscribed,
      generations_used: newCount,
      free_limit: freeLimit,
      free_remaining: isSubscribed ? null : Math.max(0, freeLimit - newCount),
    };

    // If NOT subscribed, only send a preview (first ~4 lines) + signal to paywall
    if (!isSubscribed) {
      const lines = fullText.split("\n");
      const previewLines = lines.slice(0, 4).join("\n");
      responsePayload.preview = previewLines;
      responsePayload.text = fullText; // still send full text; frontend controls unlock
      responsePayload.locked = true;
    }

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Log error
    await supabase.from("generation_logs").insert({
      user_email: user.email,
      user_id: user.id,
      success: false,
      generations_at_request: generationsUsed,
      error_message: "Backend unavailable: " + err.message,
    }).catch(() => {});

    return new Response(
      JSON.stringify({ error: "Backend unavailable: " + err.message }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = {
  path: "/api/generate",
};
