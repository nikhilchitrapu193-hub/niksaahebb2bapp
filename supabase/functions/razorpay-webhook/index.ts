// =============================================================================
// razorpay-webhook — Supabase Edge Function (Payments & credit, batch 8)
//
// Step 3 of an online payment. Razorpay calls this URL when a payment is
// captured. We verify the HMAC signature with the webhook secret, then record a
// receipt through record_online_payment() (migration 015), which is granted to
// the service role only and ignores a repeated webhook for the same payment id.
// The customer is found from notes.restaurant_id, which razorpay-order set
// server-side when it created the gateway order.
//
// Secrets: RAZORPAY_WEBHOOK_SECRET (the one typed into the Razorpay dashboard)
// Deploy:  supabase functions deploy razorpay-webhook --no-verify-jwt
//          (Razorpay does not send a Supabase JWT; the signature is the check)
// Razorpay dashboard → Webhooks: URL = <project>/functions/v1/razorpay-webhook,
//          event = payment.captured
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function text(status: number, body: string) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare so the signature check leaks no timing. */
function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text(405, "POST only");
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) return text(503, "Webhook secret not set");

  // ---- 1. Verify the signature over the RAW body.
  const raw = await req.text();
  const given = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(secret, raw);
  if (!given || !sameString(given, expected)) return text(401, "Bad signature");

  // ---- 2. Only captured payments become receipts.
  let event: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
  try { event = JSON.parse(raw); } catch { return text(400, "Invalid JSON"); }
  if (event.event !== "payment.captured") return text(200, "Ignored");
  const payment = event.payload?.payment?.entity ?? {};
  const paymentId = String(payment.id ?? "");
  const paise = Number(payment.amount ?? 0);
  const notes = (payment.notes ?? {}) as Record<string, string>;
  const restaurantId = notes.restaurant_id;
  if (!paymentId || !paise || !restaurantId) return text(400, "Missing payment id, amount or restaurant");

  // ---- 3. Record the receipt (idempotent on gateway_ref).
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("record_online_payment", {
    p_restaurant_id: restaurantId,
    p_amount: paise / 100,
    p_gateway: "razorpay",
    p_gateway_ref: paymentId,
    p_received_on: null,
    p_note: `Razorpay ${String(payment.method ?? "")} ${String(payment.email ?? "")}`.trim(),
  });
  if (error) return text(500, error.message);
  return text(200, data?.duplicate ? "Already recorded" : `Recorded ${data?.receipt_number ?? ""}`);
});
