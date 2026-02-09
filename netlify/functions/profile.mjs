import Stripe from "stripe";
import { getAuthenticatedUser, getSupabaseAdmin, getFreeLimit } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

function normalizeSubscriptionState(status) {
  const s = String(status || "").toLowerCase();
  const isPro = s === "active" || s === "trialing";
  return { status: s || "none", isPro };
}

async function syncStripeStatusIfNeeded(supabase, profile) {
  if (!profile) return profile;

  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) return profile;
  const hasStripeIds = !!(profile.stripe_customer_id || profile.stripe_subscription_id);

  const stripe = new Stripe(stripeSecretKey);

  try {
    let subscription = null;
    let stripeCustomerId = profile.stripe_customer_id || null;

    if (hasStripeIds && profile.stripe_subscription_id) {
      subscription = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
    } else if (hasStripeIds && profile.stripe_customer_id) {
      const list = await stripe.subscriptions.list({
        customer: profile.stripe_customer_id,
        status: "all",
        limit: 1,
      });
      subscription = list?.data?.[0] || null;
    } else if (profile.email) {
      const customers = await stripe.customers.list({
        email: profile.email,
        limit: 1,
      });
      const customer = customers?.data?.[0] || null;
      if (customer?.id) {
        stripeCustomerId = customer.id;
        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          status: "all",
          limit: 10,
        });
        const preferred =
          (subs?.data || []).find((s) => {
            const status = String(s.status || "").toLowerCase();
            return status === "active" || status === "trialing";
          }) || subs?.data?.[0] || null;
        subscription = preferred;
      }
    }

    if (!subscription) return profile;

    const normalized = normalizeSubscriptionState(subscription.status);
    const updates = {
      subscription_status: normalized.status,
      is_pro: normalized.isPro,
      stripe_customer_id: stripeCustomerId || profile.stripe_customer_id || null,
      stripe_subscription_id: subscription.id || profile.stripe_subscription_id || null,
      plan_id: subscription.items?.data?.[0]?.price?.id || profile.plan_id || null,
      updated_at: new Date().toISOString(),
    };

    if (subscription.current_period_end) {
      updates.current_period_end = new Date(subscription.current_period_end * 1000).toISOString();
    }

    const { data: updated } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", profile.id)
      .select("*")
      .single();

    return updated || { ...profile, ...updates };
  } catch (_) {
    return profile;
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return optionsResponse();
  }

  if (req.method !== "GET") {
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

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    return jsonResponse(200, {
      profile: {
        is_pro: false,
        subscription_status: "none",
        generations_used: 0,
        free_limit: getFreeLimit(),
      },
    });
  }

  const syncedProfile = await syncStripeStatusIfNeeded(supabase, profile);

  return jsonResponse(200, {
    profile: {
      ...syncedProfile,
      free_limit: getFreeLimit(),
    },
  });
};

export const config = {
  path: "/api/profile",
};
