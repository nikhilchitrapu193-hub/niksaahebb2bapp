-- =============================================================================
-- Migration 008: every sector may sign up from the website.
--
-- Migration 006 seeded can_self_register = true for restaurants and hotels
-- only, so the public sign-up form offered two of the five sectors. The flag
-- stays (Settings → Sectors & terms) so a sector can be switched off later;
-- the default is now "on", and a new sector row is visible everywhere unless
-- someone decides otherwise. See docs/code-rules.md, rule "Reference data shows
-- in full everywhere".
-- =============================================================================

alter table public.sectors alter column can_self_register set default true;
update public.sectors set can_self_register = true where not can_self_register;
