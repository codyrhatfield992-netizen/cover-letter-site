import Stripe from "stripe";
import { getAuthenticatedUser, getSupabaseAdmin } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

function appendIfValue(params, key, value) {
  if (value === undefined || value === null) return;
  const s = String(value).trim();
  if (!s) return;
  params.set(key, s);
}

export default async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return optionsResponse();
    }

    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const user = await getAuthenticatedUser(req);
    if (!user) {
      return jsonResponse(401, { error: "Not authenticated" });
    }

    const rawSiteUrl = getEnv("SITE_URL") || getEnv("URL") || req.headers.get("origin") || "";
    let siteUrl = "";
    try {
      siteUrl = new URL(rawSiteUrl).origin;
    } catch (_) {}
    if (!siteUrl) {
      return jsonResponse(500, { error: "Missing SITE_URL/URL for checkout redirect URLs" });
    }

    // Lemon Squeezy path (preferred when configured).
    const lemonCheckoutUrl = getEnv("LEMON_CHECKOUT_URL");
    if (lemonCheckoutUrl) {
      try {
        const u = new URL(lemonCheckoutUrl);
        appendIfValue(u.searchParams, "checkout[email]", user.email);
        appendIfValue(u.searchParams, "checkout[custom][user_id]", user.id);
        appendIfValue(u.searchParams, "checkout[custom][user_email]", user.email);
        appendIfValue(u.searchParams, "checkout[success_url]", `${siteUrl}/?checkout=success&paid=1`);
        appendIfValue(u.searchParams, "checkout[cancel_url]", `${siteUrl}/`);
        return jsonResponse(200, { url: u.toString(), provider: "lemon" });
      } catch (_) {
        return jsonResponse(500, { error: "LEMON_CHECKOUT_URL is invalid." });
      }
    }

    // Stripe path.
    const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
    const priceId = getEnv("STRIPE_PRICE_ID");
    if (!stripeSecretKey || !priceId) {
      return jsonResponse(500, {
        error: "Missing checkout env. Set LEMON_CHECKOUT_URL or STRIPE_SECRET_KEY + STRIPE_PRICE_ID.",
      });
    }

    const stripe = new Stripe(stripeSecretKey);

    let profile = null;
    try {
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

      const profileRes = await supabase
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", user.id)
        .single();
      profile = profileRes?.data || null;
    } catch (_) {
      // Continue without profile optimization if Supabase admin env is unavailable.
    }

    const sessionParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      success_url: `${siteUrl}/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/`,
    };

    // Reuse existing Stripe customer if available
    if (profile?.stripe_customer_id) {
      sessionParams.customer = profile.stripe_customer_id;
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    if (!session.url) {
      return jsonResponse(500, { error: "Stripe checkout did not return a redirect URL." });
    }
    return jsonResponse(200, { url: session.url });
  } catch (err) {
    return jsonResponse(500, { error: err?.message || "Checkout session failed" });
  }
};

export const config = {
  path: "/api/stripe/create-checkout-session",
};
