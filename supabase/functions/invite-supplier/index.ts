// invite-supplier — Edge Function (P2-4)
// Called by admin when inviting a supplier to create their portal account.
// Creates/updates a supplier_invites row, then sends an email via Resend.
//
// Deploy via CLI:
//   supabase functions deploy invite-supplier --project-ref bzxygscjhvcwahwqgqin
//
// Request: POST { supplier_id: uuid, email: string }
// Auth: must be an admin (service-role key passed in Authorization header)

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Verify caller is authenticated admin
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return new Response('Unauthorized', { status: 401 });

  // Resolve caller profile
  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) return new Response('Unauthorized', { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return new Response('Forbidden — admins only', { status: 403 });

  // Parse body
  let body: { supplier_id?: string; email?: string };
  try { body = await req.json(); } catch { return new Response('Bad Request', { status: 400 }); }
  const { supplier_id, email } = body;
  if (!supplier_id || !email) return new Response('Missing supplier_id or email', { status: 422 });

  // Validate supplier exists
  const { data: supplier, error: supErr } = await supabase
    .from('suppliers').select('id,name').eq('id', supplier_id).single();
  if (supErr || !supplier) return new Response('Supplier not found', { status: 404 });

  // Upsert invite row (replace any prior invite for this supplier+email)
  const { data: invite, error: invErr } = await supabase
    .from('supplier_invites')
    .upsert({
      supplier_id,
      email,
      invited_by: user.id,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      accepted_at: null,
    }, { onConflict: 'supplier_id,email' })
    .select('token')
    .single();
  if (invErr) return new Response(`DB error: ${invErr.message}`, { status: 500 });

  // Build portal invite link
  const baseUrl = Deno.env.get('SUPPLIER_PORTAL_URL') ?? `${Deno.env.get('SUPABASE_URL')?.replace('supabase.co/rest/v1','') ?? ''}supplier`;
  const inviteUrl = `${baseUrl}/login.html?token=${invite.token}`;

  // Send email
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (resendKey) {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'supply@freshsupply.in',
        to: email,
        subject: `You are invited to supply for Fresh Supply`,
        html: `<p>Hello,</p>
               <p>You have been invited to register as a supplier on <strong>Fresh Supply</strong> (${supplier.name}).</p>
               <p><a href="${inviteUrl}">Click here to accept the invitation</a></p>
               <p>This link expires in 7 days.</p>
               <p>If you did not expect this email, please ignore it.</p>`,
      }),
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text();
      console.error('Resend error:', txt);
      // Non-fatal: return the invite URL anyway so admin can share manually
    }
  }

  return new Response(JSON.stringify({ ok: true, invite_url: inviteUrl }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
