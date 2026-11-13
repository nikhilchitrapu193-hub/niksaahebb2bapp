-- =============================================================================
-- Migration 025: Atlas access permission
--
-- Adds the `knowledge_base` module to the permission system so super admins
-- can grant any team member access to the AppAtlas knowledge base viewer.
-- The viewer is a read-only internal tool; it contains no customer data and
-- makes no writes, so its only relevant action is 'view'.
--
-- The knowledge_base module is intentionally NOT in the standard MODULES list
-- for launch-control purposes (it is never hidden by pricing_mode/stock_mode).
-- It is gated purely by has_permission('knowledge_base','view'), which the
-- browser checks before rendering the screen and the DB function enforces
-- when serving the atlas payload.
-- =============================================================================

-- 1. Add knowledge_base to the module check constraint.
ALTER TABLE role_permissions
  DROP CONSTRAINT IF EXISTS role_permissions_module_check;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_check CHECK (module IN (
    'dashboard','orders','products','inventory','customers','payments',
    'team','settings','audit','reports','pricing','procurement','fulfilment',
    'knowledge_base'
  ));

-- 2. Add 'view' to the action check constraint (it may already exist; safe to re-add).
-- (No change needed — 'view' is already a valid action.)

-- 3. Seed: grant super_admin view access to knowledge_base by default.
INSERT INTO role_permissions (team_role, module, action, allowed)
VALUES ('super_admin', 'knowledge_base', 'view', true)
ON CONFLICT (team_role, module, action) DO NOTHING;

-- 4. Helper view: which team members have atlas access (for the settings UI).
-- (Read-only; drops and recreates safely.)
DROP VIEW IF EXISTS atlas_access_members;
CREATE VIEW atlas_access_members AS
SELECT
  p.id,
  p.full_name,
  p.email,
  p.team_role,
  COALESCE(rp.allowed, false) AS atlas_access
FROM profiles p
LEFT JOIN role_permissions rp
  ON rp.team_role = p.team_role
  AND rp.module = 'knowledge_base'
  AND rp.action = 'view'
WHERE p.role = 'admin';

COMMENT ON VIEW atlas_access_members IS
  'Admin team members with their current AppAtlas access state.';
