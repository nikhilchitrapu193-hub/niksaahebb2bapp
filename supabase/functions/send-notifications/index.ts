// =============================================================================
// send-notifications — Supabase Edge Function (migration 018)
//
// Drains the notifications OUTBOX. Database triggers queue one row per enabled
// channel (SMS / email) for order status changes, receipts, ticket replies and
// account approval; queue_payment_reminders() adds due / overdue reminders.
// This function:
//   1. calls run_standing_orders() (021) and queue_payment_reminders() — both idempotent per day,
//   2. claims up to `limit` queued rows (claim_notifications: status → sending),
//   3. sends each through the configured provider,
//   4. reports back with mark_notification(sent | failed | skipped).
//
// Providers (set as Edge Function secrets — never in web/):
//   SMS_PROVIDER    httpsms | msg91 | none        (default none → SMS rows are 'skipped')
//     httpsms:  HTTPSMS_API_KEY, HTTPSMS_FROM (the phone's own number, +91…), HTTPSMS_BASE_URL (optional)
//     msg91:    MSG91_AUTH_KEY, MSG91_SENDER (6-char DLT sender id), MSG91_TEMPLATE_ID (DLT template)
//   EMAIL_PROVIDER  resend | brevo | none         (default none → email rows are 'skipped')
//     resend:   RESEND_API_KEY, EMAIL_FROM ("Fresh Supply <orders@yourdomain.in>")
//     brevo:    BREVO_API_KEY,  EMAIL_FROM
//   CRON_SECRET     optional shared secret for the scheduler (header x-cron-secret)
//
// Who may call it:
//   • a scheduler (cron-job.org / GitHub Actions / Supabase cron) with x-cron-secret,
//   • a signed-in admin with settings:edit ("Send now" on Settings → Notifications).
// A 'none' provider is a valid setting: rows are marked 'skipped' with a reason,
// so nothing is lost and the log shows exactly what did not go out.
//
// Deploy:  supabase functions deploy send-notifications
// Call:    POST { limit?: number, dry_run?: boolean }
//          The scheduler sends "Authorization: Bearer <anon key>" (the gateway's
//          JWT check) plus "x-cron-secret: <CRON_SECRET>" (this function's check).
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type Row = {
  id: string; event: string; channel: "sms" | "email"; to_address: string; subject: string | null; body: string;
};
type SendResult = { ok: true; provider: string; ref?: string } | { ok: false; provider: string; error: string; skipped?: boolean };

// ---------- SMS providers ------------------------------------------------------

async function sendHttpSms(row: Row): Promise<SendResult> {
  const key = Deno.env.get("HTTPSMS_API_KEY");
  const from = Deno.env.get("HTTPSMS_FROM");
  if (!key || !from) return { ok: false, provider: "httpsms", error: "HTTPSMS_API_KEY / HTTPSMS_FROM not set", skipped: true };
  const base = (Deno.env.get("HTTPSMS_BASE_URL") ?? "https://api.httpsms.com").replace(/\/$/, "");
  const res = await fetch(`${base}/v1/messages/send`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ content: row.body, from, to: `+${row.to_address}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, provider: "httpsms", error: `${res.status} ${data?.message ?? JSON.stringify(data).slice(0, 200)}` };
  return { ok: true, provider: "httpsms", ref: data?.data?.id ?? data?.id };
}

async function sendMsg91(row: Row): Promise<SendResult> {
  const key = Deno.env.get("MSG91_AUTH_KEY");
  const sender = Deno.env.get("MSG91_SENDER");
  const template = Deno.env.get("MSG91_TEMPLATE_ID");
  if (!key || !sender || !template) return { ok: false, provider: "msg91", error: "MSG91_AUTH_KEY / MSG91_SENDER / MSG91_TEMPLATE_ID not set", skipped: true };
  // MSG91 "flow" API: the DLT template must carry one variable (##message##) holding our text.
  const res = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: { authkey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: template, sender, short_url: "0", recipients: [{ mobiles: row.to_address, message: row.body }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.type === "error") return { ok: false, provider: "msg91", error: `${res.status} ${data?.message ?? ""}`.trim() };
  return { ok: true, provider: "msg91", ref: data?.request_id ?? data?.message };
}

// ---------- Email providers ----------------------------------------------------

async function sendResend(row: Row): Promise<SendResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return { ok: false, provider: "resend", error: "RESEND_API_KEY / EMAIL_FROM not set", skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [row.to_address], subject: row.subject ?? row.event, text: row.body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, provider: "resend", error: `${res.status} ${data?.message ?? data?.name ?? ""}`.trim() };
  return { ok: true, provider: "resend", ref: data?.id };
}

async function sendBrevo(row: Row): Promise<SendResult> {
  const key = Deno.env.get("BREVO_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return { ok: false, provider: "brevo", error: "BREVO_API_KEY / EMAIL_FROM not set", skipped: true };
  const m = from.match(/^(.*?)\s*<([^>]+)>$/);
  const sender = m ? { name: m[1].trim() || undefined, email: m[2] } : { email: from };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ sender, to: [{ email: row.to_address }], subject: row.subject ?? row.event, textContent: row.body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, provider: "brevo", error: `${res.status} ${data?.message ?? data?.code ?? ""}`.trim() };
  return { ok: true, provider: "brevo", ref: data?.messageId };
}

// ---------- The provider interface ---------------------------------------------
// One function per channel. Adding a provider = one more case here + its secrets.

async function send(row: Row): Promise<SendResult> {
  if (row.channel === "sms") {
    const p = (Deno.env.get("SMS_PROVIDER") ?? "none").toLowerCase();
    if (p === "httpsms") return sendHttpSms(row);
    if (p === "msg91") return sendMsg91(row);
    return { ok: false, provider: "none", error: "SMS_PROVIDER is not set (none): message skipped", skipped: true };
  }
  const p = (Deno.env.get("EMAIL_PROVIDER") ?? "none").toLowerCase();
  if (p === "resend") return sendResend(row);
  if (p === "brevo") return sendBrevo(row);
  return { ok: false, provider: "none", error: "EMAIL_PROVIDER is not set (none): message skipped", skipped: true };
}

// ---------- Handler ------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ---- 1. Who is calling? The scheduler (shared secret) or an admin with settings:edit.
  const cronSecret = Deno.env.get("CRON_SECRET");
  const givenSecret = req.headers.get("x-cron-secret");
  let callerId: string | null = null;
  if (cronSecret && givenSecret && givenSecret === cronSecret) {
    callerId = null; // scheduler
  } else {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Not signed in" });
    const { data: caller, error: callerError } = await admin.auth.getUser(token);
    if (callerError || !caller?.user) return json(401, { error: "Invalid session" });
    const { data: profile } = await admin.from("profiles").select("role, team_role, is_active").eq("id", caller.user.id).maybeSingle();
    if (!profile || profile.role !== "admin" || !profile.is_active) return json(403, { error: "Admins only" });
    if (profile.team_role !== "super_admin") {
      const { data: perm } = await admin.from("role_permissions").select("team_role")
        .eq("team_role", profile.team_role).eq("module", "settings").eq("action", "edit").maybeSingle();
      if (!perm) return json(403, { error: "Needs settings: edit" });
    }
    callerId = caller.user.id;
  }

  let body: { limit?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, 200));

  // ---- 2. Standing orders (021; idempotent per day), reminders, then claim a batch.
  const { data: standing, error: soError } = await admin.rpc("run_standing_orders");
  if (soError && !/does not exist/i.test(soError.message)) console.error("run_standing_orders:", soError.message);
  const { data: reminders, error: remError } = await admin.rpc("queue_payment_reminders");
  if (remError) return json(500, { error: `queue_payment_reminders: ${remError.message}` });
  if (body.dry_run) {
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("status", "queued");
    return json(200, { ok: true, dry_run: true, reminders_queued: reminders ?? 0, standing_orders: standing ?? null, queued: count ?? 0,
      sms_provider: Deno.env.get("SMS_PROVIDER") ?? "none", email_provider: Deno.env.get("EMAIL_PROVIDER") ?? "none" });
  }
  const { data: rows, error: claimError } = await admin.rpc("claim_notifications", { p_limit: limit });
  if (claimError) return json(500, { error: `claim_notifications: ${claimError.message}` });

  // ---- 3. Send each, 4. report back. One failure never blocks the rest.
  const summary = { sent: 0, failed: 0, skipped: 0 };
  for (const row of (rows ?? []) as Row[]) {
    let result: SendResult;
    try { result = await send(row); }
    catch (e) { result = { ok: false, provider: "?", error: (e as { message?: string })?.message ?? String(e) }; }
    if (result.ok) {
      summary.sent++;
      await admin.rpc("mark_notification", { p_id: row.id, p_status: "sent", p_provider: result.provider, p_provider_ref: result.ref ?? null });
    } else {
      const status = result.skipped ? "skipped" : "failed";
      summary[status]++;
      await admin.rpc("mark_notification", { p_id: row.id, p_status: status, p_provider: result.provider, p_error: result.error });
    }
  }

  if (callerId) {
    await admin.from("audit_log").insert({
      table_name: "notifications", row_id: callerId, action: "update", changed_by: callerId,
      changes: { send_now: { ...summary, reminders_queued: reminders ?? 0 } },
    });
  }
  return json(200, { ok: true, reminders_queued: reminders ?? 0, standing_orders: standing ?? null, claimed: rows?.length ?? 0, ...summary });
});
