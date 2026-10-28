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

  // Fleetbase API base URL (set to '' to disable Fleetbase integration)
  fleetbaseUrl: '',
  // Fleetbase publishable key (safe in the browser — read-only scope)
  fleetbaseKey: '',
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
  supplier: 'supplier/',
});
export const ROLE_LOGIN = Object.freeze({
  admin: 'admin/login.html',
  restaurant: 'restaurant/login.html',
  delivery: 'delivery/login.html',
  supplier: 'supplier/login.html',
});
// "restaurant" is the app role of every customer (restaurants, hotels, institutions,
// defence, retail): the label names them all.
export const ROLE_LABELS = Object.freeze({
  admin: 'Admin',
  restaurant: 'Customer',
  delivery: 'Delivery staff',
  supplier: 'Supplier',
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
  bank_transfer: { label: 'Bank transfer (NEFT/RTGS)', needsReference: true },
  cheque:        { label: 'Cheque', needsReference: true },
  online:        { label: 'Online (Razorpay)', needsReference: true },
});

export const ORDER_STATUSES = Object.freeze({
  pending:          { label: 'Pending', badge: 'pending' },
  confirmed:        { label: 'Confirmed', badge: 'confirmed' },
  processing:       { label: 'Processing', badge: 'packed' },
  packed:           { label: 'Packed', badge: 'packed' },
  out_for_delivery: { label: 'Out for delivery', badge: 'packed' },
  delivered:        { label: 'Delivered', badge: 'delivered' },
  cancelled:        { label: 'Cancelled', badge: 'cancelled' },
  returned:         { label: 'Returned', badge: 'cancelled' },
});

export const PAYMENT_STATUSES = Object.freeze({
  unpaid:        { label: 'Unpaid', badge: 'pending' },
  partial:       { label: 'Partial', badge: 'packed' },
  paid:          { label: 'Paid', badge: 'delivered' },
  credit_applied:{ label: 'Credit applied', badge: 'delivered' },
  overdue:       { label: 'Overdue', badge: 'cancelled' },
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

/**
 * MODULES — maps permission module names (used by permissions.js) to their
 * display labels. Every module listed here can be granted a view / edit /
 * approve / export action in a team role.
 */
export const MODULES = Object.freeze({
  dashboard:   'Dashboard',
  orders:      'Orders',
  products:    'Products',
  inventory:   'Inventory',
  customers:   'Customers',
  team:        'Team',
  settings:    'Settings',
  pricing:     'Pricing',
  procurement: 'Procurement',
  fulfilment:  'Fulfilment',
  payments:    'Payments',
  reports:     'Reports',
  audit:       'Audit log',
});

// ---------------------------------------------------------------------------
// P2-2 Ordering Plus additions
// ---------------------------------------------------------------------------

/** Coupon discount types (coupons.kind), migration 20261028000002. */
export const COUPON_KINDS = Object.freeze({
  percent: { label: '% off the subtotal' },
  amount:  { label: '₹ off the subtotal' },
});

/** Quote lifecycle (quotes.status), migration 20261028000002. */
export const QUOTE_STATUSES = Object.freeze({
  draft:    { label: 'Draft',            badge: 'pending' },
  sent:     { label: 'Sent to customer', badge: 'packed' },
  accepted: { label: 'Accepted',         badge: 'delivered' },
  declined: { label: 'Declined',         badge: 'cancelled' },
  expired:  { label: 'Expired',          badge: 'inactive' },
});

/** Days of the week for standing-order schedule (ISO day number, 0 = Sunday). */
export const WEEKDAYS = Object.freeze([
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]);

// ---------------------------------------------------------------------------
// P2-3 Contract Pricing additions
// ---------------------------------------------------------------------------

/** Price-list types. */
export const PRICE_LIST_KINDS = Object.freeze({
  standard:  { label: 'Standard (all customers)' },
  contract:  { label: 'Contract (assigned accounts)' },
  promotion: { label: 'Promotion (date-limited)' },
});

// ---------------------------------------------------------------------------
// P2-4 Supplier additions
// ---------------------------------------------------------------------------

/** Supplier status. */
export const SUPPLIER_STATUSES = Object.freeze({
  active:    { label: 'Active',    badge: 'delivered' },
  inactive:  { label: 'Inactive',  badge: 'cancelled' },
  pending:   { label: 'Pending',   badge: 'pending' },
});

/** Purchase order status. */
export const PO_STATUSES = Object.freeze({
  draft:     { label: 'Draft',     badge: 'pending' },
  sent:      { label: 'Sent',      badge: 'packed' },
  received:  { label: 'Received',  badge: 'delivered' },
  partial:   { label: 'Partial',   badge: 'packed' },
  cancelled: { label: 'Cancelled', badge: 'cancelled' },
});

// ---------------------------------------------------------------------------
// P2-8 Fleetbase additions
// ---------------------------------------------------------------------------

/** Fleetbase trip status (mirrors Fleetbase order statuses). */
export const TRIP_STATUSES = Object.freeze({
  created:    { label: 'Created',       badge: 'pending' },
  dispatched: { label: 'Dispatched',    badge: 'packed' },
  started:    { label: 'Started',       badge: 'packed' },
  completed:  { label: 'Completed',     badge: 'delivered' },
  cancelled:  { label: 'Cancelled',     badge: 'cancelled' },
});
