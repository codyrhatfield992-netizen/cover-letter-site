import { getAuthenticatedUser, getSupabaseAdmin } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

function mask(v) {
  if (!v) return "";
  if (v.length < 10) return "***";
  return v.slice(0, 6) + "..." + v.slice(-4);
}

export default async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");
  const stripePaymentLink = getEnv("STRIPE_PAYMENT_LINK");
  const siteUrl = getEnv("SITE_URL") || getEnv("URL");

  const env = {
    has_stripe_secret_key: Boolean(stripeSecretKey),
    stripe_secret_key_preview: mask(stripeSecretKey),
    has_stripe_webhook_secret: Boolean(stripeWebhookSecret),
    stripe_webhook_secret_preview: mask(stripeWebhookSecret),
    has_stripe_payment_link: Boolean(stripePaymentLink),
    stripe_payment_link: stripePaymentLink || null,
    site_url: siteUrl || null,
  };

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse(200, {
      ok: false,
      auth: { logged_in: false },
      env,
      error: "Not authenticated for profile check.",
    });
  }

  const supabase = getSupabaseAdmin();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, email, is_pro, subscription_status, stripe_customer_id, stripe_subscription_id, plan_id, current_period_end, generations_used, updated_at")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    return jsonResponse(200, {
      ok: false,
      auth: { logged_in: true, user_id: user.id, email: user.email },
      env,
      error: error.message,
    });
  }

  return jsonResponse(200, {
    ok: true,
    auth: { logged_in: true, user_id: user.id, email: user.email },
    env,
    profile: profile || null,
  });
};

export const config = {
  path: "/api/diag-stripe",
};
