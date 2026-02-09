import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

function mask(value) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return value.slice(0, 6) + "..." + value.slice(-4);
}

export default async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  const apiKey = getEnv("OPENAI_API_KEY");
  const baseUrl = getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  const model = getEnv("OPENAI_MODEL", "gpt-4o-mini");

  const env = {
    has_openai_api_key: Boolean(apiKey),
    openai_api_key_preview: mask(apiKey),
    openai_base_url: baseUrl,
    openai_model: model,
  };

  if (!apiKey) {
    return jsonResponse(200, {
      ok: false,
      env,
      error: "OPENAI_API_KEY is missing in Netlify env vars.",
    });
  }

  try {
    const r = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return jsonResponse(200, {
        ok: false,
        env,
        provider_status: r.status,
        provider_error: data?.error?.message || data?.error || "Provider call failed",
      });
    }
    return jsonResponse(200, {
      ok: true,
      env,
      provider_status: r.status,
      models_count: Array.isArray(data?.data) ? data.data.length : null,
    });
  } catch (err) {
    return jsonResponse(200, {
      ok: false,
      env,
      provider_error: err.message,
    });
  }
};

export const config = {
  path: "/api/diag-ai",
};
