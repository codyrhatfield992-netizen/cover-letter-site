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

function sentenceize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHighlights(resume) {
  const parts = String(resume || "")
    .split(/\n+/)
    .map((s) => sentenceize(s))
    .filter((s) => s.length > 20);
  return parts.slice(0, 4);
}

function extractPriorities(jobDescription) {
  const parts = String(jobDescription || "")
    .split(/\n+/)
    .map((s) => sentenceize(s))
    .filter((s) => s.length > 20);
  return parts.slice(0, 3);
}

function generateFallbackCoverLetter({ jobDescription, resume, tone }) {
  const priorities = extractPriorities(jobDescription);
  const highlights = extractHighlights(resume);
  const roleLine = priorities[0] || "the role";

  const lines = [];
  lines.push("Dear Hiring Manager,");
  lines.push("");
  lines.push(`I am applying for ${roleLine}. My background aligns well with your needs, and I communicate in a ${tone || "confident and natural"} style while focusing on measurable outcomes.`);
  lines.push("");
  if (highlights.length > 0) {
    lines.push("Relevant experience I would bring includes:");
    highlights.forEach((h) => lines.push(`- ${h}`));
    lines.push("");
  }
  if (priorities.length > 1) {
    lines.push("I am especially interested in contributing to priorities such as:");
    priorities.slice(1).forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }
  lines.push("I would welcome the opportunity to discuss how I can contribute to your team from day one.");
  lines.push("");
  lines.push("Sincerely,");
  lines.push("[Your Name]");
  return lines.join("\n");
}

function buildLockedPreview(text, ratio = 0.5) {
  const src = String(text || "").trim();
  if (!src) return "";

  const safeRatio = Math.min(0.6, Math.max(0.4, ratio));
  const cut = Math.max(160, Math.floor(src.length * safeRatio));
  let preview = src.slice(0, cut);
  const sentenceBreak = Math.max(preview.lastIndexOf(". "), preview.lastIndexOf("\n\n"));
  if (sentenceBreak > 120) {
    preview = preview.slice(0, sentenceBreak + 1);
  }
  return preview.trim();
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
  await supabase
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email: user.email || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )
    .catch(() => {});

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_pro, subscription_status, generations_used")
    .eq("id", user.id)
    .single();

  const generationsUsed = profile?.generations_used || 0;
  const subscriptionStatus = String(profile?.subscription_status || "").toLowerCase();
  const isSubscribed =
    profile?.is_pro === true &&
    (subscriptionStatus === "active" || subscriptionStatus === "trialing");
  const freeLimit = getFreeLimit();
  const freeRemaining = Math.max(0, freeLimit - generationsUsed);

  const lockPreviewOnly = !isSubscribed && freeRemaining <= 0;

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
      const allowLocalFallback = getEnv("ALLOW_LOCAL_FALLBACK", "").toLowerCase() === "true";
      if (allowLocalFallback) {
        finalText = generateFallbackCoverLetter({ jobDescription, resume, tone });
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
    const freeRemainingAfterGeneration = Math.max(0, freeLimit - newCount);
    const responsePayload = lockPreviewOnly
      ? {
          text: "",
          preview: buildLockedPreview(fullText, 0.5),
          full_access: false,
          locked: true,
          message: "Unlock the full letter + unlimited generations for $9.99/month.",
          generations_used: newCount,
          free_limit: freeLimit,
          free_remaining: 0,
        }
      : {
          text: fullText,
          full_access: true,
          locked: false,
          generations_used: newCount,
          free_limit: freeLimit,
          free_remaining: isSubscribed ? null : freeRemainingAfterGeneration,
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
