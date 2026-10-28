// =============================================================================
// notifications.js — Settings → Notifications (migration 018).
//
// Three tabs:
//   Templates  one row per event (the default) plus per-sector overrides:
//              SMS on/off + text, email on/off + subject + text, a live preview.
//   Channels   the support phone / WhatsApp / email shown to customers, the
//              SMS label, and the master "notify customers" switch.
//   Log        every message queued / sent / failed / skipped, with Retry and
//              "Send now" (runs the send-notifications Edge Function).
//
// The database queues messages by trigger; nothing here sends directly. Which
// provider delivers them is an Edge Function secret (docs/deployment.md), so
// the Log tab shows "skipped: SMS_PROVIDER is not set" until one is configured
// — the owner can see exactly what did not go out and why.
// =============================================================================

import { html, mount, on, $, formatDateTime, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listNotificationSettings, saveNotificationSetting, deleteNotificationSetting, listNotifications, retryNotification,
         sendNotificationsNow, getCompanySettings, saveCompanySettings, listSectors } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { NOTIFICATION_EVENTS, NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from '../../core/config.js';
import { renderTemplate, unknownPlaceholders, SAMPLE_VALUES, phoneDigits } from '../../core/notify.js';
import { settingsTabs } from './settings.js';

export async function renderNotifications(container, me) {
  const canEdit = can(me, 'settings', 'edit');
  let tab = 'templates';
  let rows = [];
  let sectors = [];
  let settings = {};
  let log = [];
  let logFilter = { status: '' };

  async function load() {
    if (tab === 'templates') [rows, sectors] = await Promise.all([listNotificationSettings(), listSectors()]);
    else if (tab === 'channels') settings = await getCompanySettings();
    else log = await listNotifications({ status: logFilter.status || undefined, limit: 200 });
    draw();
  }

  const sectorName = (code) => (code ? (sectors.find((s) => s.code === code)?.name ?? code) : 'Default (every sector)');

  function subTabs() {
    const t = [['templates', 'Templates'], ['channels', 'Support channels'], ['log', 'Message log']];
    return html`<div class="tabs" role="tablist" style="margin-top:var(--space-3)">${t.map(([k, l]) => html`<a role="tab" href="#notifications" aria-selected="${String(k === tab)}" data-tab="${k}">${l}</a>`)}</div>`;
  }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Notifications</h1><p>SMS and email to customers when their order moves, a payment lands or falls due, or support replies.</p></div>
        ${tab === 'log' && canEdit ? html`<div class="row"><button class="btn" id="dry-run">Check queue</button><button class="btn primary" id="send-now">Send now</button></div>` : ''}</div>
      ${settingsTabs(me, '#notifications')}
      ${subTabs()}
      ${tab === 'templates' ? templates() : tab === 'channels' ? channels() : logTable()}`);
  }

  // ---------- Templates ----------
  function templates() {
    const events = Object.keys(NOTIFICATION_EVENTS);
    return html`
      ${canEdit ? html`<div class="row" style="justify-content:flex-end;margin-bottom:var(--space-3)"><button class="btn" id="add-override">Add a sector override</button></div>` : ''}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Event</th><th>Applies to</th><th>SMS</th><th>Email</th><th>SMS text</th><th></th></tr></thead>
        <tbody>${events.flatMap((ev) => {
          const forEvent = rows.filter((r) => r.event === ev);
          if (forEvent.length === 0) return [html`<tr><td><strong>${NOTIFICATION_EVENTS[ev].label}</strong></td><td class="muted">no template</td><td colspan="3" class="muted small">Messages for this event are not sent.</td>
            <td class="right">${canEdit ? html`<button class="btn small" data-new="${ev}">Add</button>` : ''}</td></tr>`];
          return forEvent.map((r, i) => html`<tr>
            <td>${i === 0 ? html`<strong>${NOTIFICATION_EVENTS[ev].label}</strong>` : ''}</td>
            <td class="small">${sectorName(r.sector_code)}</td>
            <td>${r.sms_enabled ? html`<span class="badge delivered">on</span>` : html`<span class="badge inactive">off</span>`}</td>
            <td>${r.email_enabled ? html`<span class="badge delivered">on</span>` : html`<span class="badge inactive">off</span>`}</td>
            <td class="small muted" style="max-width:420px">${r.sms_template}</td>
            <td class="right nowrap"><button class="btn small" data-edit="${r.id}">${canEdit ? 'Edit' : 'View'}</button>
              ${canEdit && r.sector_code ? html`<button class="btn ghost small" data-delete="${r.id}">Remove</button>` : ''}</td></tr>`);
        })}</tbody></table></div></div>
      <p class="muted small" style="margin-top:var(--space-3)">Placeholders: <code>{customer}</code> <code>{order}</code> <code>{total}</code> <code>{amount}</code> <code>{due_date}</code> <code>{company}</code> <code>{ticket}</code> <code>{code}</code>. A sector override replaces the default for that sector only. Keep SMS under 160 characters to stay at one message.</p>`;
  }

  function editTemplate(row) {
    const isNew = !row.id;
    const allowed = NOTIFICATION_EVENTS[row.event]?.placeholders ?? [];
    const { el, close } = openModal(html`
      <form id="tpl" class="stack" novalidate>
        <div class="form-grid">
          <label class="field"><span class="label">Event</span><select class="select" name="event" ${isNew ? '' : 'disabled'}>
            ${Object.entries(NOTIFICATION_EVENTS).map(([k, v]) => html`<option value="${k}" ${k === row.event ? 'selected' : ''}>${v.label}</option>`)}</select></label>
          <label class="field"><span class="label">Applies to</span><select class="select" name="sector_code" ${isNew ? '' : 'disabled'}>
            <option value="" ${!row.sector_code ? 'selected' : ''}>Default (every sector)</option>
            ${sectors.map((s) => html`<option value="${s.code}" ${s.code === row.sector_code ? 'selected' : ''}>${s.name} only</option>`)}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="sms_enabled" ${row.sms_enabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Send an SMS</label>
        <label class="field"><span class="label">SMS text</span><textarea class="textarea" name="sms_template" rows="3" maxlength="320" ${canEdit ? '' : 'disabled'}>${row.sms_template ?? ''}</textarea>
          <span class="hint" id="sms-preview"></span></label>
        <label class="check"><input type="checkbox" name="email_enabled" ${row.email_enabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Send an email</label>
        <label class="field"><span class="label">Email subject</span><input class="input" name="email_subject" maxlength="160" value="${row.email_subject ?? ''}" ${canEdit ? '' : 'disabled'}></label>
        <label class="field"><span class="label">Email text</span><textarea class="textarea" name="email_template" rows="6" maxlength="4000" ${canEdit ? '' : 'disabled'}>${row.email_template ?? ''}</textarea>
          <span class="hint" id="email-preview"></span></label>
        <p class="form-error" id="tpl-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button>${canEdit ? html`<button class="btn primary" type="submit">Save</button>` : ''}</div>
      </form>`, { title: isNew ? 'New template' : `${NOTIFICATION_EVENTS[row.event]?.label ?? row.event} — ${sectorName(row.sector_code)}`, wide: true });
    const form = $('#tpl', el);
    const preview = () => {
      const ev = form.elements.event.value;
      const ok = NOTIFICATION_EVENTS[ev]?.placeholders ?? allowed;
      const sms = form.elements.sms_template.value;
      const bad = unknownPlaceholders(sms + ' ' + form.elements.email_template.value + ' ' + form.elements.email_subject.value, ok);
      $('#sms-preview', el).textContent = `Preview: ${renderTemplate(sms, SAMPLE_VALUES)} (${sms.length} chars${bad.length ? ` · unknown: {${bad.join('} {')}}` : ''})`;
      $('#email-preview', el).textContent = `Preview: ${renderTemplate(form.elements.email_template.value, SAMPLE_VALUES).slice(0, 200)}`;
    };
    form.addEventListener('input', preview);
    preview();
    form.onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      v.event = form.elements.event.value; v.sector_code = form.elements.sector_code.value || null;
      v.sms_enabled = form.elements.sms_enabled.checked; v.email_enabled = form.elements.email_enabled.checked;
      if (v.sms_enabled && !v.sms_template.trim()) { $('#tpl-error', el).textContent = 'Write the SMS text or switch SMS off.'; return; }
      if (v.email_enabled && !(v.email_subject.trim() && v.email_template.trim())) { $('#tpl-error', el).textContent = 'Write the email subject and text or switch email off.'; return; }
      try { await withBusy($('button[type="submit"]', form), () => saveNotificationSetting({ ...row, ...v })); toast('Template saved', 'success'); close(); await load(); }
      catch (error) { $('#tpl-error', el).textContent = error.message; }
    };
  }

  // ---------- Channels ----------
  function channels() {
    const ro = canEdit ? '' : 'disabled';
    return html`<form class="card card-pad stack" id="channels-form" novalidate>
      <p class="muted small">Shown on the website footer, the customer app's Help page and every "Call us" button. WhatsApp needs the number with the country code (919876543210).</p>
      <div class="form-grid">
        <label class="field"><span class="label">Support phone</span><input class="input" name="support_phone" value="${settings.support_phone ?? ''}" maxlength="20" ${ro}></label>
        <label class="field"><span class="label">WhatsApp number</span><input class="input" name="support_whatsapp" value="${settings.support_whatsapp ?? ''}" maxlength="15" inputmode="numeric" ${ro}><span class="hint">Digits only, with 91</span></label>
        <label class="field"><span class="label">Support email</span><input class="input" name="support_email" type="email" value="${settings.support_email ?? ''}" maxlength="120" ${ro}></label>
        <label class="field"><span class="label">Company name in messages ({company})</span><input class="input" name="sms_from_label" value="${settings.sms_from_label ?? ''}" maxlength="40" ${ro}></label>
        <label class="check span-2"><input type="checkbox" name="notify_customers" ${settings.notify_customers ? 'checked' : ''} ${ro}> Send customers SMS / email (master switch — off = nothing is queued)</label>
      </div>
      ${canEdit ? html`<div><button class="btn primary" type="submit">Save</button></div>` : ''}
    </form>
    <div class="card card-pad" style="margin-top:var(--space-4)">
      <h3>How messages go out</h3>
      <p class="muted small">Order and payment events queue a message here. A scheduled job (or "Send now" on the log) runs the <code>send-notifications</code> function, which hands SMS to your gateway (httpSMS on your own phone, or MSG91) and email to Resend / Brevo. Setting those up is a one-time step in <code>docs/deployment.md</code>. Until then messages are logged as <em>skipped</em>, never lost.</p>
    </div>`;
  }

  // ---------- Log ----------
  function logTable() {
    return html`
      <div class="toolbar"><select class="select" data-log-status aria-label="Filter by status"><option value="">All statuses</option>
        ${Object.entries(NOTIFICATION_STATUSES).map(([k, v]) => html`<option value="${k}" ${k === logFilter.status ? 'selected' : ''}>${v.label}</option>`)}</select>
        <span class="muted small">${log.length} shown (latest 200)</span></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Event</th><th>To</th><th>Customer</th><th>Status</th><th>Detail</th><th></th></tr></thead>
        <tbody>${log.length === 0 ? html`<tr><td colspan="7"><div class="empty"><strong>No messages yet</strong>They appear here as orders move and payments land.</div></td></tr>` : log.map((n) => html`<tr>
          <td class="nowrap muted small">${formatDateTime(n.created_at)}</td>
          <td class="small">${NOTIFICATION_EVENTS[n.event]?.label ?? n.event}<div class="muted tiny">${NOTIFICATION_CHANNELS[n.channel] ?? n.channel}</div></td>
          <td class="small">${n.to_address}</td>
          <td class="small">${n.restaurants?.name ?? '—'}</td>
          <td><span class="badge ${NOTIFICATION_STATUSES[n.status]?.badge ?? ''}">${NOTIFICATION_STATUSES[n.status]?.label ?? n.status}</span>${n.attempts > 1 ? html`<div class="muted tiny">${n.attempts} attempts</div>` : ''}</td>
          <td class="small" style="max-width:360px">${n.status === 'sent' ? html`<span class="muted">${n.provider ?? ''} ${n.provider_ref ?? ''}</span>` : n.error ? html`<span style="color:var(--danger)">${n.error}</span>` : html`<span class="muted">${n.body.slice(0, 80)}</span>`}</td>
          <td class="right nowrap"><button class="btn ghost small" data-view="${n.id}">View</button>
            ${(n.status === 'failed' || n.status === 'skipped') && (canEdit || can(me, 'orders', 'edit')) ? html`<button class="btn small" data-retry="${n.id}">Retry</button>` : ''}</td></tr>`)}</tbody></table></div></div>`;
  }

  // ---------- Events ----------
  on(container, 'click', '[data-tab]', (_e, el) => { tab = el.dataset.tab; load().catch(reportError); });
  on(container, 'click', '[data-edit]', (_e, el) => editTemplate(rows.find((r) => r.id === el.dataset.edit)));
  on(container, 'click', '[data-new]', (_e, el) => editTemplate({ event: el.dataset.new, sector_code: null, sms_enabled: true, email_enabled: false, sms_template: '', email_subject: '', email_template: '' }));
  on(container, 'click', '#add-override', () => editTemplate({ event: 'order_placed', sector_code: sectors[0]?.code ?? null, sms_enabled: true, email_enabled: false, sms_template: '', email_subject: '', email_template: '' }));
  on(container, 'click', '[data-delete]', async (_e, el) => {
    if (!(await confirmDialog('Remove this sector override? The default template applies again.', { confirmText: 'Remove', danger: true }))) return;
    try { await deleteNotificationSetting(el.dataset.delete); toast('Override removed', 'success'); await load(); } catch (error) { reportError(error); }
  });
  on(container, 'submit', '#channels-form', async (event, form) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    v.notify_customers = form.elements.notify_customers.checked;
    if (v.support_whatsapp && !phoneDigits(v.support_whatsapp)) { reportError(new Error('WhatsApp number must be at least 10 digits (with 91 in front).')); return; }
    v.support_whatsapp = v.support_whatsapp ? phoneDigits(v.support_whatsapp) : '';
    try { await withBusy($('button[type="submit"]', form), () => saveCompanySettings(v)); toast('Support channels saved', 'success'); }
    catch (error) { reportError(error); }
  });
  on(container, 'change', '[data-log-status]', (_e, el) => { logFilter.status = el.value; load().catch(reportError); });
  on(container, 'click', '[data-retry]', async (_e, el) => {
    try { await retryNotification(el.dataset.retry); toast('Queued again', 'success'); await load(); } catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-view]', (_e, el) => {
    const n = log.find((x) => x.id === el.dataset.view);
    openModal(html`<div class="stack">
      <dl class="kv"><dt>Event</dt><dd>${NOTIFICATION_EVENTS[n.event]?.label ?? n.event} · ${NOTIFICATION_CHANNELS[n.channel] ?? n.channel}</dd>
        <dt>To</dt><dd>${n.to_address}</dd><dt>Status</dt><dd>${NOTIFICATION_STATUSES[n.status]?.label ?? n.status}${n.sent_at ? ` · ${formatDateTime(n.sent_at)}` : ''}</dd>
        ${n.subject ? html`<dt>Subject</dt><dd>${n.subject}</dd>` : ''}${n.error ? html`<dt>Error</dt><dd style="color:var(--danger)">${n.error}</dd>` : ''}</dl>
      <pre class="small" style="white-space:pre-wrap">${n.body}</pre>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div></div>`, { title: 'Message' });
  });
  on(container, 'click', '#send-now', async (_e, button) => {
    try {
      const r = await withBusy(button, () => sendNotificationsNow({ limit: 100 }));
      toast(`Sent ${r.sent}, failed ${r.failed}, skipped ${r.skipped}${r.reminders_queued ? ` · ${r.reminders_queued} reminders queued` : ''}`, r.failed ? 'info' : 'success');
      await load();
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '#dry-run', async (_e, button) => {
    try {
      const r = await withBusy(button, () => sendNotificationsNow({ dryRun: true }));
      toast(`${r.queued} waiting · SMS: ${r.sms_provider} · email: ${r.email_provider}`, 'info');
      await load();
    } catch (error) { reportError(error); }
  });

  await load();
}
