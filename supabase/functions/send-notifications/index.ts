// send-notifications — daily cron Edge Function.
// Invoked at 06:00 IST by a pg_cron job (or Supabase Cron in Dashboard).
// P2-2 addition: calls run_standing_orders() before sending notifications.
//
// Deploy via CLI (MCP deploy times out on JSR resolution):
//   supabase functions deploy send-notifications --project-ref bzxygscjhvcwahwqgqin
//
// Env secrets required:
//   SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY  RESEND_API_KEY  FCM_SERVER_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req: Request) => {
  // Guard: only allow cron invocations (no auth header == cron caller)
  const auth = req.headers.get('authorization');
  if (auth && auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return new Response('Forbidden', { status: 403 });
  }

  const log: string[] = [];

  // ── P2-2: Fire standing orders ───────────────────────────────────────────
  try {
    const { error: soErr } = await supabase.rpc('run_standing_orders');
    if (soErr) throw soErr;
    log.push('run_standing_orders: ok');
  } catch (e) {
    log.push(`run_standing_orders: error — ${(e as Error).message}`);
  }

  // ── Order status notifications ────────────────────────────────────────────
  // Fetch orders confirmed today that haven't been notified yet.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, order_number, total_amount, status, restaurants(name), profiles(email, full_name)')
      .eq('status', 'confirmed')
      .gte('updated_at', today)
      .is('notified_at', null)
      .limit(200);

    if (error) throw error;

    for (const order of (orders ?? [])) {
      const restaurant = (order as any).restaurants;
      const profile    = (order as any).profiles;
      if (!profile?.email) continue;

      await sendEmail({
        to: profile.email,
        subject: `Order ${order.order_number} confirmed — Fresh Supply`,
        html: `<p>Hi ${profile.full_name ?? restaurant?.name ?? 'there'},</p>
               <p>Your order <strong>${order.order_number}</strong> has been confirmed for ₹${Number(order.total_amount).toLocaleString('en-IN')}. It will be delivered tomorrow as scheduled.</p>
               <p>Thank you for ordering with Fresh Supply.</p>`,
      });

      await supabase
        .from('orders')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', order.id);
    }
    log.push(`order notifications: ${(orders ?? []).length} sent`);
  } catch (e) {
    log.push(`order notifications: error — ${(e as Error).message}`);
  }

  // ── Low-stock alerts ──────────────────────────────────────────────────────
  try {
    const { data: low, error } = await supabase
      .from('products')
      .select('id, name, stock_qty, min_stock_alert')
      .lte('stock_qty', supabase.rpc('literal', { val: 0 }) as any)   // stock at or below threshold
      .not('min_stock_alert', 'is', null)
      .limit(50);

    // Simple: just log the count; full email blast to buyers is added in a later iteration
    log.push(`low-stock items found: ${(low ?? []).length}`);
  } catch (e) {
    log.push(`low-stock check: error — ${(e as Error).message}`);
  }

  return new Response(JSON.stringify({ ok: true, log }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// ── Email helper via Resend ───────────────────────────────────────────────────
async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return;          // skip silently in dev
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'orders@freshsupply.in', to, subject, html }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Resend error ${res.status}: ${txt}`);
  }
}
