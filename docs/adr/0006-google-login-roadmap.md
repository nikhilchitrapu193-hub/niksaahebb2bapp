# 0006 — Google sign-in deferred
**Status:** Accepted (roadmap)

**Context.** Google sign-in was requested. It needs a Google Cloud OAuth client and an onboarding flow for users who sign in but have no restaurant details yet. The earlier prototype scaffolded it; the Supabase build does not include it yet.

**Decision.** Ship email + password first. To add Google later: enable the provider in Supabase, add `supabase.auth.signInWithOAuth({ provider: 'google' })` to `auth.js`, and add a "complete your restaurant profile" screen (the `handle_new_user()` trigger creates a restaurant row only when restaurant metadata is present). Role stays `restaurant`; admins are never created via Google.

**Consequences.** Faster, simpler launch; one more feature to schedule.
