import { createHmac, timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

function verifyLemonSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const sig = String(signature).trim().replace(/^sha256=/i, "");
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (sig.length !== digest.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
  } catch (_) {
    return false;
  }
}

function toIsoOrNull(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function mapSubscriptionState(status, attrs) {
  const raw = String(status || "").toLowerCase();
  const endsAtIso = toIsoOrNull(attrs?.renews_at) || toIsoOrNull(attrs?.ends_at) || toIsoOrNull(attrs?.trial_ends_at);
  const endsAtMs = endsAtIso ? Date.parse(endsAtIso) : 0;
  const hasFutureAccess = endsAtMs && endsAtMs > Date.now();

  if (raw === "active") return { subscription_status: "active", is_pro: true, current_period_end: endsAtIso };
  if (raw === "on_trial" || raw === "trialing") return { subscription_status: "trialing", is_pro: true, current_period_end: endsAtIso };
  if ((raw === "cancelled" || raw === "canceled") && hasFutureAccess) {
    return { subscription_status: "active", is_pro: true, current_period_end: endsAtIso };
  }
  return { subscription_status: raw || "none", is_pro: false, current_period_end: endsAtIso };
}

async function resolveUserId(supabase, payload) {
  const customData = payload?.meta?.custom_data || payload?.data?.attributes?.custom_data || {};
  const attrs = payload?.data?.attributes || {};
  let userId = customData.user_id || customData.userId || attrs.user_id || null;
  const email =
    customData.user_email ||
    customData.userEmail ||
    attrs.user_email ||
    attrs.email ||
    attrs.customer_email ||
    null;

  if (!userId && email) {
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", String(email))
      .maybeSingle();
    if (data?.id) userId = data.id;
  }

  return { userId, email: email ? String(email) : null };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return optionsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const secret = getEnv("LEMON_WEBHOOK_SECRET");
  if (!secret) {
    return jsonResponse(500, { error: "Missing LEMON_WEBHOOK_SECRET" });
  }

  const signature = req.headers.get("x-signature");
  const rawBody = await req.text();
  if (!verifyLemonSignature(rawBody, signature, secret)) {
    return jsonResponse(400, { error: "Invalid signature" });
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (_) {
    return jsonResponse(400, { error: "Invalid JSON payload" });
  }

  const eventName = String(payload?.meta?.event_name || "").toLowerCase();
  const type = String(payload?.data?.type || "").toLowerCase();
  const attrs = payload?.data?.attributes || {};

  const looksSubscriptionEvent =
    eventName.startsWith("subscription_") ||
    type === "subscriptions";

  if (!looksSubscriptionEvent) {
    return jsonResponse(200, { received: true, ignored: true });
  }

  const allowedProductId = getEnv("LEMON_PRODUCT_ID");
  const productId = String(attrs.product_id || attrs.first_order_item?.product_id || "");
  if (allowedProductId && productId && String(allowedProductId) !== productId) {
    return jsonResponse(200, { received: true, ignored: true, reason: "product_mismatch" });
  }

  const supabase = getSupabaseAdmin();
  const { userId, email } = await resolveUserId(supabase, payload);
  if (!userId) {
    return jsonResponse(200, { received: true, matched: false });
  }

  const mapped = mapSubscriptionState(attrs.status, attrs);
  const variantId = attrs.variant_id ? String(attrs.variant_id) : "";
  const updatePayload = {
    id: userId,
    email,
    is_pro: mapped.is_pro,
    subscription_status: mapped.subscription_status,
    current_period_end: mapped.current_period_end,
    plan_id: variantId ? `lemon:${variantId}` : "lemon",
    updated_at: new Date().toISOString(),
  };

  await supabase
    .from("profiles")
    .upsert(updatePayload, { onConflict: "id" })
    .catch(() => {});

  return jsonResponse(200, { received: true, matched: true });
};

export const config = {
  path: "/api/lemon/webhook",
};

