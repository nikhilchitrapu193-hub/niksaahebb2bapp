// =============================================================================
// notify.js — pure helpers for customer messages and contact buttons
// (migration 018). No network calls: api.js does those.
//
//   renderTemplate(template, values)  — the JS twin of public.render_template():
//                                       {name} → values.name; unknown names stay
//                                       visible so a typo shows in the preview.
//   phoneDigits(phone)                — the twin of public.phone_for_sms(): digits
//                                       with the 91 country code, or null.
//   telHref / whatsappHref            — hrefs for the Call / WhatsApp buttons.
//   mapHref(lat, lng, address)        — a Google Maps link for the delivery pin.
//   contactLinks(phone, text)         — the small "Call · WhatsApp" row used on
//                                       customers, orders, tickets and trips.
// =============================================================================

import { html } from './ui.js';

/** Replace {placeholders}; unknown ones are left as typed. Mirrors render_template() in SQL. */
export function renderTemplate(template, values = {}) {
  return String(template ?? '').replace(/\{([a-z_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) && values[key] != null ? String(values[key]) : match);
}

/** The placeholder names used in a template, in order of first appearance. */
export function templatePlaceholders(template) {
  const seen = [];
  for (const m of String(template ?? '').matchAll(/\{([a-z_]+)\}/g)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** Placeholders a template uses that the event does not provide (shown as a warning on the settings screen). */
export function unknownPlaceholders(template, allowed) {
  return templatePlaceholders(template).filter((p) => !allowed.includes(p));
}

/** Indian mobile → "91XXXXXXXXXX" (digits only). Returns null when fewer than 10 digits remain. */
export function phoneDigits(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10) d = `91${d}`;
  return d.length >= 12 ? d : null;
}

export function telHref(phone) {
  const d = phoneDigits(phone);
  return d ? `tel:+${d}` : null;
}

/** wa.me link; `text` is pre-filled (URL-encoded). */
export function whatsappHref(phone, text = '') {
  const d = phoneDigits(phone);
  if (!d) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** Google Maps link: the pin when we have one, otherwise a search for the address. */
export function mapHref(lat, lng, address = '') {
  if (lat != null && lng != null && lat !== '' && lng !== '') return `https://www.google.com/maps?q=${Number(lat)},${Number(lng)}`;
  return address ? `https://www.google.com/maps/search/${encodeURIComponent(address)}` : null;
}

/** A small "Call · WhatsApp" row for a phone number, or '' when there is no usable number. */
export function contactLinks(phone, text = '') {
  const tel = telHref(phone);
  const wa = whatsappHref(phone, text);
  if (!tel) return '';
  return html`<div class="row tiny contact-links" style="gap:8px"><a href="${tel}">Call</a><a href="${wa}" target="_blank" rel="noopener">WhatsApp</a></div>`;
}

/** Sample values for the template preview on Settings → Notifications. */
export const SAMPLE_VALUES = Object.freeze({
  customer: 'Spice Hut', order: 'ORD-1042', total: '₹4,250.00', amount: '₹4,250.00', due_date: '28 Oct',
  company: 'Fresh Supply', ticket: 'TKT-1003', status: 'confirmed', code: '4821',
});
