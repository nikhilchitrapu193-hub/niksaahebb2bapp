// =============================================================================
// customer-users — Supabase Edge Function (migration 020)
//
// The account owner (or staff with customers:edit, in scope) invites a person
// to a customer account as an outlet manager or approver. Creating a login
// needs the service-role key, so this runs server-side:
//   1. check the caller: owner of restaurant_id, or an admin with customers:edit;
//   2. auth.admin.inviteUserByEmail() with metadata customer_user_of /
//      customer_role / customer_outlet_id — the sign-up trigger
//      (handle_new_user, 020) attaches the new login to the account instead of
//      creating a new one;
//   3. audit_log row.
// If the email already has a login, it is attached directly (customer_users
// row) when it has no account of its own; a staff or owner login is refused.
//
// Deploy:  supabase functions deploy customer-users
// Call:    supabase.functions.invoke('customer-users', { body: { action: 'invite', restaurant_id, email, full_name, phone?, role, outlet_id?, redirect_to? } })
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

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "Not signed in" });
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return json(401, { error: "Invalid session" });

  let body: { action?: string; restaurant_id?: string; email?: string; full_name?: string; phone?: string; role?: string; outlet_id?: string | null; redirect_to?: string };
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  if (body.action !== "invite") return json(400, { error: `Unknown action: ${body.action}` });
  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role === "approver" ? "approver" : "outlet_manager";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "Enter a valid email address" });
  if (!body.restaurant_id) return json(400, { error: "restaurant_id is required" });

  // ---- Who is calling, and for which account?
  const { data: restaurant } = await admin.from("restaurants").select("id, name, owner_id, city_id, warehouse_id").eq("id", body.restaurant_id).maybeSingle();
  if (!restaurant) return json(404, { error: "Customer account not found" });
  const { data: profile } = await admin.from("profiles").select("role, team_role, is_active, city_id, warehouse_id").eq("id", caller.user.id).maybeSingle();
  if (!profile || !profile.is_active) return json(403, { error: "Account disabled" });
  const isOwner = restaurant.owner_id === caller.user.id;
  if (!isOwner) {
    if (profile.role !== "admin") return json(403, { error: "Only the account owner can invite members" });
    if (profile.team_role !== "super_admin") {
      const { data: perm } = await admin.from("role_permissions").select("team_role")
        .eq("team_role", profile.team_role).eq("module", "customers").eq("action", "edit").maybeSingle();
      if (!perm) return json(403, { error: "Needs customers: edit" });
    }
    if (profile.city_id && profile.city_id !== restaurant.city_id) return json(403, { error: "That customer is outside your city" });
    if (profile.warehouse_id && profile.warehouse_id !== restaurant.warehouse_id) return json(403, { error: "That customer is outside your warehouse" });
  }
  let outletId: string | null = body.outlet_id || null;
  if (role === "approver") outletId = null;
  if (outletId) {
    const { data: outlet } = await admin.from("outlets").select("id").eq("id", outletId).eq("restaurant_id", restaurant.id).maybeSingle();
    if (!outlet) return json(400, { error: "That outlet does not belong to this account" });
  }

  // ---- Existing login? Attach it when it is a plain customer login with no account of its own.
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const found = list?.users?.find((u) => (u.email ?? "").toLowerCase() === email);
  let result: Record<string, unknown>;
  try {
    if (found) {
      const { data: p } = await admin.from("profiles").select("role").eq("id", found.id).maybeSingle();
      if (!p || p.role !== "restaurant") return json(400, { error: "That email belongs to a staff login; use a different address." });
      const { data: owns } = await admin.from("restaurants").select("id").eq("owner_id", found.id).maybeSingle();
      if (owns) return json(400, { error: "That email already owns a customer account. Ask them to sign in with it, or use another address." });
      const { data: member } = await admin.from("customer_users").select("restaurant_id").eq("user_id", found.id).maybeSingle();
      if (member && member.restaurant_id !== restaurant.id) return json(400, { error: "That email is already a member of another account." });
      const { error } = await admin.from("customer_users").upsert({ user_id: found.id, restaurant_id: restaurant.id, role, outlet_id: outletId, is_active: true, invited_by: caller.user.id }, { onConflict: "user_id" });
      if (error) throw error;
      result = { attached: true, user_id: found.id };
    } else {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: body.full_name ?? "", phone: body.phone ?? "", customer_user_of: restaurant.id, customer_role: role, customer_outlet_id: outletId ?? "" },
        redirectTo: body.redirect_to || undefined,
      });
      if (error) throw error;
      // The trigger created the member row; record who invited.
      await admin.from("customer_users").update({ invited_by: caller.user.id }).eq("user_id", data.user.id);
      result = { invited: true, user_id: data.user.id };
    }
  } catch (e) {
    const message = (e as { message?: string })?.message ?? String(e);
    if (/rate limit|too many/i.test(message)) return json(429, { error: "The email service is rate-limited right now; try again in an hour or set up custom SMTP (docs/deployment.md)." });
    return json(400, { error: message });
  }

  await admin.from("audit_log").insert({
    table_name: "customer_users", row_id: result.user_id as string, action: "insert", changed_by: caller.user.id,
    changes: { invite: { email, role, outlet_id: outletId, restaurant_id: restaurant.id, restaurant_name: restaurant.name } },
  });
  return json(200, { ok: true, email, role, ...result });
});
