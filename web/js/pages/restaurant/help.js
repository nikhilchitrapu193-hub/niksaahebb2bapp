// =============================================================================
// help.js — customer app → Help (migration 018). Three things on one page:
//   • Call / WhatsApp / email buttons (support_channels, set under Settings →
//     Notifications → Support channels),
//   • help articles the admin writes (audience customer / all / public),
//   • support tickets: open one (optionally about an order), read replies,
//     reply, close. A staff reply also reaches the customer by SMS / email.
// =============================================================================

import { html, mount, on, $, formatDateTime, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { getSupportChannels, listHelpArticles, listTickets, listTicketMessages, openTicket, replyTicket, setTicket, listOrders } from '../../core/api.js';
import { TICKET_STATUSES } from '../../core/config.js';
import { telHref, whatsappHref } from '../../core/notify.js';

/** Plain text → paragraphs (blank line = new paragraph). */
export function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).filter((p) => p.trim()).map((p) => html`<p>${p.trim()}</p>`);
}

export async function renderHelp(container, state) {
  let channels = null;
  let articles = [];
  let tickets = [];
  let openSlug = null;

  async function load() {
    [channels, articles, tickets] = await Promise.all([
      getSupportChannels().catch(() => null), listHelpArticles('customer').catch(() => []), listTickets().catch(() => [])]);
    draw();
  }

  function draw() {
    const name = state.me.restaurant?.name ?? '';
    const tel = telHref(channels?.phone);
    const wa = whatsappHref(channels?.whatsapp || channels?.phone, `Hello, this is ${name}.`);
    const active = tickets.filter((t) => t.status === 'open' || t.status === 'waiting_customer');
    mount(container, html`
      <div class="page-head"><div><h1>Help</h1><p>We are a call away — or raise a ticket and we will get back to you.</p></div>
        <button class="btn primary" id="new-ticket">Raise a ticket</button></div>
      <div class="card card-pad" id="contact-card">
        <div class="row-wrap">
          ${tel ? html`<a class="btn" href="${tel}">📞 Call ${channels.phone}</a>` : ''}
          ${wa ? html`<a class="btn" href="${wa}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
          ${channels?.email ? html`<a class="btn" href="mailto:${channels.email}">✉️ ${channels.email}</a>` : ''}
          ${!tel && !wa && !channels?.email ? html`<span class="muted">Contact details are being set up; use a ticket below.</span>` : ''}
        </div></div>

      <h2 style="margin:var(--space-6) 0 var(--space-3)">Your tickets ${active.length ? html`<span class="badge pending">${active.length} open</span>` : ''}</h2>
      ${tickets.length === 0 ? html`<div class="empty">No tickets yet. Raise one for a wrong item, a missing delivery, an invoice query — anything.</div>`
        : html`<div class="card"><div class="table-wrap"><table class="table">
          <thead><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Last activity</th><th></th></tr></thead>
          <tbody>${tickets.map((t) => html`<tr><td><strong>${t.ticket_number}</strong></td><td class="small">${t.subject}</td>
            <td><span class="badge ${TICKET_STATUSES[t.status]?.badge ?? ''}">${t.status === 'waiting_customer' ? 'We replied' : (TICKET_STATUSES[t.status]?.label ?? t.status)}</span></td>
            <td class="muted small nowrap">${formatDateTime(t.last_message_at)}</td>
            <td class="right"><button class="btn small" data-ticket="${t.id}">Open</button></td></tr>`)}</tbody></table></div></div>`}

      <h2 style="margin:var(--space-6) 0 var(--space-3)">Common questions</h2>
      ${articles.length === 0 ? html`<div class="empty">No help articles yet.</div>` : html`<div class="faq card card-pad">
        ${articles.map((a) => html`<details ${a.slug === openSlug ? 'open' : ''} data-article="${a.slug}"><summary>${a.title}</summary><div class="small">${paragraphs(a.body)}</div></details>`)}</div>`}`);
  }

  // Remember which answer is open across redraws (the toggle event does not bubble, so listen for the click).
  on(container, 'click', 'details[data-article] summary', (_e, el) => { openSlug = el.parentElement.open ? null : el.parentElement.dataset.article; });
  on(container, 'click', '#new-ticket', () => newTicket());
  on(container, 'click', '[data-ticket]', (_e, el) => detail(tickets.find((t) => t.id === el.dataset.ticket)));

  async function newTicket(orderId = null) {
    const orders = await listOrders().catch(() => []);
    const { el, close } = openModal(html`<form id="new" class="stack" novalidate>
      <label class="field"><span class="label">Subject</span><input class="input" name="subject" maxlength="160" required placeholder="e.g. Tomatoes were grade B"></label>
      <label class="field"><span class="label">About an order (optional)</span><select class="select" name="orderId"><option value="">— None —</option>
        ${orders.slice(0, 30).map((o) => html`<option value="${o.id}" ${o.id === orderId ? 'selected' : ''}>${o.order_number} · ${o.status}</option>`)}</select></label>
      <label class="field"><span class="label">Tell us what happened</span><textarea class="textarea" name="body" rows="5" maxlength="4000" required></textarea></label>
      <p class="form-error" id="new-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Send</button></div></form>`, { title: 'Raise a ticket' });
    $('#new', el).onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(event.target));
      if (!v.subject.trim() || !v.body.trim()) { $('#new-error', el).textContent = 'Subject and details are required.'; return; }
      try { const r = await withBusy($('button[type="submit"]', event.target), () => openTicket({ subject: v.subject, body: v.body, orderId: v.orderId || null })); toast(`${r.ticket_number} raised — we will reply soon`, 'success'); close(); await load(); }
      catch (error) { $('#new-error', el).textContent = error.message; }
    };
  }

  async function detail(ticket) {
    const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`, { title: `${ticket.ticket_number} · ${ticket.subject}`, wide: true });
    const redraw = async () => {
      const [messages, mine] = await Promise.all([listTicketMessages(ticket.id), listTickets()]);
      tickets = mine; ticket = mine.find((t) => t.id === ticket.id) ?? ticket;
      const closed = ticket.status === 'closed';
      mount(el, html`<div class="stack">
        <div class="spread"><span class="badge ${TICKET_STATUSES[ticket.status]?.badge ?? ''}">${ticket.status === 'waiting_customer' ? 'We replied' : (TICKET_STATUSES[ticket.status]?.label ?? ticket.status)}</span><span class="muted small">${formatDateTime(ticket.created_at)}</span></div>
        <div class="stack" style="max-height:40vh;overflow:auto;gap:var(--space-2)">${messages.map((m) => html`
          <div class="card card-pad" style="${m.is_staff ? 'margin-right:var(--space-6);background:var(--surface-2)' : 'margin-left:var(--space-6)'}">
            <div class="muted tiny">${m.is_staff ? 'Our team' : 'You'} · ${formatDateTime(m.created_at)}</div>
            <div class="small" style="white-space:pre-wrap">${m.body}</div></div>`)}</div>
        ${closed ? html`<div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>` : html`
          <form id="reply" class="stack" novalidate>
            <label class="field"><span class="label">Reply</span><textarea class="textarea" name="body" rows="3" maxlength="4000" required></textarea></label>
            <p class="form-error" id="reply-error" role="alert"></p>
            <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="close-ticket">Mark as sorted</button><button class="btn primary" type="submit">Send reply</button></div>
          </form>`}
      </div>`);
      const form = $('#reply', el);
      if (form) {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const body = form.elements.body.value.trim();
          if (!body) { $('#reply-error', el).textContent = 'Write a reply first.'; return; }
          try { await withBusy($('button[type="submit"]', form), () => replyTicket(ticket.id, body)); toast('Reply sent', 'success'); await redraw(); draw(); }
          catch (error) { $('#reply-error', el).textContent = error.message; }
        };
        $('#close-ticket', el).onclick = async () => {
          try { await withBusy($('#close-ticket', el), () => setTicket(ticket.id, { status: 'closed' })); toast('Ticket closed', 'success'); close(); await load(); }
          catch (error) { $('#reply-error', el).textContent = error.message; }
        };
      }
    };
    try { await redraw(); } catch (error) { close(); reportError(error); }
  }

  await load();
}
