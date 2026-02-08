import Stripe from "stripe";
import { getSupabaseAdmin } from "./shared/supabase.mjs";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Optional but recommended: pin Stripe API version for stability
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" })
  : null;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async (req) => {
  // CORS preflight (useful if your frontend ever calls this directly)
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!stripe || !webhookSecret) {
    return json({ error: "Stripe is not configured" }, 500);
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing stripe-signature header" }, 400);

  // IMPORTANT: Webhooks must use the raw body
  const body = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err?.message || err);
    return json({ error: "Invalid signature" }, 400);
  }

  const supabase = getSupabaseAdmin();

  try {
    // 1) Checkout finished (subscription created successfully)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.client_reference_id || session?.metadata?.user_id;
      if (!userId) return json({ received: true });

      let subscriptionData = {};
      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);

        subscriptionData = {
          stripe_customer_id: session.customer || null,
          stripe_subscription_id: subscription.id,
          subscription_status: subscription.status, // "active", "trialing", etc
          is_pro: subscription.status === "active" || subscription.status === "trialing",
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          plan_id: subscription.items?.data?.[0]?.price?.id || null,
        };
      }

      await supabase
        .from("profiles")
        .update({ ...subscriptionData, updated_at: new Date().toISOString() })
        .eq("id", userId);

      return json({ received: true });
    }

    // 2) Subscription updated (renewals, cancellations at period end, payment failures, etc)
    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.created"
    ) {
      const subscription = event.data.object;

      // You stored customer id on profile during checkout; use it to find user
      const customerId = subscription.customer;
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (!profile?.id) return json({ received: true });

      await supabase
        .from("profiles")
        .update({
          stripe_subscription_id: subscription.id,
          subscription_status: subscription.status,
          is_pro: subscription.status === "active" || subscription.status === "trialing",
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          plan_id: subscription.items?.data?.[0]?.price?.id || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile.id);

      return json({ received: true });
    }

    // 3) Subscription deleted (canceled/ended)
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (!profile?.id) return json({ received: true });

      await supabase
        .from("profiles")
        .update({
          subscription_status: "canceled",
          is_pro: false,
          current_period_end: null,
          plan_id: null,
          stripe_subscription_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile.id);

      return json({ received: true });
    }

    // Ignore unhandled events (but acknowledge to Stripe)
    return json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err?.message || err);
    return json({ error: "Webhook processing failed" }, 500);
  }
};

export const config = {
  path: "/api/stripe/webhook",
};
