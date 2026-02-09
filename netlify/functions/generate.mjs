import { getAuthenticatedUser, getSupabaseAdmin, getFreeLimit } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

const DEFAULT_BACKEND_URL = "https://cover-letter-api-production-fe17.up.railway.app";
const DEFAULT_MODEL = "gpt-4o-mini";

function buildPrompt(jobDescription, resume, tone) {
  return `
You are a professional career coach and hiring manager.

Write a highly tailored, concise, persuasive cover letter based on the inputs.

Rules:
- Match the job description tone (${tone})
- Sound human, not robotic
- Avoid generic phrases like "I am excited to apply" or "I am writing to express my interest"
- Do NOT repeat the resume verbatim
- Focus on value, impact, and fit
- Keep it under 300 words
- No fluff

Job Description:
${jobDescription}

Candidate Resume:
${resume}

Output ONLY the finished cover letter. No headings. No bullets.
`;
}

async function generateViaDirectProvider({ jobDescription, resume, tone }) {
  const apiKey = getEnv("OPENAI_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "AI provider key missing in Netlify env (OPENAI_API_KEY)." };
  }

  const baseUrl = (getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = getEnv("OPENAI_MODEL", DEFAULT_MODEL) || DEFAULT_MODEL;
  const payload = {
    model,
    messages: [{ role: "user", content: buildPrompt(jobDescription, resume, tone) }],
    temperature: 0.7,
  };

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  // Helpful headers for OpenRouter (safe no-op for others).
  const siteUrl = getEnv("SITE_URL");
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  headers["X-Title"] = "CoverCraft";

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        ok: false,
        error: data.error?.message || data.error || `Direct provider error (${r.status})`,
      };
    }
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!text) {
      return { ok: false, error: "Direct provider returned empty output." };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: "Direct provider unavailable: " + err.message };
  }
}

async function generateViaBackend({ jobDescription, resume, tone }) {
  const backendUrl = getEnv("BACKEND_URL", DEFAULT_BACKEND_URL);
  try {
    const backendRes = await fetch(`${backendUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription, resume, tone }),
    });
    const data = await backendRes.json().catch(() => ({}));
    if (!backendRes.ok) {
      return {
        ok: false,
        status: backendRes.status,
        error: data.error || "Generation failed",
      };
    }
    return { ok: true, text: (data.text || "").trim() };
  } catch (err) {
    return { ok: false, status: 502, error: "Backend unavailable: " + err.message };
  }
}

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

  try {
    // 5. Run generation: backend first, direct provider fallback.
    const backendResult = await generateViaBackend({ jobDescription, resume, tone });
    let finalText = "";
    let generationError = "";

    if (backendResult.ok && backendResult.text) {
      finalText = backendResult.text;
    } else {
      const directResult = await generateViaDirectProvider({ jobDescription, resume, tone });
      if (directResult.ok && directResult.text) {
        finalText = directResult.text;
      } else {
        generationError = backendResult.error || directResult.error || "Generation failed";
        if (directResult.error) {
          generationError = directResult.error;
        }
      }
    }

    if (!finalText) {
      let backendError = generationError || "Generation failed";
      const lowered = String(backendError).toLowerCase();
      if (lowered.includes("incorrect api key") || lowered.includes("invalid api key")) {
        backendError = "AI provider key is invalid. Update OPENAI_API_KEY.";
      }
      if (lowered.includes("is not a valid model id")) {
        backendError = "AI model is invalid. Set OPENAI_MODEL to a valid provider model (e.g. openrouter/auto).";
      }
      if (lowered.includes("exceeded your current quota") || lowered.includes("insufficient_quota") || lowered.includes("429")) {
        backendError = "AI provider quota exceeded. Add billing/credits to your provider project, then retry.";
      }

      await supabase.from("generation_logs").insert({
        user_email: user.email,
        user_id: user.id,
        success: false,
        generations_at_request: generationsUsed,
        error_message: backendError,
      }).catch(() => {});

      return jsonResponse(502, { error: backendError });
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

    const fullText = finalText;

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
