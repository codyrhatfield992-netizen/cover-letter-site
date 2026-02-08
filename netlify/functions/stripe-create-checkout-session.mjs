import Stripe from "stripe";
import { getAuthenticatedUser, getSupabaseAdmin, getEnv } from "./shared/supabase.mjs";

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

function json(req, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  const user = await getAuthenticatedUser(req);
  if (!user) return json(req, 401, { error: "Not authenticated" });

  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY", "");
  const priceId = getEnv("STRIPE_PRICE_ID", "");
  const siteUrl = getEnv("URL", "") || getEnv("SITE_URL", "");

  if (!stripeSecretKey) return json(req, 500, { error: "Stripe is not configured (STRIPE_SECRET_KEY missing)" });
  if (!priceId) return json(req, 500, { error: "Stripe is not configured (STRIPE_PRICE_ID missing)" });
  if (!siteUrl) return json(req, 500, { error: "Site URL is not configured (URL or SITE_URL missing)" });

  const stripe = new Stripe(stripeSecretKey);

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (e) {
    return json(req, 500, { error: e.message });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();

  const sessionParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { user_id: user.id },
    success_url: `${siteUrl.replace(/\/$/, "")}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl.replace(/\/$/, "")}/`,
  };

  if (profile?.stripe_customer_id) sessionParams.customer = profile.stripe_customer_id;
  else sessionParams.customer_email = user.email;

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return json(req, 200, { url: session.url });
  } catch (err) {
    return json(req, 500, { error: err.message });
  }
};

export const config = { path: "/api/stripe/create-checkout-session" };
