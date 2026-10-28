# 0021 — A short, per-sector window for customer self-edit and cancel
**Status:** Accepted

**Context.** Until now a customer could edit or cancel their own `placed` order as long as the slot had not reached its
cut-off hour — in practice a whole business day. Owners want a short window instead: a customer who places by mistake
needs 10 minutes to fix it; anything later should be a phone call, so the kitchen can plan and nothing changes under
the warehouse's feet. Different sectors want different windows: a cantonment's indent is approved by an officer and must
not be self-edited at all; an institution ordering for a canteen is slower and should get more time.

**Decision.**
1. **One number per sector.** `sectors.customer_edit_window_minutes` (default 15, 0–1440), set under Settings → Sectors
   & terms. 0 means no self-edit at all — any change goes through our team. The slot cut-off remains a hard ceiling: the
   window is a shorter one *before* it, never a longer one.
2. **Measured from `orders.created_at`.** The window does not restart when the customer edits (same `created_at`), so a
   customer who tweaks three times inside the window is fine; a customer who comes back the next morning is not. A staff
   edit does not reset it either, because the window is about the customer's own self-service, not the order's history.
3. **Staff unchanged.** `orders:edit` can edit until the order is packed and cancel until it is delivered, as before.
   This is only about *customer* self-service; staff pick up anything a customer missed.
4. **The database re-checks every call.** `edit_order` and `cancel_order` enforce the window; `my_order_terms` returns
   the window so the customer app can show "X minutes left" and hide the buttons when the window is spent. Hiding is a
   convenience; the real refusal lives in the database.

**Consequences.**
+ A clear expectation for both sides: the customer sees how long they have, the kitchen knows that past that moment the
  order is settled unless the team intervenes.
+ Sector dial covers the realistic range in one setting: 0 (defence), 15 (restaurants / hotels / retail), 60
  (institutions). The owner can retune per sector without a deploy.
− The window starts at `created_at`, so an order placed close to the cut-off still gets its full window — the slot check
  still refuses if the cut-off is nearer than that.
− A customer whose order is overdue for self-edit sees "Call us"; staff then act on their behalf (an ordinary edit by
  staff is already audited, so there's no new record to keep).
