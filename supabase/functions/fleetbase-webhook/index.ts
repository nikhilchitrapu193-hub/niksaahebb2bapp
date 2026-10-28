// fleetbase-webhook — Edge Function (P2-8)
// Receives status-update webhooks from Fleetbase and updates fleet_trips + orders.
//
// Deploy via CLI:
//   supabase functions deploy fleetbase-webhook --project-ref bzxygscjhvcwahwqgqin
//
// Configure in Fleetbase Dashboard:
//   Webhook URL: https://bzxygscjhvcwahwqgqin.supabase.co/functions/v1/fleetbase-webhook
//   Secret:      FLEETBASE_WEBHOOK_SECRET (stored as Supabase secret)
//
// Env secrets:
//   SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY  FLEETBASE_WEBHOOK_SECRET

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHmac } from 'node:crypto';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Verify HMAC signature from Fleetbase
  const secret = Deno.env.get('FLEETBASE_WEBHOOK_SECRET') ?? '';
  const sigHeader = req.headers.get('x-fleetbase-signature') ?? req.headers.get('x-signature') ?? '';
  const rawBody = await req.text();

  if (secret) {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    // Constant-time compare to prevent timing attacks
    if (!timingSafeEqual(expected, sigHeader)) {
      console.error('Webhook signature mismatch');
      return new Response('Forbidden', { status: 403 });
    }
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  // Extract trip ID and status from Fleetbase event format
  const tripId = (event['order_id'] ?? event['trip_id'] ?? event['id'] ?? '') as string;
  const status = (event['status'] ?? event['event'] ?? '') as string;

  if (!tripId || !status) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no trip id or status' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Apply the event
  try {
    const { error } = await supabase.rpc('apply_fleetbase_event', {
      p_trip_id: tripId,
      p_status:  status,
      p_event:   event,
    });
    if (error) throw error;
  } catch (e) {
    console.error('apply_fleetbase_event error:', (e as Error).message);
    // Return 200 so Fleetbase doesn't retry; log for manual review
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

/** Constant-time string comparison to prevent timing attacks on HMAC verification. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
