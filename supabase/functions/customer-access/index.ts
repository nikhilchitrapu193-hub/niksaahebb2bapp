// =============================================================================
// customer-access — Supabase Edge Function (migration 016)
//
// The backups that keep a customer from getting stuck at the email step.
// Staff with customers:approve (or a super admin) can, for one customer:
//   confirm_email         mark the email confirmed so they can sign in now
//   resend_confirmation   send the confirmation email again
//   password_link         get a one-time "set your password" link to pass on
//                         by WhatsApp / phone (also confirms the email)
//   set_password          set a temporary password to tell them over the phone
//                         (also confirms the email)
// Each needs the service-role key, which must never reach a browser, so this
// small server-side function does it and writes an audit_log row per action.
//
// Deploy:  supabase functions deploy customer-access   (or via the dashboard)
// Call:    supabase.functions.invoke('customer-access', { body: { action, restaurant_id, password?, redirect_to? } })
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

const ACTIONS = ["confirm_email", "resend_confirmation", "password_link", "set_password"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ---- 1. Who is calling? An active admin with customers:approve (super admins have everything).
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "Not signed in" });
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return json(401, { error: "Invalid session" });
  const { data: profile } = await admin
    .from("profiles").select("role, team_role, is_active, city_id, warehouse_id").eq("id", caller.user.id).maybeSingle();
  if (!profile || profile.role !== "admin" || !profile.is_active) return json(403, { error: "Admins only" });
  if (profile.team_role !== "super_admin") {
    const { data: perm } = await admin.from("role_permissions").select("team_role")
      .eq("team_role", profile.team_role).eq("module", "customers").eq("action", "approve").maybeSingle();
    if (!perm) return json(403, { error: "Needs customers: approve" });
  }

  // ---- 2. Which customer, which action?
  let body: { action?: string; restaurant_id?: string; password?: string; redirect_to?: string };
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  const action = body.action ?? "";
  if (!ACTIONS.includes(action)) return json(400, { error: `Unknown action: ${action}` });
  if (!body.restaurant_id) return json(400, { error: "restaurant_id is required" });

  const { data: restaurant } = await admin
    .from("restaurants").select("id, name, owner_id, city_id, warehouse_id").eq("id", body.restaurant_id).maybeSingle();
  if (!restaurant) return json(404, { error: "Customer not found" });
  // Scope: a city / warehouse manager may only touch customers in their area.
  if (profile.city_id && profile.city_id !== restaurant.city_id) return json(403, { error: "That customer is outside your city" });
  if (profile.warehouse_id && profile.warehouse_id !== restaurant.warehouse_id) return json(403, { error: "That customer is outside your warehouse" });

  const { data: userRes, error: userError } = await admin.auth.admin.getUserById(restaurant.owner_id);
  if (userError || !userRes?.user?.email) return json(404, { error: "No login found for this customer" });
  const user = userRes.user;
  const email = user.email!;
  const redirectTo = body.redirect_to || undefined;

  // ---- 3. Do it.
  let result: Record<string, unknown> = {};
  try {
    if (action === "confirm_email") {
      if (!user.email_confirmed_at) {
        const { error } = await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
        if (error) throw error;
      }
      result = { email, confirmed: true };
    } else if (action === "resend_confirmation") {
      if (user.email_confirmed_at) return json(400, { error: "This email is already confirmed; the customer can sign in." });
      const { error } = await admin.auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo } });
      if (error) throw error;
      result = { email, sent: true };
    } else if (action === "password_link") {
      // Confirm first so the link signs them straight in; the link lands on reset.html to choose a password.
      if (!user.email_confirmed_at) {
        const { error } = await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
        if (error) throw error;
      }
      const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo } });
      if (error) throw error;
      result = { email, link: data.properties?.action_link, expires_note: "One use; valid for about an hour." };
    } else if (action === "set_password") {
      const password = (body.password ?? "").trim();
      if (password.length < 8) return json(400, { error: "The temporary password needs at least 8 characters" });
      const { error } = await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true });
      if (error) throw error;
      result = { email, password_set: true };
    }
  } catch (e) {
    const message = (e as { message?: string })?.message ?? String(e);
    // Supabase's built-in mailer allows only a few emails an hour: say so in plain words.
    if (/rate limit|too many/i.test(message)) {
      return json(429, { error: "The email service is rate-limited right now. Use 'Confirm email' or 'Password link' instead, or set up a custom SMTP sender (docs/deployment.md)." });
    }
    return json(400, { error: message });
  }

  // ---- 4. Audit: who did what to which login (never the password or the link itself).
  await admin.from("audit_log").insert({
    table_name: "auth.users", row_id: user.id, action: "update", changed_by: caller.user.id,
    changes: { customer_access: { action, email, restaurant_id: restaurant.id, restaurant_name: restaurant.name } },
  });

  return json(200, { ok: true, action, ...result });
});
