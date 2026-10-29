// =============================================================================
// tickets.js — Orders → Support tickets (migration 018). A customer raises a
// ticket from their Help page (or staff open one on their behalf after a
// call); staff reply, assign and close. A staff reply queues a "support reply"
// message to the customer (notification_settings → ticket_reply).
// Replying / assigning needs orders:edit; viewing needs orders:view or
// customers:view (scoped to the caller's city / warehouse by RLS).
// =============================================================================

import { html, mount, on, $, formatDateTime, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listTickets, listTicketMessages, openTicket, replyTicket, setTicket, listRestaurants, listUsers } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { TICKET_STATUSES, TICKET_PRIORITIES } from '../../core/config.js';
import { telHref, whatsappHref } from '../../core/notify.js';

export async function renderTickets(container, me) {
  const canEdit = can(me, 'orders', 'edit');
  let tab = 'active';
  let tickets = [];
  let team = [];

  // 'active' means status = 'open' or 'waiting_customer' (the two un-resolved states).
  // Pass the actual DB status; 'all' passes undefined (no filter).
  const tabToStatus = { active: 'open', resolved: 'resolved', all: undefined };

  async function load() {
    [tickets, team] = await Promise.all([listTickets({ status: tabToStatus[tab] }),
      listUsers().then((u) => u.filter((x) => x.role === 'admin' && x.is_active)).catch(() => [])]);
    draw();
  }
  const staffName = (id) => team.find((t) => t.id === id)?.full_name ?? (id ? 'assigned' : '—');

  function draw() {
    const t = [['active', 'Open'], ['resolved', 'Resolved'], ['all', 'All']];
    mount(container, html`
      <div class="page-head"><div><h1>Support tickets</h1><p>${tickets.length} shown</p></div>
        <div class="row"><a class="btn" href="#issues">Issues &amp; credits</a>${canEdit ? html`<button class="btn primary" id="new-ticket">Open a ticket for a customer</button>` : ''}</div></div>
      <div class="tabs" role="tablist">${t.map(([k, l]) => html`<a role="tab" href="#tickets" aria-selected="${String(k === tab)}" data-tab="${k}">${l}</a>`)}</div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Ticket</th><th>Customer</th><th>Subject</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Last activity</th><th></th></tr></thead>
        <tbody>${tickets.length === 0 ? html`<tr><td colspan="8"><div class="empty"><strong>No tickets</strong>Customers raise them from Help in their app.</div></td></tr>` : tickets.map((k) => html`<tr>
          <td><strong>${k.ticket_number}</strong></td>
          <td>${k.restaurants?.name ?? '—'}${k.restaurants?.phone ? html`<div class="row tiny" style="gap:6px">${telHref(k.restaurants.phone) ? html`<a href="${telHref(k.restaurants.phone)}">Call</a>` : ''}${whatsappHref(k.restaurants.phone) ? html`<a href="${whatsappHref(k.restaurants.phone, `Hello, about your ticket ${k.ticket_number}`)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</div>` : ''}</td>
          <td class="small">${k.subject}</td>
          <td class="small">${TICKET_PRIORITIES[k.priority] ?? k.priority}</td>
          <td><span class="badge ${TICKET_STATUSES[k.status]?.badge ?? ''}">${TICKET_STATUSES[k.status]?.label ?? k.status}</span></td>
          <td class="small">${staffName(k.assigned_to)}</td>
          <td class="muted small nowrap">${formatDateTime(k.last_message_at)}</td>
          <td class="right"><button class="btn small" data-open="${k.id}">Open</button></td></tr>`)}</tbody></table></div></div>`);
  }

  on(container, 'click', '[data-tab]', (_e, el) => { tab = el.dataset.tab; load().catch(reportError); });
  on(container, 'click', '[data-open]', (_e, el) => detail(tickets.find((k) => k.id === el.dataset.open)));
  on(container, 'click', '#new-ticket', () => newTicket());

  async function detail(ticket) {
    const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`, { title: `${ticket.ticket_number} · ${ticket.subject}`, wide: true });
    const redraw = async () => {
      const [messages, mine] = await Promise.all([listTicketMessages(ticket.id), listTickets({ restaurantId: ticket.restaurant_id, limit: 50 })]);
      ticket = mine.find((k) => k.id === ticket.id) ?? ticket;
      const closed = ticket.status === 'closed';
      mount(el, html`<div class="stack">
        <div class="spread"><div><span class="badge ${TICKET_STATUSES[ticket.status]?.badge ?? ''}">${TICKET_STATUSES[ticket.status]?.label ?? ticket.status}</span>
            <span class="muted small"> · ${ticket.restaurants?.name ?? ''} · ${TICKET_PRIORITIES[ticket.priority] ?? ticket.priority} priority</span></div>
          <span class="muted small">${formatDateTime(ticket.created_at)}</span></div>
        <div class="stack" style="max-height:40vh;overflow:auto;gap:var(--space-2)">${messages.map((m) => html`
          <div class="card card-pad" style="${m.is_staff ? 'margin-left:var(--space-6);background:var(--surface-2)' : 'margin-right:var(--space-6)'}">
            <div class="muted tiny">${m.is_staff ? (m.profiles?.full_name ?? 'Our team') : (ticket.restaurants?.name ?? 'Customer')} · ${formatDateTime(m.created_at)}</div>
            <div class="small" style="white-space:pre-wrap">${m.body}</div></div>`)}</div>
        ${canEdit && !closed ? html`<form id="reply" class="stack" novalidate>
          <label class="field"><span class="label">Reply (the customer is notified)</span><textarea class="textarea" name="body" rows="3" maxlength="4000" required></textarea></label>
          <div class="form-grid">
            <label class="field"><span class="label">Status</span><select class="select" name="status">${Object.entries(TICKET_STATUSES).map(([k, v]) => html`<option value="${k}" ${k === ticket.status ? 'selected' : ''}>${v.label}</option>`)}</select></label>
            <label class="field"><span class="label">Assigned to</span><select class="select" name="assigned_to"><option value="">— Nobody —</option>${team.map((t) => html`<option value="${t.id}" ${t.id === ticket.assigned_to ? 'selected' : ''}>${t.full_name || t.email}</option>`)}</select></label>
            <label class="field"><span class="label">Priority</span><select class="select" name="priority">${Object.entries(TICKET_PRIORITIES).map(([k, v]) => html`<option value="${k}" ${k === ticket.priority ? 'selected' : ''}>${v}</option>`)}</select></label>
          </div>
          <p class="form-error" id="reply-error" role="alert"></p>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="update-only">Update without replying</button><button class="btn primary" type="submit">Send reply</button></div>
        </form>` : html`<div class="row" style="justify-content:flex-end">${canEdit && closed ? html`<button class="btn" id="reopen">Reopen</button>` : ''}<button class="btn" data-close>Close</button></div>`}
      </div>`);
      const form = $('#reply', el);
      if (form) {
        const applyMeta = () => setTicket(ticket.id, { status: form.elements.status.value, assignedTo: form.elements.assigned_to.value || null, priority: form.elements.priority.value });
        form.onsubmit = async (event) => {
          event.preventDefault();
          const body = form.elements.body.value.trim();
          if (!body) { $('#reply-error', el).textContent = 'Write a reply first.'; return; }
          try {
            await withBusy($('button[type="submit"]', form), async () => {
              await replyTicket(ticket.id, body);
              // reply_ticket sets waiting_customer; only override when the agent chose a final status.
              const chosen = form.elements.status.value;
              if (chosen === 'resolved' || chosen === 'closed' || form.elements.assigned_to.value !== (ticket.assigned_to ?? '') || form.elements.priority.value !== ticket.priority) {
                await setTicket(ticket.id, { status: chosen === 'resolved' || chosen === 'closed' ? chosen : undefined, assignedTo: form.elements.assigned_to.value || null, priority: form.elements.priority.value });
              }
            });
            toast('Reply sent', 'success'); await load(); await redraw();
          } catch (error) { $('#reply-error', el).textContent = error.message; }
        };
        $('#update-only', el).onclick = async () => {
          try { await withBusy($('#update-only', el), applyMeta); toast('Ticket updated', 'success'); await load(); await redraw(); }
          catch (error) { $('#reply-error', el).textContent = error.message; }
        };
      }
      const reopen = $('#reopen', el);
      if (reopen) reopen.onclick = async () => { try { await setTicket(ticket.id, { status: 'open' }); await load(); await redraw(); } catch (error) { reportError(error); } };
    };
    try { await redraw(); } catch (error) { close(); reportError(error); }
  }

  async function newTicket() {
    const restaurants = await listRestaurants().catch(() => []);
    const { el, close } = openModal(html`<form id="new" class="stack" novalidate>
      <label class="field"><span class="label">Customer</span><select class="select" name="restaurantId" required>${restaurants.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></label>
      <label class="field"><span class="label">Subject</span><input class="input" name="subject" maxlength="160" required></label>
      <label class="field"><span class="label">What they told us</span><textarea class="textarea" name="body" rows="4" maxlength="4000" required></textarea></label>
      <label class="field"><span class="label">Priority</span><select class="select" name="priority">${Object.entries(TICKET_PRIORITIES).map(([k, v]) => html`<option value="${k}" ${k === 'normal' ? 'selected' : ''}>${v}</option>`)}</select></label>
      <p class="form-error" id="new-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Open ticket</button></div></form>`, { title: 'Open a ticket for a customer' });
    $('#new', el).onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(event.target));
      if (!v.subject.trim() || !v.body.trim()) { $('#new-error', el).textContent = 'Subject and details are required.'; return; }
      try { const r = await withBusy($('button[type="submit"]', event.target), () => openTicket({ subject: v.subject, body: v.body, restaurantId: v.restaurantId, priority: v.priority })); toast(`${r.ticket_number} opened`, 'success'); close(); await load(); }
      catch (error) { $('#new-error', el).textContent = error.message; }
    };
  }

  await load();
}
