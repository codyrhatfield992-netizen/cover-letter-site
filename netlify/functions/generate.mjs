import { getAuthenticatedUser, getSupabaseAdmin, getFreeLimit } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return optionsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // 1. Require authentication
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse(401, { error: "Not authenticated" });
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

    return jsonResponse(403, {
      error: "limit_reached",
      message: "You've used all 3 free generations. Upgrade for unlimited access.",
      generations_used: generationsUsed,
      free_limit: freeLimit,
    });
  }

  // 4. Parse request body
  let body;
  try {
    body = await req.json();
  } catch (_) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { jobDescription, resume, tone } = body;
  if (!jobDescription || !resume) {
    return jsonResponse(400, { error: "Job description and resume are required" });
  }

  // 5. Run generation against the backend
  const backendUrl = getEnv("BACKEND_URL", "https://cover-letter-api-production-fe17.up.railway.app");

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

      return jsonResponse(backendRes.status, { error: data.error || "Generation failed" });
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

    // 8. Determine access level.
    // At this point, free-tier users are still within their allowed generations,
    // so successful responses should return full access.
    const freeRemainingAfterGeneration = Math.max(0, freeLimit - newCount);
    const responsePayload = {
      text: fullText,
      full_access: true,
      generations_used: newCount,
      free_limit: freeLimit,
      free_remaining: isSubscribed ? null : freeRemainingAfterGeneration,
      locked: false,
    };

    return jsonResponse(200, responsePayload);
  } catch (err) {
    // Log error
    await supabase.from("generation_logs").insert({
      user_email: user.email,
      user_id: user.id,
      success: false,
      generations_at_request: generationsUsed,
      error_message: "Backend unavailable: " + err.message,
    }).catch(() => {});

    return jsonResponse(502, { error: "Backend unavailable: " + err.message });
  }
};

export const config = {
  path: "/api/generate",
};
