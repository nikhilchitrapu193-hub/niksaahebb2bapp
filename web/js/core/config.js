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
  // Private bucket for mandi bills and quality photos (migration 011)
  billBucket: 'purchase-bills',
  // Private bucket for delivery proof-of-delivery photos (migration 012)
  podBucket: 'delivery-pod',
  // Private bucket for customer FSSAI / GST documents (migration 019)
  documentBucket: 'customer-documents',

  // How often the delivery screen refreshes its list, in milliseconds
  deliveryPollMs: 30_000,

  // Razorpay "key id" (public, safe in the browser). Empty = the customer app
  // shows no "Pay online" button. The secret stays in the Edge Functions
  // (supabase/functions/razorpay-order, razorpay-webhook) — see docs/deployment.md.
  razorpayKeyId: '',
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

/** How a receipt came in (payments.method, migration 015). `needsReference` = the UTR / cheque number is required. */
export const RECEIPT_METHODS = Object.freeze({
  cash:          { label: 'Cash', needsReference: false },
  upi:           { label: 'UPI', needsReference: true },
  bank_transfer: { label: 'Bank transfer (NEFT / IMPS / RTGS)', needsReference: true },
  cheque:        { label: 'Cheque', needsReference: true },
  online:        { label: 'Online (Razorpay)', needsReference: false },
  other:         { label: 'Other / adjustment', needsReference: false },
});

/**
 * Launch control (migration 014): the two company-wide switches an admin flips
 * under Settings → Launch. Keys match the check constraints on company_settings.
 */
export const LAUNCH_PRICING_MODES = Object.freeze({
  simple:   { label: 'Simple', hint: 'Type each product\'s price on the product form. Price board, rules, benchmarks and price lists stay hidden.' },
  advanced: { label: 'Advanced', hint: 'Prices come from the pricing engine: cost + markup rules, benchmarks, margin guard, scheduled changes, price lists.' },
});
export const STOCK_MODES = Object.freeze({
  simple:  { label: 'Simple', hint: 'No quantities. A product is "in stock" or "out of stock" (the toggle on the Products list). Orders never reserve stock. Inventory and Procurement stay hidden.' },
  counted: { label: 'Counted', hint: 'The stock ledger: receive goods (GRN), per-warehouse counts, reservations per order, batches and expiry, purchase orders.' },
});

/**
 * Admin-app modules and the actions a team role can be granted in each.
 * MUST match the check constraints on role_permissions (migrations 006, 009, 011, 012).
 * `nav` is the admin route that opens the module; modules without one are
 * permission groups only (reports arrive in a later batch). Settings → Launch
 * can hide pricing / inventory / procurement (web/js/core/launch.js).
 */
export const MODULES = Object.freeze({
  dashboard: { label: 'Dashboard', nav: '#dashboard' },
  orders:    { label: 'Orders', nav: '#orders' },
  products:  { label: 'Products', nav: '#products' },
  inventory: { label: 'Inventory', nav: '#inventory' },
  customers: { label: 'Customers', nav: '#customers' },
  payments:  { label: 'Payments', nav: '#payments' },
  team:      { label: 'Team', nav: '#team' },
  settings:  { label: 'Settings', nav: '#settings' },
  audit:     { label: 'Audit log', nav: '#audit' },
  reports:   { label: 'Reports', nav: '#reports' },
  pricing:   { label: 'Pricing', nav: '#pricing' },
  procurement: { label: 'Procurement', nav: '#procurement' },
  fulfilment: { label: 'Fulfilment', nav: '#fulfilment' },
});

/** Selling-unit contents (products.pack_unit). Per-kg costs apply to kg/g/l/ml, not to pieces. */
export const PACK_UNITS = Object.freeze({ kg: 'kg', g: 'g', l: 'litre', ml: 'ml', pc: 'pieces' });

/** products.veg_type; null = not applicable (packaging, cleaning…). */
export const VEG_TYPES = Object.freeze({ veg: 'Veg', non_veg: 'Non-veg' });

/** Catalogue sort orders (customer app). */
export const CATALOGUE_SORTS = Object.freeze({
  name:       { label: 'Name A–Z' },
  price_asc:  { label: 'Price: low to high' },
  price_desc: { label: 'Price: high to low' },
});

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

/** Purchase order statuses (purchase_orders.status). */
export const PO_STATUSES = Object.freeze({
  draft:         { label: 'Draft', badge: 'pending' },
  sent:          { label: 'Sent', badge: 'confirmed' },
  part_received: { label: 'Part received', badge: 'packed' },
  closed:        { label: 'Closed', badge: 'delivered' },
  cancelled:     { label: 'Cancelled', badge: 'cancelled' },
});

/** Where a goods receipt came from (goods_receipts.source). */
export const GRN_SOURCES = Object.freeze({
  po:     { label: 'Against a purchase order' },
  mandi:  { label: 'Mandi cash purchase' },
  direct: { label: 'Direct delivery (no PO)' },
});

/** Trip-sheet statuses (trips.status), migration 012. */
export const TRIP_STATUSES = Object.freeze({
  draft:      { label: 'Draft', badge: 'pending' },
  dispatched: { label: 'Dispatched', badge: 'packed' },
  closed:     { label: 'Closed', badge: 'delivered' },
  cancelled:  { label: 'Cancelled', badge: 'cancelled' },
});

/** What a customer can report about an order (order_issues.kind), migration 013. */
export const ISSUE_KINDS = Object.freeze({
  quality:    { label: 'Quality problem' },
  short:      { label: 'Short / missing items' },
  damaged:    { label: 'Damaged in transit' },
  wrong_item: { label: 'Wrong item sent' },
  other:      { label: 'Something else' },
});

/** order_issues.status. */
export const ISSUE_STATUSES = Object.freeze({
  open:     { label: 'Open', badge: 'pending' },
  resolved: { label: 'Resolved', badge: 'delivered' },
  rejected: { label: 'Declined', badge: 'cancelled' },
});


/** Reports (migration 019): how sales_report() can group. */
export const REPORT_GROUPINGS = Object.freeze({
  day:      { label: 'By day' },
  city:     { label: 'By city' },
  sector:   { label: 'By sector' },
  customer: { label: 'By customer' },
  product:  { label: 'By product' },
  category: { label: 'By category' },
});

/** Customer-side roles (customer_users.role), migration 020. The owner is the sign-up login. */
export const CUSTOMER_ROLES = Object.freeze({
  owner:          { label: 'Owner', hint: 'Everything: orders for every outlet, approvals, payments, outlets and members.' },
  approver:       { label: 'Approver', hint: 'Sees every outlet, approves or rejects held orders, can order (not held).' },
  outlet_manager: { label: 'Outlet manager', hint: 'Orders for one outlet (or all); orders are held for approval when the account needs it.' },
});

/** orders.approval_status, migration 020. */
export const APPROVAL_STATUSES = Object.freeze({
  not_required: { label: 'No approval needed', badge: '' },
  pending:      { label: 'Awaiting approval', badge: 'pending' },
  approved:     { label: 'Approved', badge: 'delivered' },
  rejected:     { label: 'Rejected', badge: 'cancelled' },
});

/** Coupons (coupons.kind), migration 021. */
export const COUPON_KINDS = Object.freeze({
  percent: { label: '% off the subtotal' },
  amount:  { label: '₹ off the subtotal' },
});

/** Quote statuses (quotes.status), migration 021. */
export const QUOTE_STATUSES = Object.freeze({
  draft:    { label: 'Draft', badge: 'pending' },
  sent:     { label: 'Sent to customer', badge: 'packed' },
  accepted: { label: 'Accepted', badge: 'delivered' },
  declined: { label: 'Declined', badge: 'cancelled' },
  expired:  { label: 'Expired', badge: 'inactive' },
});

/** Weekdays for standing orders (standing_orders.days_of_week; 0 = Sunday, as Postgres' extract(dow)). */
export const WEEKDAYS = Object.freeze([
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' },
]);

/** Customer documents (restaurants.*_doc_path), migration 019. */
export const CUSTOMER_DOCUMENTS = Object.freeze({
  fssai: { label: 'FSSAI licence', column: 'fssai_doc_path', hint: 'Needed before approval' },
  gst:   { label: 'GST certificate', column: 'gst_doc_path', hint: 'Optional — for GST invoices with your GSTIN' },
});

/**
 * Customer messages (migration 018). Keys match the check constraint on
 * notification_settings.event; `placeholders` are the {names} a template may use.
 */
export const NOTIFICATION_EVENTS = Object.freeze({
  order_placed:           { label: 'Order placed', placeholders: ['customer', 'order', 'total', 'company'] },
  order_confirmed:        { label: 'Order confirmed', placeholders: ['customer', 'order', 'total', 'due_date', 'company'] },
  order_out_for_delivery: { label: 'Out for delivery', placeholders: ['customer', 'order', 'code', 'company'] },
  order_delivered:        { label: 'Delivered', placeholders: ['customer', 'order', 'total', 'company'] },
  order_cancelled:        { label: 'Cancelled', placeholders: ['customer', 'order', 'company'] },
  receipt_recorded:       { label: 'Payment received', placeholders: ['customer', 'amount', 'ticket', 'company'] },
  payment_due:            { label: 'Payment due tomorrow', placeholders: ['customer', 'order', 'amount', 'due_date', 'company'] },
  payment_overdue:        { label: 'Payment overdue', placeholders: ['customer', 'order', 'amount', 'due_date', 'company'] },
  ticket_reply:           { label: 'Support reply', placeholders: ['customer', 'ticket', 'company'] },
  customer_approved:      { label: 'Account approved', placeholders: ['customer', 'company'] },
});
export const NOTIFICATION_CHANNELS = Object.freeze({ sms: 'SMS', email: 'Email' });
export const NOTIFICATION_STATUSES = Object.freeze({
  queued:  { label: 'Queued', badge: 'pending' },
  sending: { label: 'Sending', badge: 'packed' },
  sent:    { label: 'Sent', badge: 'delivered' },
  failed:  { label: 'Failed', badge: 'cancelled' },
  skipped: { label: 'Skipped', badge: 'confirmed' },
});

/** Support tickets (support_tickets.status / priority), migration 018. */
export const TICKET_STATUSES = Object.freeze({
  open:             { label: 'Open', badge: 'pending' },
  waiting_customer: { label: 'Waiting for customer', badge: 'packed' },
  resolved:         { label: 'Resolved', badge: 'delivered' },
  closed:           { label: 'Closed', badge: 'cancelled' },
});
export const TICKET_PRIORITIES = Object.freeze({ low: 'Low', normal: 'Normal', high: 'High' });

/** Who a help article is written for (help_articles.audience). `public` also shows on the website FAQ. */
export const HELP_AUDIENCES = Object.freeze({
  public:   'Everyone (website FAQ + apps)',
  customer: 'Customers',
  driver:   'Delivery staff',
  all:      'Every signed-in user',
});

export const ACTIONS = Object.freeze({
  view:    'View',
  edit:    'Create / edit',
  approve: 'Approve',
  export:  'Export',
});
