// =============================================================================
// statement.js — printable account statement for one customer between two
// dates (?customer=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD). Works for the
// customer themselves and for finance: customer_statement() (migration 015)
// decides who may read it, so no extra checks are needed here.
// =============================================================================

import { html, mount, $, formatINR, formatDate, formatDateTime } from '../core/ui.js';
import { loadCurrentUser, loginFor } from '../core/auth.js';
import { getCustomerStatement, getCompanySettings } from '../core/api.js';

const root = $('#statement');
const params = new URLSearchParams(location.search);
const customerId = params.get('customer');

const KIND = { invoice: 'Invoice', debit_note: 'Debit note', payment: 'Receipt', credit_note: 'Credit note' };

async function render(from, to) {
  const me = await loadCurrentUser();
  if (!me?.profile) { location.replace(loginFor('restaurant')); return; }
  const [st, company] = await Promise.all([getCustomerStatement(customerId, from, to), getCompanySettings()]);

  document.title = `Statement ${st.name} ${from} to ${to} — ${company.name}`;
  const form = $('#range');
  form.elements.from.value = from; form.elements.to.value = to;

  mount(root, html`
    <div class="statement-head">
      <div><h1>${company.name}</h1>
        <div class="muted small">${company.address}</div>
        <div class="muted small">${company.phone ? html`${company.phone} · ` : ''}${company.email}</div>
        <div class="small">${company.gstin ? html`GSTIN ${company.gstin}` : ''}</div></div>
      <div class="right"><h2>Statement of account</h2>
        <div class="muted small">${formatDate(st.from)} to ${formatDate(st.to)}</div>
        <div class="small" style="margin-top:var(--space-2)"><strong>Closing balance ${formatINR(st.closing_balance)}</strong>${Number(st.closing_balance) < 0 ? html` <span class="muted">(in your favour)</span>` : ''}</div></div>
    </div>
    <div class="parties">
      <div><h3>Customer</h3><strong>${st.name}</strong><div class="small">${st.address ?? ''}</div>${st.gstin ? html`<div class="small">GSTIN ${st.gstin}</div>` : ''}</div>
      <div><h3>How to read it</h3><div class="small muted">Debits are invoices (delivered orders) and debit notes; credits are receipts and credit notes. The balance column runs from the opening balance.</div></div>
    </div>
    <table class="table">
      <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Details</th><th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr></thead>
      <tbody>
        <tr class="opening"><td>${formatDate(st.from)}</td><td colspan="3">Opening balance</td><td></td><td></td><td class="right num">${formatINR(st.opening_balance)}</td></tr>
        ${st.lines.length === 0 ? html`<tr><td colspan="7"><div class="empty">No activity in this period.</div></td></tr>` : st.lines.map((l) => html`<tr>
          <td class="nowrap">${formatDate(l.date)}</td><td>${KIND[l.kind] ?? l.kind}</td><td>${l.number}</td><td class="small">${l.description}</td>
          <td class="right num">${Number(l.debit) > 0 ? formatINR(l.debit) : ''}</td>
          <td class="right num">${Number(l.credit) > 0 ? formatINR(l.credit) : ''}</td>
          <td class="right num">${formatINR(l.balance)}</td></tr>`)}
        <tr class="closing"><td>${formatDate(st.to)}</td><td colspan="3">Closing balance</td>
          <td class="right num">${formatINR(st.lines.reduce((s, l) => s + Number(l.debit), 0))}</td>
          <td class="right num">${formatINR(st.lines.reduce((s, l) => s + Number(l.credit), 0))}</td>
          <td class="right num">${formatINR(st.closing_balance)}</td></tr>
      </tbody>
    </table>
    <p class="statement-note">${company.invoice_note} · Generated ${formatDateTime(new Date().toISOString())}. A positive balance is what you owe; a negative one is credit on your account.</p>`);
}

const defaultTo = new Date().toISOString().slice(0, 10);
const defaultFrom = `${defaultTo.slice(0, 7)}-01`;
render(params.get('from') || defaultFrom, params.get('to') || defaultTo).catch((error) => {
  console.error(error);
  mount(root, html`<div class="banner error">${error.message}</div>`);
});

$('#range').onsubmit = (event) => {
  event.preventDefault();
  const f = event.target.elements;
  const url = new URL(location.href);
  url.searchParams.set('from', f.from.value); url.searchParams.set('to', f.to.value);
  history.replaceState(null, '', url);
  mount(root, html`<div class="loading"><span class="spinner"></span> Loading…</div>`);
  render(f.from.value, f.to.value).catch((error) => mount(root, html`<div class="banner error">${error.message}</div>`));
};
