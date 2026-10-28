// =============================================================================
// razorpay-order — Supabase Edge Function (Payments & credit, batch 8)
//
// Step 1 of an online payment. The signed-in CUSTOMER asks to pay an amount;
// this function creates a Razorpay order for it with the gateway SECRET (which
// must never reach a browser) and returns the order id the checkout needs.
// Nothing is recorded in our database here: the receipt is written only when
// Razorpay's signed webhook arrives (razorpay-webhook → record_online_payment).
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
// Deploy:  supabase functions deploy razorpay-order
// Call:    supabase.functions.invoke('razorpay-order', { body: { amount } })   (amount in rupees)
// Returns: { order_id, amount (paise), currency, key_id }
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) return json(503, { error: "Online payments are not set up yet (Razorpay keys missing)" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ---- 1. Who is paying? Must be an active customer with an approved account.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "Not signed in" });
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return json(401, { error: "Invalid session" });
  const { data: restaurant } = await admin
    .from("restaurants").select("id, name, status").eq("owner_id", caller.user.id).maybeSingle();
  if (!restaurant || restaurant.status !== "approved") return json(403, { error: "Only an approved customer account can pay online" });

  // ---- 2. Validate the amount (rupees → paise, whole paise only).
  let body: { amount?: number };
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  const rupees = Number(body.amount);
  if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 10_000_000) return json(400, { error: "Enter a valid amount" });
  const paise = Math.round(rupees * 100);

  // ---- 3. Create the gateway order. notes.restaurant_id is what the webhook
  // uses to find the customer, so it is set here, server-side, never by the browser.
  const auth = btoa(`${keyId}:${keySecret}`);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: paise, currency: "INR", receipt: `acct-${restaurant.id.slice(0, 8)}-${Date.now()}`, notes: { restaurant_id: restaurant.id } }),
  });
  const order = await res.json();
  if (!res.ok) return json(502, { error: order?.error?.description ?? "The payment gateway refused the request" });

  return json(200, { order_id: order.id, amount: order.amount, currency: order.currency, key_id: keyId });
});
