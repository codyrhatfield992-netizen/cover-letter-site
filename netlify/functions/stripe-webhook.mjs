import Stripe from "stripe";
import { getSupabaseAdmin } from "./shared/supabase.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripeSecretKey = Netlify.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeSecretKey || !webhookSecret) {
    return new Response(
      JSON.stringify({ error: "Stripe is not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const stripe = new Stripe(stripeSecretKey);
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = getSupabaseAdmin();

  // checkout.session.completed — activate subscription
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.user_id;

    if (!userId) {
      console.error("No user ID found in checkout session");
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
          email: session.customer_details?.email || session.customer_email,
          is_pro: true,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          subscription_status: "active",
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

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  path: "/api/stripe/webhook",
};
