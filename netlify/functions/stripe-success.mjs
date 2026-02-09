import Stripe from "stripe";
import { getSupabaseAdmin } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function baseSiteUrl(req) {
  const siteUrl = getEnv("SITE_URL") || getEnv("URL");
  if (siteUrl) return siteUrl.replace(/\/+$/, "");
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return "";
  }
}

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const siteUrl = baseSiteUrl(req);
  if (!siteUrl) {
    return new Response("Missing SITE_URL/URL", { status: 500 });
  }

  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    return redirect(`${siteUrl}/?checkout=error&reason=missing_stripe_key`);
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return redirect(`${siteUrl}/?checkout=error&reason=missing_session_id`);
  }

  const stripe = new Stripe(stripeSecretKey);
  const supabase = getSupabaseAdmin();

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const customerId = session.customer || null;
    const subscriptionId = session.subscription || null;
    const checkoutEmail = session.customer_details?.email || session.customer_email || null;

    let userId = session.client_reference_id || session.metadata?.user_id || null;

    if (!userId && checkoutEmail) {
      const { data: emailProfile } = await supabase
        .from("profiles")
        .select("id")
        .ilike("email", checkoutEmail)
        .maybeSingle();
      if (emailProfile?.id) userId = emailProfile.id;
    }

    if (!userId && customerId) {
      const { data: customerProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (customerProfile?.id) userId = customerProfile.id;
    }

    if (!userId && subscriptionId) {
      const { data: subProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_subscription_id", subscriptionId)
        .maybeSingle();
      if (subProfile?.id) userId = subProfile.id;
    }

    if (!userId) {
      return redirect(`${siteUrl}/?checkout=unmatched`);
    }

    let subscriptionStatus = "active";
    let isPro = true;
    let currentPeriodEnd = null;
    let planId = null;

    if (subscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const status = String(subscription.status || "active").toLowerCase();
        subscriptionStatus = status;
        isPro = status === "active" || status === "trialing";
        currentPeriodEnd = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null;
        planId = subscription.items?.data?.[0]?.price?.id || null;
      } catch (_) {}
    }

    await supabase
      .from("profiles")
      .upsert(
        {
          id: userId,
          email: checkoutEmail,
          is_pro: isPro,
          subscription_status: subscriptionStatus,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          current_period_end: currentPeriodEnd,
          plan_id: planId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      )
      .catch(() => {});

    return redirect(`${siteUrl}/?checkout=success&paid=1`);
  } catch (_) {
    return redirect(`${siteUrl}/?checkout=error&reason=session_lookup_failed`);
  }
};

export const config = {
  path: "/api/stripe/success",
};

