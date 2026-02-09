import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  const apiKey = getEnv("OPENAI_API_KEY");
  const baseUrl = getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = getEnv("OPENAI_MODEL", "gpt-4o-mini");

  if (!apiKey) {
    return jsonResponse(200, { ok: false, error: "OPENAI_API_KEY missing" });
  }

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": getEnv("SITE_URL", ""),
        "X-Title": "CoverCraft",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Write one sentence saying this test worked." }],
        temperature: 0.2,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return jsonResponse(200, {
        ok: false,
        status: r.status,
        model,
        baseUrl,
        error: data?.error?.message || data?.error || "chat/completions failed",
      });
    }

    return jsonResponse(200, {
      ok: true,
      status: r.status,
      model,
      baseUrl,
      output: data?.choices?.[0]?.message?.content || null,
    });
  } catch (err) {
    return jsonResponse(200, {
      ok: false,
      model,
      baseUrl,
      error: err.message,
    });
  }
};

export const config = {
  path: "/api/diag-generate",
};
