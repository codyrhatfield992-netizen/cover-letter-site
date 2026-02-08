import Stripe from "stripe";
import { getSupabaseAdmin } from "./shared/supabase.mjs";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return optionsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  const webhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");
  if (!stripeSecretKey || !webhookSecret) {
    return jsonResponse(500, { error: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" });
  }

  const stripe = new Stripe(stripeSecretKey);
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return jsonResponse(400, { error: "Missing stripe-signature header" });
  }
  const body = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return jsonResponse(400, { error: "Invalid signature" });
  }

  const supabase = getSupabaseAdmin();

  // checkout.session.completed — activate subscription
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    let userId = session.client_reference_id || session.metadata?.user_id;
    const checkoutEmail = session.customer_details?.email || session.customer_email || null;

    if (!userId && checkoutEmail) {
      const { data: emailProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("email", checkoutEmail)
        .maybeSingle();

      if (emailProfile?.id) {
        userId = emailProfile.id;
      }
    }

    if (!userId) {
      console.error("No user ID found in checkout session");
      return jsonResponse(200, { received: true, matched: false });
    }

    // Retrieve the subscription for period end and price info
    let subscriptionData = {};
    if (session.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        subscriptionData = {
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          plan_id: subscription.items?.data?.[0]?.price?.id || null,
        };
      } catch (_) {}
    }

    const { error } = await supabase
      .from("profiles")
      .upsert(
        {
          id: userId,
          email: checkoutEmail,
          is_pro: true,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          subscription_status: "active",
          plan_id: subscriptionData.plan_id || null,
          ...subscriptionData,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("Error updating profile on checkout:", error.message);
    }
  }

  // invoice.payment_failed — mark subscription as past_due
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId);

    if (profiles && profiles.length > 0) {
      const { error } = await supabase
        .from("profiles")
        .update({
          subscription_status: "past_due",
          is_pro: false,
          stripe_subscription_id: invoice.subscription || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profiles[0].id);

      if (error) {
        console.error("Error updating profile on payment failure:", error.message);
      }
    }
  }

  // customer.subscription.deleted — revoke access
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId);

    if (profiles && profiles.length > 0) {
      const { error } = await supabase
        .from("profiles")
        .update({
          is_pro: false,
          subscription_status: "canceled",
          stripe_subscription_id: subscription.id || null,
          plan_id: subscription.items?.data?.[0]?.price?.id || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profiles[0].id);

      if (error) {
        console.error("Error updating profile on subscription deletion:", error.message);
      }
    }
  }

  // customer.subscription.updated — sync status
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId);

    if (profiles && profiles.length > 0) {
      const isCanceled =
        subscription.status === "canceled" ||
        subscription.status === "unpaid";

      const updateData = {
        subscription_status: subscription.status,
        stripe_subscription_id: subscription.id || null,
        plan_id: subscription.items?.data?.[0]?.price?.id || null,
        updated_at: new Date().toISOString(),
      };

      if (subscription.current_period_end) {
        updateData.current_period_end = new Date(
          subscription.current_period_end * 1000
        ).toISOString();
      }

      if (isCanceled) {
        updateData.is_pro = false;
      } else if (subscription.status === "active") {
        updateData.is_pro = true;
      }

      const { error } = await supabase
        .from("profiles")
        .update(updateData)
        .eq("id", profiles[0].id);

      if (error) {
        console.error("Error updating profile on subscription change:", error.message);
      }
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId);

    if (profiles && profiles.length > 0) {
      await supabase
        .from("profiles")
        .update({
          subscription_status: "active",
          is_pro: true,
          stripe_subscription_id: invoice.subscription || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profiles[0].id);
    }
  }

  return jsonResponse(200, { received: true });
};

export const config = {
  path: "/api/stripe/webhook",
};
