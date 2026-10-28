// fleetbase-dispatch — Edge Function (P2-8)
// Creates a trip in Fleetbase for a given order.
// Called from the admin UI (Fleetbase Trips → Dispatch).
//
// Deploy via CLI:
//   supabase functions deploy fleetbase-dispatch --project-ref bzxygscjhvcwahwqgqin
//
// Env secrets:
//   SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY
//   FLEETBASE_API_URL  FLEETBASE_API_KEY
//
// Request: POST { order_id: uuid }

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Auth
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '');
  const { data: { user }, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!['admin'].includes(profile?.role ?? '')) return new Response('Forbidden', { status: 403 });

  let body: { order_id?: string };
  try { body = await req.json(); } catch { return new Response('Bad Request', { status: 400 }); }
  const { order_id } = body;
  if (!order_id) return new Response('Missing order_id', { status: 422 });

  // Load order with outlet address
  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select(`id, order_number, total_amount, status,
             restaurants(id, name, address, phone),
             outlets(name, address, lat, lng, phone)`)
    .eq('id', order_id)
    .single();
  if (oErr || !order) return new Response('Order not found', { status: 404 });
  if (order.status !== 'packed') return new Response('Order must be packed before dispatch', { status: 422 });

  // Check Fleetbase config
  const fbUrl = Deno.env.get('FLEETBASE_API_URL');
  const fbKey = Deno.env.get('FLEETBASE_API_KEY');
  if (!fbUrl || !fbKey) return new Response('Fleetbase not configured', { status: 503 });

  // Build Fleetbase payload
  const outlet = (order as any).outlets;
  const rest   = (order as any).restaurants;
  const payload = {
    key: fbKey,
    payload: {
      type: 'delivery',
      cod_amount: order.total_amount,
      meta: { order_id: order.id, order_number: order.order_number },
    },
    pickup: {
      name: 'Fresh Supply Warehouse',
      phone: '+919999999999',  // override from fleetbase_config if available
      address: 'Warehouse, Hyderabad',
    },
    dropoff: {
      name: outlet?.name ?? rest?.name ?? 'Customer',
      phone: outlet?.phone ?? rest?.phone ?? '',
      address: outlet?.address ?? rest?.address ?? '',
      lat:  outlet?.lat  ?? null,
      lng:  outlet?.lng  ?? null,
    },
  };

  // Create trip in Fleetbase
  const fbRes = await fetch(`${fbUrl}/v1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fbKey}` },
    body: JSON.stringify(payload),
  });
  const fbBody = await fbRes.json().catch(() => ({}));
  if (!fbRes.ok) {
    console.error('Fleetbase error:', JSON.stringify(fbBody));
    return new Response(`Fleetbase error: ${fbRes.status}`, { status: 502 });
  }

  const fbTripId  = fbBody?.data?.id ?? fbBody?.id ?? null;
  const fbOrderId = fbBody?.data?.order?.id ?? null;

  // Insert fleet_trip record
  const { error: tErr } = await supabase.from('fleet_trips').insert({
    order_id,
    fleetbase_trip_id:  fbTripId,
    fleetbase_order_id: fbOrderId,
    status:             'dispatched',
    dispatch_payload:   payload,
    dispatched_at:      new Date().toISOString(),
  });
  if (tErr) console.error('fleet_trips insert error:', tErr.message);

  // Update order status to dispatched
  await supabase.from('orders').update({ status: 'dispatched', updated_at: new Date().toISOString() }).eq('id', order_id);

  return new Response(JSON.stringify({ ok: true, fleetbase_trip_id: fbTripId }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
