// =============================================================================
// invite-staff — Supabase Edge Function
//
// Lets an ADMIN invite a new admin or delivery person by email, straight from
// the Team screen. Creating users needs the service-role key, which must never
// reach a browser, so this small server-side function does it:
//
//   1. Check the caller's JWT belongs to an active admin (profiles.role).
//   2. auth.admin.inviteUserByEmail() — Supabase emails a magic link.
//   3. Set the new profile's role (the sign-up trigger always creates
//      'restaurant'; only this function and admin_set_user_role change it).
//
// Deploy:  supabase functions deploy invite-staff   (or via the dashboard)
// Call:    supabase.functions.invoke('invite-staff', { body: { email, role, full_name, redirect_to } })
// The invitee follows the emailed link to /reset.html?role=<role>, sets a
// password, and signs in on their role's login page.
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ---- 1. Who is calling? Must be an active admin. ------------------------
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "Not signed in" });

  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return json(401, { error: "Invalid session" });

  const { data: profile } = await admin
    .from("profiles").select("role, is_active").eq("id", caller.user.id).maybeSingle();
  if (!profile || profile.role !== "admin" || !profile.is_active) {
    return json(403, { error: "Admins only" });
  }

  // ---- 2. Validate input ----------------------------------------------------
  let body: { email?: string; role?: string; full_name?: string; team_role?: string | null; redirect_to?: string };
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON" }); }

  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role;
  const fullName = (body.full_name ?? "").trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Enter a valid email" });
  if (role !== "admin" && role !== "delivery") return json(400, { error: "Role must be admin or delivery" });

  // The team role (city manager, picker, ...) decides what an admin-app user
  // may do. Drivers are always 'driver'. Missing = the database default
  // (super_admin for admins), so the Team screen should always send one.
  // Only a super admin may invite another super admin.
  const teamRole = role === "delivery" ? "driver" : (body.team_role ?? "super_admin");
  const { data: roleRow } = await admin.from("team_roles").select("code").eq("code", teamRole).maybeSingle();
  if (!roleRow) return json(400, { error: `Unknown team role: ${teamRole}` });
  if (teamRole === "super_admin") {
    const { data: me } = await admin.from("profiles").select("team_role").eq("id", caller.user.id).maybeSingle();
    if (me?.team_role !== "super_admin") return json(403, { error: "Only a super admin can invite a super admin" });
  }

  // ---- 3. Send the invite -------------------------------------------------
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: body.redirect_to || undefined,
  });
  if (inviteError) {
    const msg = /already (been )?registered|already exists/i.test(inviteError.message)
      ? "That email already has an account. Change its role in the table below instead."
      : inviteError.message;
    return json(400, { error: msg });
  }

  // ---- 4. Promote the fresh profile (created by the sign-up trigger) ------
  const { error: roleError } = await admin
    .from("profiles").update({ role, team_role: teamRole, full_name: fullName || null }).eq("id", invited.user.id);
  if (roleError) return json(500, { error: `Invited, but could not set role: ${roleError.message}` });

  return json(200, { ok: true, user_id: invited.user.id, email, role, team_role: teamRole });
});
