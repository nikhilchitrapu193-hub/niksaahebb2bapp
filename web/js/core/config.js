// =============================================================================
// config.js — the ONLY place with environment-specific settings.
//
// The Supabase "publishable" key is PUBLIC BY DESIGN: it is shipped to every
// browser. Security comes from Row Level Security and role-checking database
// functions (see docs/architecture.md), not from hiding this key.
// NEVER put a privileged server-side ("secret") key in this file.
// =============================================================================

export const config = Object.freeze({
  supabaseUrl: 'https://bzxygscjhvcwahwqgqin.supabase.co',
  supabaseKey: 'sb_publishable_DrQ5oEUzzdeshkS3tALJQw_vf8yvCFO',

  appName: 'Fresh Supply',

  // Display settings
  currency: 'INR',
  locale: 'en-IN',
  timeZone: 'Asia/Kolkata',

  // Storage bucket holding product photos (created in migration 003)
  photoBucket: 'product-photos',

  // How often the delivery screen refreshes its list, in milliseconds
  deliveryPollMs: 30_000,
});

/**
 * Absolute URL of the web root (the folder containing index.html), derived from
 * this file's own location so the app works at any path or sub-folder.
 * Example: "http://localhost:3000/"
 */
export const webRoot = new URL('../../', import.meta.url).href;

/** Where each role lands after login, and where it signs in. */
export const ROLE_HOME = Object.freeze({
  admin: 'admin/',
  restaurant: 'restaurant/',
  delivery: 'delivery/',
});
export const ROLE_LOGIN = Object.freeze({
  admin: 'admin/login.html',
  restaurant: 'restaurant/login.html',
  delivery: 'delivery/login.html',
});
// "restaurant" is the app role of every customer (restaurants, hotels, institutions,
// defence, retail): the label names them all.
export const ROLE_LABELS = Object.freeze({
  admin: 'Admin',
  restaurant: 'Customer',
  delivery: 'Delivery staff',
});

/** Delivery slots offered at checkout (keys match the delivery_slot enum). */
export const DELIVERY_SLOTS = Object.freeze({
  morning:   { label: 'Morning', time: '6 am – 10 am', express: false },
  afternoon: { label: 'Afternoon', time: '12 pm – 3 pm', express: false },
  evening:   { label: 'Evening', time: '5 pm – 8 pm', express: false },
  express:   { label: 'Express (today)', time: 'within 4 hours', express: true },
});

export const PAYMENT_METHODS = Object.freeze({
  cod:    { label: 'Cash on delivery', hint: 'Pay the driver when the order arrives' },
  credit: { label: 'Credit (pay later)', hint: 'Added to your account balance; settle with us' },
});

/**
 * Admin-app modules and the actions a team role can be granted in each.
 * MUST match the check constraints on role_permissions (migrations 006, 009).
 * `nav` is the admin route that opens the module; modules without one are
 * permission groups only (reports arrive in a later batch).
 */
export const MODULES = Object.freeze({
  dashboard: { label: 'Dashboard', nav: '#dashboard' },
  orders:    { label: 'Orders', nav: '#orders' },
  products:  { label: 'Products', nav: '#products' },
  inventory: { label: 'Inventory', nav: '#inventory' },
  customers: { label: 'Customers', nav: '#customers' },
  payments:  { label: 'Payments', nav: null },
  team:      { label: 'Team', nav: '#team' },
  settings:  { label: 'Settings', nav: '#settings' },
  audit:     { label: 'Audit log', nav: '#audit' },
  reports:   { label: 'Reports', nav: null },
  pricing:   { label: 'Pricing', nav: '#pricing' },
});

/** Selling-unit contents (products.pack_unit). Per-kg costs apply to kg/g/l/ml, not to pieces. */
export const PACK_UNITS = Object.freeze({ kg: 'kg', g: 'g', l: 'litre', ml: 'ml', pc: 'pieces' });

/** How a product's price is worked out (product_pricing.pricing_mode). */
export const PRICING_MODES = Object.freeze({
  rule:                 { label: 'Cost + markup (category rule)' },
  fixed_over_benchmark: { label: 'Benchmark + fixed amount' },
  manual:               { label: 'Manual price' },
});

/** Which cost the formula starts from (pricing_rules / product_pricing.cost_method). */
export const COST_METHODS = Object.freeze({
  weighted_avg_30d: { label: '30-day weighted average (ledger)' },
  latest:           { label: 'Latest receipt (ledger)' },
  quote:            { label: "Today's supplier quote" },
  manual:           { label: 'Typed cost' },
});

export const ACTIONS = Object.freeze({
  view:    'View',
  edit:    'Create / edit',
  approve: 'Approve',
  export:  'Export',
});
