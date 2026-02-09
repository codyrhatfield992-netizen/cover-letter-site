import Stripe from "stripe";
import { getAuthenticatedUser, getSupabaseAdmin } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

export default async (req) => {
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

  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  const priceId = getEnv("STRIPE_PRICE_ID");
  if (!stripeSecretKey || !priceId) {
    return jsonResponse(500, {
      error: "Missing Stripe checkout env. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.",
    });
  }

  const stripe = new Stripe(stripeSecretKey);
  const rawSiteUrl = getEnv("SITE_URL") || getEnv("URL") || req.headers.get("origin") || "";
  let siteUrl = "";
  try {
    siteUrl = new URL(rawSiteUrl).origin;
  } catch (_) {}
  if (!siteUrl) {
    return jsonResponse(500, { error: "Missing SITE_URL/URL for Stripe redirect URLs" });
  }

  // Check if user already has a Stripe customer ID
  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();

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

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    if (!session.url) {
      return jsonResponse(500, { error: "Stripe checkout did not return a redirect URL." });
    }
    return jsonResponse(200, { url: session.url });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};

export const config = {
  path: "/api/stripe/create-checkout-session",
};
